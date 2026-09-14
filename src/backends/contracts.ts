import { Effect } from "effect";
import type {
  Allocation,
  Bounds,
  Candidate,
  CodeOutput,
  ExecutionError,
  Json,
  ProcessOutput,
} from "../domain.js";
import { Fault } from "../domain.js";
import type { ToolDescriptor } from "../mcp.js";
import type { FileTree } from "../resources.js";
export type Bridge = (
  path: string,
  input: Json,
  requestId: string,
) => Promise<Json>;
export type CodeRequest = {
  code: string;
  tools?: ToolDescriptor[];
  bounds: Bounds;
  deadline: number;
  signal: AbortSignal;
  bridge: Bridge;
  log: (line: string) => Promise<void>;
};
export interface CodeBackend {
  readonly capability: "code_execution";
  readonly lifecycle: "invocation";
  execute(request: CodeRequest): Effect.Effect<CodeOutput, ExecutionError>;
}
export type NativeRequest = {
  operation: string;
  recipe: string;
  generation: number;
  bounds: Bounds;
};
export type Command = {
  argv: string[];
  cwd: string;
  deadline: number;
  bounds: Bounds;
  signal: AbortSignal;
};
export interface NativeIO {
  initialize(allocation: Allocation): Effect.Effect<void, ExecutionError>;
  run(
    allocation: Allocation,
    command: Command,
  ): Effect.Effect<ProcessOutput, ExecutionError>;
  upload(
    allocation: Allocation,
    root: string,
    tree: FileTree,
  ): Effect.Effect<void, ExecutionError>;
  download(
    allocation: Allocation,
    root: string,
    bounds: Bounds,
  ): Effect.Effect<FileTree, ExecutionError>;
}
export interface EphemeralSandboxBackend extends NativeIO {
  readonly capability: "sandbox";
  readonly lifecycle: "ephemeral";
  create(request: NativeRequest): Effect.Effect<Allocation, ExecutionError>;
  release(allocation: Allocation): Effect.Effect<void, ExecutionError>;
}
export interface PersistentSandboxBackend extends NativeIO {
  readonly capability: "sandbox";
  readonly lifecycle: "persistent";
  create(request: NativeRequest): Effect.Effect<Allocation, ExecutionError>;
  park(allocation: Allocation): Effect.Effect<void, ExecutionError>;
  wake(
    allocation: Allocation,
    generation: number,
  ): Effect.Effect<Allocation, ExecutionError>;
}
export type Backend =
  | CodeBackend
  | EphemeralSandboxBackend
  | PersistentSandboxBackend;
export type Registration = {
  [L in Backend["lifecycle"]]: {
    candidate: Candidate & { lifecycle: L };
    backend: Extract<Backend, { lifecycle: L }>;
  };
}[Backend["lifecycle"]];
export class Backends {
  constructor(readonly entries: Registration[]) {
    if (new Set(entries.map((x) => x.candidate.id)).size !== entries.length)
      throw new Fault("DUPLICATE_BACKEND");
    for (const entry of entries)
      if (
        entry.candidate.capability !== entry.backend.capability ||
        entry.candidate.lifecycle !== entry.backend.lifecycle
      )
        throw new Fault("BACKEND_CONTRACT");
  }
  get(
    id: string,
    capability: "code_execution",
    lifecycle: "invocation",
  ): CodeBackend;
  get(
    id: string,
    capability: "sandbox",
    lifecycle: "ephemeral",
  ): EphemeralSandboxBackend;
  get(
    id: string,
    capability: "sandbox",
    lifecycle: "persistent",
  ): PersistentSandboxBackend;
  get(
    id: string,
    capability: Backend["capability"],
    lifecycle: Backend["lifecycle"],
  ): Backend {
    const found = this.entries.find((x) => x.candidate.id === id)?.backend;
    if (
      !found ||
      found.capability !== capability ||
      found.lifecycle !== lifecycle
    )
      throw new Fault(
        "UNSUPPORTED_BACKEND",
        `${id} does not provide ${capability}/${lifecycle}`,
      );
    return found;
  }
}
