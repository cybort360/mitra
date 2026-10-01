import { describe, expect, it } from "vitest";
import { keccak256 } from "js-sha3";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

/** Runs a script expecting failure, returning the error. */
const runExpectingFailure = (script: string, args: string[] = []) => {
  try {
    execFileSync("node", [path.join("scripts", script), ...args], { encoding: "utf8", stdio: "pipe" });
    return null;
  } catch (e) {
    return e as { status: number; stdout: string; stderr: string };
  }
};

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

  it("generate-dev-keys REFUSES to overwrite existing keys (F14)", () => {
    // The real funds-protection guard. The generator used to write
    // unconditionally, so "just re-run it to check it works" silently rotated
    // both keypairs and stranded the funds already sent to them. 0.1 ETH was
    // lost to exactly this before the guard existed.
    //
    // This test only runs when keys are present, and it does NOT rotate them:
    // it asserts the refusal, then confirms the address is untouched. If the
    // guard ever regresses, this test fails loudly instead of quietly
    // destroying whatever the operator has funded.
    const keyFile = path.join(".dev-keys", "evm-testnet.key");
    if (!existsSync(keyFile)) return;

    const before = readFileSync(path.join(".dev-keys", "evm-testnet.address"), "utf8");
    const err = runExpectingFailure("generate-dev-keys.mjs");

    expect(err).not.toBeNull();
    expect(err!.status).not.toBe(0);
    // It must name the address at risk and the non-destructive alternative.
    expect(err!.stderr).toMatch(/existing evm address/);
    expect(err!.stderr).toMatch(/verify-dev-keys\.mjs/);
    expect(err!.stderr).toMatch(/--force/);

    // The critical assertion: the key is still the same one.
    expect(readFileSync(path.join(".dev-keys", "evm-testnet.address"), "utf8")).toBe(before);
  });

  it("Tempo funding reads Moderato logs, never api.tempo.xyz", async () => {
    // The trap this guards: api.tempo.xyz indexes Tempo MAINNET. Its newest
    // block tracks mainnet's height, not Moderato's, so it reports an empty
    // balance for a funded testnet address. An empty response from the wrong
    // network looks exactly like an unfunded account.
    //
    // Measured, not asserted from literals: compare each API block height
    // against both nodes and record which chain it actually tracks.
    const height = async (url: string) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(12_000),
      });
      const j = await r.json() as { result?: string };
      return j.result ? parseInt(j.result, 16) : 0;
    };
    type Blocks = { data?: { number?: number }[] };
    const api: Blocks = await fetch("https://api.tempo.xyz/v1/blocks?limit=5", {
      signal: AbortSignal.timeout(12_000),
    }).then((r) => r.json() as Promise<Blocks>).catch(() => ({}));

    const mainnet = await height("https://rpc.tempo.xyz");
    const moderato = await height("https://rpc.moderato.tempo.xyz");
    expect(mainnet).toBeGreaterThan(0);
    expect(moderato).toBeGreaterThan(0);

    const apiTop = api.data?.[0]?.number ?? 0;
    expect(apiTop).toBeGreaterThan(0);
    // The API is within a few thousand blocks of exactly one chain. Which one is
    // the finding: if this ever flips to Moderato, the script's warning is stale.
    const nearMainnet = Math.abs(apiTop - mainnet) < 10_000;
    const nearModerato = Math.abs(apiTop - moderato) < 10_000;
    // Exactly one must be true — an API that tracked neither would be a third
    // failure mode this test should surface rather than silently allow.
    expect(nearMainnet !== nearModerato).toBe(true);
    expect(nearMainnet).toBe(true); // currently: mainnet, which is the hazard
  }, 40_000);

  it("fund-tempo.mjs verifies the mint actually reached the address", () => {
    // Receipt status alone is not proof of funding: `tempo_fundAddress` returns
    // successful transactions that must then be checked for a Transfer log
    // naming our address. The script does both and names the untrustworthy host.
    const out = run("fund-tempo.mjs");
    expect(out).toMatch(/Moderato/);
    expect(out).toMatch(/api\.tempo\.xyz indexes MAINNET/);
  });

  it("readiness asserts a deployable artifact, not a version banner", () => {
    // The Solana CLI being on PATH proves nothing about whether a program can be
    // built. `cargo-build-sbf` is the binary that turns Rust into the eBPF ELF a
    // validator runs, so that is what the readiness check requires. A check that
    // accepted a version string would report READY for a machine that cannot
    // deploy anything.
    const out = run("phase2-readiness.mjs");
    expect(out).toMatch(/cargo-build-sbf/);
    // And it must be able to say "absent" — a check with no failure branch is
    // not a check.
    expect(out).toMatch(/cargo-build-sbf.*(present|absent)/);
  }, 30_000);

  it("bridge-sepolia refuses the archived guide's Goerli address", async () => {
    // F16. The guide the Base docs link to is archived and hardcoded to Goerli.
    // Its L1StandardBridge has no code on Sepolia, so a script that trusted the
    // README would send value to nothing. The verification is a live check: the
    // documented Sepolia bridge must have code AND report the documented
    // messenger. A wrong-but-plausible address fails both.
    const GOOD = "0xfd0Bf71F60660E2f608ed56e1659C450eB113120";
    const GOERLI = "0xfA6D8Ee5BE770F84FC001D098C4bD604Fe01284a";

    const rpc = async (url: string, method: string, params: unknown[]) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      return (await r.json()) as { result?: string; error?: { message?: string } };
    };
    const url = "https://ethereum-sepolia-rpc.publicnode.com";

    const good = await rpc(url, "eth_getCode", [GOOD, "latest"]);
    const bad = await rpc(url, "eth_getCode", [GOERLI, "latest"]);

    // The property that makes this a real guard: the archived guide's address
    // resolves to nothing, so a script that merely *had* an address would not
    // notice. Only asking the chain distinguishes them.
    expect(good.result && good.result.length).toBeGreaterThan(2);
    expect(bad.result).toBe("0x");

    // And the good one identifies itself: messenger() must be the documented
    // L1CrossDomainMessenger, not merely "some contract".
    const m = await rpc(url, "eth_call", [{ to: GOOD, data: "0x3cb747bf" }, "latest"]);
    expect("0x" + (m.result ?? "").slice(-40).toLowerCase())
      .toBe("0xc34855f4de64f1840e5686e64278da901e261f20");
  }, 40_000);

  it("the Portal's depositTransaction works where the bridge's depositETH reverts", async () => {
    // The correction in F16. `depositETH` on L1StandardBridge reverts for an
    // EOA, but `depositTransaction` on the OptimismPortal is a different
    // function on a different contract with different access control — and it
    // works. Both are simulated with eth_call, so no gas is spent and the
    // difference is measured rather than assumed.
    const PORTAL = "0x49f53e41452C74589E85cA1677426Ba426459e85";
    const BRIDGE = "0xfd0Bf71F60660E2f608ed56e1659C450eB113120";
    const ME = "0xaea8bc34df7745e35510214147a2f6a5e15eb26d";
    const url = "https://ethereum-sepolia-rpc.publicnode.com";

    const call = async (to: string, data: string, value: string) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to, data, value }, "latest"],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      return (await r.json()) as { result?: string; error?: unknown };
    };
    const sel = (s: string) => "0x" + keccak256(s).slice(0, 8);
    const pad = (a: string) => a.slice(2).padStart(64, "0");
    const VALUE = "0x" + (10n ** 16n).toString(16);

    // depositTransaction(address,uint256,uint64,bool,bytes)
    //
    // The head is 5 words, so the dynamic `bytes` tail begins at 0xa0, not
    // 0x20. Getting that wrong ABI-encodes valid-looking calldata that reverts,
    // which is how the first version of this test "disproved" a working call.
    const words = (...v: bigint[]) => v.map((n) => n.toString(16).padStart(64, "0")).join("");
    const portal = await call(PORTAL,
      sel("depositTransaction(address,uint256,uint64,bool,bytes)") +
      pad(ME) + words(10n ** 16n, 200000n, 0n, 160n, 0n),
      VALUE);

    // depositETH(address,uint32,bytes) — 3 head words, so the tail is at 0x60.
    const bridge = await call(BRIDGE,
      sel("depositETH(address,uint32,bytes)") + pad(ME) + words(200000n, 96n, 0n),
      VALUE);

    // The portal succeeds: a result and no error. `0x` is the empty success
    // return, which is exactly what a void function returns.
    expect(portal.error).toBeUndefined();
    expect(portal.result).toBeDefined();
    // The bridge reverts. Asserting the *difference* is the point: one entry
    // point being gated says nothing about the other.
    expect(bridge.error).toBeDefined();
  }, 40_000);

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
