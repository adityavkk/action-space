/** Real remote MCP HTTP fixture, not a company registry or a compute-provider mock. */
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ElicitResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

export async function startMcpFixture(options: {
  port?: number;
  token: string;
  label: string;
  seed: number;
  file?: string;
}) {
  let writes = 0;
  let lists = 0;
  let interactions = 0;
  const sessions = new Map<
    string,
    { mcp: Server; transport: StreamableHTTPServerTransport }
  >();
  if (options.file) {
    try {
      writes = JSON.parse(await readFile(options.file, "utf8")).writes;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  }
  let persistence = Promise.resolve();
  const mutate = async () => {
    writes++;
    if (options.file) {
      const content = JSON.stringify({ writes });
      persistence = persistence.then(async () => {
        await mkdir(dirname(options.file!), { recursive: true });
        await writeFile(options.file!, content);
      });
      await persistence;
    }
  };
  const server = createServer(async (request, response) => {
    if (request.url === "/health") {
      response.end("ready");
      return;
    }
    if (request.headers.authorization !== `Bearer ${options.token}`) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (request.url === "/counter") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ writes, lists, interactions }));
      return;
    }
    if (request.url === "/redirect") {
      response.writeHead(307, { location: "/mcp" });
      response.end();
      return;
    }
    if (request.url !== "/mcp") {
      response.writeHead(404);
      response.end();
      return;
    }
    const session = request.headers["mcp-session-id"];
    if (typeof session === "string") {
      const existing = sessions.get(session);
      if (!existing) {
        response.writeHead(404);
        response.end();
        return;
      }
      await existing.transport.handleRequest(request, response);
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    const mcp = new Server(
      { name: `Action Space fixture ${options.label}`, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        sessions.set(id, { mcp, transport });
      },
    });
    const empty = {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    };
    const names = [
      "read",
      "write",
      "known_error",
      "lost_write",
      "interaction",
      "no_schema",
      "huge",
    ];
    mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      lists++;
      return {
        tools: names.map((name) => ({
          name,
          description: `${options.label} ${name}`,
          inputSchema:
            name === "write"
              ? {
                  ...empty,
                  properties: { amount: { type: "integer" } },
                  required: ["amount"],
                }
              : empty,
          ...(name === "read" || name === "write"
            ? {
                outputSchema: {
                  type: "object" as const,
                  properties: {
                    label: { type: "string" },
                    value: { type: "number" },
                    writes: { type: "integer" },
                  },
                  required: ["label", "value", "writes"],
                  additionalProperties: false,
                },
              }
            : {}),
        })),
      };
    });
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      if (params.name === "known_error")
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Fixture rejected the intention before mutation",
            },
          ],
        };
      if (params.name === "interaction") {
        interactions++;
        try {
          await mcp.request(
            {
              method: "elicitation/create",
              params: {
                message: "Approve fixture write",
                requestedSchema: { type: "object", properties: {} },
              },
            },
            ElicitResultSchema,
            { timeout: 1000 },
          );
        } catch {
          return {
            isError: true,
            content: [
              { type: "text" as const, text: "Interaction not accepted" },
            ],
          };
        }
        throw new Error("Fixture must not receive an accepted interaction");
      }
      if (params.name === "huge")
        return {
          content: [{ type: "text" as const, text: "x".repeat(512 * 1024) }],
        };
      if (params.name === "write" || params.name === "lost_write")
        await mutate();
      if (params.name === "lost_write") {
        await transport.close();
        return { content: [] };
      }
      if (params.name === "no_schema")
        return {
          content: [
            { type: "text" as const, text: `${options.label}:untyped` },
          ],
        };
      return {
        content: [],
        structuredContent: {
          label: options.label,
          value: options.seed + Number(params.arguments?.amount ?? 0),
          writes,
        },
      };
    });
    try {
      await mcp.connect(transport as Parameters<Server["connect"]>[0]);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture listen failed");
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    counts: () => ({ writes, lists, interactions }),
    close: async () => {
      await Promise.all([...sessions.values()].map((s) => s.mcp.close()));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const directory =
    process.env.ACTION_SPACE_SECRETS ?? "/run/action-space-secrets";
  const label = process.env.MCP_FIXTURE_LABEL ?? "red";
  const fixture = await startMcpFixture({
    port: 3001,
    label,
    seed: label === "red" ? 17 : 83,
    token: (await readFile(`${directory}/mcp-${label}-token`, "utf8")).trim(),
    file: `/fixture/${label}.json`,
  });
  process.once("SIGTERM", () => {
    void fixture.close();
  });
  console.log("Disposable remote MCP fixture ready; credentials not logged");
}
