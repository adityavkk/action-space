import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { defineTool, type Tool } from "../src/catalog.js";
import { Fault, defaultBounds, type Auth, type Work } from "../src/domain.js";
import { WorkManager, WorkJournal, ResourceStore } from "../src/platform.js";
import { platformLayer } from "../src/runtime.js";

export const auth: Auth = {
  tenant: "tenant-a",
  actor: "agent",
  thread: "thread-a",
  grants: [
    "code.execute",
    "sandbox.run",
    "sandbox.shell",
    "sandbox.read",
    "context.manage",
    "data.read",
    "resources.write",
    "resources.read",
    "test",
  ],
  reviewer: false,
};
const reviewer: Auth = { ...auth, actor: "reviewer", reviewer: true };
const testTool = (path: string, approval = false): Tool =>
  defineTool({
    path,
    version: "v1",
    description: "test-only connector",
    effect: approval ? "write" : "read",
    grant: "test",
    approval,
    input: Schema.Struct({ value: Schema.Number }),
    output: Schema.Struct({ value: Schema.Number }),
    invoke: Effect.fn("Test.invoke")(function* (input) {
      return input;
    }),
  });
function fixture<A, E>(
  program: Effect.Effect<A, E, WorkManager | WorkJournal | ResourceStore>,
  tools: Tool[] = [],
) {
  return Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "action-space-")),
    );
    // Exercise relative data roots, including native argv/cwd resolution, as used by the default server.
    return yield* program.pipe(
      Effect.provide(
        platformLayer({
          directory: relative(process.cwd(), directory),
          principals: [auth, reviewer],
          tools,
        }),
      ),
      Effect.ensuring(
        Effect.promise(() => rm(directory, { recursive: true, force: true })),
      ),
    );
  });
}
function output(work: Work): unknown {
  assert.equal(work.state.phase, "settled");
  if (work.state.phase !== "settled") throw new Error("not settled");
  assert.equal(
    work.state.outcome.kind,
    "completed",
    JSON.stringify(work.state),
  );
  if (work.state.outcome.kind !== "completed") throw new Error("not completed");
  return work.state.outcome.output;
}
describe("durable Action Space journeys", () => {
  it.live(
    "runs code execution through Executor discovery, concurrent calls, return, and same-key inspection",
    () =>
      fixture(
        Effect.gen(function* () {
          const manager = yield* WorkManager;
          const code = `const catalog = await tools.search({query:"sum"}); const results = await Promise.all([tools.data.sum({values:[3,5]}),tools["data.sum"]({values:[7,-2]})]);return {paths:catalog.items.map(x=>x.path),results};`;
          const first = yield* manager.execute(auth, { code }, "sum");
          const work = yield* manager.inspect(auth, first.work.id, 10_000);
          assert.deepEqual(output(work), {
            result: {
              paths: ["data.sum"],
              results: [
                { ok: true, data: { sum: 8 } },
                { ok: true, data: { sum: 5 } },
              ],
            },
            logs: [],
            artifacts: [],
          });
          assert.equal(work.state.children.length, 0);
          assert.equal(work.calls, 2);
          const duplicate = yield* manager.execute(auth, { code }, "sum");
          assert.equal(duplicate.work.id, work.id);
          assert.equal(
            (yield* manager.inspect(auth, work.id)).lease?.generation,
            1,
          );
        }),
      ),
  );
  it.live(
    "does not import legacy approval tools or create a child approval workflow",
    () =>
      fixture(
        Effect.gen(function* () {
          const manager = yield* WorkManager;
          const parent = yield* manager.execute(
            auth,
            {
              code: 'return {catalog:await tools.search({query:"write"}),read:await tools.test.read({value:99})}',
            },
            "approval",
          );
          const work = yield* manager.inspect(auth, parent.work.id, 10_000);
          const value = output(work) as {
            result: { catalog: { items: unknown[] }; read: unknown };
          };
          assert.deepEqual(value.result.catalog.items, []);
          assert.deepEqual(value.result.read, {
            ok: true,
            data: { value: 99 },
          });
          assert.equal(work.state.children.length, 0);
        }),
        [testTool("test.write", true), testTool("test.read")],
      ),
  );
  it.live(
    "publishes ephemeral Sandbox output and retains persistent workspace state across parking",
    () =>
      fixture(
        Effect.gen(function* () {
          const manager = yield* WorkManager;
          const resources = yield* ResourceStore;
          const code = yield* Effect.promise(() =>
            resources.publish(
              auth.tenant,
              {
                "run.py": {
                  base64: Buffer.from(
                    'import pathlib,sys\npathlib.Path(sys.argv[1],"report.txt").write_text("forty-two")\n',
                  ).toString("base64"),
                  executable: false,
                },
              },
              defaultBounds,
            ),
          );
          const job = yield* manager.submit(
            auth,
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
            { key: "job" },
          );
          const jobOutput = output(
            yield* manager.inspect(auth, job.id, 10_000),
          );
          assert.isObject(jobOutput);
          const ensure = yield* manager.submit(
            auth,
            {
              action: "context.ensure",
              version: "v1",
              target: null,
              input: {
                owner: auth.thread,
                name: "workspace",
                spec: {
                  profile: "sandbox-linux-persistent-v1",
                  seed: code,
                  idleMs: 60_000,
                },
              },
            },
            { key: "ensure" },
          );
          const project = Schema.decodeUnknownSync(
            Schema.Struct({
              kind: Schema.Literal("sandbox"),
              id: Schema.String,
            }),
          )(output(yield* manager.inspect(auth, ensure.id, 10_000)));
          const bound = yield* manager.bind(auth, {
            key: "bind",
            context: project,
            expectedRevision: null,
          });
          const edit = yield* manager.submit(
            auth,
            {
              action: "sandbox.shell",
              version: "v1",
              target: bound,
              input: {
                command:
                  "printf retained > note.txt; printf volatile > ../tmp/volatile",
                cwd: "/workspace",
              },
            },
            { key: "edit", finish: "seal_context" },
          );
          assert.deepEqual(
            output(yield* manager.inspect(auth, edit.id, 10_000)),
            { exitCode: 0, stdout: "", stderr: "" },
          );
          const sleep = yield* manager.submit(
            auth,
            {
              action: "context.sleep",
              version: "v1",
              target: project,
              input: {},
            },
            { key: "sleep" },
          );
          output(yield* manager.inspect(auth, sleep.id, 10_000));
          const wake = yield* manager.submit(
            auth,
            {
              action: "context.wake",
              version: "v1",
              target: project,
              input: {},
            },
            { key: "wake" },
          );
          output(yield* manager.inspect(auth, wake.id, 10_000));
          const read = yield* manager.submit(
            auth,
            {
              action: "sandbox.shell",
              version: "v1",
              target: bound,
              input: {
                command: "cat note.txt; test ! -e ../tmp/volatile",
                cwd: "/workspace",
              },
            },
            { key: "read" },
          );
          assert.deepEqual(
            output(yield* manager.inspect(auth, read.id, 10_000)),
            { exitCode: 0, stdout: "retained", stderr: "" },
          );
        }),
      ),
  );
});
