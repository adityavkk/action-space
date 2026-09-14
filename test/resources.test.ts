import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { defaultBounds } from "../src/domain.js";
import { ActionCatalog, ResourceStore } from "../src/platform.js";
import { validateTree } from "../src/resources.js";
import {
  InvocationSchema,
  ActionOutputs,
  CandidateSchema,
} from "../src/schemas.js";
import { localCandidate } from "../src/runtime.js";
import { fixture, principal } from "./fixture.js";

it("rejects invalid action/target/result combinations at runtime as well as compile time", () => {
  assert.throws(() =>
    Schema.decodeUnknownSync(InvocationSchema)({
      action: "code.execute",
      version: "v1",
      target: { kind: "sandbox", id: "p" },
      input: { code: "return 1" },
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(ActionOutputs["sandbox.run"])({
      result: 1,
      logs: [],
      artifacts: [],
    }),
  );
  const candidate = localCandidate(
    "isolate",
    { capability: "code_execution", lifecycle: "invocation" },
    ["code-js-v1"],
  );
  assert.doesNotThrow(() =>
    Schema.decodeUnknownSync(CandidateSchema)(candidate),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(CandidateSchema)({
      ...candidate,
      lifecycle: "persistent",
    }),
  );
});
it("enforces file-tree count, byte, traversal and overlapping-path boundaries", () => {
  const file = { base64: "YWJj", executable: false };
  validateTree({ "a.txt": file }, { treeBytes: 3, treeFiles: 1 });
  assert.throws(() =>
    validateTree({ "a.txt": file }, { treeBytes: 2, treeFiles: 1 }),
  );
  assert.throws(() =>
    validateTree(
      { "a.txt": file, "b.txt": file },
      { treeBytes: 6, treeFiles: 1 },
    ),
  );
  for (const name of ["../outside", "/absolute", "a/../../outside"])
    assert.throws(() => validateTree({ [name]: file }, defaultBounds));
  assert.throws(() => validateTree({ a: file, "a/b": file }, defaultBounds));
});
it.live(
  "broker resource publication honors configured host bounds rather than defaults",
  () =>
    fixture(
      Effect.gen(function* () {
        const catalog = yield* ActionCatalog;
        const tool = catalog.tool("resources.publish");
        const context = { auth: principal, workId: "bounds-test" };
        const accepted = yield* tool.invoke(
          { "a.txt": { base64: "YWJj", executable: false } },
          context,
        );
        assert.equal(
          Schema.decodeUnknownSync(ActionOutputs["context.seal"].fields.tree)(
            accepted,
          ).kind,
          "file_tree",
        );
        const denied = yield* tool
          .invoke(
            { "a.txt": { base64: "YWJjZA==", executable: false } },
            context,
          )
          .pipe(Effect.flip);
        assert.equal(denied._tag === "Fault" && denied.code, "TREE_BYTE_LIMIT");
      }),
      { settings: { bounds: { ...defaultBounds, treeBytes: 3 } } },
    ),
);
it.live(
  "deduplicates immutable blobs without transferring authority between tenants",
  () =>
    fixture(
      Effect.gen(function* () {
        const resources = yield* ResourceStore;
        const files = { "a.txt": { base64: "YWJj", executable: false } };
        const tree = yield* Effect.promise(() =>
          resources.publish(principal.tenant, files, defaultBounds),
        );
        const duplicate = yield* Effect.promise(() =>
          resources.publish(principal.tenant, files, defaultBounds),
        );
        assert.deepEqual(tree, duplicate);
        const denied = yield* Effect.tryPromise({
          try: () => resources.read("other-tenant", tree),
          catch: (error) => error,
        }).pipe(Effect.flip);
        assert.instanceOf(denied, Error);
        assert.deepEqual(
          yield* Effect.promise(() => resources.read(principal.tenant, tree)),
          files,
        );
      }),
    ),
);
