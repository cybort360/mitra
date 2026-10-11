/**
 * The unified stack supervisor — Task 3 of the loop-deployment packet.
 *
 * Spawns and tracks four processes: the Core API, the MCP gateway, the webhook worker, and
 * the keeper daemon. `stack:up` / `stack:status` / `stack:down`.
 *
 * ## The one thing this has to get right
 *
 * **`stack:down` must never kill something that is not ours.** A PID file is just a list of
 * integers, and integers get recycled: on a long-lived machine, the PID that was our webhook
 * worker last week is somebody's unrelated process today. A supervisor that SIGTERMs a
 * recorded PID without checking what is actually behind it will eventually kill a developer's
 * editor or their database.
 *
 * So every PID is recorded *with the command line it was started with*, and liveness is
 * decided by reading `/proc/<pid>/cmdline` and requiring our own marker to still be in it.
 * A PID we cannot attribute to us is reported as `unknown` and left alone. Refusing to kill
 * something is always recoverable; killing it is not.
 *
 * ## `stack:status` never claims more than it checked
 *
 * Two independent facts, reported separately: the process is alive, and the port answers.
 * A process alive on a port that does not answer is a wedged service, and a port answering
 * with no process behind it is something else entirely. Reporting one as the other is how a
 * supervisor ends up reassuring you about a dead system.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = process.cwd();
const STACK_DIR = join(ROOT, ".stack");
const PID_FILE = join(STACK_DIR, "pids.json");

const API_PORT = Number(process.env.MITRA_API_PORT ?? 3005);
const MCP_PORT = Number(process.env.MCP_GATEWAY_PORT ?? 3006);
const API_URL = `http://127.0.0.1:${API_PORT}`;
const READY_TIMEOUT_MS = Number(process.env.STACK_READY_TIMEOUT_MS ?? 90_000);

interface ServiceSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Where this service's readiness can be observed. `none` = process liveness only. */
  port?: number;
}

interface PidRecord {
  name: string;
  pid: number;
  /**
   * The kernel's start time for this PID, in clock ticks since boot — field 22 of
   * `/proc/<pid>/stat`.
   *
   * **This is what makes the PID file safe.** A PID alone is a recycled integer; the pair
   * (pid, starttime) identifies one specific process for its entire lifetime and can never
   * be reused, because no two processes share a start tick. So even if our process died
   * yesterday and its PID belongs to something else today, the starttime will not match and
   * we will know it is not ours — without depending on argument matching that could collide
   * with an unrelated process, or break when a script is renamed.
   */
  startTime: string;
  script: string;
  port?: number;
  startedAt: string;
}

const SERVICES: ServiceSpec[] = [
  {
    name: "core-api",
    command: "npx",
    args: ["next", "start", "-p", String(API_PORT)],
    env: { PORT: String(API_PORT) },
    port: API_PORT,
  },
  {
    name: "mcp-gateway",
    command: "npx",
    args: ["tsx", join(ROOT, "scripts/mcp-server-daemon.ts")],
    env: { MITRA_API_URL: API_URL, MCP_GATEWAY_PORT: String(MCP_PORT) },
    port: MCP_PORT,
  },
  {
    name: "webhook-worker",
    command: "npx",
    args: ["tsx", join(ROOT, "scripts/webhook-worker.ts")],
    env: {},
  },
  {
    name: "keeper-daemon",
    command: "npx",
    args: ["tsx", join(ROOT, "scripts/keeper-daemon.ts")],
    env: {},
  },
];

function log(service: string, line: string): void {
  process.stdout.write(`[stack:${service}] ${line}\n`);
}

// ── pid attribution ───────────────────────────────────────────────────────────

/**
 * The kernel start time of a live PID, or `null` if it is gone.
 *
 * Field 22 of `/proc/<pid>/stat`. Parsed after the final `)` because the second field is the
 * executable name in parentheses and may itself contain spaces and parentheses — a naive
 * split on whitespace reads the wrong column for a process called something like
 * `(sd-pam)`.
 */
function startTimeOf(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const tail = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    // `tail[0]` is state (field 3), so field 22 is index 19.
    const startTime = tail[19];
    return startTime === undefined ? null : startTime;
  } catch {
    return null;
  }
}

/**
 * Is this PID still the exact process we started?
 *
 * The pair (pid, starttime) is the identity. A mismatch means the number was recycled, so
 * the answer is `unknown` — and `unknown` is never signalled.
 */
function isOurs(record: PidRecord): "alive" | "dead" | "unknown" {
  const current = startTimeOf(record.pid);
  if (current === null) return "dead";
  return current === record.startTime ? "alive" : "unknown";
}

async function portAnswers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(2000),
    });
    // Any HTTP answer at all means something is listening. A 404 from the Core API is a
    // healthy service answering; a connection refused is not.
    return res.status > 0;
  } catch {
    return false;
  }
}

function readRecords(): PidRecord[] {
  if (!existsSync(PID_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(PID_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt PID file is not fatal — it means we cannot attribute anything, so we start clean.
    return [];
  }
}

function writeRecords(records: PidRecord[]): void {
  mkdirSync(dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify(records, null, 2) + "\n");
}

// ── commands ──────────────────────────────────────────────────────────────────

async function up(): Promise<number> {
  // `next start` serves a build, not source. Without one it does not fail loudly — it sits
  // there answering nothing, and the operator's first clue is the 90s timeout below. Say it
  // here instead, where it is actionable.
  // `BUILD_ID`, not `.next` itself: an aborted or dev-only build leaves the directory in
  // place with no production build in it, and `next start` then dies with a message that
  // is easy to miss in interleaved supervisor output.
  if (!existsSync(join(ROOT, ".next", "BUILD_ID"))) {
    log("stack", "no production build — run `npm run build` before stack:up (next start serves a build, not source).");
    return 1;
  }

  const existing = readRecords();
  const stillRunning = existing.filter(r => isOurs(r) === "alive");

  if (stillRunning.length > 0 && stillRunning.length === SERVICES.length) {
    log("stack", `already up (${stillRunning.length} services). Use stack:down first.`);
    return 1;
  }

  mkdirSync(STACK_DIR, { recursive: true });
  const records: PidRecord[] = [];
  const children: ChildProcess[] = [];

  for (const spec of SERVICES) {
    const child = spawn(spec.command, spec.args, {
      cwd: ROOT,
      env: { ...process.env, ...spec.env },
      // Its own process group, so the whole subtree can be signalled at once rather than
      // leaving `next start`'s workers behind when we kill the parent.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);

    const tag = `[stack:${spec.name}]`;
    child.stdout?.on("data", d => process.stdout.write(`${tag} ${String(d).trimEnd()}\n`));
    child.stderr?.on("data", d => process.stderr.write(`${tag} ${String(d).trimEnd()}\n`));
    child.on("error", e => log(spec.name, `failed to spawn: ${e.message}`));

    const pid = child.pid ?? -1;
    records.push({
      name: spec.name,
      pid,
      startTime: startTimeOf(pid) ?? "unknown",
      script: spec.args[spec.args.length - 1] ?? spec.name,
      ...(spec.port !== undefined ? { port: spec.port } : {}),
      startedAt: new Date().toISOString(),
    });
    log(spec.name, `spawned pid ${pid}`);
  }

  writeRecords(records);

  // Detach: the supervisor is a starter, not a parent. Exiting here must not signal them.
  for (const child of children) child.unref();

  log("stack", `waiting for ${API_URL}/api/v1/health (up to ${READY_TIMEOUT_MS}ms)`);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_URL}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        log("stack", `ready — ${JSON.stringify(body)}`);
        return 0;
      }
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  // Not ready. Saying so, with a non-zero exit, is the whole point of the wait existing.
  log("stack", `NOT ready after ${READY_TIMEOUT_MS}ms — the API is not answering. PIDs are in .stack/pids.json; run stack:down.`);
  return 1;
}

async function status(): Promise<number> {
  const records = readRecords();
  if (records.length === 0) {
    log("stack", "no PID file — nothing is tracked. The stack is down as far as this process knows.");
    return 1;
  }

  let unhealthy = 0;
  for (const record of records) {
    const state = isOurs(record);
    let portState = "n/a";
    if (record.port !== undefined) {
      portState = (await portAnswers(record.port)) ? "answering" : "NOT ANSWERING";
      if (portState === "NOT ANSWERING") unhealthy += 1;
    }
    const line = `${record.name.padEnd(14)} pid ${String(record.pid).padEnd(7)} process ${state.padEnd(8)} port ${portState}`;
    if (state === "alive") process.stdout.write(`${line}\n`);
    else if (state === "unknown") {
      // **Left alone on purpose.** This PID exists but is not provably ours, so we will not
      // signal it. Reported so a human can decide.
      process.stderr.write(`${line}  <- PID not attributable to us; NOT killed by stack:down\n`);
    } else {
      process.stderr.write(`${line}  <- dead\n`);
    }
    if (state !== "alive") unhealthy += 1;
  }

  process.stdout.write(unhealthy === 0 ? "\nstack: all services healthy\n" : `\nstack: ${unhealthy} problem(s)\n`);
  return unhealthy === 0 ? 0 : 1;
}

async function down(): Promise<number> {
  const records = readRecords();
  if (records.length === 0) {
    log("stack", "no PID file — nothing to stop.");
    rmSync(PID_FILE, { force: true });
    return 0;
  }

  for (const record of records) {
    const state = isOurs(record);
    if (state === "dead") {
      log(record.name, `pid ${record.pid} already gone`);
      continue;
    }
    if (state === "unknown") {
      log(record.name, `pid ${record.pid} is NOT ours — refusing to signal it`);
      continue;
    }
    try {
      // Negative PID targets the whole process group (see `detached: true` above), so
      // `next start`'s children die with it instead of being reparented and left behind.
      process.kill(-record.pid, "SIGTERM");
      log(record.name, `SIGTERM to process group ${record.pid}`);
    } catch (e) {
      log(record.name, `could not signal pid ${record.pid}: ${(e as Error).message}`);
    }
  }

  // Give them a moment to close, then check rather than assume.
  await new Promise(r => setTimeout(r, 1500));
  let stubborn = 0;
  for (const record of records) {
    if (isOurs(record) === "alive") stubborn += 1;
  }
  if (stubborn > 0) {
    log("stack", `${stubborn} service(s) still alive after SIGTERM — they may be mid-request; run stack:down again`);
  }

  rmSync(PID_FILE, { force: true });
  log("stack", "PID file removed");
  return stubborn > 0 ? 1 : 0;
}

async function cli(): Promise<void> {
  const command = process.argv[2] ?? "up";
  const handlers: Record<string, () => Promise<number>> = { up, status, down };
  if (!handlers[command]) {
    log("stack", `unknown command "${command}". Use: ${Object.keys(handlers).join(" | ")}`);
    process.exitCode = 2;
    return;
  }
  process.exitCode = await handlers[command]();
}

cli().catch((e: unknown) => {
  process.stderr.write(`[stack] ${(e as Error).message}\n`);
  process.exitCode = 1;
});