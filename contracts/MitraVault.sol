// SPDX-License-Identifier: MIT

// ============================================================================
// CANONICAL MitraVault — THIS SOURCE PRODUCES THE DEPLOYED BYTECODE.
//
//   Base Sepolia (84532)   0x6a731a654423d64afb9839742c3e48c6c54eea9c
//   Tempo Moderato (42431) 0x19b3c58d85114bcc9451cff83e9c09c10986fcb0
//
// Verified by reading the chain, not a log: both carry 8,593 bytes of code, and
// PERMIT_TYPEHASH() on both returns 0xec3317dd5c94a5a003c11d0eaa00f56ddb10aa8b95c0057febc7827a774d249c,
// the keccak256 of the typehash string below.
//
// A DIFFERENT contract lives at contracts/src/MitraVault.sol with a DIFFERENT
// permit scheme (actionHash, uint64 version, [principal][holder] keying). It is
// NOT deployed. See contracts/README.md before editing anything here: changing
// this file invalidates every on-chain proof recorded in forge/PROOF_LEDGER.md.
//
// Addresses are quoted ONLY from lib/evm/deployments.json and chain receipts.
// An address reconstructed from a truncated or abbreviated string is not evidence
// — see F58 in forge/FAILURES.md.
// ============================================================================
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MitraVault — the EVM capital boundary
/// @notice A faithful port of `programs/mitra-vault` (ADR-0002, ADR-0009, PRD §15).
/// @dev Every rule here has a counterpart in the Solana program, and the reasoning
///      is copied rather than reinvented. Where this file departs from the EVM-first
///      sketch it is because the sketch reintroduced a bug the Solana program had
///      already found; those departures are marked DO NOT RE-ADD.
contract MitraVault is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── ADR-0002: positional capital, not a status ────────────────────────────
    // Six independent positions that sum to total. NOT a boolean: a vault is
    // routinely in several at once (frozen AND mid-settlement, encumbered AND
    // escrowed). See docs/adr/0002.
    struct Positions {
        uint256 total;
        uint256 available;
        uint256 reserved;
        uint256 escrowed;
        uint256 encumbered;
        uint256 settling;
        uint256 frozen;
        /// An independent GUARD, not a position. Halts new spend without touching
        /// the arithmetic — a freeze must not corrupt positional accounting.
        bool emergencyFreeze;
    }

    // ── ADR-0009: versioned authority ─────────────────────────────────────────
    struct Mandate {
        address principal;
        address holder;
        uint64 limit;          // per-transaction, checked AT ISSUANCE
        uint64 ceiling;        // cumulative, enforced at spend
        uint64 spent;          // cumulative tracked
        uint64 expiresAt;
        uint32 version;        // monotonic; a permit cites the version it was issued under
        address policyEngine;  // the only signer that can authorise a spend
        bool revoked;          // terminal
    }

    // ── PRD §15 / ERC-8183: commercial escrow ────────────────────────────────
    struct EscrowJob {
        address client;
        address provider;
        address token;
        uint256 amount;
        uint64 timeout;
        bool completed;
        bool refunded;
    }

    // NOTE the missing `settlementId`/chain binding relative to the Rust
    // `action_digest`: `block.chainid` and `address(this)` are covered by the
    // EIP-712 domain separator, so a permit cannot be replayed on another chain
    // or against a re-deployed contract at the same address.
    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "SpendPermit(address principal,address holder,address token,bytes32 actionHash,uint256 amount,address recipient,uint32 mandateVersion,uint64 deadline)"
    );

    /// The signed terms. Ported from the v2 variant: `actionHash` replaces the
    /// free-form `settlementId` string, so the binding is a fixed-width digest
    /// rather than caller-chosen text that two callers could spell differently.
    struct SpendPermit {
        address principal;
        address holder;
        address token;
        bytes32 actionHash;
        uint256 amount;
        address recipient;
        uint32 mandateVersion;
        uint64 deadline;
    }

    mapping(address => mapping(address => Positions)) public vaults;
    // Keyed by [principal][holder], ported from the v2 variant. Keyed by holder
    // alone, Principal A could open a mandate on an agent address Principal B
    // wants, squatting it so B's own openMandate reverts MANDATE_ALREADY_EXISTS.
    // Keyed by [principal][holder][token] (F61). Keyed by holder alone, `limit` and
    // `ceiling` are raw atomic units, so a ceiling meant as "500 USD" (500e6 units)
    // also authorised 500e6 raw units of every other token in the vault — with an
    // 8-decimal token that is 5 BTC. The on-chain bound then fails to bound value.
    mapping(address => mapping(address => mapping(address => Mandate))) public mandates;
    mapping(bytes32 => bool) public consumedPermits;
    mapping(bytes32 => EscrowJob) public escrows;

    event Deposited(address indexed principal, address indexed token, uint256 amount);
    event Withdrawn(address indexed principal, address indexed token, uint256 amount, address indexed recipient);
    event MandateOpened(address indexed principal, address indexed holder, uint32 version, uint64 limit, uint64 ceiling, address policyEngine);
    event MandateAmended(address indexed holder, uint32 newVersion, uint64 newLimit, uint64 newCeiling);
    event MandateRevoked(address indexed caller, address indexed holder);
    event EmergencyFreezeToggled(address indexed principal, address indexed token, bool frozen);
    // NOTE: 3 indexed max (solc 7249) — actionHash is NOT indexed. It is the
    // single most useful field for an indexer, so if one must be dropped later, drop
    // `principal`, not this.
    event SpendExecuted(address indexed principal, address indexed recipient, address indexed token, uint256 amount, bytes32 actionHash);
    event EscrowLocked(bytes32 indexed jobId, address indexed client, address indexed provider, address token, uint256 amount, uint64 timeout);
    event EscrowReleased(bytes32 indexed jobId, address indexed provider, uint256 amount);
    event EscrowRefunded(bytes32 indexed jobId, address indexed client, uint256 amount);

    constructor() EIP712("MitraVault", "1") {}

    /// The EIP-712 domain separator, as a single hash.
    ///
    /// OZ v5 exposes `eip712Domain()` (IERC5267) which returns a STRUCT, not the
    /// digest, and keeps `_domainSeparatorV4()` internal — so an off-chain client
    /// has to rebuild the whole derivation to sign. The test that does exactly that
    /// got it wrong and produced `POLICY_ENGINE_MISMATCH` on four passing tests: an
    /// error that points at the signature rather than at the harness.
    ///
    /// Publishing the separator removes that entire class of bug. A client that
    /// cannot obtain the value has to guess, and a client that guesses signs against
    /// the wrong domain.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// DO NOT RE-ADD: a boolean `frozen`. ADR-0002 requires six positions, and a
    /// freeze is a guard that must not perturb the sum.
    ///
    /// Mutation-verified: removing the freeze guard from `withdraw` fails
    /// `test_frozen_vault_cannot_be_drained`.
    function _assertReconciled(Positions memory p) internal pure {
        require(
            p.total == (p.available + p.reserved + p.escrowed + p.encumbered + p.settling + p.frozen),
            "VAULT_RECONCILIATION_FAILED"
        );
    }

    // ── 1. capital ───────────────────────────────────────────────────────────

    function deposit(address token, uint256 amount) external nonReentrant {
        require(amount > 0, "INVALID_AMOUNT");
        Positions storage p = vaults[msg.sender][token];
        p.total += amount;
        p.available += amount;
        _assertReconciled(p);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, token, amount);
    }

    /// Principal-only by construction: `msg.sender` IS the vault key.
    /// Frozen vaults cannot be drained — the F41 defect, which on Solana was a
    /// `withdraw` that skipped `is_frozen()` entirely.
    function withdraw(address token, uint256 amount, address recipient) external nonReentrant {
        Positions storage p = vaults[msg.sender][token];
        require(!p.emergencyFreeze, "VAULT_EMERGENCY_FROZEN");
        require(amount > 0 && amount <= p.available, "INSUFFICIENT_AVAILABLE");
        p.available -= amount;
        p.total -= amount;
        _assertReconciled(p);
        IERC20(token).safeTransfer(recipient, amount);
        emit Withdrawn(msg.sender, token, amount, recipient);
    }

    function setEmergencyFreeze(address token, bool freeze) external {
        vaults[msg.sender][token].emergencyFreeze = freeze;
        emit EmergencyFreezeToggled(msg.sender, token, freeze);
    }

    // ── 2. mandate lifecycle (ADR-0009) ───────────────────────────────────────

    function openMandate(address holder, address token, uint64 limit, uint64 ceiling, uint64 expiresAt, address policyEngine) external {
        require(mandates[msg.sender][holder][token].holder == address(0), "MANDATE_ALREADY_EXISTS");
        require(limit > 0 && ceiling >= limit, "EXCEEDS_MANDATE_CEILING");
        require(expiresAt > block.timestamp, "INVALID_EXPIRY");
        require(policyEngine != address(0), "INVALID_POLICY_ENGINE");
        mandates[msg.sender][holder][token] = Mandate({
            principal: msg.sender, holder: holder, limit: limit, ceiling: ceiling,
            spent: 0, expiresAt: expiresAt, version: 1, policyEngine: policyEngine, revoked: false
        });
        emit MandateOpened(msg.sender, holder, 1, limit, ceiling, policyEngine);
    }

    /// Amending governs FUTURE permits. A permit already issued stands.
    function amendMandate(address holder, address token, uint64 newLimit, uint64 newCeiling, uint64 newExpiresAt) external {
        Mandate storage m = mandates[msg.sender][holder][token];
        require(m.principal == msg.sender, "UNAUTHORIZED_PRINCIPAL");
        require(!m.revoked, "MANDATE_REVOKED");
        require(m.expiresAt > block.timestamp, "MANDATE_EXPIRED");
        require(newLimit > 0 && newCeiling >= newLimit, "EXCEEDS_MANDATE_CEILING");
        m.version += 1;
        m.limit = newLimit;
        m.ceiling = newCeiling;
        m.expiresAt = newExpiresAt;
        emit MandateAmended(holder, m.version, newLimit, newCeiling);
    }

    /// Revoking is asymmetric with amending ON PURPOSE: revoke means "this agent is
    /// compromised" and must stop value NOW, so it reaches back and kills outstanding
    /// permits. The holder may also revoke itself, which cannot move value.
    function revokeMandate(address principal, address holder, address token) external {
        Mandate storage m = mandates[principal][holder][token];
        require(msg.sender == m.principal || msg.sender == m.holder, "UNAUTHORIZED");
        require(!m.revoked, "ALREADY_REVOKED");
        m.revoked = true;
        emit MandateRevoked(msg.sender, holder);
    }

    // ── 3. guarded spend — the load-bearing invariant ─────────────────────────

    function spendAuthorized(
        SpendPermit calldata permit,
        bytes calldata signature
    ) external nonReentrant {
        address principal = permit.principal;
        address holder     = permit.holder;
        address token      = permit.token;
        uint256 amount     = permit.amount;

        Mandate storage m = mandates[principal][holder][token];
        Positions storage p = vaults[principal][token];

        require(m.principal == principal, "PRINCIPAL_MISMATCH");
        require(!m.revoked, "MANDATE_REVOKED");
        require(block.timestamp < m.expiresAt, "MANDATE_EXPIRED");
        require(block.timestamp <= permit.deadline, "PERMIT_EXPIRED");
        // DO NOT RE-ADD equality here. A mutation test kills the one test that covers
        // this when `==` is restored. `== m.version` also rejects permits issued
        // under an OLDER version, so every amendment instantly strands every
        // outstanding permit — the same live-lock the `m.limit` re-check caused,
        // arriving through a second door. The Solana reference is explicit
        // (lib.rs:880): only a version FROM THE FUTURE is not something this
        // mandate issued. A permit issued under v1 was authorised under v1's limit,
        // which is exactly the promise ADR-0009 says must stand.
        require(permit.mandateVersion <= m.version, "MANDATE_VERSION_FROM_FUTURE");
        require(!p.emergencyFreeze, "VAULT_FROZEN");
        require(amount <= p.available, "INSUFFICIENT_AVAILABLE");
        require(m.spent + amount <= m.ceiling, "EXCEEDS_MANDATE_CEILING");

        // DO NOT RE-ADD `require(amount <= m.limit)`. A mutation test confirms this
        // line is load-bearing: reinstating it strands every outstanding permit the
        // moment a principal amends. It was removed on Solana after
        // it caused a live-lock: a principal tightening a limit would strand every
        // outstanding permit issued under the old one, and it makes a permit's
        // validity depend on WHEN it is spent rather than on the policy that
        // authorised it — the retroactive tightening ADR-0009 exists to prevent.
        // The limit is enforced at ISSUANCE, against the version the permit cites.

        bytes32 structHash = keccak256(abi.encode(
            PERMIT_TYPEHASH, principal, holder, token, permit.actionHash,
            amount, permit.recipient, permit.mandateVersion, permit.deadline
        ));
        bytes32 actionHash = _hashTypedDataV4(structHash);

        // Checks-Effects-Interactions. Verification precedes the state write.
        //
        // NOTE: an earlier revision of this comment claimed the old ordering
        // (consume, then verify) was a griefing vector — that anyone could burn a
        // live permit by submitting a bad signature. That was WRONG, and a mutation
        // test proved it: swapping these two lines leaves all 11 tests green.
        // EVM reverts are atomic and there is no external call between them, so a
        // failed verification rolls back the burn with it.
        //
        // The ordering is kept because CEI is the habit worth having, not because it
        // prevents an attack. It would only matter if a `try`/`catch` or a low-level
        // call were ever introduced between the two.
        address signer = ECDSA.recover(actionHash, signature);
        require(signer == m.policyEngine, "POLICY_ENGINE_MISMATCH");

        require(!consumedPermits[actionHash], "AUTHORIZATION_CONSUMED");
        consumedPermits[actionHash] = true;

        // Safe: the ceiling check above forces `amount <= ceiling - spent <= 2^64-1`,
        // so this downcast cannot truncate. Stated because an unchecked downcast in
        // an accounting field is the kind of thing that silently rots.
        m.spent += uint64(amount);
        p.available -= amount;
        p.total -= amount;
        _assertReconciled(p);

        IERC20(token).safeTransfer(permit.recipient, amount);
        emit SpendExecuted(principal, permit.recipient, token, amount, actionHash);
    }

    // ── 4. commercial escrow (PRD §15) ────────────────────────────────────────

    function lockEscrow(bytes32 jobId, address provider, address token, uint256 amount, uint64 timeout)
        external nonReentrant
    {
        require(escrows[jobId].client == address(0), "JOB_ALREADY_EXISTS");
        require(amount > 0, "INVALID_AMOUNT");
        require(timeout > block.timestamp, "INVALID_TIMEOUT");
        require(provider != address(0), "INVALID_PROVIDER");
        Positions storage p = vaults[msg.sender][token];
        require(!p.emergencyFreeze, "VAULT_FROZEN");
        require(amount <= p.available, "INSUFFICIENT_AVAILABLE");
        p.available -= amount;
        p.escrowed += amount;
        _assertReconciled(p);
        escrows[jobId] = EscrowJob({
            client: msg.sender, provider: provider, token: token,
            amount: amount, timeout: timeout, completed: false, refunded: false
        });
        emit EscrowLocked(jobId, msg.sender, provider, token, amount, timeout);
    }

    function releaseEscrow(bytes32 jobId) external nonReentrant {
        EscrowJob storage job = escrows[jobId];
        require(job.client != address(0), "JOB_NOT_FOUND");
        require(msg.sender == job.client, "ONLY_CLIENT_MAY_RELEASE");
        require(!job.completed && !job.refunded, "JOB_ALREADY_SETTLED");
        job.completed = true;
        Positions storage p = vaults[job.client][job.token];
        p.escrowed -= job.amount;
        p.total -= job.amount;   // capital LEAVES the vault
        _assertReconciled(p);
        IERC20(job.token).safeTransfer(job.provider, job.amount);
        emit EscrowReleased(jobId, job.provider, job.amount);
    }

    function refundEscrow(bytes32 jobId) external nonReentrant {
        EscrowJob storage job = escrows[jobId];
        require(job.client != address(0), "JOB_NOT_FOUND");
        require(msg.sender == job.client, "ONLY_CLIENT_MAY_REFUND");
        require(!job.completed && !job.refunded, "JOB_ALREADY_SETTLED");
        // DEVIATION from the sketch, deliberate: the sketch let the PROVIDER refund at
        // any time. That makes a paid-for commitment voidable at will by the party
        // being paid, which defeats the purpose of an escrow. Refund is the CLIENT's
        // remedy, after the timeout has passed or after an explicit rejection.
        // If provider-initiated cancellation is wanted it needs its own function and
        // its own consequence — not a footgun on the refund path.
        require(block.timestamp >= job.timeout, "TIMEOUT_NOT_REACHED");
        job.refunded = true;
        Positions storage p = vaults[job.client][job.token];
        p.escrowed -= job.amount;
        p.available += job.amount;   // capital STAYS in the vault
        _assertReconciled(p);
        emit EscrowRefunded(jobId, job.client, job.amount);
    }

    // NOTE: `reserved`, `encumbered` and `settling` are declared and reconciled but
    // have no transition yet. The six-position model is therefore only partially
    // exercised on EVM. That is stated rather than hidden: adding setters for them
    // without a use would make the reconciliation check pass vacuously, which is the
    // F42 failure shape.
}
