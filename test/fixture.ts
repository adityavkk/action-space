import { Effect, Scope } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Auth, Work } from "../src/domain.js";
import {
  WorkManager,
  WorkJournal,
  ResourceStore,
  ActionCatalog,
  ComputeRegistry,
  PlatformSettings,
} from "../src/platform.js";
import { platformLayer } from "../src/runtime.js";
import { assert } from "@effect/vitest";
export const principal: Auth = {
  tenant: "a",
  actor: "agent",
  thread: "demo",
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
type Services =
  | WorkManager
  | WorkJournal
  | ResourceStore
  | ActionCatalog
  | ComputeRegistry
  | PlatformSettings
  | Scope.Scope;
export function fixture<A, E>(
  program: Effect.Effect<A, E, Services>,
  options: Partial<Parameters<typeof platformLayer>[0]> = {},
) {
  return Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "action-space-test-")),
    );
    return yield* Effect.scoped(
      program.pipe(
        Effect.provide(
          platformLayer({ directory, principals: [principal], ...options }),
        ),
      ),
    ).pipe(
      Effect.ensuring(
        Effect.promise(() => rm(directory, { recursive: true, force: true })),
      ),
    );
  });
}
export function output(work: Work): unknown {
  assert.equal(work.state.phase, "settled", JSON.stringify(work.state));
  if (work.state.phase !== "settled" || work.state.outcome.kind !== "completed")
    throw new Error(JSON.stringify(work.state));
  return work.state.outcome.output;
}
