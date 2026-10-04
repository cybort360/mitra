/**
 * The MCP server over the network (PRD Phase 5; the lead's handoff §2.2) — the same
 * `createMitraMcpServer` as stdio, behind an HTTP listener, for remote agents.
 *
 * ## Two wire formats, one port
 *
 * - `GET /sse` + `POST /messages?sessionId=…` — the HTTP+SSE transport the handoff
 *   names. The SDK marks it deprecated; older clients still speak only this.
 * - `/mcp` — Streamable HTTP, the transport current MCP clients speak.
 *
 * Every session gets its own `McpServer` (an SDK server binds one transport), and
 * every one is the thin client of the Mitra API that stdio serves: the network adds
 * reach, never authority. Withheld tools stay withheld.
 *
 * ## Who can connect
 *
 * The API has no caller identity yet (F55), so whoever reaches this port can do what
 * the served tools do — e.g. open an agreement naming any client. Over stdio that is
 * the local user; over a network it is whoever can connect. Hence:
 *
 * - it binds `127.0.0.1` unless told otherwise;
 * - it REFUSES to bind any other host without a bearer token (≥ 32 chars), checked
 *   in constant time on every request;
 * - on loopback, the `Host` header must name loopback (DNS rebinding: a web page
 *   that rebinds its own name to 127.0.0.1 still sends its own name as `Host`);
 * - a request carrying `Origin` (i.e. from a browser) is refused unless that origin
 *   is allowed explicitly.
 *
 * A token says "may connect". It is not "is agent X" — that is F55, still open.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMitraMcpServer, servedToolNames, type MitraApi } from "./server";

export interface McpHttpOptions {
  api: MitraApi;
  port: number;
  /** Default 127.0.0.1. Any non-loopback host requires `token`. */
  host?: string;
  /** Bearer token every request must carry. Required off loopback; at least 32 characters. */
  token?: string;
  /** Browser origins allowed to call (exact match, e.g. "https://console.example"). Default: none. */
  allowedOrigins?: string[];
  /** Extra `Host` header values accepted when bound to loopback (e.g. behind a local proxy). */
  allowedHosts?: string[];
  /** Concurrent sessions across both wire formats. Default 64. */
  maxSessions?: number;
  /** Largest POST body accepted, in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  /**
   * A Streamable HTTP session with no request for this long is closed. Default 15 min.
   * A client that walks away without `DELETE` would otherwise hold its slot forever,
   * and enough of them fill `maxSessions` for everyone. (SSE sessions end with their
   * connection, so they need no timer.)
   */
  idleMs?: number;
}

export interface McpHttpServer {
  url: string;
  sessionCount(): number;
  close(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
export const isLoopbackHost = (host: string) => LOOPBACK.has(host.replace(/^\[|\]$/g, ""));

const MIN_TOKEN_LENGTH = 32;
const digest = (s: string) => createHash("sha256").update(s).digest();

type Session =
  | { kind: "sse"; transport: SSEServerTransport; server: McpServer }
  | { kind: "streamable"; transport: StreamableHTTPServerTransport; server: McpServer; lastSeen: number };

function refuse(res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}) {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ error }));
}

class BodyTooLarge extends Error {}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startMcpHttpServer(opts: McpHttpOptions): Promise<McpHttpServer> {
  const host = opts.host ?? "127.0.0.1";
  const loopback = isLoopbackHost(host);
  if (opts.token !== undefined && opts.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`MCP_TOKEN_TOO_SHORT: a bearer token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  if (!loopback && !opts.token) {
    throw new Error(
      `MCP_TOKEN_REQUIRED_OFF_LOOPBACK: refusing to serve MCP on ${host} without a bearer token — ` +
      "the API has no caller identity (F55), so anyone who can connect could act as any party",
    );
  }
  const tokenDigest = opts.token ? digest(opts.token) : null;
  const allowedOrigins = new Set(opts.allowedOrigins ?? []);
  const maxSessions = opts.maxSessions ?? 64;
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
  const idleMs = opts.idleMs ?? 15 * 60_000;
  const sessions = new Map<string, Session>();
  let boundPort = opts.port;

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (s.kind === "streamable" && now - s.lastSeen > idleMs) {
        sessions.delete(id);
        void s.server.close();
      }
    }
  }, Math.min(idleMs, 60_000));
  sweep.unref();

  const hostAllowed = (header: string | undefined) => {
    if (!loopback) return true; // off loopback the token is the gate; Host is whatever name the proxy uses
    if (!header) return false;
    const names = ["127.0.0.1", "localhost", "[::1]"].map((h) => `${h}:${boundPort}`);
    return names.includes(header.toLowerCase()) || (opts.allowedHosts ?? []).includes(header.toLowerCase());
  };

  const authorized = (header: string | undefined) => {
    if (!tokenDigest) return true;
    const m = /^Bearer (.+)$/.exec(header ?? "");
    return Boolean(m) && timingSafeEqual(digest(m![1]), tokenDigest);
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!hostAllowed(req.headers.host)) return refuse(res, 403, "HOST_NOT_ALLOWED");
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) return refuse(res, 403, "ORIGIN_NOT_ALLOWED");
    if (!authorized(req.headers.authorization)) return refuse(res, 401, "UNAUTHORIZED", { "www-authenticate": "Bearer" });

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ ok: true, tools: servedToolNames().length, sessions: sessions.size }));
    }

    // ── legacy HTTP+SSE ─────────────────────────────────────────────────────────
    if (url.pathname === "/sse" && req.method === "GET") {
      if (sessions.size >= maxSessions) return refuse(res, 503, "TOO_MANY_SESSIONS");
      const transport = new SSEServerTransport("/messages", res);
      const server = createMitraMcpServer(opts.api);
      sessions.set(transport.sessionId, { kind: "sse", transport, server });
      transport.onclose = () => { sessions.delete(transport.sessionId); };
      res.on("close", () => { void server.close(); });
      await server.connect(transport);
      return;
    }
    if (url.pathname === "/messages" && req.method === "POST") {
      const s = sessions.get(url.searchParams.get("sessionId") ?? "");
      if (!s || s.kind !== "sse") return refuse(res, 404, "UNKNOWN_SESSION");
      const body = await readJson(req, maxBody);
      return void (await s.transport.handlePostMessage(req, res, body));
    }

    // ── Streamable HTTP ─────────────────────────────────────────────────────────
    if (url.pathname === "/mcp") {
      const id = req.headers["mcp-session-id"];
      const body = req.method === "POST" ? await readJson(req, maxBody) : undefined;
      if (typeof id === "string") {
        const s = sessions.get(id);
        if (!s || s.kind !== "streamable") return refuse(res, 404, "UNKNOWN_SESSION");
        s.lastSeen = Date.now();
        return void (await s.transport.handleRequest(req, res, body));
      }
      if (req.method !== "POST" || !isInitializeRequest(body)) return refuse(res, 400, "SESSION_REQUIRED");
      if (sessions.size >= maxSessions) return refuse(res, 503, "TOO_MANY_SESSIONS");
      const server = createMitraMcpServer(opts.api);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sid) => { sessions.set(sid, { kind: "streamable", transport, server, lastSeen: Date.now() }); },
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); void server.close(); };
      await server.connect(transport);
      return void (await transport.handleRequest(req, res, body));
    }

    return refuse(res, 404, "NOT_FOUND");
  }

  const http: Server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof BodyTooLarge) return refuse(res, 413, "BODY_TOO_LARGE");
      if (e instanceof SyntaxError) return refuse(res, 400, "INVALID_JSON");
      refuse(res, 500, "INTERNAL_ERROR");
    });
  });

  await new Promise<void>((ok, fail) => {
    http.once("error", fail);
    http.listen(opts.port, host, () => { http.off("error", fail); ok(); });
  });
  boundPort = (http.address() as AddressInfo).port;
  const shown = host.includes(":") ? `[${host}]` : host;

  return {
    url: `http://${shown}:${boundPort}`,
    sessionCount: () => sessions.size,
    async close() {
      clearInterval(sweep);
      await Promise.allSettled([...sessions.values()].map((s) => s.server.close()));
      sessions.clear();
      http.closeAllConnections();
      await new Promise<void>((ok) => http.close(() => ok()));
    },
  };
}
