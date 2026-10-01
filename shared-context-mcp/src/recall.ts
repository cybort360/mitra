import type { Entry, RecallHit } from "./types.js";

/** Split text into comparable terms, keeping dotted/CamelCase paths intact. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_$./-]+/)
    .flatMap((chunk) => (chunk.includes(".") || chunk.includes("/") ? [chunk, ...chunk.split(/[./]/)] : [chunk]))
    .filter((t) => t.length > 1);
}

/**
 * Lightweight BM25-flavoured ranking.
 *
 * Deliberately dependency-free: a full-text search engine would be a large
 * operational surface for a memory store that realistically holds thousands,
 * not millions, of entries. Rare terms score higher than common ones, which
 * makes "reservation" outrank "the" without needing a model.
 */
export function search(entries: Entry[], query: string, limit = 10): RecallHit[] {
  const terms = tokenize(query);
  if (!terms.length) return [];

  const docs = entries.map((e) => ({
    entry: e,
    title: new Set(tokenize(e.title)),
    body: new Set(tokenize(e.body)),
    tags: new Set(e.tags.flatMap(tokenize)),
    scope: new Set(tokenize(e.scope)),
    data: new Set(tokenize(JSON.stringify(e.data ?? {}))),
  }));

  // Document frequency across the corpus drives the IDF term.
  const df = new Map<string, number>();
  for (const term of terms) {
    df.set(term, docs.filter((d) => d.title.has(term) || d.body.has(term) || d.tags.has(term) || d.scope.has(term) || d.data.has(term)).length);
  }

  const hits: RecallHit[] = [];
  for (const doc of docs) {
    let score = 0;
    const matchedIn: string[] = [];
    for (const term of new Set(terms)) {
      const n = df.get(term) ?? 0;
      if (!n) continue;
      const idf = Math.log(1 + docs.length / n);
      // Field weights reflect how much a match there implies relevance.
      if (doc.title.has(term)) { score += idf * 3; matchedIn.push("title"); }
      if (doc.tags.has(term)) { score += idf * 2.5; matchedIn.push("tags"); }
      if (doc.scope.has(term)) { score += idf * 1.5; matchedIn.push("scope"); }
      if (doc.data.has(term)) { score += idf * 1.2; matchedIn.push("data"); }
      if (doc.body.has(term)) { score += idf; matchedIn.push("body"); }
    }
    if (score > 0) {
      // Superseded entries are history, not current truth: demote rather than
      // hide, so a superseded decision is still findable when asked for.
      if (doc.entry.status === "superseded") score *= 0.3;
      // Recency nudge keeps fresh context ahead of stale context on ties.
      const ageDays = (Date.now() - new Date(doc.entry.createdAt).getTime()) / 86_400_000;
      score *= 1 + Math.max(0, 0.1 - ageDays * 0.001);
      hits.push({ entry: doc.entry, score: Number(score.toFixed(4)), matchedIn: [...new Set(matchedIn)] });
    }
  }
  return hits.sort((a, b) => b.score - a.score || b.entry.seq - a.entry.seq).slice(0, limit);
}
