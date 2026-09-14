import { Config, Effect, Schema } from "effect";
import assert from "node:assert/strict";
import {
  InvocationSchema,
  Tree,
  SandboxRef,
  WorkSchema,
  BoundSandbox,
  ActionOutputs,
  FileTreeSchema,
} from "../src/schemas.js";
import type { Invocation } from "../src/domain.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const journeys = Effect.gen(function* () {
  const url = yield* Config.string("ACTION_SPACE_URL").pipe(
    Config.withDefault("http://127.0.0.1:3000"),
  );
  const token = yield* Config.string("ACTION_SPACE_TOKEN");
  // Stable intentions: repeated demos retrieve the original Work, even after restart.
  const prefix = "local-demo-v2";
  const observation = randomUUID();
  const receipts: Record<string, string> = {};
  const unauthorized = yield* Effect.promise(() =>
    fetch(`${url}/v1/capabilities`),
  );
  assert.equal(unauthorized.status, 401);
  const request = (path: string, body?: unknown, key?: string) =>
    Effect.promise(async () => {
      const response = await fetch(`${url}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(key ? { "idempotency-key": `${prefix}/${key}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return (await response.json()) as unknown;
    });
  const wait = Effect.fn("Demo.observe")(function* (id: string) {
    const work = Schema.decodeUnknownSync(WorkSchema)(
      yield* request(`/v1/work/${id}?waitMs=10000`),
    );
    if (
      work.state.phase !== "settled" ||
      work.state.outcome.kind !== "completed"
    )
      throw new Error(JSON.stringify(work.state));
    return work.state.outcome.output;
  });
  const submit = Effect.fn("Demo.submit")(function* (
    call: Invocation,
    key: string,
  ) {
    Schema.decodeUnknownSync(InvocationSchema)(call);
    const ref = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
      yield* request("/v1/work", { call }, key),
    );
    receipts[key] = ref.id;
    return yield* wait(ref.id);
  });
  const execution = Schema.decodeUnknownSync(
    Schema.Struct({ work: Schema.Struct({ id: Schema.String }) }),
  )(
    yield* request(
      "/v1/execute",
      {
        code: 'const found=await tools.search({query:"sum"}); return {found,values:await Promise.all([tools.data.sum({values:[3,8]}),tools["data.sum"]({values:[7,-2]})])};',
      },
      "code",
    ),
  );
  receipts.code = execution.work.id;
  const codeOutput = Schema.decodeUnknownSync(ActionOutputs["code.execute"])(
    yield* wait(execution.work.id),
  );
  assert.deepEqual((codeOutput.result as { values: unknown }).values, [
    { ok: true, data: { sum: 11 } },
    { ok: true, data: { sum: 5 } },
  ]);
  const code = Schema.decodeUnknownSync(Tree)(
    yield* request("/v1/resources", {
      "run.py": {
        base64: Buffer.from(
          'import pathlib,sys\npathlib.Path(sys.argv[1],"report.txt").write_text("forty-two")\n',
        ).toString("base64"),
        executable: false,
      },
    }),
  );
  const ephemeral = Schema.decodeUnknownSync(ActionOutputs["sandbox.run"])(
    yield* submit(
      {
        action: "sandbox.run",
        version: "v1",
        target: null,
        input: {
          profile: "sandbox-python-ephemeral-v1",
          code,
          inputs: {},
          argv: ["python3", "/code/run.py", "/out"],
          outputs: { required: ["report.txt"] },
        },
      },
      "ephemeral",
    ),
  );
  const artifact = Schema.decodeUnknownSync(FileTreeSchema)(
    yield* request(`/v1/resources/${ephemeral.files.id}`),
  );
  assert.equal(
    Buffer.from(artifact["report.txt"]!.base64, "base64").toString(),
    "forty-two",
  );
  const sandbox = Schema.decodeUnknownSync(SandboxRef)(
    yield* submit(
      {
        action: "context.ensure",
        version: "v1",
        target: null,
        input: {
          owner: "demo",
          name: `demo-${prefix}`,
          spec: {
            profile: "sandbox-linux-persistent-v1",
            seed: code,
            idleMs: 60_000,
          },
        },
      },
      "ensure",
    ),
  );
  // First run starts unbound; retries return the same binding receipt before CAS.
  const binding = Schema.decodeUnknownSync(BoundSandbox)(
    yield* request(
      "/v1/binding",
      { context: sandbox, expectedRevision: null },
      "bind",
    ),
  );
  yield* submit(
    {
      action: "sandbox.shell",
      version: "v1",
      target: binding,
      input: {
        command: "printf retained > note.txt; printf x >> mutation-count.txt",
        cwd: "/workspace",
      },
    },
    "edit",
  );
  yield* submit(
    { action: "context.sleep", version: "v1", target: sandbox, input: {} },
    "park",
  );
  yield* submit(
    { action: "context.wake", version: "v1", target: sandbox, input: {} },
    "wake",
  );
  // New read-only intentions prove the current workspace, not a cached read result.
  const read = Schema.decodeUnknownSync(ActionOutputs["sandbox.read"])(
    yield* submit(
      {
        action: "sandbox.read",
        version: "v1",
        target: binding,
        input: { path: "/workspace/note.txt" },
      },
      `read-${observation}`,
    ),
  );
  const count = Schema.decodeUnknownSync(ActionOutputs["sandbox.read"])(
    yield* submit(
      {
        action: "sandbox.read",
        version: "v1",
        target: binding,
        input: { path: "/workspace/mutation-count.txt" },
      },
      `count-${observation}`,
    ),
  );
  assert.equal(read.text, "retained");
  assert.equal(count.text, "x", "Retry must not rerun the original mutation");
  yield* Effect.logInfo("Demo passed", {
    authentication: "401 without token",
    sums: [11, 5],
    artifact: "forty-two",
    workspace: read.text,
    mutationCount: 1,
    receipts,
  });
});
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  Effect.runPromise(journeys).catch((error) => {
    console.error(
      "Demo failed:",
      error instanceof Error ? error.message : "unknown",
    );
    process.exitCode = 1;
  });
}
