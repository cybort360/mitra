import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./hash.js";
import type { ContextStore } from "./store.js";
import type { MergeReport, SyncBundle } from "./types.js";

export interface SyncAgentOptions {
  store: ContextStore;
  /** Directory shared between participants (git repo, synced folder, NFS). */
  dir: string;
  intervalMs?: number;
  /** Logging sink. Defaults to stderr — stdout is the MCP transport. */
  log?: (msg: string) => void;
}

export interface SyncStatus {
  enabled: boolean;
  dir?: string;
  lastExport?: string;
  lastImport?: string;
  peers: { nodeId: string; entries: number; appliedAt: string }[];
  applied: number;
  conflicts: number;
  orphans: number;
}

const PREFIX = "ctxbundle-";
const SUFFIX = ".json";

/**
 * Filesystem-based auto-sync.
 *
 * Each node publishes its whole log as one JSON file named after itself. Peers
 * poll the directory and merge anything they have not seen. This keeps the
 * transport trivial — a git repo, Dropbox, a shared volume — with no server to
 * run and no network protocol to reason about.
 *
 * Correctness rests on two properties the store already guarantees: merging is
 * additive and idempotent, and every entry is content-addressed. Applying a
 * bundle twice is a no-op and two nodes publishing the same entry converge
 * without coordination.
 */
export class SyncAgent {
  private readonly store: ContextStore;
  private readonly dir: string;
  private readonly intervalMs: number;
  private readonly log: (msg: string) => void;
  /** Bundle digests already applied, keyed by filename. Prevents re-merging. */
  private readonly seen = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private pulling = false;
  private dirty = false;
  private status: SyncStatus = { enabled: false, peers: [], applied: 0, conflicts: 0, orphans: 0 };

  constructor(opts: SyncAgentOptions) {
    this.store = opts.store;
    this.dir = opts.dir;
    this.intervalMs = opts.intervalMs ?? 3000;
    this.log = opts.log ?? ((m) => process.stderr.write(`[shared-context:sync] ${m}\n`));
  }

  private get file(): string {
    return join(this.dir, `${PREFIX}${this.store.nodeId}${SUFFIX}`);
  }

  /** Mark the local log dirty; the next tick publishes it. */
  touch(): void {
    this.dirty = true;
  }

  start(): SyncStatus {
    if (this.running) return this.status;
    mkdirSync(this.dir, { recursive: true });
    this.running = true;
    this.status = { ...this.status, enabled: true, dir: this.dir };
    // Publish and pull immediately so a restart converges before first use.
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    this.log(`auto-sync active dir=${this.dir} interval=${this.intervalMs}ms`);
    return this.status;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.running = false;
  }

  getStatus(): SyncStatus {
    return { ...this.status, peers: [...this.status.peers] };
  }

  /** Run one publish/import cycle. */
  tick(): void {
    if (this.pulling) return;
    this.pulling = true;
    try {
      this.importPeers();
      if (this.dirty || this.needsPublish()) this.publish();
    } catch (err) {
      this.log(`sync error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.pulling = false;
    }
  }

  /** Publish when our on-disk bundle differs from what peers would see. */
  private needsPublish(): boolean {
    if (!existsSync(this.file)) return true;
    return sha256(JSON.stringify(this.store.exportBundle(0).entries)) !== this.seen.get(this.file);
  }

  /**
   * Write our bundle atomically: temp file plus rename, so a peer polling at the
   * wrong moment never reads a half-written document.
   */
  publish(): void {
    const bundle = this.store.exportBundle(0);
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(bundle, null, 2), "utf8");
    renameSync(tmp, this.file);
    this.seen.set(this.file, sha256(JSON.stringify(bundle.entries)));
    this.dirty = false;
    this.status.lastExport = new Date().toISOString();
  }

  /** Merge every peer bundle we have not already applied. */
  importPeers(): MergeReport[] {
    const reports: MergeReport[] = [];
    if (!existsSync(this.dir)) return reports;

    for (const name of readdirSync(this.dir)) {
      if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) continue;
      if (name.includes(".tmp")) continue; // in-flight write from a peer
      const path = join(this.dir, name);
      if (path === this.file) continue;

      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        continue; // peer is mid-rename; retry next tick
      }
      const digest = sha256(raw);
      if (this.seen.get(name) === digest) continue; // nothing new

      let bundle: SyncBundle;
      try {
        bundle = JSON.parse(raw) as SyncBundle;
      } catch {
        // Mark seen so a corrupt file is not retried forever.
        this.seen.set(name, digest);
        this.log(`skipping unreadable bundle ${name}`);
        continue;
      }

      this.seen.set(name, digest);
      const report = this.store.merge(bundle);
      reports.push(report);
      this.status.applied += report.applied;
      this.status.conflicts += report.conflicts.length;
      this.status.orphans += report.orphaned;
      this.status.lastImport = new Date().toISOString();

      const peer = this.status.peers.find((p) => p.nodeId === bundle.fromNodeId);
      if (peer) {
        peer.entries = bundle.entries.length;
        peer.appliedAt = new Date().toISOString();
      } else {
        this.status.peers.push({ nodeId: bundle.fromNodeId, entries: bundle.entries.length, appliedAt: new Date().toISOString() });
      }

      if (report.applied > 0) {
        this.log(`merged ${report.applied} entries from ${bundle.fromNodeId} (orphans=${report.orphaned}, conflicts=${report.conflicts.length})`);
        // Our view changed, so republish to propagate onward.
        this.dirty = true;
      }
      if (report.conflicts.length > 0) {
        this.log(`CONFLICTS from ${bundle.fromNodeId}: ${report.conflicts.map((c) => c.entryId).join(", ")}`);
      }
    }
    return reports;
  }
}
