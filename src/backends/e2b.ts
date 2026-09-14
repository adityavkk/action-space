import {
  Sandbox,
  CommandExitError,
  type SandboxOpts,
  type SandboxConnectOpts,
  type CommandHandle,
  type CommandStartOpts,
  type SandboxInfo,
  type SandboxPauseOpts,
  type ConnectionOpts,
} from "e2b";
import { Effect } from "effect";
import {
  Fault,
  Uncertain,
  type Allocation,
  type ProcessOutput,
} from "../domain.js";
import { external } from "../effects.js";
import { RemoteNativeIO, type NativeTransport } from "./native-controller.js";
import type {
  EphemeralSandboxBackend,
  NativeRequest,
  PersistentSandboxBackend,
} from "./contracts.js";
export interface E2BSession {
  sandboxId: string;
  commands: {
    run(
      command: string,
      options: CommandStartOpts & { background: true },
    ): Promise<
      Pick<CommandHandle, "sendStdin" | "closeStdin" | "wait" | "kill">
    >;
  };
  pause(options?: SandboxPauseOpts): Promise<boolean>;
}
export interface E2BClient {
  create(template: string, options: SandboxOpts): Promise<E2BSession>;
  connect(id: string, options: SandboxConnectOpts): Promise<E2BSession>;
  getInfo(
    id: string,
    options: ConnectionOpts,
  ): Promise<Pick<SandboxInfo, "sandboxId" | "state">>;
  kill(id: string, options: ConnectionOpts): Promise<boolean>;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export class E2BBackend {
  readonly io: RemoteNativeIO;
  constructor(
    readonly config: { apiKey: string; timeoutMs: number },
    readonly client: E2BClient = Sandbox,
  ) {
    const transport: NativeTransport = {
      execute: async (
        allocation,
        argv,
        stdin,
        timeoutMs,
        outputBytes,
        signal,
      ) => {
        const info = await client.getInfo(allocation.id, {
          apiKey: config.apiKey,
        });
        if (info.state !== "running") throw new Fault("ALLOCATION_NOT_RUNNING");
        const sandbox = await client.connect(allocation.id, {
          apiKey: config.apiKey,
          timeoutMs: config.timeoutMs,
          onResume: "reboot",
        });
        let bytes = 0;
        let overflow = false;
        const bound = (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > outputBytes) {
            overflow = true;
            void handle?.kill();
          }
        };
        let handle:
          | Pick<CommandHandle, "sendStdin" | "closeStdin" | "wait" | "kill">
          | undefined;
        handle = await sandbox.commands.run(argv.map(quote).join(" "), {
          background: true,
          stdin: true,
          user: "root",
          timeoutMs,
          requestTimeoutMs: timeoutMs + 5000,
          signal,
          onStdout: bound,
          onStderr: bound,
        });
        await handle.sendStdin(stdin);
        await handle.closeStdin();
        let result: ProcessOutput;
        try {
          result = await handle.wait();
        } catch (error) {
          if (error instanceof CommandExitError)
            result = {
              exitCode: error.exitCode,
              stdout: error.stdout,
              stderr: error.stderr,
            };
          else throw error;
        }
        if (overflow) throw new Fault("OUTPUT_LIMIT");
        return result;
      },
    };
    this.io = new RemoteNativeIO(transport);
  }
  create = Effect.fn("E2B.create")(
    function* (this: E2BBackend, request: NativeRequest) {
      const session = yield* external("E2B.Sandbox.create", async () => {
        try {
          return await this.client.create(request.recipe, {
            apiKey: this.config.apiKey,
            timeoutMs: this.config.timeoutMs,
            allowInternetAccess: false,
            metadata: { actionSpaceOperation: request.operation },
            lifecycle: { onTimeout: "pause", autoResume: false },
          });
        } catch {
          throw new Uncertain(
            "E2B create response lost. Inspect metadata actionSpaceOperation; do not repeat create.",
          );
        }
      });
      const allocation: Allocation = {
        provider: "e2b",
        id: session.sandboxId,
        generation: request.generation,
        data: { operation: request.operation },
      };
      return allocation;
    }.bind(this),
  );
  park = Effect.fn("E2B.park")(
    function* (this: E2BBackend, allocation: Allocation) {
      yield* this.io.quiesce(allocation);
      yield* external("E2B.Sandbox.pause", async () => {
        const sandbox = await this.client.connect(allocation.id, {
          apiKey: this.config.apiKey,
          timeoutMs: this.config.timeoutMs,
        });
        await sandbox.pause({ keepMemory: false });
        const info = await this.client.getInfo(allocation.id, {
          apiKey: this.config.apiKey,
        });
        if (info.state !== "paused")
          throw new Uncertain("E2B pause not confirmed");
      });
    }.bind(this),
  );
  wake = Effect.fn("E2B.wake")((allocation: Allocation, generation: number) =>
    external("E2B.Sandbox.connect", async () => {
      await this.client.connect(allocation.id, {
        apiKey: this.config.apiKey,
        timeoutMs: this.config.timeoutMs,
        onResume: "reboot",
      });
      const info = await this.client.getInfo(allocation.id, {
        apiKey: this.config.apiKey,
      });
      if (info.state !== "running") throw new Fault("ALLOCATION_NOT_RUNNING");
      return { ...allocation, generation };
    }),
  );
  release = Effect.fn("E2B.release")((allocation: Allocation) =>
    external("E2B.Sandbox.kill", async () => {
      await this.client.kill(allocation.id, { apiKey: this.config.apiKey });
    }),
  );
  ephemeral(): EphemeralSandboxBackend {
    return {
      capability: "sandbox",
      lifecycle: "ephemeral",
      initialize: this.io.initialize,
      create: this.create,
      run: this.io.run,
      upload: this.io.upload,
      download: this.io.download,
      release: this.release,
    };
  }
  persistent(): PersistentSandboxBackend {
    return {
      capability: "sandbox",
      lifecycle: "persistent",
      initialize: this.io.initialize,
      create: this.create,
      run: this.io.run,
      upload: this.io.upload,
      download: this.io.download,
      park: this.park,
      wake: this.wake,
    };
  }
}
