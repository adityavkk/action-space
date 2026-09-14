// Vendored @executor-js/runtime-quickjs 1.6.8, MIT (see LICENSE).
// The exact upstream bytes and local patches are documented in INTEGRATION.md.
// src/index.ts
import {
  recoverExecutionBody,
  stripTypeScript
} from "@executor-js/codemode-core";
import * as Data2 from "effect/Data";
import * as Effect2 from "effect/Effect";

// src/sealed-bundle.ts
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { getQuickJS } from "quickjs-emscripten";
var SealedBundleError = class extends Data.TaggedError("SealedBundleError") {
};
var DEFAULT_TIMEOUT_MS = 1e4;
var DEFAULT_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
var DEFAULT_MAX_STACK_SIZE_BYTES = 2 * 1024 * 1024;
var BUNDLE_FILENAME = "executor-sealed-bundle.js";
var CALL_FILENAME = "executor-sealed-call.js";
var errorMessage = (cause) => cause instanceof Error ? cause.message : String(cause);
var evaluate = (context2, source, filename) => {
  const result = context2.evalCode(source, filename);
  if (result.error) {
    const dumped = context2.dump(result.error);
    result.error.dispose();
    throw new Error(
      typeof dumped === "object" && dumped !== null && "message" in dumped ? String(dumped.message) : String(dumped)
    );
  }
  result.value.dispose();
};
var runSealedBundle = async (options, resolveModule) => {
  const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const QuickJS = await resolveModule();
  const runtime = QuickJS.newRuntime();
  try {
    runtime.setMemoryLimit(options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES);
    runtime.setMaxStackSize(options.maxStackSizeBytes ?? DEFAULT_MAX_STACK_SIZE_BYTES);
    const deadline = Date.now() + timeoutMs;
    runtime.setInterruptHandler(() => Date.now() >= deadline);
    const context2 = runtime.newContext();
    try {
      evaluate(context2, options.bundle, BUNDLE_FILENAME);
      evaluate(
        context2,
        `globalThis.__executor_sealed = { settled: false, value: undefined, error: undefined };
         Promise.resolve(${options.call}).then(
           function (value) { globalThis.__executor_sealed.value = value; globalThis.__executor_sealed.settled = true; },
           function (error) {
             globalThis.__executor_sealed.error = error && error.message ? String(error.message) : String(error);
             globalThis.__executor_sealed.settled = true;
           },
         );`,
        CALL_FILENAME
      );
      const drained = runtime.executePendingJobs();
      if (drained.error) {
        const dumped = context2.dump(drained.error);
        drained.error.dispose();
        throw new Error(errorMessage(dumped));
      }
      const stateHandle = context2.getProp(context2.global, "__executor_sealed");
      try {
        const state = context2.dump(stateHandle);
        if (state.settled !== true) {
          throw new Error(`Sealed bundle did not settle within ${timeoutMs}ms`);
        }
        if (state.error !== void 0) {
          throw new Error(String(state.error));
        }
        if (typeof state.value !== "string") {
          throw new Error(`Sealed bundle resolved a ${typeof state.value}, expected a string`);
        }
        return state.value;
      } finally {
        stateHandle.dispose();
      }
    } finally {
      context2.dispose();
    }
  } finally {
    runtime.dispose();
  }
};
var executeSealedBundle = (options, resolveModule) => Effect.tryPromise({
  try: () => runSealedBundle(options, resolveModule),
  catch: (cause) => new SealedBundleError({ message: errorMessage(cause) })
}).pipe(
  Effect.withSpan("executor.sealed_bundle.exec", {
    attributes: { "executor.runtime": "quickjs" }
  })
);

// src/index.ts
import {
  getQuickJS as getQuickJS2
} from "quickjs-emscripten";
var preloadedModule = null;
var setQuickJSModule = (mod) => {
  preloadedModule = mod;
};
var resolveQuickJS = () => preloadedModule ? Promise.resolve(preloadedModule) : getQuickJS2();
var executeSealedBundle2 = (options) => executeSealedBundle(options, resolveQuickJS);
var QuickJsExecutionError = class extends Data2.TaggedError("QuickJsExecutionError") {
};
var DEFAULT_TIMEOUT_MS2 = 5 * 6e4;
var DEFAULT_MEMORY_LIMIT_BYTES2 = 64 * 1024 * 1024;
var DEFAULT_MAX_STACK_SIZE_BYTES2 = 1 * 1024 * 1024;
var EXECUTION_FILENAME = "executor-quickjs-runtime.js";
var toError = (cause) => cause instanceof Error ? cause : new Error(String(cause));
var sandboxDefectMessage = (cause) => {
  if (cause !== null && typeof cause === "object") {
    const tagged = cause;
    if (tagged._tag === "ExecutionToolError" && typeof tagged.message === "string") {
      return tagged.message;
    }
  }
  return "Internal tool error";
};
var toErrorMessage = (cause) => {
  if (typeof cause === "object" && cause !== null) {
    const message = "message" in cause && typeof cause.message === "string" ? cause.message : void 0;
    if (message) {
      return message;
    }
    const stack = "stack" in cause && typeof cause.stack === "string" ? cause.stack : void 0;
    if (stack) {
      return stack;
    }
  }
  const error = toError(cause);
  return error.stack ?? error.message;
};
var serializeJson = (value, label) => {
  if (typeof value === "undefined") {
    return void 0;
  }
  try {
    return JSON.stringify(value);
  } catch (cause) {
    throw new Error(`${label} is not JSON serializable: ${toError(cause).message}`);
  }
};
var looksLikeInterruptedError = (message) => /\binterrupted\b/i.test(message);
var timeoutMessage = (timeoutMs) => `QuickJS execution timed out after ${timeoutMs}ms`;
var makeDeadlineTracker = (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  return {
    deadlineMs: () => deadline,
    dispatchStarted: () => {},
    dispatchReturned: () => {}
  };
};
var shouldInterruptAfterDeadline = (deadline) => () => {
  const deadlineMs = deadline.deadlineMs();
  return deadlineMs !== null && Date.now() >= deadlineMs;
};
var normalizeExecutionError = (cause, deadline, timeoutMs) => {
  const message = toErrorMessage(cause);
  const deadlineMs = deadline.deadlineMs();
  return deadlineMs !== null && Date.now() >= deadlineMs && looksLikeInterruptedError(message) ? timeoutMessage(timeoutMs) : message;
};
var buildExecutionSource = (code) => {
  // Action Space passes a validated async JS body, never recovered/replayed source.
  const body = code;
  return [
    '"use strict";',
    "const __invokeTool = __executor_invokeTool;",
    "const __log = __executor_log;",
    "try { delete globalThis.__executor_invokeTool; } catch {}",
    "try { delete globalThis.__executor_log; } catch {}",
    "const __formatLogArg = (value) => {",
    "  if (typeof value === 'string') return value;",
    "  try {",
    "    return JSON.stringify(value);",
    "  } catch {",
    "    return String(value);",
    "  }",
    "};",
    "const __formatLogLine = (args) => args.map(__formatLogArg).join(' ');",
    "const __outputs = [];",
    "globalThis.__executor_outputs = __outputs;",
    "const __formatOutputText = (value) => {",
    "  if (typeof value === 'undefined') return 'undefined';",
    "  if (value === null) return 'null';",
    "  if (typeof value === 'string') return value;",
    "  try {",
    "    return JSON.stringify(value);",
    "  } catch {",
    "    return String(value);",
    "  }",
    "};",
    "const __isToolFile = (value) => value && typeof value === 'object' && value._tag === 'ToolFile' && typeof value.mimeType === 'string' && value.encoding === 'base64' && typeof value.data === 'string' && typeof value.byteLength === 'number';",
    "const __isMcpTextContentBlock = (value) => value && typeof value === 'object' && value.type === 'text' && typeof value.text === 'string';",
    "const __isMcpImageContentBlock = (value) => value && typeof value === 'object' && value.type === 'image' && typeof value.data === 'string' && typeof value.mimeType === 'string';",
    "const __isMcpAudioContentBlock = (value) => value && typeof value === 'object' && value.type === 'audio' && typeof value.data === 'string' && typeof value.mimeType === 'string';",
    "const __isMcpResourceContentBlock = (value) => value && typeof value === 'object' && value.type === 'resource' && value.resource && typeof value.resource === 'object' && typeof value.resource.uri === 'string' && (typeof value.resource.text === 'string' || typeof value.resource.blob === 'string');",
    "const __isMcpResourceLinkContentBlock = (value) => value && typeof value === 'object' && value.type === 'resource_link' && typeof value.uri === 'string' && typeof value.name === 'string';",
    "const __isMcpContentBlock = (value) => __isMcpTextContentBlock(value) || __isMcpImageContentBlock(value) || __isMcpAudioContentBlock(value) || __isMcpResourceContentBlock(value) || __isMcpResourceLinkContentBlock(value);",
    "const __toolsEnumerationError = (path) => new Error(",
    "  (path.length === 0 ? 'tools' : 'tools.' + path.join('.')) +",
    `    ' is a lazy proxy and cannot be enumerated. Use tools.search({ query: "..." }) to find tools, tools.search({ namespace: "<integration>", query: "" }) to list every tool in an integration, or tools.executor.coreTools.connections.list({}) to list saved connections.',`,
    ");",
    "const __makeToolsProxy = (path = []) => new Proxy(() => undefined, {",
    "  get(_target, prop) {",
    "    if (prop === 'then' || typeof prop === 'symbol') {",
    "      return undefined;",
    "    }",
    "    return __makeToolsProxy([...path, String(prop)]);",
    "  },",
    "  ownKeys() {",
    "    throw __toolsEnumerationError(path);",
    "  },",
    "  getOwnPropertyDescriptor() {",
    "    throw __toolsEnumerationError(path);",
    "  },",
    "  apply(_target, _thisArg, args) {",
    "    const toolPath = path.join('.');",
    "    if (!toolPath) {",
    "      throw new Error('Tool path missing in invocation');",
    "    }",
    "    return Promise.resolve(__invokeTool(toolPath, args[0])).then((raw) => raw === undefined ? undefined : JSON.parse(raw));",
    "  },",
    "});",
    "const tools = __makeToolsProxy();",
    "const console = {",
    "  log: (...args) => __log('log', __formatLogLine(args)),",
    "  warn: (...args) => __log('warn', __formatLogLine(args)),",
    "  error: (...args) => __log('error', __formatLogLine(args)),",
    "  info: (...args) => __log('info', __formatLogLine(args)),",
    "  debug: (...args) => __log('debug', __formatLogLine(args)),",
    "};",
    "(async () => {",
    body,
    "})()"
  ].join("\n");
};
var readPropDump = (context2, handle, key) => {
  const prop = context2.getProp(handle, key);
  try {
    return context2.dump(prop);
  } finally {
    prop.dispose();
  }
};
var readOutputItems = (context2) => {
  const output = readPropDump(context2, context2.global, "__executor_outputs");
  return Array.isArray(output) && output.length > 0 ? output : void 0;
};
var readResultState = (context2, handle) => ({
  settled: readPropDump(context2, handle, "settled") === true,
  value: readPropDump(context2, handle, "v"),
  error: readPropDump(context2, handle, "e")
});
var createLogBridge = (context2, logs, onLog) => context2.newFunction("__executor_log", (levelHandle, lineHandle) => {
  const level = context2.getString(levelHandle);
  const line = context2.getString(lineHandle);
  onLog?.(`[${level}] ${line}`);
  logs.push(`[${level}] ${line}`);
  return context2.undefined;
});
var createToolBridge = (context2, toolInvoker, pendingDeferreds, runPromise, deadline) => context2.newFunction("__executor_invokeTool", (pathHandle, argsHandle) => {
  const path = context2.getString(pathHandle);
  const args = argsHandle === void 0 || context2.typeof(argsHandle) === "undefined" ? void 0 : context2.dump(argsHandle);
  const deferred = context2.newPromise();
  pendingDeferreds.add(deferred);
  deferred.settled.finally(() => {
    pendingDeferreds.delete(deferred);
  });
  deadline.dispatchStarted();
  void runPromise(toolInvoker.invoke({ path, args })).then(
    (value) => {
      deadline.dispatchReturned();
      if (!deferred.alive) {
        return;
      }
      const serialized = serializeJson(value, `Tool result for ${path}`);
      if (typeof serialized === "undefined") {
        deferred.resolve();
        return;
      }
      const valueHandle = context2.newString(serialized);
      deferred.resolve(valueHandle);
      valueHandle.dispose();
    },
    (cause) => {
      deadline.dispatchReturned();
      if (!deferred.alive) {
        return;
      }
      const message = sandboxDefectMessage(cause);
      try {
        console.error("[executor:quickjs] tool dispatch defect", { path, cause });
      } catch {
      }
      const errorHandle = context2.newError(message);
      deferred.reject(errorHandle);
      errorHandle.dispose();
    }
  );
  return deferred.handle;
});
var drainJobs = (context2, runtime, deadline, timeoutMs) => {
  while (runtime.hasPendingJob()) {
    const deadlineMs = deadline.deadlineMs();
    if (deadlineMs !== null && Date.now() >= deadlineMs) {
      throw new Error(timeoutMessage(timeoutMs));
    }
    const pending = runtime.executePendingJobs(32);
    if (pending.error) {
      const error = context2.dump(pending.error);
      pending.error.dispose();
      throw toError(error);
    }
  }
};
var waitForDeferreds = async (pendingDeferreds, deadline, timeoutMs) => {
  const settled = Promise.race([...pendingDeferreds].map((deferred) => deferred.settled));
  const deadlineMs = deadline.deadlineMs();
  if (deadlineMs === null) {
    await settled;
    return;
  }
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(timeoutMessage(timeoutMs));
  }
  let timer;
  try {
    await Promise.race([
      settled,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage(timeoutMs))), remainingMs);
      })
    ]);
  } finally {
    if (timer !== void 0) {
      clearTimeout(timer);
    }
  }
};
var drainAsync = async (context2, runtime, pendingDeferreds, deadline, timeoutMs) => {
  drainJobs(context2, runtime, deadline, timeoutMs);
  while (pendingDeferreds.size > 0) {
    await waitForDeferreds(pendingDeferreds, deadline, timeoutMs);
    drainJobs(context2, runtime, deadline, timeoutMs);
  }
  drainJobs(context2, runtime, deadline, timeoutMs);
};
var evaluateInQuickJs = async (options, code, toolInvoker, runPromise) => {
  const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS2);
  const deadline = makeDeadlineTracker(timeoutMs);
  const logs = [];
  const pendingDeferreds = /* @__PURE__ */ new Set();
  const QuickJS = await resolveQuickJS();
  const runtime = QuickJS.newRuntime();
  try {
    runtime.setMemoryLimit(options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES2);
    runtime.setMaxStackSize(options.maxStackSizeBytes ?? DEFAULT_MAX_STACK_SIZE_BYTES2);
    runtime.setInterruptHandler(() => options.shouldInterrupt?.() || shouldInterruptAfterDeadline(deadline)());
    const context2 = runtime.newContext();
    try {
      const logBridge = createLogBridge(context2, logs, options.onLog);
      context2.setProp(context2.global, "__executor_log", logBridge);
      logBridge.dispose();
      const toolBridge = createToolBridge(
        context2,
        toolInvoker,
        pendingDeferreds,
        runPromise,
        deadline
      );
      context2.setProp(context2.global, "__executor_invokeTool", toolBridge);
      toolBridge.dispose();
      const evaluated = context2.evalCode(buildExecutionSource(code), EXECUTION_FILENAME);
      if (evaluated.error) {
        const error = context2.dump(evaluated.error);
        evaluated.error.dispose();
        return {
          result: null,
          error: normalizeExecutionError(error, deadline, timeoutMs),
          logs
        };
      }
      context2.setProp(context2.global, "__executor_result", evaluated.value);
      evaluated.value.dispose();
      const stateResult = context2.evalCode(
        "(function(p){ var s = { v: void 0, e: void 0, settled: false }; var formatError = function(e){ if (e && typeof e === 'object') { var message = typeof e.message === 'string' ? e.message : ''; var stack = typeof e.stack === 'string' ? e.stack : ''; if (message && stack) { return stack.indexOf(message) === -1 ? message + '\\n' + stack : stack; } if (message) return message; if (stack) return stack; } return String(e); }; p.then(function(v){ s.v = v; s.settled = true; }, function(e){ s.e = formatError(e); s.settled = true; }); return s; })(__executor_result)"
      );
      if (stateResult.error) {
        const error = context2.dump(stateResult.error);
        stateResult.error.dispose();
        return {
          result: null,
          error: normalizeExecutionError(error, deadline, timeoutMs),
          logs
        };
      }
      const stateHandle = stateResult.value;
      try {
        await drainAsync(context2, runtime, pendingDeferreds, deadline, timeoutMs);
        const state = readResultState(context2, stateHandle);
        if (!state.settled) {
          return {
            result: null,
            error: timeoutMessage(timeoutMs),
            output: readOutputItems(context2),
            logs
          };
        }
        if (typeof state.error !== "undefined") {
          return {
            result: null,
            error: normalizeExecutionError(state.error, deadline, timeoutMs),
            output: readOutputItems(context2),
            logs
          };
        }
        return {
          result: state.value,
          output: readOutputItems(context2),
          logs
        };
      } finally {
        stateHandle.dispose();
      }
    } finally {
      for (const deferred of pendingDeferreds) {
        if (deferred.alive) {
          deferred.dispose();
        }
      }
      pendingDeferreds.clear();
      context2.dispose();
    }
  } catch (cause) {
    return {
      result: null,
      error: normalizeExecutionError(cause, deadline, timeoutMs),
      logs
    };
  } finally {
    runtime.dispose();
  }
};
var runInQuickJs = (options, code, toolInvoker) => Effect2.gen(function* () {
  const context2 = yield* Effect2.context();
  const runPromise = Effect2.runPromiseWith(context2);
  return yield* Effect2.tryPromise({
    try: () => evaluateInQuickJs(options, code, toolInvoker, runPromise),
    catch: (cause) => new QuickJsExecutionError({ message: String(cause) })
  });
}).pipe(
  Effect2.withSpan("executor.code.exec.quickjs", {
    attributes: { "executor.runtime": "quickjs" }
  })
);
var makeQuickJsExecutor = (options = {}) => ({
  execute: (code, toolInvoker) => runInQuickJs(options, code, toolInvoker)
});
export {
  SealedBundleError,
  executeSealedBundle2 as executeSealedBundle,
  makeQuickJsExecutor,
  setQuickJSModule
};
