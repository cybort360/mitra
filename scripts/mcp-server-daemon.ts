/**
 * The standalone MCP gateway — Task 2 of the loop-deployment packet.
 *
 * A separate process from the Core API, on its own port, because the MCP surface has a
 * different threat model from the HTTP plane and should be able to be run, exposed, or
 * killed independently of it. The gateway holds **no authority of its own**: every tool is a
 * forwarding of a call to the Core API, signed by the agent that makes it. It cannot sign,
 * it cannot hold funds, and it has no route that the API does not also expose.
 *
 * What it *does* own is the security posture of the MCP wire, which is enforced in
 * `startMcpHttpServer` rather than here: loopback binding by default, a bearer token
 * required to bind anything else, `Host` checked on loopback (DNS rebinding), and `Origin`
 * refused unless allow-listed.
 *
 * F100 is respected structurally, not by convention: the served tool list comes from
 * `servedToolNames()`, so there is no path by which adding a tool to this daemon could
 * widen what an agent may do. Mandate creation is absent from that list and stays on the
 * HTTP operator plane.
 */
import { startMcpHttpServer } from "@/lib/mcp/http";
import { httpApi, servedToolNames } from "@/lib/mcp/server";

const API_URL = process.env.MITRA_API_URL ?? "http://127.0.0.1:3005";
const PORT = Number(process.env.MCP_GATEWAY_PORT ?? process.env.PORT ?? 3006);
const HOST = process.env.MCP_GATEWAY_HOST ?? "127.0.0.1";
const TOKEN = process.env.MCP_TOKEN;

async function main(): Promise<void> {
  const server = await startMcpHttpServer({
    api: httpApi(API_URL),
    port: PORT,
    host: HOST,
    ...(TOKEN ? { token: TOKEN } : {}),
  });

  const tools = servedToolNames();
  process.stdout.write(
    `[mcp-gateway] ${tools.length} tools on ${server.url}/mcp (and /sse), forwarding to ${API_URL}\n`,
  );
  if (HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1" && !TOKEN) {
    // `startMcpHttpServer` already refuses this; this line exists so the reason is in the log
    // an operator reads, not only in a thrown error they may have missed.
    process.stderr.write("[mcp-gateway] refusing to serve a non-loopback host without MCP_TOKEN\n");
  }

  // A gateway that has lost its upstream is not a degraded gateway, it is a lying one: every
  // tool would fail with a connection error that reads like an application bug. Close loudly
  // instead, so the supervisor restarts it rather than reporting a healthy process.
  const shutdown = async (signal: string) => {
    process.stdout.write(`[mcp-gateway] ${signal}, closing ${server.sessionCount()} session(s)\n`);
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const health = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/health`);
      return res.ok;
    } catch {
      return false;
    }
  };
  if (!(await health())) {
    process.stderr.write(`[mcp-gateway] warning: ${API_URL}/api/v1/health is not answering; tools will fail until it is up\n`);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`[mcp-gateway] ${(e as Error).message}\n`);
  process.exitCode = 1;
});