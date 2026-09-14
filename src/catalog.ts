import { Effect, Schema } from "effect";
import { Ajv2020 } from "ajv/dist/2020.js";
import { compile } from "json-schema-to-typescript";
import { Fault, type Auth, type ExecutionError, type Json } from "./domain.js";
import { canonical, hash, json } from "./util.js";
import { external } from "./effects.js";
export type ToolContext = { auth: Auth; workId: string };
export type Tool = {
  path: string;
  version: string;
  description: string;
  effect: "read" | "write";
  grant: string;
  approval: boolean;
  inputSchema: object;
  outputSchema: object;
  invoke: (
    input: Json,
    context: ToolContext,
  ) => Effect.Effect<Json, ExecutionError>;
};
export function defineTool<
  I extends Schema.Constraint & { DecodingServices: never },
  O extends Schema.Constraint,
>(
  spec: Omit<Tool, "inputSchema" | "outputSchema" | "invoke"> & {
    input: I;
    output: O;
    invoke: (
      input: I["Type"],
      context: ToolContext,
    ) => Effect.Effect<O["Type"], ExecutionError>;
  },
): Tool {
  return {
    ...spec,
    inputSchema: Schema.toJsonSchemaDocument(spec.input).schema,
    outputSchema: Schema.toJsonSchemaDocument(spec.output).schema,
    invoke: Effect.fn(`Connector.${spec.path}`)(function* (input, context) {
      const parsed = yield* Schema.decodeUnknownEffect(spec.input)(input, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => new Fault("INVALID_TOOL_INPUT")));
      const result = yield* spec.invoke(parsed, context);
      return yield* Effect.try({
        try: () => json(result, 256 * 1024),
        catch: () => new Fault("INVALID_TOOL_OUTPUT"),
      });
    }),
  };
}
export class Catalog {
  readonly revision: string;
  private readonly validators = new Map<
    string,
    {
      input: ReturnType<Ajv2020["compile"]>;
      output: ReturnType<Ajv2020["compile"]>;
    }
  >();
  private readonly descriptions = new Map<string, Json>();
  private constructor(readonly tools: Tool[]) {
    const ajv = new Ajv2020({
      strict: true,
      allErrors: false,
      coerceTypes: false,
    });
    for (const tool of tools) {
      if (
        !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(tool.path) ||
        tool.path
          .split(".")
          .some((x) =>
            [
              "constructor",
              "prototype",
              "__proto__",
              "then",
              "search",
              "describe",
            ].includes(x),
          ) ||
        this.validators.has(tool.path)
      )
        throw new Fault("INVALID_CATALOG_PATH");
      this.validators.set(tool.path, {
        input: ajv.compile(tool.inputSchema),
        output: ajv.compile(tool.outputSchema),
      });
    }
    this.revision = hash(
      canonical(tools.map(({ invoke: _, ...tool }) => tool)),
    );
  }
  static build = Effect.fn("Catalog.build")(function* (tools: Tool[]) {
    const catalog = new Catalog(tools);
    for (const tool of tools) {
      const inputTypeScript = yield* external("Catalog.generateInput", () =>
        compile(tool.inputSchema, "Input", { bannerComment: "" }),
      );
      const outputTypeScript = yield* external("Catalog.generateOutput", () =>
        compile(tool.outputSchema, "Output", { bannerComment: "" }),
      );
      catalog.descriptions.set(
        tool.path,
        json(
          {
            catalog: catalog.revision,
            path: tool.path,
            version: tool.version,
            effect: tool.effect,
            inputTypeScript,
            outputTypeScript,
            signature: `tools[${JSON.stringify(tool.path)}](input: Input): Promise<ToolResult<Output>>`,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            returns: "value",
            waitMs: 1000,
            semantics: tool.description,
          },
          256 * 1024,
        ),
      );
    }
    return catalog;
  });
  tool(path: string): Tool {
    const tool = this.tools.find((x) => x.path === path);
    if (!tool) throw new Fault("UNKNOWN_TOOL");
    return tool;
  }
  check(path: string, direction: "input" | "output", input: unknown): void {
    if (!this.validators.get(path)?.[direction](input))
      throw new Fault(
        direction === "input" ? "INVALID_TOOL_INPUT" : "INVALID_TOOL_OUTPUT",
      );
  }
  search(query: string, limit: number, grants: string[]): Json {
    const words = query.toLowerCase().split(/\W+/).filter(Boolean);
    const ranked = this.tools
      .filter((x) => grants.includes(x.grant))
      .map((tool) => ({
        tool,
        score: words.reduce(
          (score, word) =>
            score +
            (tool.path.toLowerCase().includes(word)
              ? 3
              : tool.description.toLowerCase().includes(word)
                ? 1
                : 0),
          0,
        ),
      }))
      .filter((x) => !words.length || x.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.tool.path.localeCompare(b.tool.path),
      );
    return {
      catalog: this.revision,
      incomplete: ranked.length > limit,
      items: ranked.slice(0, limit).map(({ tool }) => ({
        path: tool.path,
        description: tool.description,
        effect: tool.effect,
      })),
    };
  }
  describe(path: string, grants: string[]): Json {
    const tool = this.tool(path);
    if (!grants.includes(tool.grant)) throw new Fault("DENIED");
    return this.descriptions.get(path) ?? null;
  }
}
