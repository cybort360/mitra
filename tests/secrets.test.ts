import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * A private key in git history is unrecoverable by removing it later.
 *
 * The `.dev-keys/` directory holds testnet secrets — small in value, but the
 * *mechanism* is the same one that leaks a mainnet key, and a repository that
 * establishes the habit is the thing worth preventing. So the guard is a test
 * rather than a review instruction, because a review instruction is exactly the
 * kind of claim that is cheaper to make than to check.
 *
 * This runs in CI and locally, on every commit.
 */
const ROOT = process.cwd();
const KEY_DIR = path.join(ROOT, ".dev-keys");

/** Runs git and returns trimmed stdout, or null if git is unavailable. */
function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

describe("secrets hygiene", () => {
  it(".dev-keys/ is gitignored", () => {
    const ignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    expect(ignore).toMatch(/^\.dev-keys\/?$/m);
  });

  it("git actually reports the key files as ignored", () => {
    // The .gitignore entry is the intent; this is the effect. They can disagree
    // — a negation later in the file, or a force-added file — so the effect is
    // what gets checked.
    if (!existsSync(KEY_DIR)) return; // nothing generated yet; the rule above still holds
    const check = git(["check-ignore", "-q", ".dev-keys/evm-testnet.key"]);
    // Exit code 0 means "ignored". execFileSync throws on non-zero, so a
    // successful call is the passing case and a throw is the failure.
    expect(check).toBe("");
  });

  it("no private key material is tracked by git", () => {
    // The strongest form: ask git what it has staged, rather than what files
    // exist. A key that was once committed and later deleted still fails here.
    const tracked = git(["ls-files"]);
    if (tracked === null) return;
    const offenders = tracked
      .split("\n")
      .filter((f) => /\.(key|pem|p12|keystore)$/.test(f) || f.startsWith(".dev-keys/"));
    expect(offenders).toEqual([]);
  });

  it("no key-shaped string appears in tracked source", () => {
    // A 64-hex-char value assigned to something named like a key. The context
    // requirement is what keeps this from firing on content hashes, which are
    // 64 hex chars by design and appear throughout the suite.
    //
    // Scoped by *assignment target*, not by filename. An earlier version
    // excluded any file whose path contained "canonical" to dodge its own known
    // hashes — and therefore skipped `lib/domain/canonical.ts` entirely, which
    // is precisely where a planted key was expected to be caught. Verified by
    // planting one there: the guard did not fire. A filename exclusion is a
    // hole shaped like the thing it excludes.
    const tracked = (git(["ls-files"]) ?? "").split("\n").filter(Boolean);
    const KEY_ASSIGNMENT =
      /(privateKey|secretKey|mnemonic|PRIVATE_KEY|secret)\s*[:=]\s*["'][0-9a-fA-F]{64}["']/;
    // Known-safe lines: assertions that name a digest's literal value.
    const isKnownDigestLiteral = (line: string) =>
      /contentHash|actionDigest|typedHash|chainHash|sha256/.test(line);

    const suspicious: string[] = [];
    for (const file of tracked) {
      if (!/\.(ts|tsx|mjs|js|json|md|env)$/.test(file)) continue;
      const full = path.join(ROOT, file);
      if (!existsSync(full)) continue;
      readFileSync(full, "utf8").split("\n").forEach((line, i) => {
        if (!KEY_ASSIGNMENT.test(line)) return;
        if (isKnownDigestLiteral(line)) return;
        suspicious.push(`${file}:${i + 1}`);
      });
    }
    expect(suspicious).toEqual([]);
  });

  it("the key directory, if present, holds only expected files", () => {
    // An unexpected file in the secrets directory is either a mistake or a
    // leak, and both are worth knowing about before anything is committed.
    if (!existsSync(KEY_DIR)) return;
    const expected = new Set([
      "README.md", "solana-testnet.json", "solana-testnet.address",
      "evm-testnet.key", "evm-testnet.address",
    ]);
    const unexpected = readdirSync(KEY_DIR).filter((f) => !expected.has(f));
    expect(unexpected).toEqual([]);
  });
});
