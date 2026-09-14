import { Schema } from "effect";
import { ConnectionSelection, FrozenTools } from "./mcp.js";
import type {
  Invocation,
  Work,
  Context,
  ActionName,
  Output,
} from "./domain.js";
export const Text = Schema.NonEmptyString.check(Schema.isMaxLength(65_536));
const stringArray = Schema.Array(Schema.String).pipe(Schema.mutable);
export const Tree = Schema.Struct({
  kind: Schema.Literal("file_tree"),
  id: Text,
});
export const SandboxRef = Schema.Struct({
  kind: Schema.Literal("sandbox"),
  id: Text,
});
export const BoundSandbox = Schema.Struct({
  thread: Text,
  slot: Schema.Literal("sandbox"),
  revision: Schema.Int,
  context: SandboxRef,
});
const target = Schema.Union([SandboxRef, BoundSandbox]);
const Empty = Schema.Struct({});
export const SandboxSpec = Schema.Struct({
  profile: Text,
  seed: Tree,
  idleMs: Schema.Int.check(
    Schema.isBetween({ minimum: 1000, maximum: 86_400_000 }),
  ),
});
const fields = { version: Schema.Literal("v1") };
export const Execute = Schema.Struct({
  code: Text,
  connections: Schema.optionalKey(ConnectionSelection),
});
export const InvocationSchema = Schema.Union([
  Schema.Struct({
    ...fields,
    action: Schema.Literal("code.execute"),
    target: Schema.Null,
    input: Execute,
  }),
  Schema.Struct({
    ...fields,
    action: Schema.Literal("sandbox.run"),
    target: Schema.Null,
    input: Schema.Struct({
      profile: Text,
      code: Tree,
      inputs: Schema.Record(Schema.String, Tree),
      argv: stringArray,
      outputs: Schema.Struct({ required: stringArray }),
    }),
  }),
  Schema.Struct({
    ...fields,
    action: Schema.Literal("sandbox.shell"),
    target,
    input: Schema.Struct({ command: Text, cwd: Text }),
  }),
  Schema.Struct({
    ...fields,
    action: Schema.Literal("sandbox.read"),
    target,
    input: Schema.Struct({ path: Text }),
  }),
  Schema.Struct({
    ...fields,
    action: Schema.Literal("context.ensure"),
    target: Schema.Null,
    input: Schema.Struct({ owner: Text, name: Text, spec: SandboxSpec }),
  }),
  Schema.Struct({
    ...fields,
    action: Schema.Literal("context.wake"),
    target: SandboxRef,
    input: Empty,
  }),
  Schema.Struct({
    ...fields,
    action: Schema.Literal("context.sleep"),
    target: SandboxRef,
    input: Empty,
  }),
  Schema.Struct({
    ...fields,
    action: Schema.Literal("context.seal"),
    target: SandboxRef,
    input: Empty,
  }),
  Schema.Struct({
    ...fields,
    action: Schema.Literal("connector.call"),
    target: Schema.Null,
    input: Schema.Struct({ path: Text, args: Schema.MutableJson }),
  }),
]) satisfies Schema.Codec<Invocation>;
export const Search = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(1000)),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  ),
});
export const Describe = Schema.Struct({ path: Text });
export const FileTreeSchema = Schema.Record(
  Schema.String,
  Schema.Struct({ base64: Schema.String, executable: Schema.Boolean }),
);
const Positive = Schema.Int.check(Schema.isGreaterThan(0));
export const Bounds = Schema.Struct({
  wallMs: Positive,
  cpuMs: Positive,
  heapBytes: Positive,
  stackBytes: Positive,
  sourceBytes: Positive,
  calls: Positive,
  inFlight: Positive,
  argumentBytes: Positive,
  resultBytes: Positive,
  logBytes: Positive,
  treeBytes: Positive,
  treeFiles: Positive,
});
const Cursor = Schema.Struct({ lineage: Text, step: Schema.Int });
const Point = Schema.Struct({
  tree: Tree,
  cursor: Cursor,
  recipe: Text,
  roots: Schema.Tuple([Schema.Literal("/workspace")]).pipe(Schema.mutable),
  consistency: Schema.Literal("filesystem"),
});
const Allocation = Schema.Struct({
  provider: Text,
  id: Text,
  generation: Schema.Int,
  data: Schema.Record(Schema.String, Schema.String),
});
const ProcessOutput = Schema.Struct({
  exitCode: Schema.Int,
  stdout: Schema.String,
  stderr: Schema.String,
});
const CodeOutput = Schema.Struct({
  result: Schema.MutableJson,
  logs: stringArray,
  artifacts: Schema.Array(Tree).pipe(Schema.mutable),
});
export const ActionOutputs = {
  "code.execute": CodeOutput,
  "sandbox.run": Schema.Struct({
    exitCode: Schema.Literal(0),
    files: Tree,
    log: ProcessOutput,
  }),
  "sandbox.shell": ProcessOutput,
  "sandbox.read": Schema.Struct({ text: Schema.String, cursor: Cursor }),
  "context.ensure": SandboxRef,
  "context.wake": Schema.Struct({
    context: SandboxRef,
    epoch: Schema.Int,
    cursor: Cursor,
    kind: Schema.Literals(["created", "remounted"]),
    discarded: Schema.Tuple([
      Schema.Literal("processes"),
      Schema.Literal("sockets"),
    ]).pipe(Schema.mutable),
    rootLayer: Schema.Literal("not_promised"),
  }),
  "context.sleep": Schema.Union([
    Schema.Struct({ kind: Schema.Literal("parked"), point: Point }),
    Schema.Struct({ kind: Schema.Literal("already_unallocated") }),
  ]),
  "context.seal": Point,
  "connector.call": Schema.MutableJson,
} satisfies { [A in ActionName]: Schema.Codec<Output<A>> };
export function checkOutput(work: Work): void {
  if (
    work.state.phase === "settled" &&
    (work.state.outcome.kind === "completed" ||
      work.state.outcome.kind === "seal_failed")
  ) {
    if (
      work.state.outcome.kind === "seal_failed" &&
      work.call.action !== "sandbox.shell"
    )
      throw new Error("Invalid seal outcome");
    Schema.decodeUnknownSync(ActionOutputs[work.call.action])(
      work.state.outcome.output,
      { onExcessProperty: "error" },
    );
  }
}
const StateReceipt = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("not_stateful") }),
  Schema.Struct({
    kind: Schema.Literal("unsealed"),
    cursor: Cursor,
    lastSeal: Schema.NullOr(Point),
  }),
  Schema.Struct({ kind: Schema.Literal("sealed"), point: Point }),
]);
const Outcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("completed"),
    output: Schema.Unknown,
    state: StateReceipt,
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    code: Text,
    message: Schema.String,
    evidence: Schema.MutableJson,
  }),
  Schema.Struct({
    kind: Schema.Literal("interrupted"),
    reason: Schema.Literals([
      "approval",
      "child_pending",
      "limit",
      "isolate_lost",
    ]),
    partial: Schema.NullOr(CodeOutput),
  }),
  Schema.Struct({
    kind: Schema.Literal("seal_failed"),
    output: Schema.Unknown,
    reason: Schema.String,
    state: StateReceipt,
  }),
  Schema.Struct({ kind: Schema.Literal("cancelled") }),
]);
const State = Schema.Union([
  Schema.Struct({ children: stringArray, phase: Schema.Literal("queued") }),
  Schema.Struct({
    children: stringArray,
    phase: Schema.Literal("held"),
    reason: Schema.Literals(["approval", "capacity", "context", "budget"]),
    detail: Schema.String,
  }),
  Schema.Struct({
    children: stringArray,
    phase: Schema.Literal("running"),
    attempt: Schema.Int,
  }),
  Schema.Struct({
    children: stringArray,
    phase: Schema.Literal("finalizing"),
    stage: Schema.Literal("output_publication"),
    execution: ProcessOutput,
    allocation: Allocation,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    children: stringArray,
    phase: Schema.Literal("reconciling"),
    known: stringArray,
    uncertain: stringArray,
    safeNext: Schema.Literals(["inspect", "human_review"]),
  }),
  Schema.Struct({
    children: stringArray,
    phase: Schema.Literal("settled"),
    outcome: Outcome,
  }),
]);
const Estimate = Schema.Struct({
  cost: Schema.NullOr(Schema.Number),
  startupMs: Schema.NullOr(Schema.Number),
  transferMs: Schema.NullOr(Schema.Number),
  warmStartupMs: Schema.NullOr(Schema.Number),
});
const executionFields = [
  {
    capability: Schema.Literal("code_execution"),
    lifecycle: Schema.Literal("invocation"),
  },
  {
    capability: Schema.Literal("sandbox"),
    lifecycle: Schema.Literals(["ephemeral", "persistent"]),
  },
] as const;
const candidateFields = {
  id: Text,
  profiles: stringArray,
  region: Text,
  trust: Schema.Literals(["development", "qualified"]),
  available: Schema.Boolean,
  capacity: Schema.Int,
  maxMemoryBytes: Schema.Number,
  estimate: Estimate,
};
export const CandidateSchema = Schema.Union([
  Schema.Struct({ ...candidateFields, ...executionFields[0] }),
  Schema.Struct({ ...candidateFields, ...executionFields[1] }),
]);
const Plan = Schema.Struct({
  kind: Schema.Literal("eligible"),
  candidate: CandidateSchema,
  warm: Schema.Boolean,
  score: Schema.Number,
  estimatedCost: Schema.NullOr(Schema.Number),
  estimatedMs: Schema.NullOr(Schema.Number),
  unknowns: stringArray,
});
const Placement = Schema.Struct({
  chosen: Schema.NullOr(Plan),
  rejected: Schema.Array(
    Schema.Struct({ provider: Text, reasons: stringArray }),
  ).pipe(Schema.mutable),
  considered: Schema.Array(Plan).pipe(Schema.mutable),
  policy: Schema.Literal("known-estimates-v1"),
});
const demandFields = {
  profile: Text,
  region: Text,
  trust: Schema.Literals(["development", "qualified"]),
  deadline: Schema.Number,
  maxCost: Schema.NullOr(Schema.Number),
  memoryBytes: Schema.Number,
  stickyBackend: Schema.NullOr(Text),
  warm: Schema.Boolean,
};
export const DemandSchema = Schema.Union([
  Schema.Struct({ ...demandFields, ...executionFields[0] }),
  Schema.Struct({ ...demandFields, ...executionFields[1] }),
  Schema.Struct({
    ...demandFields,
    capability: Schema.Null,
    lifecycle: Schema.Null,
  }),
]);
export const WorkSchema = Schema.Struct({
  id: Text,
  tenant: Text,
  actor: Text,
  thread: Text,
  key: Text,
  digest: Text,
  call: InvocationSchema,
  target: Schema.NullOr(SandboxRef),
  catalog: Text,
  tools: Schema.optionalKey(FrozenTools),
  finish: Schema.Literals(["record_result", "seal_context"]),
  bounds: Bounds,
  demand: DemandSchema,
  state: State,
  parent: Schema.NullOr(Text),
  gate: Schema.Boolean,
  calls: Schema.Int,
  inFlight: Schema.Int,
  created: Schema.Number,
  trace: Schema.NullOr(
    Schema.Struct({ traceId: Text, spanId: Text, sampled: Schema.Boolean }),
  ),
  lease: Schema.NullOr(
    Schema.Struct({
      holder: Text,
      generation: Schema.Int,
      reservedAt: Schema.Number,
      expiresAt: Schema.Number,
    }),
  ),
  placement: Schema.NullOr(Placement),
  approved: Schema.NullOr(
    Schema.Struct({ digest: Text, actor: Text, expiresAt: Schema.Number }),
  ),
}) satisfies Schema.Codec<Work>;
export const ContextSchema = Schema.Struct({
  id: Text,
  tenant: Text,
  owner: Text,
  name: Text,
  spec: SandboxSpec,
  cursor: Cursor,
  epoch: Schema.Int,
  phase: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("unallocated") }),
    Schema.Struct({ kind: Schema.Literal("ready"), allocation: Allocation }),
    Schema.Struct({
      kind: Schema.Literal("parked"),
      allocation: Allocation,
      point: Point,
    }),
    Schema.Struct({
      kind: Schema.Literal("blocked"),
      reason: Text,
      allocation: Schema.NullOr(Allocation),
    }),
  ]),
  lastSeal: Schema.NullOr(Point),
  backend: Schema.NullOr(Text),
  busy: Schema.NullOr(Text),
  lastActive: Schema.Number,
}) satisfies Schema.Codec<Context>;
