import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { selectPlacement, fairOrder } from "../src/scheduler.js";
import { localCandidate } from "../src/runtime.js";
import type { Demand } from "../src/domain.js";
import { WorkJournal, WorkManager } from "../src/platform.js";
import { fixture, principal } from "./fixture.js";
const demand: Demand = {
  capability: "sandbox",
  lifecycle: "persistent",
  profile: "workspace",
  region: "local",
  trust: "development",
  deadline: 10_000,
  memoryBytes: 100,
  maxCost: null,
  warm: false,
  stickyBackend: null,
};
const candidate = (id: string, cost: number | null) => ({
  ...localCandidate(id, { capability: "sandbox", lifecycle: "persistent" }, [
    "workspace",
  ]),
  estimate: { cost, startupMs: 5000, warmStartupMs: 10, transferMs: 100 },
});
describe("eligibility before optimization", () => {
  it("rejects cheap incompatible providers and exposes the rejection", () => {
    const wrong = {
      ...candidate("cheap-isolate", 0),
      capability: "code_execution" as const,
      lifecycle: "invocation" as const,
      profiles: ["stateless"],
    };
    const placement = selectPlacement(
      demand,
      [wrong, candidate("native", 5)],
      {},
      0,
    );
    assert.equal(placement.chosen?.candidate.id, "native");
    assert.deepEqual(placement.rejected, [
      {
        provider: "cheap-isolate",
        reasons: ["capability", "lifecycle", "profile/continuity"],
      },
    ]);
  });
  it("rejects an ephemeral Sandbox even when its profile name matches a persistent requirement", () => {
    const result = selectPlacement(
      demand,
      [
        { ...candidate("cheap", 0), lifecycle: "ephemeral" },
        candidate("retained", 5),
      ],
      {},
      0,
    );
    assert.equal(result.chosen?.candidate.id, "retained");
    assert.deepEqual(result.rejected, [
      { provider: "cheap", reasons: ["lifecycle"] },
    ]);
  });
  it("reuses the warm Context but never replaces sticky state to chase a lower price", () => {
    const placement = selectPlacement(
      { ...demand, stickyBackend: "retained", warm: true },
      [candidate("retained", 20), candidate("cheap", 0)],
      {},
      0,
    );
    assert.equal(placement.chosen?.estimatedMs, 10);
    assert.equal(placement.chosen?.warm, true);
    assert.deepEqual(placement.rejected, [
      { provider: "cheap", reasons: ["context affinity"] },
    ]);
    const unavailable = selectPlacement(
      { ...demand, stickyBackend: "retained" },
      [
        { ...candidate("retained", 20), available: false },
        candidate("cheap", 0),
      ],
      {},
      0,
    );
    assert.equal(unavailable.chosen, null);
  });
  it("enforces budget, deadline, capacity, locality, trust and memory instead of merely penalizing them", () => {
    assert.include(
      selectPlacement({ ...demand, maxCost: 4 }, [candidate("x", 5)], {}, 0)
        .rejected[0]?.reasons ?? [],
      "budget",
    );
    assert.include(
      selectPlacement({ ...demand, maxCost: 4 }, [candidate("x", null)], {}, 0)
        .rejected[0]?.reasons ?? [],
      "budget",
    );
    assert.include(
      selectPlacement({ ...demand, deadline: 5100 }, [candidate("x", 1)], {}, 0)
        .rejected[0]?.reasons ?? [],
      "deadline",
    );
    assert.equal(
      selectPlacement({ ...demand, deadline: 5101 }, [candidate("x", 1)], {}, 0)
        .chosen?.candidate.id,
      "x",
    );
    const x = {
      ...candidate("x", 1),
      capacity: 1,
      maxMemoryBytes: 99,
      region: "elsewhere",
    };
    assert.deepEqual(
      selectPlacement({ ...demand, trust: "qualified" }, [x], { x: 1 }, 0)
        .rejected[0]?.reasons,
      ["locality", "isolation not qualified", "capacity", "memory"],
    );
  });
  it("uses configurable estimates and honestly reports unknown pricing", () => {
    const result = selectPlacement(
      demand,
      [candidate("unknown", null), candidate("known", 9)],
      {},
      0,
    );
    assert.equal(result.chosen?.candidate.id, "known");
    assert.deepEqual(result.considered[1]?.unknowns, ["cost"]);
    assert.equal(
      selectPlacement(
        demand,
        [candidate("unknown", null), candidate("known", 9)],
        {},
        0,
        { cost: 1, latency: 0, unknown: 0 },
      ).chosen?.candidate.id,
      "unknown",
    );
  });
  it("rotates tenants without changing FIFO ordering within a tenant", () => {
    assert.deepEqual(
      fairOrder(
        [
          { tenant: "a", created: 3 },
          { tenant: "b", created: 2 },
          { tenant: "a", created: 1 },
        ],
        "a",
      ),
      [
        { tenant: "b", created: 2 },
        { tenant: "a", created: 1 },
        { tenant: "a", created: 3 },
      ],
    );
  });
  it.live("competing atomic claims reserve exactly one attempt", () =>
    fixture(
      Effect.gen(function* () {
        const manager = yield* WorkManager;
        const work = yield* manager.submit(
          principal,
          {
            action: "code.execute",
            version: "v1",
            target: null,
            input: { code: "return 7" },
          },
          { key: "one" },
        );
        const claims = yield* Effect.all(
          Array.from({ length: 8 }, () => manager.claim()),
          { concurrency: "unbounded" },
        );
        assert.equal(claims.filter(Boolean).length, 1);
        assert.equal(claims.find(Boolean)?.id, work.id);
        assert.equal(
          (yield* manager.inspect(principal, work.id)).lease?.generation,
          1,
        );
      }),
      { settings: { autoRun: false } },
    ),
  );
  it.live(
    "admission between snapshot and reservation waits instead of being falsely denied",
    () =>
      fixture(
        Effect.gen(function* () {
          const manager = yield* WorkManager;
          const journal = yield* WorkJournal;
          const transaction = journal.transaction.bind(journal);
          let newId = "";
          journal.transaction = async (fn) => {
            journal.transaction = transaction;
            const snapshot = await transaction(fn);
            // Deterministic barrier: commit new Work after claim's snapshot but before its reservation.
            const ref = await Effect.runPromise(
              manager.submit(
                principal,
                {
                  action: "code.execute",
                  version: "v1",
                  target: null,
                  input: { code: "return 31" },
                },
                { key: "concurrent-admission" },
              ),
            );
            newId = ref.id;
            return snapshot;
          };
          assert.equal(yield* manager.claim(), null);
          assert.equal(
            (yield* manager.inspect(principal, newId)).state.phase,
            "queued",
          );
          assert.equal((yield* manager.claim())?.id, newId);
        }),
        { settings: { autoRun: false } },
      ),
  );
  it.live("tenant limits leave capacity for another tenant", () =>
    fixture(
      Effect.gen(function* () {
        const manager = yield* WorkManager;
        const b = { ...principal, tenant: "b" };
        for (const [auth, key] of [
          [principal, "a1"],
          [principal, "a2"],
          [b, "b1"],
        ] as const)
          yield* manager.submit(
            auth,
            {
              action: "code.execute",
              version: "v1",
              target: null,
              input: { code: "return 7" },
            },
            { key },
          );
        assert.equal((yield* manager.claim())?.key, "a1");
        assert.equal((yield* manager.claim())?.key, "b1");
        assert.equal(yield* manager.claim(), null);
      }),
      {
        principals: [principal, { ...principal, tenant: "b" }],
        settings: { autoRun: false, tenantConcurrency: 1 },
      },
    ),
  );
  it.live(
    "duplicate dispatch deliveries execute only once, and cancellation before delivery executes nothing",
    () => {
      let runs = 0;
      return fixture(
        Effect.gen(function* () {
          const manager = yield* WorkManager;
          yield* manager.submit(
            principal,
            {
              action: "code.execute",
              version: "v1",
              target: null,
              input: { code: "return 1" },
            },
            { key: "delivered-twice" },
          );
          const claimed = yield* manager.claim();
          if (!claimed) throw new Error("missing reservation");
          yield* Effect.all(
            [manager.dispatch(claimed), manager.dispatch(claimed)],
            { concurrency: "unbounded" },
          );
          assert.equal(runs, 1);
          const ref = yield* manager.submit(
            principal,
            {
              action: "code.execute",
              version: "v1",
              target: null,
              input: { code: "return 1" },
            },
            { key: "cancel-before-delivery" },
          );
          const cancelled = yield* manager.claim();
          if (!cancelled) throw new Error("missing reservation");
          yield* manager.cancel(principal, ref.id);
          yield* manager.dispatch(cancelled);
          const work = yield* manager.inspect(principal, ref.id);
          assert.equal(
            work.state.phase === "settled" && work.state.outcome.kind,
            "cancelled",
          );
          assert.equal(runs, 1);
        }),
        {
          settings: { autoRun: false },
          registrations: [
            {
              candidate: localCandidate(
                "counter",
                { capability: "code_execution", lifecycle: "invocation" },
                ["code-js-v1"],
              ),
              backend: {
                capability: "code_execution",
                lifecycle: "invocation",
                execute: () =>
                  Effect.sync(() => ({
                    result: ++runs,
                    logs: [],
                    artifacts: [],
                  })),
              },
            },
          ],
        },
      );
    },
  );
  it.effect(
    "queue deadline is an enforced boundary independent of observation waiting",
    () =>
      fixture(
        Effect.gen(function* () {
          const manager = yield* WorkManager;
          const ref = yield* manager.submit(
            principal,
            {
              action: "code.execute",
              version: "v1",
              target: null,
              input: { code: "return 1" },
            },
            { key: "deadline" },
          );
          yield* TestClock.adjust(10_001);
          assert.equal(yield* manager.claim(), null);
          const work = yield* manager.inspect(principal, ref.id);
          assert.equal(
            work.state.phase === "settled" &&
              work.state.outcome.kind === "failed" &&
              work.state.outcome.code,
            "QUEUE_DEADLINE",
          );
        }),
        { settings: { autoRun: false } },
      ),
  );
});
