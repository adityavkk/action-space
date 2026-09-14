import assert from "node:assert/strict";
import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import { WorkSchema } from "../src/schemas.js";
import type { CodeOutput, Json } from "../src/domain.js";

/** Repeatable real HTTP demo; stable write key survives container/API/PostgreSQL restart. */
export async function mcpJourney(
  environment: Record<string, string | undefined>,
) {
  const base = environment.ACTION_SPACE_URL ?? "http://127.0.0.1:3000";
  const a = environment.ACTION_SPACE_TOKEN!,
    b = environment.MCP_BLUE_API_TOKEN!;
  const request = async (
    token: string,
    path: string,
    method = "GET",
    body?: unknown,
    key = "",
  ) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await response.json()) as Record<string, any>;
    assert.ok(response.ok, `API rejected ${path}: ${data.error}`);
    return data;
  };
  for (const [token, connections] of [
    [a, ["red"]],
    [b, ["blue"]],
  ] as const) {
    const current = await request(token, "/v1/thread/tools");
    if (current.revision === 0)
      await request(token, "/v1/thread/tools", "PUT", {
        expectedRevision: 0,
        connections,
      });
    else
      assert.deepEqual(
        current.connections,
        connections,
        "Demo will not overwrite existing thread defaults",
      );
  }
  const run = async (
    token: string,
    code: string,
    key: string,
    connections?: string[],
  ) => {
    const submitted = await request(
      token,
      "/v1/execute",
      "POST",
      { code, ...(connections ? { connections } : {}) },
      key,
    );
    const work = Schema.decodeUnknownSync(WorkSchema)(
      await request(token, `/v1/work/${submitted.work.id}?waitMs=10000`),
    );
    assert.equal(work.state.phase, "settled");
    if (
      work.state.phase !== "settled" ||
      work.state.outcome.kind !== "completed"
    )
      throw new Error(JSON.stringify(work.state));
    assert.equal(work.state.children.length, 0);
    return {
      work,
      result: (work.state.outcome.output as CodeOutput).result as Record<
        string,
        any
      >,
    };
  };
  const code =
    'const c=await tools.search({query:"red write"});const t=await tools.describe.tool({path:"mcp.red.write"});console.log("fixture mutation");return {typed:t.inputTypeScript.includes("amount"),paths:c.items.map(x=>x.path),write:await tools.mcp.red.write({amount:-6})};';
  const write = await run(a, code, "mcp-demo-v1/write");
  assert.equal(write.result.typed, true);
  assert.ok(write.result.paths.includes("mcp.red.write"));
  assert.equal(write.result.write.ok, true);
  assert.equal(write.result.write.data.value, 11);
  const duplicate = await run(a, code, "mcp-demo-v1/write");
  assert.equal(duplicate.work.id, write.work.id);
  assert.deepEqual(duplicate.result, write.result);
  assert.equal(duplicate.work.lease?.generation, 1);
  const inspectCode =
    'const c=await tools.search({query:"read"});return {paths:c.items.filter(x=>x.path.startsWith("mcp.")).map(x=>x.path),read:await tools.mcp.blue.read({})};';
  const override = await run(
    a,
    inspectCode,
    `mcp-demo-v1/override/${randomUUID()}`,
    ["blue"],
  );
  assert.deepEqual(override.result.paths, ["mcp.blue.read"]);
  assert.equal(override.result.read.data.value, 83);
  const other = await run(b, inspectCode, `mcp-demo-v1/tenant/${randomUUID()}`);
  assert.deepEqual(other.result, override.result);
  const live = await run(
    a,
    "return await tools.mcp.red.read({})",
    `mcp-demo-v1/fresh/${randomUUID()}`,
  );
  assert.equal(
    live.result.data.writes,
    write.result.write.data.writes,
    "Duplicate demo submissions must not increment the remote counter",
  );
  assert.deepEqual((await request(a, "/v1/thread/tools")).connections, ["red"]);
  const denied = await fetch(`${base}/v1/execute`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${b}`,
      "content-type": "application/json",
      "idempotency-key": `denied/${randomUUID()}`,
    },
    body: JSON.stringify({ code: "return 1", connections: ["red"] }),
  });
  assert.equal(denied.status, 409);
  assert.equal(
    ((await denied.json()) as { error: string }).error,
    "MCP_CONNECTION_DENIED",
  );
  console.log(
    JSON.stringify({
      result: "PASS",
      engine: "Executor 1.6.8 / QuickJS",
      work: write.work.id,
      output: 11,
      remoteWriteCount: live.result.data.writes,
      otherTenantValue: 83,
      duplicateAttempt: 1,
      childWork: 0,
      replacement: "verified",
      threadDefaults: "unchanged",
    } satisfies Record<string, Json>),
  );
}
