import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  lstat,
  writeFile,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import {
  Fault,
  type Allocation,
  type Bounds,
  type ProcessOutput,
} from "../domain.js";
import { external } from "../effects.js";
import { relativePath } from "../util.js";
import { validateTree, type FileTree } from "../resources.js";
import type {
  Command,
  EphemeralSandboxBackend,
  NativeIO,
  NativeRequest,
  PersistentSandboxBackend,
} from "./contracts.js";

/** Development compatibility backend, NOT a filesystem, egress, or hostile-tenant boundary. */
export class LocalNative implements NativeIO {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  initialize = (_allocation: Allocation) => Effect.void;
  private directory(a: Allocation): string {
    return join(this.root, relativePath(a.id));
  }
  private path(a: Allocation, path: string): string {
    const relative = path.replace(/^\//, "");
    relativePath(relative);
    return join(this.directory(a), relative);
  }
  create = Effect.fn("LocalNative.create")((request: NativeRequest) =>
    external("LocalNative.mkdir", async () => {
      const a: Allocation = {
        provider: "local",
        id: request.operation,
        generation: request.generation,
        data: {},
      };
      for (const path of [
        "workspace",
        "code",
        "inputs",
        "out",
        "scratch",
        "tmp",
      ])
        await mkdir(this.path(a, path), { recursive: true, mode: 0o700 });
      return a;
    }),
  );
  run = Effect.fn("LocalNative.run")((a: Allocation, command: Command) =>
    external(
      "LocalNative.process",
      (signal) =>
        new Promise<ProcessOutput>((resolveResult, reject) => {
          const mapArg = (arg: string) =>
            /^\/(workspace|code|inputs|out|scratch)(\/|$)/.test(arg)
              ? this.path(a, arg)
              : arg;
          const executable = command.argv[0];
          if (!executable) {
            reject(new Fault("EMPTY_ARGV"));
            return;
          }
          const processTree = spawn(
            mapArg(executable),
            command.argv.slice(1).map(mapArg),
            {
              cwd: this.path(a, command.cwd),
              detached: true,
              env: {
                PATH: "/usr/local/bin:/usr/bin:/bin",
                LANG: "C.UTF-8",
                HOME: this.path(a, "/workspace"),
                WORKSPACE: this.path(a, "/workspace"),
                OUT: this.path(a, "/out"),
                TMPDIR: this.path(a, "/tmp"),
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "";
          let stderr = "";
          let bytes = 0;
          let failure: Fault | undefined;
          const stop = () => {
            try {
              if (processTree.pid) process.kill(-processTree.pid, "SIGKILL");
            } catch {}
          };
          const abort = () => {
            failure = new Fault("CANCELLED");
            stop();
          };
          const timer = setTimeout(
            () => {
              failure = new Fault("EXECUTION_LIMIT");
              stop();
            },
            Math.max(1, command.deadline - Date.now()),
          );
          signal.addEventListener("abort", abort, { once: true });
          command.signal.addEventListener("abort", abort, { once: true });
          for (const [stream, append] of [
            [
              processTree.stdout,
              (s: string) => {
                stdout += s;
              },
            ],
            [
              processTree.stderr,
              (s: string) => {
                stderr += s;
              },
            ],
          ] as const)
            stream.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > command.bounds.logBytes) {
                failure = new Fault("LOG_LIMIT");
                stop();
              } else append(chunk.toString());
            });
          processTree.on("error", () => {
            failure = new Fault("PROCESS_START_FAILED");
          });
          // Exit, not close: background descendants may hold the output pipes open. Stop the entire group.
          processTree.on("exit", () => stop());
          processTree.on("close", (code) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            command.signal.removeEventListener("abort", abort);
            if (failure) reject(failure);
            else resolveResult({ exitCode: code ?? 128, stdout, stderr });
          });
          if (signal.aborted || command.signal.aborted) abort();
        }),
    ),
  );
  upload = Effect.fn("LocalNative.upload")(
    (a: Allocation, root: string, tree: FileTree) =>
      external("LocalNative.materialize", async () => {
        const directory = this.path(a, root);
        await mkdir(directory, { recursive: true });
        for (const [path, file] of Object.entries(tree)) {
          relativePath(path);
          const target = join(directory, path);
          // Inputs only go into newly allocated roots. Reject existing links before writing.
          const segments = path.split("/");
          let current = directory;
          for (const segment of segments.slice(0, -1)) {
            current = join(current, segment);
            await mkdir(current, { recursive: true });
            if ((await lstat(current)).isSymbolicLink())
              throw new Fault("SYMLINK_DENIED");
          }
          await writeFile(target, Buffer.from(file.base64, "base64"), {
            flag: "wx",
            mode: file.executable ? 0o700 : 0o600,
          });
        }
      }),
  );
  download = Effect.fn("LocalNative.download")(
    (a: Allocation, root: string, bounds: Bounds) =>
      external("LocalNative.capture", async () => {
        const tree: FileTree = {};
        let bytes = 0;
        const directory = this.path(a, root);
        const walk = async (path: string) => {
          for (const entry of await readdir(join(directory, path))) {
            const relative = path ? `${path}/${entry}` : entry;
            relativePath(relative);
            const stat = await lstat(join(directory, relative));
            if (stat.isSymbolicLink()) throw new Fault("SYMLINK_DENIED");
            if (stat.isDirectory()) {
              await walk(relative);
              continue;
            }
            if (!stat.isFile() || stat.nlink > 1)
              throw new Fault("UNSUPPORTED_FILE");
            bytes += stat.size;
            if (
              bytes > bounds.treeBytes ||
              Object.keys(tree).length >= bounds.treeFiles
            )
              throw new Fault("TREE_LIMIT");
            tree[relative] = {
              base64: (await readFile(join(directory, relative))).toString(
                "base64",
              ),
              executable: (stat.mode & 0o111) !== 0,
            };
          }
        };
        await walk("");
        validateTree(tree, bounds);
        return tree;
      }),
  );
  park = Effect.fn("LocalNative.park")((a: Allocation) =>
    external("LocalNative.discardVolatile", async () => {
      for (const path of ["code", "inputs", "out", "scratch", "tmp"])
        await rm(this.path(a, path), { recursive: true, force: true });
    }),
  );
  wake = Effect.fn("LocalNative.wake")((a: Allocation, generation: number) =>
    external("LocalNative.remount", async () => {
      if (!(await lstat(this.path(a, "/workspace"))).isDirectory())
        throw new Fault("WORKSPACE_LOST");
      for (const path of ["out", "scratch", "tmp"])
        await mkdir(this.path(a, path), { recursive: true });
      return { ...a, generation };
    }),
  );
  release = Effect.fn("LocalNative.release")((a: Allocation) =>
    external("LocalNative.releaseFiles", () =>
      rm(this.directory(a), { recursive: true, force: true }),
    ),
  );
  ephemeral(): EphemeralSandboxBackend {
    return {
      capability: "sandbox",
      lifecycle: "ephemeral",
      initialize: this.initialize,
      create: this.create,
      run: this.run,
      upload: this.upload,
      download: this.download,
      release: this.release,
    };
  }
  persistent(): PersistentSandboxBackend {
    return {
      capability: "sandbox",
      lifecycle: "persistent",
      initialize: this.initialize,
      create: this.create,
      run: this.run,
      upload: this.upload,
      download: this.download,
      park: this.park,
      wake: this.wake,
    };
  }
}
