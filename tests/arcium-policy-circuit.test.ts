/**
 * The hermetic mirror is still a mirror.
 *
 * `tests/arcium-circuit.test.ts` transcribes the Arcium circuit into TypeScript so
 * the F43-class defects can be caught in CI. A transcription can only be corrected
 * by reading its source — and until this file existed, that source was a path
 * **outside this repository** (`/home/ubuntu/arcium-probe/…`). So the mirror could
 * be wrong in one direction only: nobody reviewing Mitra could check it against the
 * thing it claims to mirror, and the two were free to diverge with nothing failing.
 *
 * This asserts the properties that actually changed during F43, by reading the
 * committed circuit text. It is deliberately a *text* assertion rather than a
 * re-execution: the live cluster run (recorded in `forge/PROOF_LEDGER.md`) is what
 * proves the circuit computes the right answers, and this is what stops the CI
 * mirror from quietly drifting away from a circuit that was changed to match it —
 * which is the failure mode a hand-written mirror has, and the reason "the tests
 * are green" stopped meaning "the circuit is correct" here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CIRCUIT = "programs/arcium-policy-circuit/encrypted-ixs/src/lib.rs";
const src = readFileSync(CIRCUIT, "utf8");

/** The circuit body, so a doc comment cannot satisfy a check meant for code. */
const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the committed confidential policy circuit", () => {
  it("is the source of record, and exists where the mirror says it does", () => {
    // `tests/arcium-circuit.test.ts` documents this path. If it moves, that file's
    // header is wrong and this fails — which is the point of naming the path in two
    // places: a stale path is invisible until someone runs it.
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("evaluate_mandate");
    // The header of the committed file names the sync direction; a copy edited in
    // both working trees is a copy that will disagree.
    expect(readFileSync("programs/arcium-policy-circuit/README.md", "utf8"))
      .toMatch(/re-synced\s+\*from\*\s+this directory/);
  });

  describe("F43 defect 1 — is_nonzero", () => {
    it("is `gt(x, 0)`, so a zero amount is REFUSED", () => {
      // `not_gt(0, x)` is `!(0 > x)` = `x >= 0` — always true — so the original made
      // a ZERO-AMOUNT action ALLOWED, the exact opposite of the guard above it. The
      // comment form is excluded so the historical mention cannot satisfy this.
      expect(code).toMatch(/fn is_nonzero\s*\(\s*x:\s*u64\s*\)\s*->\s*u64\s*\{\s*gt\(\s*x\s*,\s*0\s*\)\s*\}/);
      expect(code).not.toMatch(/fn is_nonzero[\s\S]{0,120}not_gt\(\s*0\s*,/);
      // …and the same trap must not have reappeared anywhere else.
      expect(code).not.toMatch(/not_gt\(\s*0\s*,/);
    });

    it("`is_zero` is the negation, so the two cannot both be true", () => {
      expect(code).toMatch(/fn is_zero\s*\(\s*x:\s*u64\s*\)\s*->\s*u64\s*\{\s*not_gt\(\s*x\s*,\s*0\s*\)\s*\}/);
    });
  });

  describe("F43 defect 2 — reason attribution", () => {
    it("never calls `when_allowed`", () => {
      // `when_allowed(allowed, reason, REASON_AMOUNT_INVALID)` computed
      // `allowed * reason + (1 - allowed) * fallback`, so EVERY denial returned
      // REASON_AMOUNT_INVALID regardless of which check failed — making reasons
      // 1, 2, 4, 5 and 6 unreachable. Its absence is the fix.
      expect(code).not.toContain("when_allowed");
    });

    it("every `reason` write is guarded by `is_zero(reason)`", () => {
      // Precedence: only the FIRST failing check may set the reason. A write that is
      // not guarded lets a later check overwrite an earlier, more fundamental one —
      // which is exactly how a dead mandate got reported as MAX_TRANSACTION_EXCEEDED.
      const writes = [...code.matchAll(/reason\s*=\s*when\(([^;]*?);/g)].map((m) => m[1].trim());
      expect(writes.length, "the circuit must assign `reason` via guarded `when`s").toBe(6);
      for (const w of writes) {
        expect(w.startsWith("is_zero(reason)"), `unguarded reason write: when(${w})`).toBe(true);
      }
    });

    it("the reason codes the mirror asserts are the ones the circuit defines", () => {
      // Seven constants, and the values are the mirror's whole vocabulary. A circuit
      // that renumbered them would leave `tests/arcium-circuit.test.ts` asserting
      // numbers that no longer mean what it says they mean.
      const defined = [...code.matchAll(/const REASON_([A-Z_]+):\s*u64\s*=\s*(\d+);/g)]
        .map((m) => [m[1], Number(m[2])] as const);
      expect(defined).toEqual([
        ["OK", 0],
        ["MANDATE_NOT_LIVE", 1],
        ["CHAIN_NOT_ALLOWED", 2],
        ["AMOUNT_INVALID", 3],
        ["MAX_TRANSACTION_EXCEEDED", 4],
        ["BUDGET_EXCEEDED", 5],
        ["INSUFFICIENT_CAPITAL", 6],
      ]);
    });
  });

  describe("what is secret, and what the circuit is allowed to assume", () => {
    it("declares all six policy inputs, in the order the Anchor program queues them", () => {
      // Order is load-bearing and nothing in the type system checks it: the Anchor
      // program queues six `encrypted_u64` arguments positionally. A field inserted
      // or reordered here compiles, runs, and quietly evaluates a different policy.
      const struct = code.match(/pub struct MandatePolicyInput \{([^}]*)\}/)?.[1] ?? "";
      const fields = [...struct.matchAll(/^\s*(\w+):\s*u64,/gm)].map((m) => m[1]);
      expect(fields).toEqual([
        "amount",
        "max_transaction",
        "budget",
        "available",
        "mandate_live",
        "chain_allowed",
      ]);
    });

    it("folds all six gates into `allowed` multiplicatively", () => {
      // Each `ok *= cond` zeroes the flag without branching, which is the only shape
      // an MPC circuit can take: circuit structure is fixed at compile time and
      // cannot depend on secret data. A version that returned early would not
      // compile as a circuit at all, and one that branched would leak.
      // Four re-multiplications, after the seeding line. Asserted as an ordered list
      // rather than a count: a gate DROPPED is the defect that matters, and a count
      // would happily accept four gates in the wrong order — which would evaluate
      // `allowed` correctly while reporting the wrong REASON, the exact shape of F43.
      const gates = [...code.matchAll(/allowed\s*=\s*allowed\s*\*\s*(\w+);/g)].map((m) => m[1]);
      expect(gates).toEqual(["amount_ok", "within_max", "within_budget", "has_capital"]);
      // …and the seed itself is `mandate_live * chain_allowed`, so a dead mandate
      // zeroes the decision before any amount is considered.
      expect(code).toMatch(/let mut allowed = i\.mandate_live \* i\.chain_allowed;/);
    });

    it("does not take a timestamp — expiry arrives pre-folded as `mandate_live`", () => {
      // The task brief for LP-5 asked for an `expiresAt`/`currentTime` guard. There
      // is none, and a harness asserting one would pass forever while proving
      // nothing. The circuit's liveness is a flag the caller cannot forge by
      // omitting the field, which is why expiry is not a comparison here.
      expect(code).not.toMatch(/expires_at|expiresAt|current_time|currentTime|clock|timestamp/);
    });

    it("returns an encrypted output, never a plaintext decision", () => {
      // The output is `Enc<Shared, MandatePolicyOutput>`: the program cannot read its
      // own verdict, which is the point of an enclave. A plaintext return would make
      // every ciphertext input pointless.
      expect(code).toMatch(/pub fn evaluate_mandate\(\s*input_ctxt:\s*Enc<Shared, MandatePolicyInput>,?\s*\)\s*->\s*Enc<Shared, MandatePolicyOutput>/);
      expect(code).toMatch(/from_arcis\(MandatePolicyOutput \{ allowed, reason \}\)/);
    });

    it("keeps the six binding fields OUT of the circuit", () => {
      // PRD §11.12: expose enough to establish that a decision occurred under a valid
      // policy, while keeping sensitive policy values private. The identifiers travel
      // alongside the encrypted result as plaintext; putting the action digest INSIDE
      // would spend MPC cycles on values already public on chain. Asserted so a
      // future "let's bind it in the circuit" change is deliberate.
      expect(code).not.toMatch(/action_hash|action_digest|pubkey|nonce|vault|mandate_id/);
    });
  });
});
