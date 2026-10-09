/**
 * The sandbox's chain (PP-7): a throwaway anvil node running the real MitraJobEscrow.
 *
 * Nothing on it is a stand-in for the contract. The escrow is the compiled
 * `contracts/src/ERC8183/MitraJobEscrow.sol`; time travel is anvil's own
 * `evm_increaseTime`, so a timeout refund is the contract's `block.timestamp >=
 * timeout` branch, reached in milliseconds. The token is the 6-decimal `PlainToken`
 * the escrow's Foundry suite uses, deployed fresh.
 *
 * Only the CHAIN clock moves. Mitra's off-chain clock is the wall clock.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  createPublicClient, createWalletClient, http, parseAbi,
  type Abi, type Address, type Hex, type PublicClient,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";

/** Anvil's chain id. The sandbox refuses any other, so it can never address a real network. */
export const SANDBOX_CHAIN_ID = 31337;

/** Anvil's default dev mnemonic. Public by design; these keys guard nothing. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

const ROOT = process.cwd();
const ARTIFACTS = {
  // `out/` is foundry.toml's `out`. It was previously `contracts/out`, which is a STALE
  // duplicate: nothing writes it any more, and it silently shadowed a rebuilt contract, so
  // a Solidity fix compiled cleanly and the sandbox kept deploying the old bytecode. F95
  // looked "not fixed" for that reason and nothing else.
  escrow: join(ROOT, "out/MitraJobEscrow.sol/MitraJobEscrow.json"),
  token: join(ROOT, "out/MitraJobEscrow.t.sol/PlainToken.json"),
};

export const SANDBOX_TOKEN_ABI = parseAbi([
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function balanceOf(address who) external view returns (uint256)",
]);

export interface SandboxClock {
  /** The chain's latest block timestamp, unix seconds. */
  now(): Promise<number>;
  /** Moves the chain clock forward and mines a block, so the next call sees the new time. */
  advanceSeconds(seconds: number): Promise<number>;
}

export interface LocalChain {
  rpcUrl: string;
  chainId: number;
  /** Anvil dev accounts 0..9. Account 0 deploys and relays. */
  accounts: HDAccount[];
  escrow: Address;
  token: Address;
  clock: SandboxClock;
  publicClient: PublicClient;
  /** Sends `amount` base units of the sandbox token from `from` to `to`. */
  transferToken(from: HDAccount, to: Address, amount: bigint): Promise<Hex>;
  tokenBalance(who: Address): Promise<bigint>;
  stop(): Promise<void>;
}

export class SandboxChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxChainError";
  }
}

export function anvilAvailable(bin = process.env.MITRA_ANVIL_BIN ?? "anvil"): boolean {
  return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
}

export async function startLocalChain(opts: { anvilBin?: string } = {}): Promise<LocalChain> {
  const bin = opts.anvilBin ?? process.env.MITRA_ANVIL_BIN ?? "anvil";
  if (!anvilAvailable(bin)) {
    throw new SandboxChainError(`anvil not found (${bin}). Install Foundry: https://getfoundry.sh`);
  }
  ensureArtifacts();

  const port = await freePort();
  const node: ChildProcess = spawn(bin, ["--port", String(port), "--chain-id", String(SANDBOX_CHAIN_ID), "--silent"], { stdio: "ignore" });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const stop = () => new Promise<void>((done) => {
    if (node.exitCode !== null) return done();
    node.once("exit", () => done());
    node.kill("SIGTERM");
  });

  try {
    const publicClient = createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
    await waitForRpc(publicClient);
    const chainId = await publicClient.getChainId();
    if (chainId !== SANDBOX_CHAIN_ID) throw new SandboxChainError(`refusing chain id ${chainId}: the sandbox runs only on ${SANDBOX_CHAIN_ID}`);

    const accounts = Array.from({ length: 10 }, (_, i) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }));
    const deployer = accounts[0];
    const escrow = await deploy(rpcUrl, publicClient, deployer, ARTIFACTS.escrow, []);
    const token = await deploy(rpcUrl, publicClient, deployer, ARTIFACTS.token, [deployer.address]);

    const rpc = (method: string, params: unknown[]) =>
      publicClient.request({ method: method as never, params: params as never });
    const clock: SandboxClock = {
      now: async () => Number((await publicClient.getBlock()).timestamp),
      advanceSeconds: async (seconds) => {
        await rpc("evm_increaseTime", [seconds]);
        await rpc("evm_mine", []);
        return clock.now();
      },
    };

    return {
      rpcUrl, chainId, accounts, escrow, token, clock, publicClient,
      transferToken: async (from, to, amount) => {
        const wallet = createWalletClient({ account: from, transport: http(rpcUrl) });
        const hash = await wallet.writeContract({ address: token, abi: SANDBOX_TOKEN_ABI, functionName: "transfer", args: [to, amount], chain: null });
        const rc = await publicClient.waitForTransactionReceipt({ hash });
        if (rc.status !== "success") throw new SandboxChainError(`token transfer reverted: ${hash}`);
        return hash;
      },
      tokenBalance: (who) => publicClient.readContract({ address: token, abi: SANDBOX_TOKEN_ABI, functionName: "balanceOf", args: [who] }),
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

/**
 * Builds the contracts unless the artifacts are present AND newer than their sources.
 *
 * **Staleness matters as much as absence.** The previous version built only when an artifact
 * was missing, so after a Solidity fix the sandbox deployed the previous bytecode and the
 * fix appeared to do nothing. Comparing mtimes against the source is what turns "the file
 * exists" into "the file is current".
 */
function ensureArtifacts(): void {
  if (artifactsAreCurrent()) return;
  const r = spawnSync("forge", ["build"], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0 || !Object.values(ARTIFACTS).every((p) => existsSync(p))) {
    throw new SandboxChainError("forge build did not produce the MitraJobEscrow artifacts");
  }
}

function artifactsAreCurrent(): boolean {
  if (!Object.values(ARTIFACTS).every((p) => existsSync(p))) return false;
  let newestSource = 0;
  for (const dir of ["contracts/src", "contracts/test"]) {
    for (const file of walk(join(ROOT, dir))) {
      newestSource = Math.max(newestSource, mtime(file));
    }
  }
  const oldestArtifact = Math.min(...Object.values(ARTIFACTS).map(mtime));
  return oldestArtifact >= newestSource;
}

/** Every `.sol` under `dir`, recursively. A build artefact is not a source. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".sol")) out.push(full);
  }
  return out;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

async function deploy(rpcUrl: string, pub: PublicClient, from: HDAccount, artifact: string, args: unknown[]): Promise<Address> {
  const json = JSON.parse(readFileSync(artifact, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  const wallet = createWalletClient({ account: from, transport: http(rpcUrl) });
  const hash = await wallet.deployContract({ abi: json.abi, bytecode: json.bytecode.object, args, chain: null });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success" || !rc.contractAddress) throw new SandboxChainError(`deploy of ${artifact} failed: ${hash}`);
  return rc.contractAddress;
}

async function waitForRpc(pub: PublicClient): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { await pub.getChainId(); return; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  throw new SandboxChainError("anvil did not answer on its RPC port within 5s");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}
