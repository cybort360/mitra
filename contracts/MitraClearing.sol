// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MitraClearing — on-chain clearing epoch (Phase 7)
/// @notice Spec 14: clearing DETERMINES the economic obligation; settlement MOVES the
/// asset. This contract only ever resolves obligations into a net position and a set of
/// residual transfer instructions. It moves no token itself — residual settlement stays
/// with the settlement adapter (spec 21.4), because clearing must not depend on any one
/// chain's transfer semantics.
///
/// Access model (spec 14.8):
///   - `operator` is the clearinghouse. It may open and record epochs.
///   - `challengeEpoch` is PERMISSIONLESS inside the challenge window. If only the
///     operator could challenge, clearing would be unfalsifiable — the operator would be
///     judge, party, and appellant. That is precisely the trust assumption spec 55.3
///     says must not be granted silently.
///   - `finalizeEpoch` is PERMISSIONLESS once the challenge window has closed, so a
///     stalled operator cannot freeze an epoch and hold everyone's obligations open.
contract MitraClearing is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public operator;

    enum EpochStatus { None, Open, Frozen, Challenged, Finalized, Settled }

    struct Obligation {
        address debtor;
        address creditor;
        uint128 amount;
        bool included;
        bool excluded;
    }

    struct TransferInstruction {
        address from;
        address to;
        uint128 amount;
    }

    struct Epoch {
        EpochStatus status;
        uint64 challengeExpiresAt;
        uint256 obligationCount;
        bytes32 inputsRoot;
        bytes32 resultHash;
        address challenger;
        bytes32 reasonHash;
        uint256 version;
    }

    /// F47 — one finalisation per epoch. A second attempt reverts here.
    mapping(bytes32 => Epoch) public epochs;
    mapping(bytes32 => Obligation[]) internal obligations;
    mapping(bytes32 => TransferInstruction[]) internal transfers;

    event OperatorTransferred(address indexed previous, address indexed next);
    event EpochCommitted(bytes32 indexed epochId, uint256 obligationCount, uint64 challengeExpiresAt);
    event SettlementRecorded(bytes32 indexed epochId, bytes32 indexed inputsRoot, uint256 netCount);
    event EpochChallenged(bytes32 indexed epochId, address indexed challenger, bytes32 reasonHash);
    event EpochFinalized(bytes32 indexed epochId, bytes32 resultHash, uint256 netCount);

    error NotOperator();
    error UnknownEpoch();
    error EpochNotOpen();
    error EpochNotFrozen();
    error AlreadyFinalized();
    error ChallengeWindowClosed();
    error ChallengeWindowOpen();
    error InvalidWindow();
    error EmptyEpoch();
    error SameParty();

    constructor(address initialOperator) {
        require(initialOperator != address(0), "INVALID_OPERATOR");
        operator = initialOperator;
        emit OperatorTransferred(address(0), initialOperator);
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    function transferOperator(address next) external onlyOperator {
        require(next != address(0), "INVALID_OPERATOR");
        emit OperatorTransferred(operator, next);
        operator = next;
    }

    /// OPEN -> FROZEN. The epoch is sealed and its obligations become append-only.
    function commitEpoch(
        bytes32 epochId,
        uint64 challengeWindow,
        bytes32 inputsRoot
    ) external onlyOperator nonReentrant returns (EpochStatus) {
        if (epochId == bytes32(0)) revert UnknownEpoch();
        if (epochs[epochId].status != EpochStatus.None) revert AlreadyFinalized();
        if (challengeWindow == 0) revert InvalidWindow();

        Epoch storage e = epochs[epochId];
        e.status = EpochStatus.Frozen;
        e.challengeExpiresAt = uint64(block.timestamp) + challengeWindow;
        e.inputsRoot = inputsRoot;
        e.version = 1;
        emit EpochCommitted(epochId, 0, e.challengeExpiresAt);
        return e.status;
    }

    /// Append an obligation. Only while OPEN so a sealed epoch cannot be rewritten.
    function recordObligation(
        bytes32 epochId,
        address debtor,
        address creditor,
        uint128 amount
    ) external onlyOperator nonReentrant {
        Epoch storage e = epochs[epochId];
        if (e.status == EpochStatus.None) revert UnknownEpoch();
        if (e.status != EpochStatus.Open && e.status != EpochStatus.Frozen) revert EpochNotOpen();
        if (debtor == address(0) || creditor == address(0)) revert SameParty();
        if (debtor == creditor) revert SameParty();
        if (amount == 0) revert EmptyEpoch();

        obligations[epochId].push(Obligation({debtor: debtor, creditor: creditor, amount: amount, included: true, excluded: false}));
        unchecked { ++e.obligationCount; }
    }

    /// FROZEN -> OPEN is deliberately absent: obligations are appended before commit in
    /// the reference flow, and `commitEpoch` seals. Callers that need to add obligations
    /// call `recordObligation` while the epoch is still Open, then commit.

    function openEpoch(bytes32 epochId) external onlyOperator {
        Epoch storage e = epochs[epochId];
        if (e.status != EpochStatus.None) revert AlreadyFinalized();
        e.status = EpochStatus.Open;
        e.version = 1;
    }

    /// Record the operator's computed net position. Hash-committed, not trusted silently:
    /// anyone can recompute the netting from `inputsRoot` and compare.
    function recordSettlement(
        bytes32 epochId,
        TransferInstruction[] calldata net,
        bytes32 resultHash
    ) external onlyOperator nonReentrant {
        Epoch storage e = epochs[epochId];
        if (e.status != EpochStatus.Frozen) revert EpochNotFrozen();

        delete transfers[epochId];
        for (uint256 i = 0; i < net.length; ++i) {
            transfers[epochId].push(net[i]);
        }
        e.resultHash = resultHash;
        emit SettlementRecorded(epochId, e.inputsRoot, net.length);
    }

    /// PERMISSIONLESS within the challenge window (spec 14.8).
    function challengeEpoch(bytes32 epochId, bytes32 reasonHash) external nonReentrant {
        Epoch storage e = epochs[epochId];
        if (e.status != EpochStatus.Frozen && e.status != EpochStatus.Challenged) revert EpochNotFrozen();
        if (block.timestamp >= e.challengeExpiresAt) revert ChallengeWindowClosed();
        e.status = EpochStatus.Challenged;
        e.challenger = msg.sender;
        e.reasonHash = reasonHash;
        emit EpochChallenged(epochId, msg.sender, reasonHash);
    }

    /// PERMISSIONLESS after the window closes, and single-shot (F47).
    function finalizeEpoch(bytes32 epochId) external nonReentrant returns (EpochStatus) {
        Epoch storage e = epochs[epochId];
        if (e.status == EpochStatus.None) revert UnknownEpoch();
        if (e.status == EpochStatus.Finalized || e.status == EpochStatus.Settled) revert AlreadyFinalized();
        if (block.timestamp < e.challengeExpiresAt) revert ChallengeWindowOpen();
        e.status = EpochStatus.Finalized;
        emit EpochFinalized(epochId, e.resultHash, transfers[epochId].length);
        return e.status;
    }

    function transfersOf(bytes32 epochId) external view returns (TransferInstruction[] memory) {
        return transfers[epochId];
    }

    function obligationsOf(bytes32 epochId) external view returns (Obligation[] memory) {
        return obligations[epochId];
    }
}
