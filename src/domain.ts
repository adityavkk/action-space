import { Schema } from "effect";
import type { FrozenTools } from "./mcp.js";
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type ToolResult<T extends Json = Json> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: Json } };
export type ExecutionProfile =
  | { capability: "code_execution"; lifecycle: "invocation" }
  | { capability: "sandbox"; lifecycle: "ephemeral" | "persistent" };
export type WorkRef<T = unknown> = { id: string; readonly __output?: T };
export type Tree = { kind: "file_tree"; id: string };
export type SandboxRef = { kind: "sandbox"; id: string };
export type BoundSandbox = {
  thread: string;
  slot: "sandbox";
  revision: number;
  context: SandboxRef;
};
export type SandboxTarget = SandboxRef | BoundSandbox;
export type Cursor = { lineage: string; step: number };
export type WorkspacePoint = {
  tree: Tree;
  cursor: Cursor;
  recipe: string;
  roots: ["/workspace"];
  consistency: "filesystem";
};
export type Profile =
  | {
      capability: "code_execution";
      lifecycle: "invocation";
      id: string;
      continuity: "none";
    }
  | {
      capability: "sandbox";
      lifecycle: "ephemeral";
      id: string;
      continuity: "none";
      recipe: string;
    }
  | {
      capability: "sandbox";
      lifecycle: "persistent";
      id: string;
      continuity: "workspace";
      recipe: string;
    };
export type ProcessOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
};
export type CodeOutput = { result: Json; logs: string[]; artifacts: Tree[] };
export type SandboxRunInput = {
  profile: string;
  code: Tree;
  inputs: Record<string, Tree>;
  argv: string[];
  outputs: { required: string[] };
};
export type SandboxSpec = { profile: string; seed: Tree; idleMs: number };
type Contract<T, I, O> = { target: T; input: I; output: O };
export type Actions = {
  "code.execute": Contract<
    null,
    { code: string; connections?: string[] },
    CodeOutput
  >;
  "sandbox.run": Contract<
    null,
    SandboxRunInput,
    { exitCode: 0; files: Tree; log: ProcessOutput }
  >;
  "sandbox.shell": Contract<
    SandboxTarget,
    { command: string; cwd: string },
    ProcessOutput
  >;
  "sandbox.read": Contract<
    SandboxTarget,
    { path: string },
    { text: string; cursor: Cursor }
  >;
  "context.ensure": Contract<
    null,
    { owner: string; name: string; spec: SandboxSpec },
    SandboxRef
  >;
  "context.wake": Contract<SandboxRef, Record<string, never>, Continuity>;
  "context.sleep": Contract<
    SandboxRef,
    Record<string, never>,
    { kind: "parked"; point: WorkspacePoint } | { kind: "already_unallocated" }
  >;
  "context.seal": Contract<SandboxRef, Record<string, never>, WorkspacePoint>;
  "connector.call": Contract<null, { path: string; args: Json }, Json>;
};
export type ActionName = keyof Actions;
export type Invocation = {
  [A in ActionName]: {
    action: A;
    version: "v1";
    target: Actions[A]["target"];
    input: Actions[A]["input"];
  };
}[ActionName];
export type Output<A extends ActionName> = Actions[A]["output"];
export type SubmitOptions<A extends ActionName> = {
  key: string;
  finish?: A extends "sandbox.shell"
    ? "record_result" | "seal_context"
    : "record_result";
};
export type Outcome<T> =
  | { kind: "completed"; output: T; state: StateReceipt }
  | { kind: "failed"; code: string; message: string; evidence: Json }
  | {
      kind: "interrupted";
      reason: "approval" | "child_pending" | "limit" | "isolate_lost";
      partial: CodeOutput | null;
    }
  | { kind: "seal_failed"; output: T; reason: string; state: StateReceipt }
  | { kind: "cancelled" };
export type WorkState<T = unknown> = { children: string[] } & (
  | { phase: "queued" }
  | {
      phase: "held";
      reason: "approval" | "capacity" | "context" | "budget";
      detail: string;
    }
  | { phase: "running"; attempt: number }
  | {
      phase: "finalizing";
      stage: "output_publication";
      execution: ProcessOutput;
      allocation: Allocation;
      expiresAt: number;
    }
  | {
      phase: "reconciling";
      known: string[];
      uncertain: string[];
      safeNext: "inspect" | "human_review";
    }
  | { phase: "settled"; outcome: Outcome<T> }
);
export type StateReceipt =
  | { kind: "not_stateful" }
  | { kind: "unsealed"; cursor: Cursor; lastSeal: WorkspacePoint | null }
  | { kind: "sealed"; point: WorkspacePoint };
export type ContextPhase =
  | { kind: "unallocated" }
  | { kind: "ready"; allocation: Allocation }
  | { kind: "parked"; allocation: Allocation; point: WorkspacePoint }
  | { kind: "blocked"; reason: string; allocation: Allocation | null };
export type Context = {
  id: string;
  tenant: string;
  owner: string;
  name: string;
  spec: SandboxSpec;
  cursor: Cursor;
  epoch: number;
  phase: ContextPhase;
  lastSeal: WorkspacePoint | null;
  backend: string | null;
  busy: string | null;
  lastActive: number;
};
export type Continuity = {
  context: SandboxRef;
  epoch: number;
  cursor: Cursor;
  kind: "created" | "remounted";
  discarded: ["processes", "sockets"];
  rootLayer: "not_promised";
};
export type Allocation = {
  provider: string;
  id: string;
  generation: number;
  data: Record<string, string>;
};
export type Bounds = {
  wallMs: number;
  cpuMs: number;
  heapBytes: number;
  stackBytes: number;
  sourceBytes: number;
  calls: number;
  inFlight: number;
  argumentBytes: number;
  resultBytes: number;
  logBytes: number;
  treeBytes: number;
  treeFiles: number;
};
export const defaultBounds: Bounds = {
  wallMs: 10_000,
  cpuMs: 2_000,
  heapBytes: 32 * 1024 * 1024,
  stackBytes: 512 * 1024,
  sourceBytes: 64 * 1024,
  calls: 30,
  inFlight: 8,
  argumentBytes: 64 * 1024,
  resultBytes: 256 * 1024,
  logBytes: 32 * 1024,
  treeBytes: 4 * 1024 * 1024,
  treeFiles: 200,
};
export type Demand = (
  | ExecutionProfile
  | { capability: null; lifecycle: null }
) & {
  profile: string;
  region: string;
  trust: "development" | "qualified";
  deadline: number;
  maxCost: number | null;
  memoryBytes: number;
  stickyBackend: string | null;
  warm: boolean;
};
export type Estimate = {
  cost: number | null;
  startupMs: number | null;
  transferMs: number | null;
  warmStartupMs: number | null;
};
export type Candidate = ExecutionProfile & {
  id: string;
  profiles: string[];
  region: string;
  trust: "development" | "qualified";
  available: boolean;
  capacity: number;
  maxMemoryBytes: number;
  estimate: Estimate;
};
export type EligiblePlan = {
  kind: "eligible";
  candidate: Candidate;
  warm: boolean;
  score: number;
  estimatedCost: number | null;
  estimatedMs: number | null;
  unknowns: string[];
};
export type Placement = {
  chosen: EligiblePlan | null;
  rejected: { provider: string; reasons: string[] }[];
  considered: EligiblePlan[];
  policy: "known-estimates-v1";
};
export type Lease = {
  holder: string;
  generation: number;
  reservedAt: number;
  expiresAt: number;
};
export type Trace = { traceId: string; spanId: string; sampled: boolean };
export type Auth = {
  tenant: string;
  actor: string;
  thread: string;
  grants: string[];
  reviewer: boolean;
};
export type Work = {
  id: string;
  tenant: string;
  actor: string;
  thread: string;
  key: string;
  digest: string;
  call: Invocation;
  target: SandboxRef | null;
  catalog: string;
  /** Absent only on legacy evidence; never upgrade an admitted source program in place. */
  tools?: FrozenTools;
  finish: "record_result" | "seal_context";
  bounds: Bounds;
  demand: Demand;
  state: WorkState;
  parent: string | null;
  gate: boolean;
  calls: number;
  inFlight: number;
  created: number;
  trace: Trace | null;
  lease: Lease | null;
  placement: Placement | null;
  approved: { digest: string; actor: string; expiresAt: number } | null;
};
export class Fault extends Schema.TaggedError<Fault>()("Fault", {
  code: Schema.String,
  message: Schema.String,
}) {
  constructor(code: string, message = code) {
    super({ code, message });
  }
}
export class Uncertain extends Schema.TaggedError<Uncertain>()("Uncertain", {
  message: Schema.String,
}) {
  constructor(message: string) {
    super({ message });
  }
}
export class Interrupt extends Schema.TaggedError<Interrupt>()("Interrupt", {
  reason: Schema.Literals([
    "approval",
    "child_pending",
    "limit",
    "isolate_lost",
  ]),
}) {
  constructor(reason: "approval" | "child_pending" | "limit" | "isolate_lost") {
    super({ reason });
  }
}
export type ExecutionError = Fault | Uncertain | Interrupt;
export const notStateful: StateReceipt = { kind: "not_stateful" };
