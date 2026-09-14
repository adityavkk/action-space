import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Deferred, Fiber } from "effect";
import { QuickJSBackend } from "../src/backends/quickjs.js";
import {
  defaultBounds,
  Fault,
  Interrupt,
  Uncertain,
  type Bounds,
  type Json,
} from "../src/domain.js";
const backend = new QuickJSBackend();
const execute = (
  code: string,
  bridge: (path: string, args: Json) => Promise<Json> = async () => null,
  bounds: Partial<Bounds> = {},
) =>
  backend.execute({
    code,
    bridge,
    bounds: { ...defaultBounds, ...bounds },
    deadline: Date.now() + (bounds.wallMs ?? 10_000),
    signal: new AbortController().signal,
    log: async () => {},
  });
describe("QuickJS real disposable WASM execution", () => {
  it.live(
    "returns JSON, keeps logs, has no ambient authority and resets heaps",
    () =>
      Effect.gen(function* () {
        const result = yield* execute(
          'globalThis.marker=42; console.log("hello", 7); return {answer:6*7, ambient:[typeof process,typeof require,typeof fetch]};',
        );
        assert.deepEqual(result.result, {
          answer: 42,
          ambient: ["undefined", "undefined", "undefined"],
        });
        assert.deepEqual(result.logs, ["[log] hello 7"]);
        assert.equal(
          (yield* execute("return typeof marker")).result,
          "undefined",
        );
        assert.equal((yield* execute("21 + 21")).result, null);
      }),
  );
  it.live(
    "preserves multibyte tool arguments and results across IPC chunks",
    () =>
      Effect.gen(function* () {
        const expected = "x" + "界😀".repeat(18000);
        const result = yield* execute(
          'const r=await tools.test.echo({text:"x"+"界😀".repeat(18000)});return r.data.text;',
          async (_path, args) => {
            assert.deepEqual(args, { text: expected });
            return { ok: true, data: args };
          },
          { argumentBytes: 200000, resultBytes: 200000 },
        );
        assert.equal(result.result, expected);
      }),
  );
  it.live("overlaps asynchronous calls and preserves input order", () =>
    Effect.gen(function* () {
      const waiting: Array<(value: Json) => void> = [];
      const names: string[] = [];
      const result = yield* execute(
        'return await Promise.all([tools["test.a"]({n:3}),tools.test.b({n:5})]);',
        (path) =>
          new Promise((resolve) => {
            names.push(path);
            waiting.push(resolve);
            if (waiting.length === 2) {
              waiting[1]?.({ ok: true, data: 35 });
              waiting[0]?.({ ok: true, data: 21 });
            }
          }),
      );
      assert.deepEqual(names, ["test.a", "test.b"]);
      assert.deepEqual(result.result, [
        { ok: true, data: 21 },
        { ok: true, data: 35 },
      ]);
    }),
  );
  it.live(
    "enforces cumulative CPU independently of wall time across tool waits",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const result = yield* execute(
          'for(let i=0;i<40;i++){const end=Date.now()+70;while(Date.now()<end){};await tools.test.tick({});}return "cpu-not-enforced"',
          async () => {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { ok: true, data: null };
          },
          { wallMs: 10000, cpuMs: 400 },
        ).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(result));
        assert.isAtLeast(calls, 1);
        assert.isBelow(calls, 25); // A deadline-only or per-tool-reset budget completes all forty.
      }),
  );
  it.live(
    "the actual Executor instance exposes no management tools or ambient credentials",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const result = yield* backend.execute({
          code: 'let denied=false;try{const result=await tools.executor.coreTools.oauth.probe({url:"https://example.com"});denied=result.ok===false}catch{denied=true}return {denied,ambient:[typeof process,typeof require,typeof fetch,typeof emit]};',
          tools: [], // Use the SDK/execution path, not the standalone runtime test hook.
          bounds: defaultBounds,
          deadline: Date.now() + 10000,
          signal: new AbortController().signal,
          bridge: async () => {
            calls++;
            return null;
          },
          log: async () => {},
        });
        assert.deepEqual(result.result, {
          denied: true,
          ambient: ["undefined", "undefined", "undefined", "undefined"],
        });
        assert.equal(calls, 0);
      }),
  );
  it.live(
    "does not hang on an unawaited, unresolved broker call after return",
    () =>
      Effect.gen(function* () {
        let admitted = 0;
        const result = yield* execute(
          "tools.test.hang({});return 7",
          async () => {
            admitted++;
            return new Promise(() => {});
          },
          { wallMs: 1500 },
        ).pipe(Effect.flip);
        assert.equal(admitted, 1);
        assert.instanceOf(result, Uncertain);
      }),
  );
  it.live(
    "cancels a suspended runtime without claiming an unresolved external call was rolled back",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const called = yield* Deferred.make<void>();
          const controller = new AbortController();
          const fiber = yield* backend
            .execute({
              code: "await tools.test.wait({});return 7",
              bounds: defaultBounds,
              deadline: Date.now() + 10_000,
              signal: controller.signal,
              bridge: async () => {
                await Effect.runPromise(Deferred.succeed(called, undefined));
                return new Promise(() => {});
              },
              log: async () => {},
            })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(called);
          controller.abort();
          const error = yield* Fiber.join(fiber).pipe(Effect.flip);
          assert.instanceOf(error, Uncertain);
        }),
      ),
  );
  it.live(
    "enforces allocator, output and log limits on both sides of the boundary",
    () =>
      Effect.gen(function* () {
        assert.equal(
          (yield* execute('return "1234"', undefined, { resultBytes: 6 }))
            .result,
          "1234",
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              execute('return "12345"', undefined, { resultBytes: 6 }),
            ),
          ),
        );
        assert.equal(
          (yield* execute("return 1", undefined, {
            heapBytes: 8 * 1024 * 1024,
          })).result,
          1,
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              execute("return new Array(10_000_000).fill(7)", undefined, {
                heapBytes: 8 * 1024 * 1024,
              }),
            ),
          ),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              execute('console.log("12345");return 1', undefined, {
                logBytes: 4,
              }),
            ),
          ),
        );
      }),
  );
  for (const code of [
    "while(true){}",
    "await new Promise(()=>{})",
    "await (async function loop(){await 0;return loop()})()",
  ]) {
    it.live(`bounds execution: ${code.slice(0, 35)}`, () =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(
          execute(code, undefined, { wallMs: 1500, cpuMs: 500 }),
        );
        assert.isTrue(Exit.isFailure(result));
      }),
    );
  }
  for (const code of [
    "return {x:undefined}",
    "return NaN",
    "const x={};x.x=x;return x",
    "return Object.keys(tools)",
    "return tools.constructor",
    'return await import("node:fs")',
    "};globalThis.oops=1;{",
    "const x:number=1;return x",
  ]) {
    it.live(`rejects invalid guest behavior: ${code.slice(0, 40)}`, () =>
      Effect.gen(function* () {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(execute(code))));
      }),
    );
  }
});
