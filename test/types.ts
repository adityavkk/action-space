import { Effect } from "effect";
import type {
  Invocation,
  Output,
  WorkState,
  Auth,
  ExecutionProfile,
  Profile,
} from "../src/domain.js";
import type { WorkManagerApi } from "../src/platform.js";
import { defineTool } from "../src/catalog.js";
import { Schema } from "effect";

// These are compiled, not run. Removing correlation makes @ts-expect-error fail.
function contract(manager: WorkManagerApi, auth: Auth) {
  const wrongTarget: Invocation = {
    action: "code.execute",
    version: "v1",
    // @ts-expect-error Stateless code execution cannot mutate a Sandbox target.
    target: { kind: "sandbox", id: "p" },
    input: { code: "return 1" },
  };
  // @ts-expect-error Native shell requires a typed target.
  const missingTarget: Invocation = {
    action: "sandbox.shell",
    version: "v1",
    target: null,
    input: { command: "ls", cwd: "/workspace" },
  };
  const wrongOutput: WorkState<Output<"sandbox.run">> = {
    phase: "settled",
    children: [],
    outcome: {
      kind: "completed",
      // @ts-expect-error Output fields belong to their Action.
      output: { result: 1, logs: [], artifacts: [] },
      state: { kind: "not_stateful" },
    },
  };
  manager.submit(
    auth,
    {
      action: "code.execute",
      version: "v1",
      target: null,
      input: { code: "return 1" },
    },
    // @ts-expect-error Sealing is only available for a mutating persistent Sandbox Action.
    { key: "x", finish: "seal_context" },
  );
  // @ts-expect-error A stateless code provider cannot promise persistent continuity.
  const invalidCapability: ExecutionProfile = {
    capability: "code_execution",
    lifecycle: "persistent",
  };
  // @ts-expect-error Ephemeral Sandboxes cannot promise workspace continuity.
  const invalidContinuity: Profile = {
    capability: "sandbox",
    lifecycle: "ephemeral",
    id: "wrong",
    continuity: "workspace",
    recipe: "python3",
  };
  defineTool({
    path: "typed.tool",
    version: "v1",
    description: "type fixture",
    effect: "read",
    grant: "test",
    approval: false,
    input: Schema.Struct({ n: Schema.Number }),
    output: Schema.Struct({ value: Schema.Number }),
    // @ts-expect-error Connector implementations must return their declared output.
    invoke: () => Effect.succeed({ value: "not a number" }),
  });
}
