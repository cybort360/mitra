/**
 * PP-8: the agent skills in skills/ stay true to the code they describe.
 *
 * A skill an LLM follows is an instruction set, and a stale one is worse than
 * none: it names a tool that is gone, or a workaround for a defect that is fixed.
 * Each check below turns one kind of drift into a failing test.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { servedToolNames } from "@/lib/mcp/server";
import { prohibitedDirectTools } from "@/lib/mcp/surface";
import { MitraClient } from "@/lib/sdk";

const ROOT = join(__dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");
const ROLE_SKILLS = ["mitra-buyer", "mitra-provider", "mitra-evaluator", "mitra-treasury"];

const skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ dir: d.name, text: readFileSync(join(SKILLS_DIR, d.name, "SKILL.md"), "utf8") }));

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return {};
  return Object.fromEntries(m[1].split("\n").map((l) => {
    const i = l.indexOf(":");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
}

/** Every source file under lib/ and app/, concatenated: where a reason code must exist. */
function sourceText(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(join(ROOT, "lib"));
  walk(join(ROOT, "app"));
  return out.join("\n");
}

describe("skills/", () => {
  it("holds mitra-core and the four role skills, each with a name matching its folder and a description", () => {
    expect(skills.map((s) => s.dir).sort()).toEqual(["mitra-core", ...ROLE_SKILLS].sort());
    for (const s of skills) {
      const fm = frontmatter(s.text);
      expect(fm.name, s.dir).toBe(s.dir);
      expect(fm.description?.length ?? 0, s.dir).toBeGreaterThan(40);
      expect(fm.description!.length, s.dir).toBeLessThanOrEqual(1024);
    }
  });

  it("every role skill points to mitra-core for signing and refusal codes", () => {
    for (const s of skills.filter((x) => ROLE_SKILLS.includes(x.dir))) expect(s.text, s.dir).toContain("`mitra-core`");
  });

  it("every MCP tool a skill names is served", () => {
    const served = new Set<string>(servedToolNames());
    for (const s of skills) {
      for (const [tool] of s.text.matchAll(/\bmitra_[a-z_]+\b/g)) expect(served.has(tool), `${s.dir}: ${tool}`).toBe(true);
    }
  });

  it("every SDK call a skill names exists on MitraClient", () => {
    const client = new MitraClient({ baseUrl: "http://x", signer: privateKeyToAccount(generatePrivateKey()), chainId: 84532, agentId: "a" }) as unknown as Record<string, Record<string, unknown>>;
    for (const s of skills) {
      for (const [, ns, method] of s.text.matchAll(/`(commerce|authority|agents|clearing|recovery|inbox)\.([a-zA-Z]+)/g)) {
        expect(typeof client[ns]?.[method], `${s.dir}: ${ns}.${method}`).toBe("function");
      }
    }
  });

  it("every refusal code in mitra-core is one the code can produce", () => {
    const source = sourceText();
    const core = skills.find((s) => s.dir === "mitra-core")!.text;
    const table = core.slice(core.indexOf("## Refusal codes"));
    const codes = [...table.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(10);
    for (const code of codes) expect(source.includes(`"${code}"`), code).toBe(true);
  });

  it("no skill names a prohibited capital verb", () => {
    for (const s of skills) for (const verb of prohibitedDirectTools) expect(s.text, s.dir).not.toContain(verb);
  });

  it("every defect a skill works around is still open, so a fixed one forces the workaround out", () => {
    const failures = readFileSync(join(ROOT, "forge/FAILURES.md"), "utf8");
    for (const s of skills) {
      for (const id of new Set(s.text.match(/\bF\d{2,}\b/g) ?? [])) {
        const entry = failures.split(/\n(?=## )/).find((e) => e.startsWith(`## ${id} `));
        expect(entry, `${s.dir}: ${id} has a FAILURES.md entry`).toBeTruthy();
        expect(/\*\*Status:\*\* open/.test(entry!), `${s.dir}: ${id} is fixed; update the skill`).toBe(true);
      }
    }
  });
});
