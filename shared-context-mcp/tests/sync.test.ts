import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextStore } from "../src/store.js";
import { SyncAgent } from "../src/sync.js";

const mkStore = (nodeId: string) => new ContextStore({ path: ":memory:", nodeId });
const note = (title: string) => ({ kind: "note" as const, title, body: "", scope: "core", authorId: "agent:x" });
const silent = () => vi.fn();

const dirs: string[] = [];
const sharedDir = () => {
  const d = mkdtempSync(join(tmpdir(), "ctxsync-"));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("auto-sync", () => {
  it("publishes a bundle on the first tick", () => {
    const dir = sharedDir();
    const store = mkStore("nodeA");
    store.append(note("hello"));
    new SyncAgent({ store, dir, log: silent() }).tick();
    expect(readdirSync(dir)).toEqual(["ctxbundle-nodeA.json"]);
  });

  it("does not rewrite an unchanged bundle on every tick", () => {
    const dir = sharedDir();
    const store = mkStore("nodeA");
    store.append(note("stable"));
    const agent = new SyncAgent({ store, dir, log: silent() });
    agent.tick();
    const first = readdirSync(dir);
    agent.tick();
    agent.tick();
    expect(readdirSync(dir)).toEqual(first);
  });

  it("converges two nodes with no manual exchange", () => {
    const dir = sharedDir();
    const a = mkStore("nodeA");
    const b = mkStore("nodeB");
    a.append(note("from A"));
    b.append(note("from B"));
    const agentA = new SyncAgent({ store: a, dir, log: silent() });
    const agentB = new SyncAgent({ store: b, dir, log: silent() });
    agentA.tick();
    agentB.tick();
    agentA.tick();
    expect(a.list({ limit: 100 }).map((e) => e.title).sort()).toEqual(["from A", "from B"]);
    expect(b.list({ limit: 100 }).map((e) => e.title).sort()).toEqual(["from A", "from B"]);
  });

  it("propagates a third node's entry through an intermediary", () => {
    // A and C never meet directly, but B republishes after merging, so C still
    // converges. This is what makes a shared folder behave like a real bus.
    const dir = sharedDir();
    const a = mkStore("nodeA");
    const b = mkStore("nodeB");
    const c = mkStore("nodeC");
    a.append(note("from A"));
    b.append(note("from B"));
    const agentA = new SyncAgent({ store: a, dir, log: silent() });
    const agentB = new SyncAgent({ store: b, dir, log: silent() });
    const agentC = new SyncAgent({ store: c, dir, log: silent() });
    agentA.tick();
    agentB.tick();   // B learns A, marks dirty
    agentB.tick();   // B republishes including A
    agentC.tick();
    expect(c.list({ limit: 100 }).map((e) => e.title).sort()).toEqual(["from A", "from B"]);
  });


  it("stays idempotent across many ticks", () => {
    const dir = sharedDir();
    const a = mkStore("nodeA");
    const b = mkStore("nodeB");
    a.append(note("shared"));
    const agentA = new SyncAgent({ store: a, dir, log: silent() });
    const agentB = new SyncAgent({ store: b, dir, log: silent() });
    for (let i = 0; i < 5; i += 1) { agentA.tick(); agentB.tick(); }
    expect(b.list({ limit: 100 })).toHaveLength(1);
    expect(agentB.getStatus().applied).toBe(1);
  });

  it("reports peers it has merged", () => {
    const dir = sharedDir();
    const a = mkStore("nodeA");
    const b = mkStore("nodeB");
    a.append(note("from A"));
    new SyncAgent({ store: a, dir, log: silent() }).tick();
    const agentB = new SyncAgent({ store: b, dir, log: silent() });
    // `enabled` reflects the background loop, which only start() turns on.
    expect(agentB.getStatus().enabled).toBe(false);
    agentB.start();
    expect(agentB.getStatus().enabled).toBe(true);
    expect(agentB.getStatus().peers.map((p) => p.nodeId)).toEqual(["nodeA"]);
  });

  it("ignores its own bundle and peer temp files", () => {
    const dir = sharedDir();
    const a = mkStore("nodeA");
    a.append(note("mine"));
    const agentA = new SyncAgent({ store: a, dir, log: silent() });
    agentA.tick();
    // A must not import its own published bundle.
    expect(agentA.importPeers()).toHaveLength(0);

    // A half-written peer file must not be parsed or applied. B still picks up
    // A's real bundle, which is correct -- only the temp file is ignored.
    const b = mkStore("nodeB");
    writeFileSync(join(dir, "ctxbundle-nodeZ.json.999.tmp"), "{ partial", "utf8");
    const agentB = new SyncAgent({ store: b, dir, log: vi.fn() });
    agentB.tick();
    expect(b.list({ limit: 10 }).map((e) => e.title)).toEqual(["mine"]);
    expect(agentB.getStatus().peers.map((p) => p.nodeId)).toEqual(["nodeA"]);
    // The temp file was never promoted to a bundle.
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual(["ctxbundle-nodeA.json", "ctxbundle-nodeB.json"]);
  });

  it("skips an unreadable bundle without crashing or retrying forever", () => {
    const dir = sharedDir();
    const log = silent();
    writeFileSync(join(dir, "ctxbundle-nodeZ.json"), "{ not json", "utf8");
    const agent = new SyncAgent({ store: mkStore("nodeA"), dir, log });
    expect(() => agent.tick()).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("unreadable"));
    agent.tick();
    expect(log.mock.calls.filter((c) => String(c[0]).includes("unreadable"))).toHaveLength(1);
  });

  it("refuses a forged peer bundle without blocking the peers after it", () => {
    const dir = sharedDir();
    const forger = mkStore("node0");
    forger.append(note("real"));
    const forged = forger.exportBundle();
    forged.entries[0] = { ...forged.entries[0], body: "forged" };
    // "node0" sorts before "nodeA", so the forged bundle is read first.
    writeFileSync(join(dir, "ctxbundle-node0.json"), JSON.stringify(forged), "utf8");
    const a = mkStore("nodeA");
    a.append(note("from A"));
    new SyncAgent({ store: a, dir, log: silent() }).tick();

    const log = silent();
    const b = mkStore("nodeB");
    new SyncAgent({ store: b, dir, log }).tick();
    expect(b.list({ limit: 10 }).map((e) => e.title)).toEqual(["from A"]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/refused bundle ctxbundle-node0\.json.*ENTRY_ID_MISMATCH/));
    expect(b.verify().ok).toBe(true);
  });

  it("leaves no temp files behind after publishing", () => {
    const dir = sharedDir();
    const store = mkStore("nodeA");
    store.append(note("clean"));
    new SyncAgent({ store, dir, log: silent() }).tick();
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });

  it("keeps both chains valid after auto-syncing", () => {
    const dir = sharedDir();
    const a = mkStore("nodeA");
    const b = mkStore("nodeB");
    a.append(note("from A"));
    b.append(note("from B"));
    const agentA = new SyncAgent({ store: a, dir, log: silent() });
    const agentB = new SyncAgent({ store: b, dir, log: silent() });
    agentA.tick(); agentB.tick(); agentA.tick();
    expect(a.verify().ok).toBe(true);
    expect(b.verify().ok).toBe(true);
  });

  it("stop() halts background ticking", async () => {
    const dir = sharedDir();
    const store = mkStore("nodeA");
    store.append(note("x"));
    const agent = new SyncAgent({ store, dir, intervalMs: 10, log: silent() });
    agent.start();
    agent.stop();
    rmSync(join(dir, "ctxbundle-nodeA.json"), { force: true });
    await new Promise((r) => setTimeout(r, 60));
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

