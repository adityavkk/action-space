import { WorkerEntrypoint } from "cloudflare:workers";
import { guestSurface } from "../../src/backends/guest.js";

// This is a DEPLOYED trusted gateway Worker with a LOADER binding, not a Cloudflare REST sandbox API.
export class Broker extends WorkerEntrypoint {
  async request(body) {
    const { brokerUrl, channel, deadline, argumentBytes, resultBytes } =
      this.ctx.props;
    if (Date.now() >= deadline) throw new Error("CHANNEL_CLOSED");
    const encoded = JSON.stringify(body);
    if (new TextEncoder().encode(encoded).length > argumentBytes + 2048)
      throw new Error("ARGUMENT_LIMIT");
    const response = await fetch(brokerUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${channel}`,
        "content-type": "application/json",
      },
      body: encoded,
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (!response.ok) throw new Error("COMPOSITION_INTERRUPTED");
    const text = await response.text();
    if (new TextEncoder().encode(text).length > resultBytes)
      throw new Error("OUTPUT_LIMIT");
    return text;
  }
}
export function workerCode(input, broker) {
  return {
    compatibilityDate: "2026-09-12",
    mainModule: "agent.js",
    globalOutbound: null,
    limits: { cpuMs: input.bounds.cpuMs, subRequests: input.bounds.calls + 1 },
    env: { BROKER: broker },
    modules: {
      // Separate module scope: agent source cannot capture env, the raw broker or request IDs.
      "program.js": `export default async function(tools, console) { return await ${input.program}; }`,
      "agent.js": `
    import program from './program.js';
    export default {async fetch(_request, env) {
      const logs=[]; const pending=[]; let logBytes=0; let sequence=0;
      const surface=(${guestSurface.toString()})(
        (path, payload)=>env.BROKER.request({kind:'call',requestId:String(sequence++),path,input:JSON.parse(payload)}),
        line=>{logBytes+=new TextEncoder().encode(line).length;if(logBytes>${input.bounds.logBytes})throw new Error('LOG_LIMIT');logs.push(line);pending.push(env.BROKER.request({kind:'log',line}));},
        ${JSON.stringify(input.bounds)});
      const result=await program(surface.tools, surface.console);
      await Promise.all(pending);
      return Response.json({result:JSON.parse(surface.finish(result)),logs,artifacts:[]});
    }}
  `,
    },
  };
}
export default {
  async fetch(request, env, ctx) {
    if (
      request.method !== "POST" ||
      request.headers.get("authorization") !== `Bearer ${env.GATEWAY_TOKEN}`
    )
      return new Response("Unauthorized", { status: 401 });
    const body = await request.text();
    if (body.length > 100_000)
      return new Response("Too large", { status: 413 });
    const input = JSON.parse(body);
    // Only authenticated control-plane traffic can supply programs and limits. The guest never gets these credentials.
    if (input.brokerUrl !== env.BROKER_URL || Date.now() >= input.deadline)
      return new Response("Invalid channel", { status: 403 });
    const broker = ctx.exports.Broker({
      props: {
        brokerUrl: env.BROKER_URL,
        channel: input.channel,
        deadline: input.deadline,
        argumentBytes: input.bounds.argumentBytes,
        resultBytes: input.bounds.resultBytes,
      },
    });
    const worker = env.LOADER.load(workerCode(input, broker));
    try {
      return await worker
        .getEntrypoint()
        .fetch(new Request("https://guest.invalid/"));
    } catch {
      return new Response("Composition interrupted; inspect Work", {
        status: 409,
      });
    }
  },
};
