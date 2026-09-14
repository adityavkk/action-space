import { assert, it } from "@effect/vitest";
import { rejects } from "node:assert/strict";
import { Effect } from "effect";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vi } from "vitest";
import { initializeSecrets } from "../scripts/container.js";
import { Journal } from "../src/journal.js";
import { Fault } from "../src/domain.js";
import { WorkJournal } from "../src/platform.js";
import { serve } from "../src/http.js";
import { BridgeRegistry } from "../src/backends/cloudflare.js";
import { fixture } from "./fixture.js";

it.live(
  "initializes private independent secrets once and refuses to overwrite malformed existing credentials",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "action-space-secrets-")),
      );
      yield* Effect.gen(function* () {
        yield* initializeSecrets(directory);
        const token = yield* Effect.promise(() =>
          readFile(join(directory, "api-token"), "utf8"),
        );
        const password = yield* Effect.promise(() =>
          readFile(join(directory, "postgres-password"), "utf8"),
        );
        assert.match(token.trim(), /^[a-f0-9]{64}$/);
        assert.notEqual(token, password);
        assert.equal(
          (yield* Effect.promise(() => stat(join(directory, "api-token"))))
            .mode & 0o777,
          0o600,
        );
        yield* initializeSecrets(directory);
        assert.equal(
          yield* Effect.promise(() =>
            readFile(join(directory, "api-token"), "utf8"),
          ),
          token,
        );
        yield* Effect.promise(() =>
          writeFile(join(directory, "api-token"), "interrupted-write"),
        );
        const failure = yield* initializeSecrets(directory).pipe(Effect.flip);
        if (!(failure instanceof Fault)) throw failure;
        assert.equal(failure.code, "INVALID_LOCAL_SECRET");
        assert.equal(
          yield* Effect.promise(() =>
            readFile(join(directory, "api-token"), "utf8"),
          ),
          "interrupted-write",
        );
        assert.equal(
          yield* Effect.promise(() =>
            readFile(join(directory, "postgres-password"), "utf8"),
          ),
          password,
        );
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
);

it.live(
  "rolls back failed schema initialization and releases the database for repair",
  () =>
    Effect.promise(async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "action-space-migration-"),
      );
      try {
        const existing = new PGlite(directory);
        // Migration's final INSERT must fail, after its earlier CREATE TABLE statements.
        await existing.exec("CREATE TABLE scheduler (different_column text)");
        await existing.close();
        await rejects(Journal.open(directory), /column "id"/);
        const repaired = new PGlite(directory);
        assert.equal(
          (
            await repaired.query<{ name: string | null }>(
              "SELECT to_regclass('public.work')::text AS name",
            )
          ).rows[0]?.name,
          null,
        );
        await repaired.exec("DROP TABLE scheduler");
        await repaired.close();
        const first = await Journal.open(directory);
        await first.close();
        const second = await Journal.open(directory);
        await second.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

it.live(
  "health reports database failure instead of advertising a ready listener",
  () =>
    fixture(
      Effect.gen(function* () {
        const journal = yield* WorkJournal;
        const api = yield* serve({
          port: 0,
          credentials: new Map(),
          bridges: new BridgeRegistry(),
        });
        const healthy = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${api.port}/health`),
        );
        assert.equal(healthy.status, 200);
        const unavailable = vi
          .spyOn(journal, "transaction")
          .mockRejectedValue(new Error("connection lost"));
        yield* Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            fetch(`http://127.0.0.1:${api.port}/health`),
          );
          assert.equal(response.status, 503);
          assert.deepEqual(yield* Effect.promise(() => response.json()), {
            service: "Action Space",
            ready: false,
          });
        }).pipe(Effect.ensuring(Effect.sync(() => unavailable.mockRestore())));
      }),
      { settings: { autoRun: false } },
    ),
);
