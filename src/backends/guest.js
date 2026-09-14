/** Shared guest surface. This function's source is evaluated only in the selected isolate. */
export function guestSurface(bridge, appendLog, bounds) {
  const stringify = JSON.stringify.bind(JSON);
  const parse = JSON.parse.bind(JSON);
  const keys = Object.keys.bind(Object);
  const finite = Number.isFinite.bind(Number);
  const isArray = Array.isArray.bind(Array);
  const SetType = Set;
  const forbidden = new SetType([
    "__proto__",
    "prototype",
    "constructor",
    "caller",
    "callee",
    "arguments",
  ]);
  function encode(value, max) {
    const seen = new SetType();
    function visit(v, depth) {
      if (depth > 40) throw new Error("JSON_DEPTH");
      if (v === null || typeof v === "string" || typeof v === "boolean") return;
      if (typeof v === "number" && finite(v)) return;
      if (typeof v !== "object" || seen.has(v)) throw new Error("INVALID_JSON");
      seen.add(v);
      if (isArray(v)) {
        for (let i = 0; i < v.length; i++) visit(v[i], depth + 1);
      } else {
        for (const key of keys(v)) visit(v[key], depth + 1);
      }
      seen.delete(v);
    }
    visit(value, 0);
    const encoded = stringify(value);
    // UTF-8 <= three bytes per UTF-16 code unit; host checks actual bytes as well.
    if (encoded.length > max) throw new Error("OUTPUT_LIMIT");
    return encoded;
  }
  function proxy(parts) {
    return new Proxy(function () {}, {
      get(_target, name) {
        if (name === "then") return undefined;
        if (typeof name !== "string" || forbidden.has(name))
          throw new Error("INVALID_TOOL_PATH");
        return proxy(parts.concat(name));
      },
      apply(_target, _this, args) {
        if (args.length !== 1) throw new Error("INVALID_TOOL_ARGUMENTS");
        return bridge(
          parts.join("."),
          encode(args[0], bounds.argumentBytes),
        ).then(parse);
      },
      ownKeys() {
        throw new Error("TOOL_ENUMERATION_DENIED");
      },
      set() {
        throw new Error("TOOL_ASSIGNMENT_DENIED");
      },
      defineProperty() {
        throw new Error("TOOL_ASSIGNMENT_DENIED");
      },
      deleteProperty() {
        throw new Error("TOOL_ASSIGNMENT_DENIED");
      },
      setPrototypeOf() {
        throw new Error("TOOL_ASSIGNMENT_DENIED");
      },
      getPrototypeOf() {
        return null;
      },
    });
  }
  return {
    tools: proxy([]),
    console: Object.freeze({
      log(...values) {
        appendLog(encode(values, bounds.logBytes));
      },
    }),
    finish(value) {
      return encode(value === undefined ? null : value, bounds.resultBytes);
    },
  };
}
