// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MitraVault — the EVM capital boundary (sprint item 6; the lead's Package B).
///
/// @notice The EVM counterpart of `programs/mitra-vault`, carrying the F51 fix from
/// the start. The load-bearing rule: a policy engine's ALLOW is not permission to
/// move value. This contract re-derives, for every spend, whose capital it is, who
/// may authorize it, and who gets paid — none of it from the caller.
///
/// Deviations from the lead's sketch (HANDOFF_SOLANA_VERIFICATION_AND_EVM_VAULTS.md),
/// each because the sketch would have shipped F51 again:
///  - Mandates are keyed by (principal, holder), not holder alone. A holder-only key
///    names no vault, and lets the first principal to grant a holder squat the slot
///    for every other principal (the reseed the lead approved in seq 55).
///  - Only the principal opens or amends a mandate on its own vault (msg.sender).
///    The holder may only revoke itself.
///  - The permit binds principal, holder, token, recipient and mandate version, not
///    only an action hash. A permit is therefore spendable by anyone (a relayer) but
///    redirectable by no one.
///  - A cumulative ceiling is enforced, and permits are single-use per mandate.
contract MitraVault is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Position {
        uint256 available;
        uint256 escrowed;
        bool frozen;
    }

    struct Mandate {
        address engine; // the only key whose permits this mandate honours (EOA or ERC-1271)
        address token;
        uint128 limit; // per spend
        uint128 ceiling; // cumulative over the mandate's life
        uint128 spent;
        uint64 expiresAt;
        uint64 version; // bumps on every open/amend; permits name the version that issued them
        bool revoked;
    }

    struct SpendPermit {
        address principal;
        address holder;
        address token;
        bytes32 actionHash; // Mitra's settlement commitment
        uint256 amount;
        address recipient;
        uint64 mandateVersion;
        uint64 deadline;
    }

    struct Escrow {
        address client;
        address provider;
        address token;
        uint256 amount;
        uint64 timeout;
        bool open;
    }

    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "SpendPermit(address principal,address holder,address token,bytes32 actionHash,uint256 amount,address recipient,uint64 mandateVersion,uint64 deadline)"
    );

    mapping(address principal => mapping(address token => Position)) public positions;
    mapping(address principal => mapping(address holder => Mandate)) public mandates;
    /// keccak256(principal, holder, actionHash) => consumed
    mapping(bytes32 => bool) public consumed;
    mapping(bytes32 jobId => Escrow) public escrows;

    event Deposited(address indexed principal, address indexed token, uint256 amount);
    event Withdrawn(address indexed principal, address indexed token, uint256 amount, address to);
    event FreezeSet(address indexed principal, address indexed token, bool frozen);
    event MandateOpened(address indexed principal, address indexed holder, address engine, address token, uint128 limit, uint128 ceiling, uint64 expiresAt, uint64 version);
    event MandateRevoked(address indexed principal, address indexed holder, address by);
    event SpendExecuted(address indexed principal, address indexed holder, address indexed recipient, address token, uint256 amount, bytes32 actionHash, uint64 mandateVersion);
    event EscrowLocked(bytes32 indexed jobId, address indexed client, address indexed provider, address token, uint256 amount, uint64 timeout);
    event EscrowReleased(bytes32 indexed jobId, address indexed to, uint256 amount);
    event EscrowRefunded(bytes32 indexed jobId, address indexed to, uint256 amount, address by);

    error ZeroAmount();
    error ZeroAddress();
    error VaultFrozen();
    error InsufficientAvailable();
    error NoMandate();
    error MandateIsRevoked();
    error MandateExpired();
    error BadMandateTerms();
    error NotPrincipalOrHolder();
    error PermitExpired();
    error VersionMismatch();
    error TokenMismatch();
    error EngineSignatureInvalid();
    error ExceedsLimit();
    error ExceedsCeiling();
    error AlreadyConsumed();
    error EscrowExists();
    error EscrowNotOpen();
    error NotClient();
    error RefundNotAllowedYet();

    constructor() EIP712("MitraVault", "1") {}

    // ── capital ─────────────────────────────────────────────────────────────

    /// Credits what actually arrived, not what was asked for, so a token that takes
    /// a fee on transfer cannot over-credit a vault.
    function deposit(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        positions[msg.sender][token].available += received;
        emit Deposited(msg.sender, token, received);
    }

    /// Principal only, by construction: the position is msg.sender's own.
    function withdraw(address token, uint256 amount, address to) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        Position storage p = positions[msg.sender][token];
        // F41 on Solana: withdraw skipped the freeze check and a frozen vault could
        // be drained. Not repeated here.
        if (p.frozen) revert VaultFrozen();
        if (p.available < amount) revert InsufficientAvailable();
        p.available -= amount;
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(msg.sender, token, amount, to);
    }

    function setFrozen(address token, bool frozen) external {
        positions[msg.sender][token].frozen = frozen;
        emit FreezeSet(msg.sender, token, frozen);
    }

    // ── mandates ────────────────────────────────────────────────────────────

    /// Open, or amend, the mandate `holder` holds over msg.sender's vault. The
    /// version always increases, so every permit issued under earlier terms dies.
    function openMandate(address holder, address engine, address token, uint128 limit, uint128 ceiling, uint64 expiresAt) external {
        if (holder == address(0) || engine == address(0) || token == address(0)) revert ZeroAddress();
        if (limit == 0 || ceiling < limit || expiresAt <= block.timestamp) revert BadMandateTerms();
        Mandate storage m = mandates[msg.sender][holder];
        uint64 version = m.version + 1;
        mandates[msg.sender][holder] = Mandate({
            engine: engine, token: token, limit: limit, ceiling: ceiling,
            // Amending keeps the spend history: a new ceiling is not a new budget.
            spent: m.revoked ? 0 : m.spent,
            expiresAt: expiresAt, version: version, revoked: false
        });
        emit MandateOpened(msg.sender, holder, engine, token, limit, ceiling, expiresAt, version);
    }

    /// The principal may revoke; the holder may revoke its own mandate — an agent can
    /// stop itself, never widen itself (lead, seq 55).
    function revokeMandate(address principal, address holder) external {
        if (msg.sender != principal && msg.sender != holder) revert NotPrincipalOrHolder();
        Mandate storage m = mandates[principal][holder];
        if (m.version == 0) revert NoMandate();
        m.revoked = true;
        emit MandateRevoked(principal, holder, msg.sender);
    }

    // ── guarded spend ───────────────────────────────────────────────────────

    function permitDigest(SpendPermit calldata p) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            PERMIT_TYPEHASH, p.principal, p.holder, p.token, p.actionHash, p.amount, p.recipient, p.mandateVersion, p.deadline
        )));
    }

    /// Anyone may submit; nothing about the payment is theirs to choose. The vault
    /// debited, the payee and the amount are all inside the engine's signature, and
    /// the engine must be the one the principal named on this mandate.
    function spendAuthorized(SpendPermit calldata p, bytes calldata engineSignature) external nonReentrant {
        if (p.amount == 0) revert ZeroAmount();
        if (p.recipient == address(0)) revert ZeroAddress();
        if (block.timestamp > p.deadline) revert PermitExpired();

        Mandate storage m = mandates[p.principal][p.holder];
        if (m.version == 0) revert NoMandate();
        if (m.revoked) revert MandateIsRevoked();
        if (block.timestamp >= m.expiresAt) revert MandateExpired();
        if (p.mandateVersion != m.version) revert VersionMismatch();
        if (p.token != m.token) revert TokenMismatch();
        if (!SignatureChecker.isValidSignatureNow(m.engine, permitDigest(p), engineSignature)) revert EngineSignatureInvalid();
        if (p.amount > m.limit) revert ExceedsLimit();
        if (uint256(m.spent) + p.amount > m.ceiling) revert ExceedsCeiling();

        bytes32 key = keccak256(abi.encode(p.principal, p.holder, p.actionHash));
        if (consumed[key]) revert AlreadyConsumed();
        consumed[key] = true;

        Position storage pos = positions[p.principal][p.token];
        if (pos.frozen) revert VaultFrozen();
        if (pos.available < p.amount) revert InsufficientAvailable();
        pos.available -= p.amount;
        m.spent += uint128(p.amount);

        IERC20(p.token).safeTransfer(p.recipient, p.amount);
        emit SpendExecuted(p.principal, p.holder, p.recipient, p.token, p.amount, p.actionHash, p.mandateVersion);
    }

    // ── escrow (ERC-8183-shaped job escrow; PRD §15 recovery leg) ──────────

    function lockEscrow(bytes32 jobId, address provider, address token, uint256 amount, uint64 timeout) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (provider == address(0)) revert ZeroAddress();
        if (escrows[jobId].client != address(0)) revert EscrowExists();
        Position storage pos = positions[msg.sender][token];
        if (pos.frozen) revert VaultFrozen();
        if (pos.available < amount) revert InsufficientAvailable();
        pos.available -= amount;
        pos.escrowed += amount;
        escrows[jobId] = Escrow({client: msg.sender, provider: provider, token: token, amount: amount, timeout: timeout, open: true});
        emit EscrowLocked(jobId, msg.sender, provider, token, amount, timeout);
    }

    /// Only the client releases payment — acceptance is the client's act.
    function releaseEscrow(bytes32 jobId) external nonReentrant {
        Escrow storage e = escrows[jobId];
        if (!e.open) revert EscrowNotOpen();
        if (msg.sender != e.client) revert NotClient();
        e.open = false;
        positions[e.client][e.token].escrowed -= e.amount;
        IERC20(e.token).safeTransfer(e.provider, e.amount);
        emit EscrowReleased(jobId, e.provider, e.amount);
    }

    /// Back to the client's available capital. The provider may refund at any time
    /// (it is giving up its own claim); the client only after the timeout — otherwise
    /// a client could take back payment for work already delivered.
    function refundEscrow(bytes32 jobId) external nonReentrant {
        Escrow storage e = escrows[jobId];
        if (!e.open) revert EscrowNotOpen();
        if (msg.sender == e.client) {
            if (block.timestamp < e.timeout) revert RefundNotAllowedYet();
        } else if (msg.sender != e.provider) {
            revert NotClient();
        }
        e.open = false;
        Position storage pos = positions[e.client][e.token];
        pos.escrowed -= e.amount;
        pos.available += e.amount;
        emit EscrowRefunded(jobId, e.client, e.amount, msg.sender);
    }
}
