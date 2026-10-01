import { describe, expect, it } from "vitest";
import { ContextStore } from "../src/store.js";
import { search, tokenize } from "../src/recall.js";
import { detectDrift, digest } from "../src/digest.js";

const fresh = () => new ContextStore({ path: ":memory:", nodeId: "n_test" });
const entry = (over: Partial<Parameters<ContextStore["append"]>[0]> = {}) => ({
  kind: "note" as const, title: "A note", body: "Body text",
  scope: "core", authorId: "agent:a", ...over,
});

const seeded = () => {
  const s = fresh();
  s.append(entry({ kind: "decision", title: "Store runs must be deterministic", body: "Determinism matters for replay.", scope: "kernel", tags: ["determinism"] }));
  s.append(entry({ kind: "convention", title: "Use node:sqlite for storage", body: "No native deps.", scope: "infra", tags: ["storage", "sqlite"] }));
  s.append(entry({ kind: "blocker", title: "Clearing needs dispute flow", body: "Disputed obligations must stay visible.", scope: "clearing", tags: ["dispute"] }));
  return s;
};

describe("recall", () => {
  it("tokenizes on path separators and lowercases", () => {
    expect(tokenize("lib/kernel/vault.ts")).toContain("kernel");
    expect(tokenize("Hello World")).toContain("hello");
  });

  it("finds an entry by a distinctive title term", () => {
    const hits = search(seeded().list({ limit: 100 }), "deterministic");
    expect(hits[0].entry.title).toMatch(/deterministic/);
    expect(hits[0].matchedIn).toContain("title");
  });

  it("matches on tags", () => {
    const hits = search(seeded().list({ limit: 100 }), "dispute");
    expect(hits[0].matchedIn).toContain("tags");
  });

  it("ranks a title match above a body-only match", () => {
    const s = fresh();
    s.append(entry({ title: "Unrelated heading", body: "mentions sqlite in passing" }));
    s.append(entry({ title: "sqlite is the storage engine", body: "no keyword here" }));
    const hits = search(s.list({ limit: 100 }), "sqlite");
    expect(hits[0].entry.title).toMatch(/storage engine/);
  });

  it("returns nothing for a term that appears nowhere", () => {
    expect(search(seeded().list({ limit: 100 }), "kubernetes")).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(search(seeded().list({ limit: 100 }), "   ")).toEqual([]);
  });

  it("respects the result limit", () => {
    const s = fresh();
    for (let i = 0; i < 10; i += 1) s.append(entry({ title: `alpha topic ${i}` }));
    expect(search(s.list({ limit: 100 }), "alpha", 3)).toHaveLength(3);
  });

  it("demotes superseded entries below active ones", () => {
    const s = fresh();
    const old = s.append(entry({ title: "alpha approach", status: "active" }));
    s.append(entry({ title: "alpha approach revised", supersedesId: old.entryId }));
    const hits = search(s.list({ limit: 100 }), "alpha");

describe("digest", () => {
  const team = () => {
    const s = fresh();
    s.registerActor({ actorId: "human:sam", kind: "human", displayName: "Sam" });
    s.registerActor({ actorId: "agent:a", kind: "agent", displayName: "Agent A" });
    s.append(entry({ kind: "invariant", title: "Capital is conserved", scope: "kernel", authorId: "human:sam" }));
    s.append(entry({ kind: "decision", title: "Use Postgres for the event log", scope: "kernel", authorId: "agent:a" }));
    s.append(entry({ kind: "blocker", title: "Signer abstraction undecided", scope: "kernel", authorId: "agent:a" }));
    s.append(entry({ kind: "question", title: "Should netting be per-asset?", scope: "clearing", authorId: "human:sam" }));
    return s;
  };

  it("puts invariants before decisions in mustRead", () => {
    const s = team();
    const d = digest(s.list({ limit: 100 }), s.listActors(), "kernel");
    expect(d.mustRead[0].kind).toBe("invariant");
    expect(d.mustRead.some((e) => e.kind === "decision")).toBe(true);
  });

  it("counts contributors with display names", () => {
    const s = team();
    const d = digest(s.list({ limit: 100 }), s.listActors(), "all");
    expect(d.contributors.map((c) => c.displayName).sort()).toEqual(["Agent A", "Sam"]);
  });

  it("scopes to a single area", () => {
    const s = team();
    const d = digest(s.list({ limit: 100 }), s.listActors(), "clearing");
    expect(d.openQuestions).toHaveLength(1);
    expect(d.blockers).toHaveLength(0);
  });

  it("counts entries by kind", () => {
    const s = team();
    const d = digest(s.list({ limit: 100 }), s.listActors(), "kernel");
    expect(d.byKind).toEqual({ invariant: 1, decision: 1, blocker: 1 });
  });

  it("surfaces a topic where two people recorded competing decisions", () => {
    const s = fresh();
    s.registerActor({ actorId: "human:sam", kind: "human", displayName: "Sam" });
    s.registerActor({ actorId: "agent:a", kind: "agent", displayName: "Agent A" });
    s.append(entry({ kind: "decision", title: "Use Postgres for the event log", authorId: "human:sam" }));
    s.append(entry({ kind: "decision", title: "Use Postgres for the event log", authorId: "agent:a" }));
    const d = digest(s.list({ limit: 100 }), s.listActors(), "all");
    expect(d.contested).toHaveLength(1);
    expect(d.contested[0].authors.sort()).toEqual(["agent:a", "human:sam"]);
  });
});

describe("drift detection", () => {
  const withFile = () => {
    const s = fresh();
    s.append(entry({ kind: "convention", title: "Kernel tests live in tests/kernel.test.ts", data: { files: ["tests/kernel.test.ts"] } }));
    return s;
  };

  it("flags a convention whose referenced file is missing", () => {
    const report = detectDrift(withFile().list({ limit: 10 }), () => false);
    expect(report.healthy).toBe(false);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]).toMatch(/tests\/kernel\.test\.ts/);
  });

  it("is healthy when the referenced file exists", () => {
    // Regression: `null` means "present and fine". Treating it as missing
    // reported every existing file as a gap.
    const report = detectDrift(withFile().list({ limit: 10 }), () => null);
    expect(report.healthy).toBe(true);
    expect(report.gaps).toHaveLength(0);
  });

  it("treats an undefined probe result as fine, not missing", () => {
    expect(detectDrift(withFile().list({ limit: 10 }), () => undefined).healthy).toBe(true);
  });

  it("records a non-fatal note as a warning, not a gap", () => {
    const report = detectDrift(withFile().list({ limit: 10 }), () => "file exists but is empty");
    expect(report.healthy).toBe(true);
    expect(report.warnings).toHaveLength(1);
  });

  it("ignores conventions with no declared files", () => {
    const s = fresh();
    s.append(entry({ kind: "convention", title: "Prefer pure functions" }));
    expect(detectDrift(s.list({ limit: 10 }), () => false).healthy).toBe(true);
  });

  it("ignores superseded conventions", () => {
    const s = fresh();
    const old = s.append(entry({ kind: "convention", title: "Old layout", data: { files: ["gone.ts"] } }));
    s.append(entry({ kind: "convention", title: "New layout", data: { files: ["here.ts"] }, supersedesId: old.entryId }));
    expect(detectDrift(s.list({ limit: 10 }), () => false).gaps).toHaveLength(0);
  });
});

    expect(hits[0].entry.status).toBe("active");
    expect(hits[0].entry.title).toMatch(/revised/);
  });
});
