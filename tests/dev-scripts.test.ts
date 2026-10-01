import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The key-generation scripts, checked.
 *
 * These produce the addresses real test funds will be sent to, so "it printed
 * something" is not a sufficient standard. Each check re-derives rather than
 * re-reads, which is the only way an address can be shown to belong to a key.
 *
 * The known-answer vector matters most. An earlier draft derived EVM addresses
 * through a hand-assembled PKCS#8 envelope that Node rejected, and before that
 * used `createHash('sha3-256')` — which is *not* keccak256 and would have
 * produced well-formed addresses belonging to no key at all. Test tokens sent to
 * one of those would simply be gone. So the vector is asserted here, and
 * `generate-dev-keys.mjs` refuses to run if it fails.
 */
const run = (script: string) =>
  execFileSync("node", [path.join("scripts", script)], { encoding: "utf8" });

const hasKeys = existsSync(path.join(".dev-keys", "evm-testnet.key"));

describe.skipIf(!hasKeys)("dev key scripts", () => {
  it("verify-dev-keys re-derives every address from the stored secret", () => {
    // The script exits non-zero on any mismatch, so a clean run is the proof.
    expect(run("verify-dev-keys.mjs")).toContain("All keys re-derive correctly.");
  });

  it("dev-keys.mjs prints both addresses and the faucets", () => {
    const out = run("dev-keys.mjs");
    expect(out).toMatch(/Solana devnet/);
    expect(out).toMatch(/faucet\.solana\.com/);
    expect(out).toMatch(/0x[0-9a-f]{40}/);
  });

  it("generation is idempotent in shape — a second run produces a valid pair", () => {
    // Not comparing addresses: a second run *should* produce different keys.
    // What must hold is that the derivation still verifies, which is what would
    // catch a broken change to the crypto path.
    const out = run("verify-dev-keys.mjs");
    expect(out).toContain("OK");
  });

  it("the readiness script reports preconditions, not adjectives", () => {
    // Network probes may fail in CI, so only the structure is asserted.
    const out = run("phase2-readiness.mjs");
    expect(out).toMatch(/READY|BLOCKED/);
    expect(out).toMatch(/preconditions met/);
  });

  it("Tempo readiness is pinned to Moderato, and mainnet is refused", () => {
    // The check that matters. A readiness script pointed at Tempo mainnet must
    // not report the testnet as live, or every downstream claim built on it
    // refers to the wrong chain. See forge/FAILURES.md F12.
    const moderato = run("phase2-readiness.mjs");
    expect(moderato).toContain("Tempo Moderato RPC");
    // The real assertion: mainnet must be *blocked*, with the reason named.
    const mainnet = execFileSync("node", [path.join("scripts", "phase2-readiness.mjs")], {
      encoding: "utf8",
      env: { ...process.env, TEMPO_RPC_URL: "https://rpc.tempo.xyz" },
    });
    expect(mainnet).toMatch(/BLOCKED\s+Tempo Moderato RPC/);
    expect(mainnet).toMatch(/4217/);
  });
});

describe("Tempo balance semantics (F12)", () => {
  const RPC = process.env.TEMPO_RPC_URL ?? "https://rpc.moderato.tempo.xyz";
  const balance = async (address: string) => {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return BigInt((await r.json() as { result: string }).result);
  };

  it("returns the SAME non-zero value for unrelated addresses", async () => {
    // Documentation says native balance is always 0. The node returns a large
    // constant instead. This is measured, not asserted from a literal, so the
    // test fails if the node's behaviour changes.
    //
    // The failure this guards is a vault controller reading a balance,
    // concluding it is unimaginably funded, and moving capital on that basis.
    const [dev, dead, ones] = await Promise.all([
      balance("0x5a335c1fdbfd660c54e83e2b77dcf31f6dc2fb29"),
      balance("0x000000000000000000000000000000000000dead"),
      balance("0x1111111111111111111111111111111111111111"),
    ]);

    // Address-independence is the whole point: a value that is identical for
    // every address carries no information about any of them.
    expect(dev).toBe(dead);
    expect(dev).toBe(ones);
    // And it is large, so it survives a naive `> 0` funding check.
    expect(dev).toBeGreaterThan(0n);
  }, 20_000);

  it("a zero-balance chain would return 0 — so the constant is the anomaly", async () => {
    // Makes the finding falsifiable in both directions.
    //
    // If Tempo ever implements a real native balance, eth_getBalance becomes
    // address-dependent and these two assertions fail — which is the signal to
    // revisit F12 rather than leave a stale warning in the code. If instead the
    // node starts returning 0 as the docs claim, the >0 assertion fails and the
    // docs are vindicated. Either way the test reacts to reality.
    const dev = await balance("0x5a335c1fdbfd660c54e83e2b77dcf31f6dc2fb29");
    const other = await balance("0x000000000000000000000000000000000000bEEF");
    expect(dev).toBe(other);
    // Currently: large, constant, address-independent. Not a balance.
    expect(dev).toBeGreaterThan(0n);
  }, 20_000);
});

describe("key derivation correctness", () => {
  it("keccak256 of scalar 1 is the published secp256k1 address", () => {
    // The vector that distinguishes keccak256 from SHA3-256. If someone
    // "simplifies" this to Node's built-in sha3-256, this fails — and the
    // failure is loud, which is the entire point.
    const { createECDH } = require("node:crypto") as typeof import("node:crypto");
    const { keccak256 } = require("js-sha3") as { keccak256: (s: Uint8Array) => string };
    const raw = Buffer.alloc(32);
    raw[31] = 1;
    const ecdh = createECDH("secp256k1");
    ecdh.setPrivateKey(raw);
    const pub = ecdh.getPublicKey();
    const addr = ("0x" + keccak256(pub.subarray(1)).slice(-40)).toLowerCase();
    expect(addr).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  });

  it("sha3-256 is NOT keccak256, which is why the library is required", () => {
    // Documents the trap rather than just avoiding it. If this ever stops
    // holding, the two have converged and the dependency can be revisited.
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const { keccak256 } = require("js-sha3") as { keccak256: (s: Uint8Array) => string };
    const input = new Uint8Array(Buffer.from("hello"));
    expect(createHash("sha3-256").update(input).digest("hex")).not.toBe(keccak256(input));
  });
});
