import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkJournal, WorkManager, ResourceStore } from "../src/platform.js";
import {
  defaultBounds,
  Fault,
  Uncertain,
  type Invocation,
} from "../src/domain.js";
import { platformLayer, localCandidate } from "../src/runtime.js";
import { defineTool } from "../src/catalog.js";
import type { BlobStore } from "../src/resources.js";
import type {
  EphemeralSandboxBackend,
  PersistentSandboxBackend,
} from "../src/backends/contracts.js";
import { fixture, output, principal } from "./fixture.js";
import { SandboxRef } from "../src/schemas.js";
import { Journal } from "../src/journal.js";
import { PGlite } from "@electric-sql/pglite";

const composed = (code: string): Invocation => ({
  action: "code.execute",
  version: "v1",
  target: null,
  input: { code },
});
describe("failure and recovery boundaries", () => {
  it.live(
    "refuses the retired wire format without migrating or deleting its evidence",
    () =>
      Effect.promise(async () => {
        const directory = await mkdtemp(join(tmpdir(), "action-space-legacy-"));
        const evidence = {
          demand: { offering: "project" },
          frozen: "keep-exactly",
        };
        try {
          const old = new PGlite(directory);
          await old.exec("CREATE TABLE work(data jsonb)");
          await old.query("INSERT INTO work VALUES ($1)", [
            JSON.stringify(evidence),
          ]);
          await old.close();
          let failure: unknown;
          try {
            await Journal.open(directory);
          } catch (error) {
            failure = error;
          }
          assert.instanceOf(failure, Fault);
          assert.equal((failure as Fault).code, "LEGACY_JOURNAL");
          const preserved = new PGlite(directory);
          try {
            assert.deepEqual(
              (
                await preserved.query<{ data: unknown }>(
                  "SELECT data FROM work",
                )
              ).rows[0]?.data,
              evidence,
            );
            assert.equal(
              (
                await preserved.query<{ name: string | null }>(
                  "SELECT to_regclass('public.outbox')::text AS name",
                )
              ).rows[0]?.name,
              null,
            );
          } finally {
            await preserved.close();
          }
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }),
  );
  it.live(
    "a new coordinator retrieves completed Work and reconciles an orphan without replay",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "action-space-restart-")),
        );
        const layer = () =>
          platformLayer({
            directory,
            principals: [principal],
            settings: { autoRun: false },
          });
        let doneId = "";
        let orphanId = "";
        yield* Effect.gen(function* () {
          const manager = yield* WorkManager;
          doneId = (yield* manager.submit(principal, composed("return 19"), {
            key: "done",
          })).id;
          const claimed = yield* manager.claim();
          if (!claimed) throw new Error("missing claim");
          yield* manager.dispatch(claimed);
          orphanId = (yield* manager.submit(principal, composed("return 23"), {
            key: "orphan",
          })).id;
          yield* manager.claim();
        }).pipe(Effect.provide(layer()));
        yield* Effect.gen(function* () {
          const manager = yield* WorkManager;
          assert.deepEqual(output(yield* manager.inspect(principal, doneId)), {
            result: 19,
            logs: [],
            artifacts: [],
          });
          assert.equal(
            (yield* manager.submit(principal, composed("return 19"), {
              key: "done",
            })).id,
            doneId,
          );
          const orphan = yield* manager.inspect(principal, orphanId);
          assert.equal(orphan.state.phase, "reconciling");
          assert.equal(orphan.gate, false);
          assert.equal(orphan.lease?.generation, 2);
          assert.equal(yield* manager.claim(), null);
        }).pipe(
          Effect.provide(layer()),
          Effect.ensuring(
            Effect.promise(() =>
              rm(directory, { recursive: true, force: true }),
            ),
          ),
        );
      }),
  );
  it.live("deduplicates before re-resolving a changed thread binding", () =>
    fixture(
      Effect.gen(function* () {
        const manager = yield* WorkManager;
        const resources = yield* ResourceStore;
        const seed = yield* Effect.promise(() =>
          resources.publish(principal.tenant, {}, defaultBounds),
        );
        const contexts = [];
        for (const name of ["a", "b"]) {
          const ref = yield* manager.submit(
            principal,
            {
              action: "context.ensure",
              version: "v1",
              target: null,
              input: {
                owner: principal.thread,
                name,
                spec: {
                  profile: "sandbox-linux-persistent-v1",
                  seed,
                  idleMs: 60_000,
                },
              },
            },
            { key: name },
          );
          contexts.push(
            Schema.decodeUnknownSync(SandboxRef)(
              output(yield* manager.inspect(principal, ref.id, 10_000)),
            ),
          );
        }
        const first = contexts[0];
        const second = contexts[1];
        if (!first || !second) throw new Error("context setup");
        const bound = yield* manager.bind(principal, {
          context: first,
          expectedRevision: null,
          key: "bind-a",
        });
        const call: Invocation = {
          action: "sandbox.shell",
          version: "v1",
          target: bound,
          input: { command: "printf old-context", cwd: "/workspace" },
        };
        const original = yield* manager.submit(principal, call, {
          key: "stable",
        });
        yield* manager.inspect(principal, original.id, 10_000);
        yield* manager.bind(principal, {
          context: second,
          expectedRevision: 1,
          key: "bind-b",
        });
        assert.equal(
          (yield* manager.submit(principal, call, { key: "stable" })).id,
          original.id,
        );
        const changed = yield* manager
          .submit(principal, call, { key: "new" })
          .pipe(Effect.flip);
        assert.equal(
          changed instanceof Fault ? changed.code : "",
          "BINDING_CHANGED",
        );
        assert.equal(
          (yield* manager.inspect(principal, original.id)).target?.id,
          first.id,
        );
      }),
    ),
  );
  it.live(
    "retains observed effect diagnostics after source failure and never replays uncertain writes",
    () => {
      let effects = 0;
      const write = defineTool({
        path: "test.write",
        version: "v1",
        description: "fault fixture",
        effect: "write",
        grant: "test",
        approval: false,
        input: Schema.Struct({ uncertain: Schema.Boolean }),
        output: Schema.Struct({ n: Schema.Number }),
        invoke: Effect.fn("Fixture.write")(function* (input) {
          effects++;
          if (input.uncertain)
            return yield* new Uncertain("response lost after commit");
          return { n: effects };
        }),
      });
      return fixture(
        Effect.gen(function* () {
          const manager = yield* WorkManager;
          const p = yield* manager.execute(
            principal,
            {
              code: 'await tools.test.write({uncertain:false});throw new Error("parent failed")',
            },
            "parent-fail",
          );
          const failed = yield* manager.inspect(principal, p.work.id, 10_000);
          assert.equal(failed.state.phase, "settled");
          assert.equal(failed.state.children.length, 0);
          assert.equal(failed.calls, 1);
          assert.equal(effects, 1);
          const journal = yield* WorkJournal;
          const observations = yield* Effect.promise(() =>
            journal.transaction((tx) =>
              tx.sql.query(
                "SELECT data FROM event WHERE work_id=$1 AND data->'tool'->>'phase'='observed'",
                [p.work.id],
              ),
            ),
          );
          assert.equal(observations.rows.length, 1);
          const u = yield* manager.execute(
            principal,
            {
              code: "try{await tools.test.write({uncertain:true})}catch{};return await tools.test.write({uncertain:false})",
            },
            "uncertain",
          );
          const parent = yield* manager.inspect(principal, u.work.id, 10_000);
          assert.equal(parent.state.children.length, 0);
          assert.equal(parent.state.phase, "reconciling");
          assert.equal(effects, 2);
        }),
        { tools: [write] },
      );
    },
  );
  it.live(
    "publication and release failures retry finalization, never native execution",
    () => {
      const bytes = new Map<string, Uint8Array>();
      let failPublication = false;
      let failRelease = true;
      let runs = 0;
      let releases = 0;
      const blobs: BlobStore = {
        put: async (key, value) => {
          if (failPublication) throw new Error("object store down");
          bytes.set(key, value);
        },
        get: async (key) => {
          const value = bytes.get(key);
          if (!value) throw new Error("missing");
          return value;
        },
      };
      const backend: EphemeralSandboxBackend = {
        capability: "sandbox",
        lifecycle: "ephemeral",
        initialize: () => Effect.void,
        create: (r) =>
          Effect.succeed({
            provider: "fixture",
            id: r.operation,
            generation: r.generation,
            data: {},
          }),
        upload: () => Effect.void,
        run: () =>
          Effect.sync(() => {
            runs++;
            return { exitCode: 0, stdout: "execution-evidence", stderr: "" };
          }),
        download: () =>
          Effect.succeed({
            "result.txt": { base64: "NDI=", executable: false },
          }),
        release: () =>
          Effect.gen(function* () {
            releases++;
            if (failRelease) return yield* new Fault("RELEASE_UNAVAILABLE");
          }),
      };
      return fixture(
        Effect.gen(function* () {
          const manager = yield* WorkManager;
          const resources = yield* ResourceStore;
          const journal = yield* WorkJournal;
          const code = yield* Effect.promise(() =>
            resources.publish(principal.tenant, {}, defaultBounds),
          );
          const ref = yield* manager.submit(
            principal,
            {
              action: "sandbox.run",
              version: "v1",
              target: null,
              input: {
                profile: "sandbox-python-ephemeral-v1",
                code,
                inputs: {},
                argv: ["test"],
                outputs: { required: ["result.txt"] },
              },
            },
            { key: "job" },
          );
          const work = yield* manager.claim();
          if (!work) throw new Error("no placement");
          failPublication = true;
          yield* manager.dispatch(work);
          yield* manager.pass();
          assert.equal(
            (yield* manager.inspect(principal, ref.id)).state.phase,
            "finalizing",
          );
          assert.equal(runs, 1);
          assert.equal(releases, 0);
          failPublication = false;
          yield* Effect.all([manager.pass(), manager.pass()], {
            concurrency: "unbounded",
          });
          assert.isObject(output(yield* manager.inspect(principal, ref.id)));
          assert.equal(runs, 1);
          const rows = yield* Effect.promise(() =>
            journal.transaction((tx) =>
              tx.sql.query<{ release_error: string; released: boolean }>(
                "SELECT release_error,released FROM job_allocation",
              ),
            ),
          );
          assert.equal(rows.rows[0]?.released, false);
          assert.equal(rows.rows[0]?.release_error, "Fault");
          failRelease = false;
          yield* manager.pass();
          assert.equal(
            (yield* Effect.promise(() =>
              journal.transaction((tx) =>
                tx.sql.query<{ released: boolean }>(
                  "SELECT released FROM job_allocation",
                ),
              ),
            )).rows[0]?.released,
            true,
          );
          assert.equal(runs, 1);
        }),
        {
          blobs,
          settings: { autoRun: false },
          registrations: [
            {
              candidate: localCandidate(
                "fixture-ephemeral",
                { capability: "sandbox", lifecycle: "ephemeral" },
                ["sandbox-python-ephemeral-v1"],
              ),
              backend,
            },
          ],
        },
      );
    },
  );
  it.live(
    "seal failure preserves execution output and explicit seal only retries capture",
    () => {
      let captures = 0;
      let runs = 0;
      const backend: PersistentSandboxBackend = {
        capability: "sandbox",
        lifecycle: "persistent",
        initialize: () => Effect.void,
        create: (r) =>
          Effect.succeed({
            provider: "fixture",
            id: r.operation,
            generation: 1,
            data: {},
          }),
        upload: () => Effect.void,
        run: () =>
          Effect.sync(() => {
            runs++;
            return { exitCode: 0, stdout: "retained-execution", stderr: "" };
          }),
        download: () =>
          Effect.gen(function* () {
            captures++;
            if (captures === 1) return yield* new Fault("CAPTURE_FAILED");
            return {};
          }),
        park: () => Effect.void,
        wake: (a, generation) => Effect.succeed({ ...a, generation }),
      };
      return fixture(
        Effect.gen(function* () {
          const manager = yield* WorkManager;
          const resources = yield* ResourceStore;
          const seed = yield* Effect.promise(() =>
            resources.publish(principal.tenant, {}, defaultBounds),
          );
          const ensure = yield* manager.submit(
            principal,
            {
              action: "context.ensure",
              version: "v1",
              target: null,
              input: {
                owner: principal.thread,
                name: "seal",
                spec: {
                  profile: "sandbox-linux-persistent-v1",
                  seed,
                  idleMs: 60_000,
                },
              },
            },
            { key: "context" },
          );
          const target = Schema.decodeUnknownSync(SandboxRef)(
            output(yield* manager.inspect(principal, ensure.id, 10_000)),
          );
          const shell = yield* manager.submit(
            principal,
            {
              action: "sandbox.shell",
              version: "v1",
              target,
              input: { command: "test", cwd: "/workspace" },
            },
            { key: "mutate", finish: "seal_context" },
          );
          const failed = yield* manager.inspect(principal, shell.id, 10_000);
          assert.equal(
            failed.state.phase === "settled" && failed.state.outcome.kind,
            "seal_failed",
          );
          if (
            failed.state.phase === "settled" &&
            failed.state.outcome.kind === "seal_failed"
          )
            assert.deepEqual(failed.state.outcome.output, {
              exitCode: 0,
              stdout: "retained-execution",
              stderr: "",
            });
          const retry = yield* manager.submit(
            principal,
            { action: "context.seal", version: "v1", target, input: {} },
            { key: "retry-capture" },
          );
          output(yield* manager.inspect(principal, retry.id, 10_000));
          assert.equal(runs, 1);
          assert.equal(captures, 2);
        }),
        {
          registrations: [
            {
              candidate: localCandidate(
                "fixture-persistent",
                { capability: "sandbox", lifecycle: "persistent" },
                ["sandbox-linux-persistent-v1"],
              ),
              backend,
            },
          ],
        },
      );
    },
  );
});
