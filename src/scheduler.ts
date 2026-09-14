import type { Candidate, Demand, EligiblePlan, Placement } from "./domain.js";

/** Eligibility is mandatory; weights express operator preferences, not vendor prices. */
export function selectPlacement(
  demand: Demand,
  candidates: Candidate[],
  used: Record<string, number>,
  now: number,
  weights = { cost: 1, latency: 0.001, unknown: 1000 },
): Placement {
  const considered: EligiblePlan[] = [];
  const rejected: Placement["rejected"] = [];
  for (const candidate of candidates) {
    const reasons: string[] = [];
    const warm = demand.warm && candidate.id === demand.stickyBackend;
    if (candidate.capability !== demand.capability) reasons.push("capability");
    if (candidate.lifecycle !== demand.lifecycle) reasons.push("lifecycle");
    if (!candidate.profiles.includes(demand.profile))
      reasons.push("profile/continuity");
    if (candidate.region !== demand.region) reasons.push("locality");
    if (demand.trust === "qualified" && candidate.trust !== "qualified")
      reasons.push("isolation not qualified");
    if (!candidate.available) reasons.push("unavailable");
    if ((used[candidate.id] ?? 0) >= candidate.capacity)
      reasons.push("capacity");
    if (demand.memoryBytes > candidate.maxMemoryBytes) reasons.push("memory");
    if (demand.stickyBackend && candidate.id !== demand.stickyBackend)
      reasons.push("context affinity");
    const startup = warm
      ? candidate.estimate.warmStartupMs
      : candidate.estimate.startupMs;
    const transfer = warm ? 0 : candidate.estimate.transferMs;
    const estimatedMs =
      startup === null || transfer === null ? null : startup + transfer;
    const estimatedCost = candidate.estimate.cost;
    if (
      demand.maxCost !== null &&
      (estimatedCost === null || estimatedCost > demand.maxCost)
    )
      reasons.push("budget");
    if (
      demand.deadline <= now ||
      (estimatedMs !== null && estimatedMs >= demand.deadline - now)
    )
      reasons.push("deadline");
    if (reasons.length) {
      rejected.push({ provider: candidate.id, reasons });
      continue;
    }
    const unknowns = [
      estimatedCost === null ? "cost" : null,
      estimatedMs === null ? "startup/transfer" : null,
    ].filter((x): x is string => x !== null);
    considered.push({
      kind: "eligible",
      candidate,
      warm,
      estimatedMs,
      estimatedCost,
      unknowns,
      score:
        (estimatedCost ?? 0) * weights.cost +
        (estimatedMs ?? 0) * weights.latency +
        unknowns.length * weights.unknown,
    });
  }
  considered.sort(
    (a, b) => a.score - b.score || a.candidate.id.localeCompare(b.candidate.id),
  );
  return {
    chosen: considered[0] ?? null,
    rejected,
    considered,
    policy: "known-estimates-v1",
  };
}

/** Round-robin among tenants, FIFO within a tenant. The cursor is durable. */
export function fairOrder<T extends { tenant: string; created: number }>(
  items: T[],
  lastTenant: string | null,
): T[] {
  const tenants = [...new Set(items.map((x) => x.tenant))].sort();
  const split =
    lastTenant === null ? 0 : tenants.findIndex((t) => t > lastTenant);
  const ordered =
    split < 0 ? tenants : [...tenants.slice(split), ...tenants.slice(0, split)];
  return ordered.flatMap((t) =>
    items.filter((x) => x.tenant === t).sort((a, b) => a.created - b.created),
  );
}
