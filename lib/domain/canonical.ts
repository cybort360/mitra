/**
 * Canonical serialization and content hashing.
 *
 * ## Why this exists
 *
 * PRD §16 requires a canonical action digest over execution-relevant parameters,
 * §17.3 requires receipts to chain by `previousReceiptHash`, and §17.3 also asks
 * receipts to reference canonical objects by content hash. All three need one
 * thing: a byte string that is *the same for the same value*, across processes,
 * machines and runtimes, and different for every meaningfully different value.
 *
 * ## The properties that actually matter
 *
 * 1. **Key order cannot matter.** `{a:1,b:2}` and `{b:2,a:1}` are the same value.
 *    `JSON.stringify` preserves insertion order, so it would produce different
 *    digests for equal objects — and a receipt chain would fork on a key reorder.
 * 2. **Undefined is not the same as absent.** They mean different things when
 *    comparing two versions of an object.
 * 3. **Floats cannot be compared by bit pattern.** `0.1 + 0.2 !== 0.3`, and
 *    `1` and `1.0` are the same amount. Money must hash identically regardless
 *    of how it was written, or a legitimate re-serialization changes the hash.
 * 4. **Arrays are ordered; objects are not.** Sorting keys must not sort list
 *    elements — `["a","b"]` and `["b","a"]` are genuinely different intents.
 *
 * ## What this deliberately does not do
 *
 * It does not claim to be a general-purpose canonical JSON standard (RFC 8785
 * exists for that). It is scoped to Mitra's own objects, and it is pinned by
 * `tests/canonical.test.ts` including the float cases, which is the part most
 * likely to regress silently.
 */
import { createHash } from "node:crypto";

export type Canonical = null | boolean | number | string | Canonical[] | { [k: string]: Canonical };

/**
 * Money is canonicalized as a fixed-scale decimal string.
 *
 * Numbers cannot represent 0.1 exactly, so two amounts that are economically
 * identical can have different bit patterns. Converting through a decimal string
 * at a fixed scale makes `0.1` and `0.10` the same hash, and stops `1e-7` and
 * `0` from hashing as equal by accident.
 */
const MONEY_SCALE = 6;

/** Serialize a value to its canonical form. Stable across key orderings. */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return canonicalNumber(value);
    case "string":
      return JSON.stringify(value);
    case "bigint":
      return value.toString();
    default:
      break;
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  if (Array.isArray(value)) {
    // Order is significant for arrays and is preserved.
    return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      // Absent and undefined collapse to the same canonical form on purpose:
      // a key explicitly set to undefined carries no information.
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }

  throw new TypeError(`cannot canonicalize ${typeof value}`);
}

function canonicalNumber(n: number): string {
  if (!Number.isFinite(n)) {
    // NaN and Infinity have no stable representation; refusing is better than
    // emitting a value that hashes differently on another runtime.
    throw new TypeError(`cannot canonicalize non-finite number: ${n}`);
  }
  // Integers hash as integers, so 1 and 1.0 agree.
  if (Number.isInteger(n)) return n.toFixed(0);
  // Everything else goes through a fixed-scale decimal, so 0.1 and 0.10 agree
  // and 0.1 + 0.2 does not become a third value.
  return n.toFixed(MONEY_SCALE).replace(/0+$/, "").replace(/\.$/, "");
}

/** `sha256:<hex>` over the canonical form. Used for action digests and object hashes. */
export function contentHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

/** Hash with the domain separated, so two different uses cannot collide. */
export function typedHash(domain: string, value: unknown): string {
  return contentHash({ domain, value });
}

/**
 * Chain a hash, as PRD §17.3 requires for receipts.
 *
 * Separating the domain string from the payload is what makes the chain
 * tamper-evident: to alter any earlier receipt an attacker must recompute every
 * subsequent link, and each link is visible to an auditor as a stored field.
 */
export function chainHash(previousHash: string | null, value: unknown): string {
  return typedHash("mitra.receipt.v1", { previousHash: previousHash ?? null, value });
}

/**
 * Binds a settlement receipt to the exact set it settles.
 *
 * ## F47 — `docs/SECURITY.md`
 *
 * > A settlement receipt binds to the exact cleared obligation or transfer set.
 *
 * `chainHash` commits a receipt to the object it carries, and `resultHash` commits an
 * epoch to its netting result — but nothing bound a receipt to a *particular* clearing
 * result. A receipt for epoch A could be presented alongside epoch B's numbers and
 * nothing would object, because the two commitments were never combined.
 *
 * `settlementReceiptHash` binds all four things that must agree:
 *
 *   settlementId · epochId · resultHash · the residual transfers themselves
 *
 * The transfer list is included rather than referenced, deliberately. Including the
 * epoch's `resultHash` proves which computation was performed; including the actual
 * transfers proves the receipt describes the money that moved. A receipt that cites
 * an epoch but enumerates different transfers would have to change `resultHash` to
 * pass, which it cannot do without recomputing the whole netting.
 */
export function settlementReceiptHash(receipt: {
  settlementId: string;
  epochId: string;
  resultHash: string;
  residualTransfers: ReadonlyArray<{ from: string; to: string; amount: number }>;
}): string {
  return typedHash("mitra.settlement-receipt.v1", {
    settlementId: receipt.settlementId,
    epochId: receipt.epochId,
    resultHash: receipt.resultHash,
    // Sorted, because the order of a transfer list is not economically meaningful
    // and an unsorted list would let two identical settlements hash differently.
    residualTransfers: [...receipt.residualTransfers]
      .map((t) => ({ from: t.from, to: t.to, amount: t.amount }))
      .sort((a, b) => `${a.from}${a.to}${a.amount}`.localeCompare(`${b.from}${b.to}${b.amount}`)),
  });
}

/**
 * The PRD §15.5 commitment for a compensation route: 32 bytes over the route string,
 * domain-separated.
 *
 * ## Why this is sha256 with a domain prefix, and not keccak256 (F81)
 *
 * Two definitions of "the route hash" existed, and they disagreed:
 *
 * - `routeCommitment` here, added with F76, was `keccak256(route)`.
 * - `routeHashFor` in `lib/solana/vault-program.ts` was
 *   `sha256("mitra-recovery-route-v1:" + route)`.
 *
 * Both are 32 bytes and both rails accept either, because neither contract can read a
 * hash — `MitraJobEscrow.sol` and the Solana `JobEscrow` program only check it is
 * non-zero. So the disagreement was invisible on chain and only mattered at the one
 * place where it decides something: LP-6 has to hand **one** value to both rails and
 * store it on the agreement, and there was no single value to hand.
 *
 * The Solana definition wins, for two reasons. It is what LP-4's live devnet proof
 * actually committed, so it is the deployed reality. And a domain prefix is the
 * correct construction: without one, the same route string hashed for another purpose
 * would produce the same commitment, which is the cross-protocol collision the
 * `mitra.settlement-receipt.v1` / `typedHash` prefixes above exist to prevent.
 *
 * `routeHashFor` now delegates here, so there is one implementation and the two rails
 * cannot drift again.
 *
 * ## Why the route is hashed at all
 *
 * `Saga.compensationRoutes` stores route **ids**, and `compensate()` takes the route
 * bodies from a caller-supplied `availableRoutes` array. So a caller could hand back
 * the committed id with entirely different instructions behind it — the same id
 * pointing at a different contract, a different job, a different payee — and the
 * engine would run it. Hashing the route at declaration makes the id and the body one
 * value, so substituting the body breaks the check instead of satisfying it (F76).
 *
 * The empty string still hashes to a real non-zero digest, so callers must refuse an
 * empty route themselves; `armSaga` already does (`r.route.length > 0`).
 */
export function routeCommitment(route: string): string {
  return `0x${createHash("sha256").update(`mitra-recovery-route-v1:${route}`, "utf8").digest("hex")}`;
}
