import type { Actor, Entry } from "./types.js";

export interface Digest {
  scope: string;
  total: number;
  byKind: Record<string, number>;
  contributors: { actorId: string; displayName: string; count: number }[];
  /** What a new collaborator should read first, in order. */
  mustRead: Entry[];
  openQuestions: Entry[];
  blockers: Entry[];
  recentDecisions: Entry[];
  /** Decisions and conventions recorded by more than one party. */
  contested: { title: string; authors: string[] }[];
  generatedAt: string;
}

const READ_ORDER: Record<string, number> = {
  invariant: 0, decision: 1, convention: 2, blocker: 3, task: 4, finding: 5, question: 6, handoff: 7, note: 8,
};

/**
 * Build an onboarding digest for a scope.
 *
 * This is the "comprehend" surface: an agent joining the project calls one
 * tool and gets the current shape of the work without reading every entry.
 * Decisions outrank notes, and active entries outrank resolved ones, so the
 * ordering reflects what actually constrains current work.
 */
export function digest(entries: Entry[], actors: Actor[], scope = "all"): Digest {
  const inScope = (e: Entry) => scope === "all" || e.scope === scope;
  const scoped = entries.filter(inScope);
  const active = scoped.filter((e) => e.status === "active");

  const byKind: Record<string, number> = {};
  for (const e of active) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

  const perAuthor = new Map<string, number>();
  for (const e of scoped) perAuthor.set(e.authorId, (perAuthor.get(e.authorId) ?? 0) + 1);
  const contributors = [...perAuthor.entries()]
    .map(([actorId, count]) => ({
      actorId,
      displayName: actors.find((a) => a.actorId === actorId)?.displayName ?? actorId,
      count,
    }))
    .sort((a, b) => b.count - a.count);

  // A decision on the same topic from several people is exactly where agents
  // and humans drift apart, so surface it explicitly.
  const byTopic = new Map<string, Set<string>>();
  for (const e of scoped) {
    if (e.kind !== "decision" && e.kind !== "convention" && e.kind !== "invariant") continue;
    const topic = e.title.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    if (!byTopic.has(topic)) byTopic.set(topic, new Set());
    byTopic.get(topic)!.add(e.authorId);
  }
  const contested = [...byTopic.entries()]
    .filter(([, authors]) => authors.size > 1)
    .map(([title, authors]) => ({ title, authors: [...authors] }));

  const rank = (e: Entry) => (READ_ORDER[e.kind] ?? 9) * 1000 - e.seq / 1000;
  const mustRead = active
    .filter((e) => ["invariant", "decision", "convention"].includes(e.kind))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 12);

  return {
    scope,
    total: scoped.length,
    byKind,
    contributors,
    mustRead,
    openQuestions: active.filter((e) => e.kind === "question").sort((a, b) => b.seq - a.seq).slice(0, 8),
    blockers: active.filter((e) => e.kind === "blocker").sort((a, b) => b.seq - a.seq).slice(0, 8),
    recentDecisions: active.filter((e) => e.kind === "decision").sort((a, b) => b.seq - a.seq).slice(0, 8),
    contested,
    generatedAt: new Date().toISOString(),
  };
}

export interface DriftReport {
  scope: string;
  gaps: string[];
  warnings: string[];
  healthy: boolean;
}

/**
 * Result of testing one referenced file.
 *  - `false` the file is absent (a real gap)
 *  - `string` the file exists but a non-fatal problem was noted
 *  - `null`/`undefined` the file exists and is fine
 */
export type FileProbe = false | string | null | undefined;

/**
 * Compare stated conventions against observed code to catch drift between what
 * the team agreed and what is actually on disk. Cheap, deterministic, and it
 * turns the convention log into something that can fail loudly.
 */
export function detectDrift(entries: Entry[], check: (path: string) => FileProbe): DriftReport {
  const conventions = entries.filter((e) => e.kind === "convention" && e.status === "active");
  const gaps: string[] = [];
  const warnings: string[] = [];

  for (const c of conventions) {
    const files = Array.isArray(c.data?.files) ? (c.data.files as string[]) : [];
    for (const file of files) {
      const result = check(file);
      // Only an explicit `false` means missing; null/undefined mean "fine".
      if (result === false) {
        gaps.push(`${c.entryId}: "${c.title}" references ${file}, which is not present.`);
      } else if (typeof result === "string" && result.length > 0) {
        warnings.push(`${c.entryId}: "${c.title}" — ${result}`);
      }
    }
  }
  return { scope: "conventions", gaps, warnings, healthy: gaps.length === 0 };
}
