// Trusted, disposable Node wrapper. Agent source executes only in QuickJS-WASM.
import { createExecutor } from "@executor-js/sdk";
import { definePlugin } from "@executor-js/sdk/core";
import { createExecutionEngine } from "@executor-js/execution";
import { Effect } from "effect";
import { makeQuickJsExecutor } from "./runtime.js";
import { createWriteStream } from "node:fs";

// Dedicated inherited pipe: upstream loggers may write stdout/stderr, never IPC frames.
const frames = createWriteStream(null, { fd: 3, autoClose: false });
const send = (frame) => frames.write(`${JSON.stringify(frame)}\n`);
const callbacks = new Map();
let started = false;
let buffer = "";
let sequence = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) process.exit(71);
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (!started) {
      started = true;
      void run(message);
    } else {
      callbacks.get(message.id)?.(JSON.parse(message.value));
      callbacks.delete(message.id);
    }
  }
});
process.stdin.on("end", () => process.exit(72));

// Executed inside the guest, before QuickJS's lossy object dump. Capture intrinsics before source runs.
function resultEncoder() {
  const stringify = JSON.stringify.bind(JSON),
    keys = Object.keys.bind(Object),
    finite = Number.isFinite.bind(Number),
    array = Array.isArray.bind(Array),
    Seen = Set;
  return (value) => {
    const seen = new Seen();
    function visit(v, depth) {
      if (depth > 40) throw Error("JSON_DEPTH");
      if (
        v === null ||
        typeof v === "string" ||
        typeof v === "boolean" ||
        (typeof v === "number" && finite(v))
      )
        return;
      if (typeof v !== "object" || seen.has(v)) throw Error("INVALID_JSON");
      seen.add(v);
      if (array(v)) {
        for (let i = 0; i < v.length; i++) visit(v[i], depth + 1);
      } else for (const key of keys(v)) visit(v[key], depth + 1);
      seen.delete(v);
    }
    const result = value === undefined ? null : value;
    visit(result, 0);
    return stringify(result);
  };
}
const standard = (schema) => ({
  "~standard": {
    version: 1,
    vendor: "action-space-broker",
    // Discovery representation only. The trusted broker enforces Ajv before every real dispatch.
    validate: (value) => ({ value }),
    jsonSchema: { input: () => schema, output: () => schema },
  },
});
async function run(input) {
  let executor;
  let logBytes = 0;
  let exceeded = false;
  try {
    const invoke = ({ path, args }) =>
      Effect.promise(
        () =>
          new Promise((resolve) => {
            const id = sequence++;
            const value = JSON.stringify(args ?? null);
            if (Buffer.byteLength(value) > input.bounds.argumentBytes) {
              exceeded = true;
              send({ kind: "error", message: "ARGUMENT_LIMIT" });
              return;
            }
            callbacks.set(id, resolve);
            send({ kind: "call", id, path, value });
          }),
      );
    if (input.tools) {
      const integrations = new Map();
      for (const descriptor of input.tools) {
        const split = descriptor.path.lastIndexOf(".");
        const id = descriptor.path.slice(0, split),
          name = descriptor.path.slice(split + 1);
        if (!integrations.has(id))
          integrations.set(id, { id, name: id, kind: "in-memory", tools: [] });
        integrations.get(id).tools.push({
          name,
          description: descriptor.description,
          inputSchema: standard(descriptor.inputSchema),
          ...(descriptor.outputSchema
            ? { outputSchema: standard(descriptor.outputSchema) }
            : {}),
          handler: ({ args }) => invoke({ path: descriptor.path, args }),
        });
      }
      const plugin = definePlugin(() => ({
        id: "action-space-host",
        storage: () => ({}),
        staticIntegrations: () => [...integrations.values()],
      }))();
      executor = await createExecutor({
        plugins: [plugin],
        onElicitation: async () => {
          throw Error("INTERACTION_UNSUPPORTED");
        },
      });
    }
    const cpuStart = process.cpuUsage();
    const runtime = makeQuickJsExecutor({
      timeoutMs: Math.max(1, input.deadline - Date.now()),
      memoryLimitBytes: input.bounds.heapBytes,
      maxStackSizeBytes: input.bounds.stackBytes,
      shouldInterrupt: () => {
        const cpu = process.cpuUsage(cpuStart);
        return exceeded || (cpu.user + cpu.system) / 1000 > input.bounds.cpuMs;
      },
      onLog: (line) => {
        logBytes += Buffer.byteLength(line);
        if (logBytes > input.bounds.logBytes) {
          exceeded = true;
          throw Error("LOG_LIMIT");
        }
        send({ kind: "log", line });
      },
    });
    const code = `const __encode = (${resultEncoder.toString()})(); return __encode(await ${input.program});`;
    const result = executor
      ? await createExecutionEngine({
          executor,
          codeExecutor: runtime,
        }).execute(code, {
          onElicitation: async () => {
            throw Error("INTERACTION_UNSUPPORTED");
          },
        })
      : await Effect.runPromise(runtime.execute(code, { invoke }));
    if (exceeded || result.error || typeof result.result !== "string")
      throw Error("GUEST_ERROR");
    if (Buffer.byteLength(result.result) > input.bounds.resultBytes)
      throw Error("RESULT_LIMIT");
    send({ kind: "result", value: result.result });
  } catch {
    send({ kind: "error", message: "GUEST_ERROR" });
  } finally {
    await executor?.close();
    process.stdin.pause();
  }
}
