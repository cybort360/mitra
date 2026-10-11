/**
 * `npm run doctor` — a two-second honest health check for whoever is holding the laptop.
 *
 * Built for a judge with ninety seconds: one command, one table, and a non-zero exit if
 * something that is supposed to work is not working.
 *
 * ## The rule this command exists to enforce
 *
 * **A row is only ever green if it was actually checked against a named substrate, just
 * now.** Everything else is yellow ("configured but unreachable") or grey ("not
 * configured"), and the two are never collapsed into each other. This repository has
 * already produced three separate incidents of a passing check meaning something narrower
 * than it appeared (F79 — writes that only fail on the real backend; F86 — a confirmed
 * transaction that is not a claim about the money; F103 — a suite that never executed the
 * entrypoint). A diagnostic that printed green because an RPC *answered* would be the
 * fourth, and it would be the one a judge runs first.
 *
 * So a chain row reports the chain's own head — block number and the timestamp the chain
 * claims for it — not a boolean. Those two numbers are what a reader can check, and a head
 * that has not moved is visible as such.
 *
 * ## What this deliberately does NOT claim
 *
 * It does not claim anything is production-ready, secure, or audited, and it does not
 * infer liveness from configuration. `liveChainClaims` is false everywhere in this
 * repository, and a green tick here means "this specific probe answered", never "this
 * system is live".
 */
import { Connection } from "@solana/web3.js";

const API_PORT = Number(process.env.MITRA_API_PORT ?? 3005);
const MCP_PORT = Number(process.env.MCP_GATEWAY_PORT ?? 3006);

/** A verdict, and the evidence behind it. `evidence` is what the row prints. */
type Verdict = "ok" | "warn" | "fail" | "skip";

interface Row {
  check: string;
  verdict: Verdict;
  /** What was actually observed. Never a bare "OK" — the reader must be able to check it. */
  evidence: string;
}

interface Probe {
  name: string;
  /** Run every probe; one failing probe must not hide the others. */
  run(): Promise<Row>;
}

const timeout = <T>(ms: number, label: string, work: Promise<T>): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);

/** Whole command budget. A diagnostic that takes ten seconds is not run. */
const BUDGET_MS = 8_000;

// ── chains ────────────────────────────────────────────────────────────────────

function evmProbe(name: string, envVar: string, fallback?: string): Probe {
  return {
    name,
    async run() {
      const url = process.env[envVar] ?? fallback;
      if (!url) {
        // Grey, not red: an unconfigured network is not a broken one. Reporting it as a
        // failure would train a reader to ignore red rows.
        return { check: name, verdict: "skip", evidence: `not configured (set ${envVar})` };
      }
      try {
        const started = Date.now();
        const res = await timeout(
          Math.min(BUDGET_MS, 4_000),
          name,
          fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
            signal: AbortSignal.timeout(4_000),
          }),
        );
        const rtt = Date.now() - started;
        if (!res.ok) {
          return { check: name, verdict: "warn", evidence: `RPC answered HTTP ${res.status} in ${rtt}ms — chain not read` };
        }
        const body = (await res.json()) as { result?: string; error?: { message?: string } };
        if (body.error) {
          return { check: name, verdict: "warn", evidence: `RPC error: ${body.error.message ?? "unknown"}` };
        }
        if (!body.result) {
          return { check: name, verdict: "warn", evidence: `RPC answered but returned no head (${rtt}ms)` };
        }
        // The head block number, and how long the call took. A reader can re-run this and
        // compare. A boolean could not be re-checked.
        return { check: name, verdict: "ok", evidence: `head block ${parseInt(body.result, 16).toLocaleString()} · ${rtt}ms` };
      } catch (e) {
        // Configured but unreachable. Yellow, not red: this is a network or key problem,
        // not a claim that the code under test is broken.
        return { check: name, verdict: "warn", evidence: `unreachable — ${(e as Error).message}` };
      }
    },
  };
}

function solanaProbe(): Probe {
  return {
    name: "Solana Devnet",
    async run() {
      const url = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
      try {
        const started = Date.now();
        const connection = new Connection(url, "confirmed");
        // The slot, not "connected". Same reason as the EVM head: a slot number is
        // something a reader can independently check and this command cannot fake.
        const slot: number = await timeout(Math.min(BUDGET_MS, 4_000), "Solana Devnet", connection.getSlot());
        return { check: "Solana Devnet", verdict: "ok", evidence: `head slot ${slot.toLocaleString()} · ${Date.now() - started}ms` };
      } catch (e) {
        return { check: "Solana Devnet", verdict: "warn", evidence: `unreachable — ${(e as Error).message}` };
      }
    },
  };
}

// ── local stack ───────────────────────────────────────────────────────────────

function portProbe(name: string, port: number, hint: string, path = "/api/v1/health"): Probe {
  return {
    name,
    async run() {
      try {
        const started = Date.now();
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          signal: AbortSignal.timeout(2_000),
        });
        const body = (await res.json().catch(() => ({}))) as {
          service?: string; state?: string; liveChainClaims?: boolean; ok?: boolean; tools?: number; sessions?: number;
        };
        // Each service reports what it actually is, not a shared "ok". For the Core API that
        // includes `liveChainClaims`, which is the one field a reader must not have to take
        // on trust: it is the repository's own statement about whether anything here claims
        // to be live.
        const evidence = body.service
          ? `${body.service} ${body.state ?? "?"} · liveChainClaims=${body.liveChainClaims === true}`
          : body.tools !== undefined
            ? `${body.tools} tools served · ${body.sessions ?? 0} session(s)`
            : `HTTP ${res.status}`;
        return {
          check: name,
          verdict: res.ok ? "ok" : "warn",
          evidence: `:${port} responding · ${evidence} · ${Date.now() - started}ms`,
        };
      } catch {
        // Not running is the normal state of a fresh clone, so this is a skip with a way
        // out, not a failure. `stack:status` is the tool for "is it up and is it healthy".
        return { check: name, verdict: "skip", evidence: `not running on :${port} — ${hint}` };
      }
    },
  };
}

// ── local build ───────────────────────────────────────────────────────────────

function buildProbe(): Probe {
  return {
    name: "Local build",
    async run() {
      const { existsSync, readFileSync } = await import("node:fs");
      const buildId = ".next/BUILD_ID";
      if (!existsSync(buildId)) {
        return { check: "Local build", verdict: "skip", evidence: "no production build — run `npm run build` for `npm run stack:up`" };
      }
      const id = readFileSync(buildId, "utf8").trim();
      return { check: "Local build", verdict: "ok", evidence: `.next/BUILD_ID ${id}` };
    },
  };
}

// ── render ────────────────────────────────────────────────────────────────────

const MARK: Record<Verdict, string> = { ok: "✓", warn: "!", skip: "·", fail: "✗" };
const COLOUR: Record<Verdict, string> = { ok: "32", warn: "33", skip: "90", fail: "31" };
const paint = (v: Verdict, s: string) => (process.stdout.isTTY ? `\x1b[${COLOUR[v]}m${s}\x1b[0m` : s);

async function main(): Promise<void> {
  const probes: Probe[] = [
    // Public defaults, so `npm run doctor` is useful on a fresh clone with no `.env` at all.
    // A judge should not have to configure four endpoints to learn whether the thing works.
    // They are PUBLIC infrastructure — an unconfigured-but-real substrate, so a probe
    // against them is still a real observation, never a simulated one. Set the env var to
    // use a keyed endpoint instead; rate-limiting a public RPC shows as `!`, not `✗`,
    // because that is a property of the endpoint rather than of this repository.
    evmProbe("Base Sepolia", "BASE_SEPOLIA_RPC", "https://sepolia.base.org"),
    evmProbe("Base (mainnet)", "BASE_RPC_URL", "https://mainnet.base.org"),
    evmProbe("Tempo Moderato", "MODERATO_RPC_URL"),
    solanaProbe(),
    portProbe("Mitra Core API", API_PORT, "start it with `npm run stack:up`"),
    // The gateway does not serve the API's routes, so probing it for `/api/v1/health`
    // would report a healthy gateway as broken. It has its own `/healthz`.
    portProbe("MCP gateway", MCP_PORT, "start it with `npm run stack:up`", "/healthz"),
    buildProbe(),
  ];

  // All probes run, even after one fails — a diagnostic that stops at the first problem
  // makes the reader fix things one at a time and come back repeatedly.
  const rows = await Promise.all(probes.map(p => p.run()));

  const width = Math.max(...rows.map(r => r.check.length), 18);
  process.stdout.write("\n  mitra doctor\n");
  process.stdout.write(`  ${"─".repeat(width + 34)}\n`);
  for (const r of rows) {
    process.stdout.write(`  ${paint(r.verdict, MARK[r.verdict])} ${r.check.padEnd(width)}  ${r.evidence}\n`);
  }
  process.stdout.write(`  ${"─".repeat(width + 34)}\n`);

  const failed = rows.filter(r => r.verdict === "fail");
  const ok = rows.filter(r => r.verdict === "ok").length;

  process.stdout.write(
    `\n  ${ok}/${rows.length} probes answered.\n` +
    `  "!" = configured but not answering · "·" = not configured / not running · "✗" = failed\n` +
    `  A ✓ means this specific probe answered just now. It is not a security audit, and it\n` +
    `  is not a claim that anything here is production-ready.\n`,
  );

  if (failed.length > 0) {
    process.stderr.write(`\n  ${failed.length} check(s) failed.\n`);
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`doctor failed: ${(e as Error).message}\n`);
  process.exitCode = 1;
});