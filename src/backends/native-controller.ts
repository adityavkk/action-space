import { Effect, Schema } from "effect";
import {
  Fault,
  Uncertain,
  type Allocation,
  type Bounds,
  type ProcessOutput,
} from "../domain.js";
import { external } from "../effects.js";
import { FileTreeSchema } from "../schemas.js";
import { validateTree, type FileTree } from "../resources.js";
import type { Command, NativeIO } from "./contracts.js";

/** SDK/transport seam. stdin and output bounds are enforced by each implementation. */
export interface NativeTransport {
  execute(
    allocation: Allocation,
    argv: string[],
    stdin: string,
    timeoutMs: number,
    outputBytes: number,
    signal: AbortSignal,
  ): Promise<ProcessOutput>;
}
const ProcessResult = Schema.Struct({
  exitCode: Schema.Int,
  stdout: Schema.String,
  stderr: Schema.String,
});

// Controller executes as root in the provider guest. Workloads use dedicated uid 2000,
// with no sudo/capabilities. The reviewed image must provide python3 and that identity.
// This is transport/controller code, not a second journal or arbitrary user completion hook.
export const controllerSource = String.raw`
import sys,os,json,base64,stat,subprocess,signal,resource,selectors,time,math
req=json.load(sys.stdin)
uid=2000
def path(root, rel=''):
    if not root.startswith('/') or any(x in ['','.','..'] for x in root[1:].split('/')):
        raise ValueError('INVALID_ROOT')
    if root.split('/')[1] not in ['workspace','code','out','scratch','inputs']:
        raise ValueError('INVALID_ROOT')
    if rel and (rel.startswith('/') or any(x in ['','.','..'] for x in rel.split('/'))):
        raise ValueError('INVALID_PATH')
    p=os.path.join(root,rel)
    current='/'
    for part in p.strip('/').split('/'):
        current=os.path.join(current,part)
        if os.path.islink(current): raise ValueError('SYMLINK_DENIED')
    return p
def quiesce():
    # Kill every workload-owned process, including descendants that called setsid.
    for entry in os.scandir('/proc'):
        if entry.name.isdigit():
            try:
                if entry.stat().st_uid==uid: os.kill(int(entry.name),signal.SIGKILL)
            except (ProcessLookupError,FileNotFoundError): pass
    deadline=time.monotonic()+3
    while time.monotonic()<deadline:
        live=False
        for entry in os.scandir('/proc'):
            if entry.name.isdigit():
                try:
                    if entry.stat().st_uid==uid and open(entry.path+'/stat').read().split()[2]!='Z': live=True
                except (ProcessLookupError,FileNotFoundError): pass
        if not live: return
        time.sleep(.01)
    raise ValueError('QUIESCE_FAILED')
op=req['op']
if op=='initialize':
    for root in ['/workspace','/code','/inputs','/out','/scratch']:
        os.makedirs(root,exist_ok=True)
        # A remounted workspace is still owned by uid 2000. CAP_CHOWN is granted,
        # CAP_FOWNER is not: establish controller ownership before changing mode.
        os.chown(root,0,0)
        os.chmod(root,0o755)
        if root in ['/workspace','/out','/scratch']: os.chown(root,uid,uid)
    print('{}')
elif op=='run':
    quiesce()
    bounds=req['bounds']; timeout=max(.001,req['timeoutMs']/1000)
    def restrict():
        os.setsid();os.setgroups([]);os.setgid(uid);os.setuid(uid)
        resource.setrlimit(resource.RLIMIT_CPU,(max(1,math.ceil(bounds['cpuMs']/1000)),)*2)
        resource.setrlimit(resource.RLIMIT_AS,(bounds['heapBytes'],)*2)
        resource.setrlimit(resource.RLIMIT_FSIZE,(bounds['treeBytes'],)*2)
        resource.setrlimit(resource.RLIMIT_NPROC,(64,64))
    p=subprocess.Popen(req['argv'],cwd=path(req['cwd']),env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/workspace','LANG':'C.UTF-8'},stdout=subprocess.PIPE,stderr=subprocess.PIPE,preexec_fn=restrict)
    sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ,'stdout');sel.register(p.stderr,selectors.EVENT_READ,'stderr')
    data={'stdout':bytearray(),'stderr':bytearray()}; deadline=time.monotonic()+timeout; total=0
    try:
        while sel.get_map():
            if time.monotonic()>deadline: raise ValueError('EXECUTION_LIMIT')
            if p.poll() is not None: quiesce()
            for key,_ in sel.select(.02):
                chunk=os.read(key.fileobj.fileno(),8192)
                if not chunk: sel.unregister(key.fileobj);continue
                total+=len(chunk)
                if total>bounds['logBytes']: raise ValueError('LOG_LIMIT')
                data[key.data].extend(chunk)
        p.wait(timeout=max(.001,deadline-time.monotonic()))
        print(json.dumps({'exitCode':p.returncode,'stdout':data['stdout'].decode('utf8','replace'),'stderr':data['stderr'].decode('utf8','replace')}))
    finally: quiesce()
elif op=='upload':
    root=req['root']; path(root);os.makedirs(root,exist_ok=True)
    for rel,item in req['tree'].items():
        p=path(root,rel);os.makedirs(os.path.dirname(p),exist_ok=True)
        with open(p,'xb') as f:f.write(base64.b64decode(item['base64'],validate=True))
        os.chmod(p,0o755 if item['executable'] else 0o644)
        if root=='/workspace':os.chown(p,uid,uid)
    if root=='/workspace':
        for d,dirs,files in os.walk(root): os.chown(d,uid,uid)
    print('{}')
elif op=='download':
    quiesce();root=path(req['root']);tree={};size=0
    for d,dirs,files in os.walk(root,followlinks=False):
        for name in dirs+files:
            p=os.path.join(d,name);s=os.lstat(p)
            if stat.S_ISLNK(s.st_mode):raise ValueError('SYMLINK_DENIED')
            if stat.S_ISDIR(s.st_mode):continue
            if not stat.S_ISREG(s.st_mode) or s.st_nlink>1:raise ValueError('UNSUPPORTED_FILE')
            size+=s.st_size
            if size>req['bounds']['treeBytes'] or len(tree)>=req['bounds']['treeFiles']:raise ValueError('TREE_LIMIT')
            with open(p,'rb') as f:content=f.read(req['bounds']['treeBytes']+1)
            tree[os.path.relpath(p,root)]={'base64':base64.b64encode(content).decode(),'executable':bool(s.st_mode&0o111)}
    print(json.dumps(tree))
elif op=='quiesce':quiesce();print('{}')
else:raise ValueError('UNSUPPORTED_OPERATION')
`;

export class RemoteNativeIO implements NativeIO {
  constructor(readonly transport: NativeTransport) {}
  private request = Effect.fn("Native.controller")(
    (
      a: Allocation,
      input: object,
      timeoutMs: number,
      outputBytes: number,
      signal?: AbortSignal,
    ) =>
      external("Native.transport", async (effectSignal) => {
        let result: ProcessOutput;
        try {
          result = await this.transport.execute(
            a,
            ["python3", "-c", controllerSource],
            JSON.stringify(input),
            timeoutMs,
            outputBytes,
            signal ? AbortSignal.any([signal, effectSignal]) : effectSignal,
          );
        } catch {
          throw new Uncertain(
            "Native transport lost; process outcome or controller operation is unknown",
          );
        }
        if (result.exitCode !== 0)
          throw new Fault(
            "NATIVE_CONTROLLER_FAILED",
            "Controller rejected execution or capture; original code must not be replayed",
          );
        return JSON.parse(result.stdout) as unknown;
      }),
  );
  initialize = Effect.fn("Native.initialize")((a: Allocation) =>
    this.request(a, { op: "initialize" }, 10_000, 1024).pipe(Effect.asVoid),
  );
  quiesce = Effect.fn("Native.quiesce")((a: Allocation) =>
    this.request(a, { op: "quiesce" }, 10_000, 1024).pipe(Effect.asVoid),
  );
  run = Effect.fn("Native.run")(
    function* (this: RemoteNativeIO, a: Allocation, command: Command) {
      const timeoutMs = Math.max(1, command.deadline - Date.now());
      const result = yield* this.request(
        a,
        {
          op: "run",
          argv: command.argv,
          cwd: command.cwd,
          bounds: command.bounds,
          timeoutMs,
        },
        timeoutMs + 5000,
        command.bounds.logBytes * 8 + 1024,
        command.signal,
      );
      return yield* Schema.decodeUnknownEffect(ProcessResult)(result).pipe(
        Effect.mapError(
          () => new Uncertain("Native execution returned invalid evidence"),
        ),
      );
    }.bind(this),
  );
  upload = Effect.fn("Native.upload")(
    (a: Allocation, root: string, tree: FileTree) =>
      this.request(a, { op: "upload", root, tree }, 30_000, 1024).pipe(
        Effect.asVoid,
      ),
  );
  download = Effect.fn("Native.download")(
    function* (
      this: RemoteNativeIO,
      a: Allocation,
      root: string,
      bounds: Bounds,
    ) {
      const result = yield* this.request(
        a,
        { op: "download", root, bounds },
        30_000,
        bounds.treeBytes * 2 + bounds.treeFiles * 1024,
      );
      const tree = yield* Schema.decodeUnknownEffect(FileTreeSchema)(
        result,
      ).pipe(Effect.mapError(() => new Fault("INVALID_TREE")));
      yield* Effect.try({
        try: () => validateTree(tree, bounds),
        catch: () => new Fault("INVALID_TREE"),
      });
      return tree;
    }.bind(this),
  );
}
