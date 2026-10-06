/**
 * The deployed `mitra-vault` program id — an **address**, not a secret.
 *
 * ## Why this file exists, and why it is not a keypair
 *
 * `scripts/vault-devnet.mjs` used to derive the program id from
 * `programs/mitra-vault/target/deploy/mitra_vault-keypair.json`, on the reasoning
 * that a derived id cannot drift from the binary. That reasoning is correct and
 * the mechanism is wrong:
 *
 *   - `cargo-build-sbf` generates that keypair **if it is absent**, and
 *     `cargo clean` deletes it. So the first `cargo clean` between a deploy and a
 *     harness run replaces the key with a fresh one whose id is a program that
 *     does not exist. The harness then derives `27Li8mEF…`, finds no vault there,
 *     and reports a failure that reads like a broken program. (Observed on
 *     2026-10-06, mid-LP-4: the upgrade had to be re-run with an explicit
 *     `--program-id` because the keypair had been cleaned away.)
 *   - Worse in the other direction: a *stale* keypair next to a *newly built* `.so`
 *     makes the harness confidently drive the previous deployment, reporting its
 *     failures as if they were current. That is the exact failure this harness's
 *     own comment says it was written to prevent — and it reintroduces it through
 *     the mechanism meant to prevent it.
 *
 * The keypair is deliberately **not** committed: `tests/dev-scripts.test.ts` fails
 * the build if any `*-keypair.json` is tracked, because holding a program's
 * keypair is the right to replace the program at that address. So the durable half
 * of the identity is the address, and that is what belongs in the repository.
 *
 * ## Keeping the copies from drifting
 *
 * This address appears in three places that must agree:
 *
 *   1. here, for the `.mjs` harness;
 *   2. `VAULT_PROGRAM_ID` in `lib/solana/vault-program.ts`, for the TypeScript
 *      client; and
 *   3. `PROGRAM_ID_BYTES` in `programs/mitra-vault/src/lib.rs`, which is what
 *      `tests/golden/vault-layout.json` is generated from.
 *
 * `tests/dev-scripts.test.ts` pins all three to each other, so a redeploy at a new
 * address fails a test rather than silently pointing a harness at nothing.
 */
export const VAULT_PROGRAM_ID = "GkQQtmVXtGGeGvdHCXPtU6kbcKytQ4Dva7XdoCUj8CqY";

/**
 * The program's own bytes, for the `.mjs` harnesses.
 *
 * `scripts/vault-devnet.mjs` derived Anchor's discriminators inline
 * (`sha256("global:<name>")[..8]`) and hand-wrote the account lengths, and this
 * follows that precedent rather than inventing a second convention. Two reasons it
 * is a commitment and not a convenience:
 *
 *   - **Derived, never transcribed.** `VAULT_DISCRIMINATOR` was originally written
 *     from memory and was wrong (F17): a mismatched account is rejected loudly, but
 *     a wrong-but-consistent discriminator deserializes into a different program's
 *     account. So every value here is computed from the same string Anchor would.
 *   - **Pinned across the language boundary.** `tests/dev-scripts.test.ts` asserts
 *     these against `tests/golden/vault-layout.json`, which the RUST program
 *     generates from its own types. Two hand-written encoders agreeing with
 *     themselves is the failure this repository keeps paying for (F12, F45).
 */
import { createHash } from "node:crypto";

/** Anchor's derivation: the first 8 bytes of sha256 over a namespaced name. */
const anchorDisc = (preimage) => createHash("sha256").update(preimage, "utf8").digest().subarray(0, 8);

export const account = {
  vault: anchorDisc("account:Vault"),
  mandate: anchorDisc("account:Mandate"),
  authorization: anchorDisc("account:Authorization"),
  jobEscrow: anchorDisc("account:JobEscrow"),
};

export const IX = {
  initializeVault: anchorDisc("global:initialize_vault"),
  deposit: anchorDisc("global:deposit"),
  openMandate: anchorDisc("global:open_mandate"),
  authorize: anchorDisc("global:authorize"),
  spendAuthorized: anchorDisc("global:spend_authorized"),
  amendMandate: anchorDisc("global:amend_mandate"),
  lockEscrow: anchorDisc("global:lock_escrow"),
  releaseEscrow: anchorDisc("global:release_escrow"),
  refundEscrow: anchorDisc("global:refund_escrow"),
};

export const VAULT_LEN = 105;
export const MANDATE_LEN = 138;
export const AUTHORIZATION_LEN = 130;
/** 8 + 32 job_id + 32 client + 32 provider + 8 amount + 8 timeout + 2 flags + 32 route. */
export const ESCROW_LEN = 154;

/** Program error codes the harnesses need to name (anchor_parity::err). */
export const ERRORS = {
  6019: "NO_COMMITMENT",
  6020: "BEFORE_TIMEOUT",
  6021: "ESCROW_ALREADY_SETTLED",
  6022: "ESCROW_NOT_FUNDED",
  6023: "INVALID_TIMEOUT",
};

// ── PDAs ─────────────────────────────────────────────────────────────────────

/** `[b"vault", principal]` */
export const vaultPda = (principal, programId, PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), principal.toBuffer()], programId);

/** `[b"escrow", vault, job_id]` — the job id is 32 bytes, the runtime's per-seed cap. */
export const escrowPda = (vault, jobId, programId, PublicKey) => {
  if (jobId.length !== 32) throw new Error("JOB_ID_NOT_32_BYTES");
  return PublicKey.findProgramAddressSync([Buffer.from("escrow"), vault.toBuffer(), Buffer.from(jobId)], programId);
};

/**
 * PRD §15.5 — the hash of a job's compensation route, domain-separated.
 *
 * The client does not decide what the route *is*; that is a commercial term agreed
 * between the parties. This only commits to a description of it, so an on-chain
 * refund can name what was promised without the program ever being able to execute
 * arbitrary calldata on the strength of a hash it cannot read. An all-zero hash is
 * the absence of a commitment and the program refuses it, so the domain prefix is
 * also what keeps a derived route from ever being zero.
 */
export const routeHashFor = (route) =>
  createHash("sha256").update(`mitra-recovery-route-v1:${route}`, "utf8").digest();
