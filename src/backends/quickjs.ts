import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import {
  Fault,
  Interrupt,
  Uncertain,
  type CodeOutput,
  type Json,
} from "../domain.js";
import { external } from "../effects.js";
import { json } from "../util.js";
import type { CodeBackend, CodeRequest } from "./contracts.js";
import { prepare } from "./prepare.js";

const Frame = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("call"),
    id: Schema.Int,
    path: Schema.String,
    value: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("log"), line: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("result"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("error"), message: Schema.String }),
]);
export class QuickJSBackend implements CodeBackend {
  readonly capability = "code_execution";
  readonly lifecycle = "invocation";
  execute = Effect.fn("QuickJS.execute")((request: CodeRequest) =>
    external(
      "QuickJS.process",
      (signal) =>
        new Promise<CodeOutput>((resolve, reject) => {
          const program = prepare(request.code, request.bounds.sourceBytes);
          const file = fileURLToPath(
            new URL(
              import.meta.url.endsWith(".ts")
                ? "../../providers/executor/runner.js"
                : "../../../providers/executor/runner.js",
              import.meta.url,
            ),
          );
          const runner = spawn(
            process.execPath,
            [
              "--max-old-space-size=256",
              ...(file.endsWith(".ts")
                ? ["--import", import.meta.resolve("tsx")]
                : []),
              file,
            ],
            {
              stdio: ["pipe", "ignore", "ignore", "pipe"],
              env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
              cwd: "/tmp",
            },
          );
          let finished = false;
          let returned = false;
          let buffer = "";
          let logBytes = 0;
          const logs: string[] = [];
          const accepted = new Set<Promise<void>>();
          const logWrites: Promise<void>[] = [];
          const done = (error: unknown, output?: CodeOutput) => {
            if (finished) return;
            finished = true;
            clearTimeout(watchdog);
            signal.removeEventListener("abort", abort);
            request.signal.removeEventListener("abort", abort);
            runner.kill("SIGKILL");
            // Never wait indefinitely or replay source after a possibly dispatched external effect.
            if (error instanceof Uncertain) reject(error);
            else if (accepted.size)
              reject(
                new Uncertain(
                  "Runner ended with unresolved broker calls; inspect diagnostics, do not replay",
                ),
              );
            else if (error) reject(error);
            else if (output) resolve(output);
          };
          const abort = () => done(new Fault("CANCELLED"));
          const watchdog = setTimeout(
            () => done(new Interrupt("limit")),
            Math.max(1, request.deadline - Date.now()),
          );
          signal.addEventListener("abort", abort, { once: true });
          request.signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted || request.signal.aborted) {
            abort();
            return;
          }
          (runner.stdio[3] as Readable)
            .setEncoding("utf8")
            .on("data", (chunk: string) => {
              if (finished) return;
              buffer += chunk;
              if (
                Buffer.byteLength(buffer) >
                request.bounds.resultBytes * 2 +
                  request.bounds.argumentBytes * 2
              ) {
                done(new Interrupt("limit"));
                return;
              }
              let index: number;
              while ((index = buffer.indexOf("\n")) >= 0 && !finished) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                try {
                  const frame = Schema.decodeUnknownSync(Frame)(
                    JSON.parse(line),
                  );
                  if (frame.kind === "call") {
                    const input = json(
                      JSON.parse(frame.value),
                      request.bounds.argumentBytes,
                    );
                    const pending = Promise.resolve()
                      .then(() =>
                        request.bridge(frame.path, input, String(frame.id)),
                      )
                      .then((value) => {
                        if (!finished)
                          runner.stdin!.write(
                            `${JSON.stringify({ id: frame.id, value: JSON.stringify(json(value, request.bounds.resultBytes)) })}\n`,
                          );
                      })
                      .catch((error) => done(error));
                    accepted.add(pending);
                    void pending.finally(() => accepted.delete(pending));
                  } else if (frame.kind === "log") {
                    logBytes += Buffer.byteLength(frame.line);
                    if (logBytes > request.bounds.logBytes)
                      throw new Interrupt("limit");
                    logs.push(frame.line);
                    logWrites.push(
                      request.log(frame.line).catch((error) => done(error)),
                    );
                  } else if (frame.kind === "error")
                    done(
                      new Fault(
                        "GUEST_ERROR",
                        "JavaScript execution failed or exceeded engine limits",
                      ),
                    );
                  else {
                    returned = true;
                    const output = {
                      result: json(
                        JSON.parse(frame.value),
                        request.bounds.resultBytes,
                      ),
                      logs,
                      artifacts: [],
                    };
                    if (accepted.size)
                      done(new Uncertain("Unresolved broker calls"));
                    else
                      void Promise.all(logWrites).then(() =>
                        done(null, output),
                      );
                  }
                } catch (error) {
                  done(error);
                }
              }
            });
          // Discard upstream diagnostic stdout/stderr; only validated frames cross to Work.
          runner.stdin!.on("error", () => {});
          runner.on("error", () => done(new Interrupt("isolate_lost")));
          runner.on("exit", () => {
            if (!finished && !returned) done(new Interrupt("isolate_lost"));
          });
          runner.stdin!.write(
            `${JSON.stringify({ program, tools: request.tools, bounds: request.bounds, deadline: request.deadline })}\n`,
          );
        }),
    ),
  );
}
