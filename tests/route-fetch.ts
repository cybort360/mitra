/**
 * A `fetch` that serves `/api/v1/*` from the real route modules, in-process.
 *
 * The SDK takes a `fetch`, so handing it this one runs the same route code
 * `next start` runs, with no socket and no `next build`. Nothing is stubbed: an
 * unknown path is a 404 `NO_ROUTE`, and a method the module does not export is a
 * 405, as Next would answer.
 */

type RouteModule = Partial<Record<"GET" | "POST" | "PUT", (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>>>;

const routeModules = import.meta.glob("../app/api/v1/**/route.ts") as Record<string, () => Promise<RouteModule>>;
const ROUTES = Object.entries(routeModules)
  .map(([file, load]) => ({ segments: file.replace("../app", "").replace(/\/route\.ts$/, "").split("/").filter(Boolean), load }))
  // Static segments win over dynamic ones, as in Next.
  .sort((a, b) => a.segments.filter((s) => s.startsWith("[")).length - b.segments.filter((s) => s.startsWith("[")).length);

function match(pathname: string): { load: () => Promise<RouteModule>; params: Record<string, string> } | null {
  const parts = pathname.split("/").filter(Boolean);
  for (const r of ROUTES) {
    if (r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (r.segments.every((s, i) => {
      if (s.startsWith("[") && s.endsWith("]")) { params[s.slice(1, -1)] = decodeURIComponent(parts[i]); return true; }
      return s === parts[i];
    })) return { load: r.load, params };
  }
  return null;
}

export const ROUTE_BASE_URL = "http://mitra.test";

export const routeFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const route = match(new URL(request.url).pathname);
  if (!route) return Response.json({ error: "NO_ROUTE" }, { status: 404 });
  const handler = (await route.load())[request.method as "GET" | "POST" | "PUT"];
  if (!handler) return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
  return handler(request, { params: Promise.resolve(route.params) });
};
