/**
 * Where a page's numbers come from (sprint item 5). The Console used to render
 * fixture arrays straight from `lib/store/seed`, indistinguishable from real state.
 * Each page now says which it is.
 */
export function DataSource({ backend, fixtures }: { backend?: "memory" | "postgres"; fixtures?: string }) {
  if (fixtures) {
    return <div className="notice" style={{ marginBottom: 16 }}>Reference fixtures — {fixtures}. Not live state.</div>;
  }
  return (
    <div className="notice" style={{ marginBottom: 16, borderColor: "#cfe2d3", background: "var(--greenSoft)", color: "var(--green)" }}>
      Live store: <strong className="mono" style={{ marginLeft: 4 }}>{backend}</strong>
      {backend === "memory" ? " — process-local; restarts lose state. Set DATABASE_URL for Postgres." : " — durable."}
    </div>
  );
}
