/**
 * The outbound HTTP POST a webhook makes, and the SSRF guard around it (PP-3).
 *
 * A webhook makes Mitra's server send a request to a URL someone else chose. Left
 * unguarded, that is a way to reach whatever the server can reach: the cloud
 * metadata endpoint, a database's admin port, the loopback API. So:
 *
 * - the URL must be `https`, with no credentials in it;
 * - the address is checked inside the socket's DNS `lookup`, i.e. at connect
 *   time, against the address actually dialled. Checking the name once at
 *   registration and connecting later is the DNS-rebinding hole, and an IP
 *   literal never calls `lookup` at all, so literals are checked separately;
 * - loopback, private, link-local, CGNAT, multicast, reserved and the
 *   IPv4-mapped / NAT64 forms of those are refused;
 * - redirects are never followed (a 3xx is a failed delivery);
 * - every attempt has a timeout, and the response body is discarded unread.
 *
 * `MITRA_WEBHOOKS_ALLOW_PRIVATE=1` lifts the address and scheme checks for local
 * development only.
 */
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { fail, pass, type Result } from "@/lib/kernel/commerce";

/** POSTs `body`; resolves with the response status, rejects on a network failure or timeout. */
export type WebhookTransport = (url: string, body: string, headers: Record<string, string>, timeoutMs: number) => Promise<{ status: number }>;

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** Whether an address may never be a webhook target. Unparseable counts as forbidden. */
export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family !== 6) return true;
  const lower = address.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:XXXX:XXXX): judge the IPv4 address it carries.
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/.exec(lower);
  if (mapped) {
    const tail = mapped[1];
    if (isIP(tail) === 4) return blocked.check(tail, "ipv4");
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16 >>> 0) + parseInt(hex[2], 16);
      return blocked.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."), "ipv4");
    }
    return true;
  }
  return blocked.check(address, "ipv6");
}

const allowPrivate = () => process.env.MITRA_WEBHOOKS_ALLOW_PRIVATE === "1";

/** Registration-time check. The connect-time check in `safeTransport` still applies. */
export function checkWebhookUrl(raw: string, opts: { allowPrivate?: boolean } = {}): Result<URL> {
  const permissive = opts.allowPrivate ?? allowPrivate();
  let url: URL;
  try { url = new URL(raw); } catch { return fail("URL_INVALID"); }
  if (url.protocol !== "https:" && !(permissive && url.protocol === "http:")) return fail("URL_SCHEME_NOT_HTTPS");
  if (url.username || url.password) return fail("URL_HAS_CREDENTIALS");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!permissive) {
    if (isIP(host) && isForbiddenAddress(host)) return fail("URL_TARGET_FORBIDDEN");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return fail("URL_TARGET_FORBIDDEN");
  }
  return pass(url);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A `lookup` for the socket that refuses forbidden addresses after resolution. */
function guardedLookup(hostname: string, options: { all?: boolean; family?: number } | number, cb: LookupCallback) {
  const opts = typeof options === "number" ? { family: options } : options ?? {};
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return cb(err, "");
    const bad = addresses.find((a) => isForbiddenAddress(a.address));
    if (bad) {
      const e: NodeJS.ErrnoException = new Error(`WEBHOOK_TARGET_FORBIDDEN: ${hostname} resolves to ${bad.address}`);
      e.code = "WEBHOOK_TARGET_FORBIDDEN";
      return cb(e, "");
    }
    if (opts.all) return cb(null, addresses);
    cb(null, addresses[0].address, addresses[0].family);
  });
}

/** The production transport. */
export function safeTransport(opts: { allowPrivate?: boolean } = {}): WebhookTransport {
  return (rawUrl, body, headers, timeoutMs) => new Promise((resolve, reject) => {
    const permissive = opts.allowPrivate ?? allowPrivate();
    const checked = checkWebhookUrl(rawUrl, { allowPrivate: permissive });
    if (!checked.ok) return reject(new Error(checked.reason));
    // checkWebhookUrl has refused forbidden IP literals, which never reach `lookup`.
    const url = checked.value;
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(body).toString(), "user-agent": "mitra-webhooks/1" },
      ...(permissive ? {} : { lookup: guardedLookup as never }),
    }, (res) => {
      res.resume(); // discard the body unread
      resolve({ status: res.statusCode ?? 0 });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("WEBHOOK_TIMEOUT")));
    req.on("error", reject);
    req.end(body);
  });
}
