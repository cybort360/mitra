// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MitraClearing — on-chain clearing epoch (Phase 7)
/// @notice Spec 14: clearing DETERMINES the economic obligation; settlement MOVES the
/// asset. This contract resolves obligations into a net result and records the
/// receipts of the residual transfers. It moves no token itself — residual settlement
/// stays with the settlement adapter behind the execution guard (spec 21.4).
///
/// Lifecycle (PRD §14.4), fixed in F62:
///
///   openEpoch → recordObligation* → freezeEpoch → proposeResult
///     → [challengeObligation → proposeResult]* → finalizeEpoch → recordReceipt* → SETTLED
///
/// - The inputs root is computed HERE, as a rolling hash of the recorded obligations,
///   and frozen with them. The operator cannot commit to inputs it did not record,
///   and nothing enters after the freeze (§14.5 FROZEN).
/// - A proposed result must CONSERVE every address's net position over the included
///   obligations. A result that pays anyone what the obligations do not net to
///   reverts; it is not merely left open to challenge.
/// - Each proposal opens a full challenge window, so a result replaced late gets a
///   window of its own.
/// - Only the debtor or creditor of an obligation may challenge it (decision
///   ctx_79718f2aadabac9b). The outcome (§14.8): the leg is excluded and stays visible
///   with its reason, the result is invalidated, and the operator must re-propose
///   without it. A challenged result can never finalize.
/// - `finalizeEpoch` is PERMISSIONLESS once the window closes, so a stalled operator
///   cannot hold everyone's obligations open; single-shot (F47).
///
/// The operator is a single EOA: one point of control over what is recorded and
/// proposed. Spec 55.3 lists clearing trust as open; conservation and party
/// challenges bound what that control can do.
contract MitraClearing {
    address public operator;

    /// Bounds the on-chain conservation check.
    uint256 public constant MAX_OBLIGATIONS = 64;
    uint256 public constant MAX_TRANSFERS = 64;

    enum EpochStatus { None, Open, Frozen, Proposed, Challenged, Finalized, Settling, Settled }

    struct Obligation {
        address debtor;
        address creditor;
        uint128 amount;
        bool excluded;
        bytes32 reasonHash;
    }

    struct TransferInstruction {
        address from;
        address to;
        uint128 amount;
    }

    struct Epoch {
        EpochStatus status;
        uint64 challengeWindow;
        uint64 challengeExpiresAt;
        uint32 obligationCount;
        bytes32 inputsRoot;
        bytes32 resultHash;
        uint32 proposalVersion;
        uint32 receiptCount;
    }

    mapping(bytes32 => Epoch) public epochs;
    mapping(bytes32 => Obligation[]) internal obligations;
    mapping(bytes32 => TransferInstruction[]) internal transfers;
    mapping(bytes32 => bytes32[]) internal receipts;

    event OperatorTransferred(address indexed previous, address indexed next);
    event EpochOpened(bytes32 indexed epochId, uint64 challengeWindow);
    event ObligationRecorded(bytes32 indexed epochId, uint256 index, address indexed debtor, address indexed creditor, uint128 amount);
    event EpochFrozen(bytes32 indexed epochId, bytes32 inputsRoot, uint256 obligationCount);
    event ResultProposed(bytes32 indexed epochId, bytes32 resultHash, uint256 version, uint64 challengeExpiresAt, uint256 transferCount);
    event ObligationChallenged(bytes32 indexed epochId, uint256 index, address indexed challenger, bytes32 reasonHash);
    event EpochFinalized(bytes32 indexed epochId, bytes32 resultHash, uint256 transferCount);
    event ReceiptRecorded(bytes32 indexed epochId, uint256 transferIndex, bytes32 receiptHash);
    event EpochSettled(bytes32 indexed epochId);

    error NotOperator();
    error UnknownEpoch();
    error EpochExists();
    error EpochNotOpen();
    error EpochNotFrozen();
    error NoResult();
    error ResultChallenged();
    error ResultNotConserved();
    error AlreadyFinalized();
    error NotFinalized();
    error ChallengeWindowClosed();
    error ChallengeWindowOpen();
    error InvalidWindow();
    error EmptyEpoch();
    error SameParty();
    error ZeroAmount();
    error TooMany();
    error UnknownIndex();
    error NotAParty();
    error AlreadyExcluded();
    error ReceiptAlreadyRecorded();
    error ZeroReceipt();

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

    /// None → OPEN. The window is fixed per epoch and reused by every proposal.
    function openEpoch(bytes32 epochId, uint64 challengeWindow) external onlyOperator {
        if (epochId == bytes32(0)) revert UnknownEpoch();
        if (epochs[epochId].status != EpochStatus.None) revert EpochExists();
        if (challengeWindow == 0) revert InvalidWindow();
        Epoch storage e = epochs[epochId];
        e.status = EpochStatus.Open;
        e.challengeWindow = challengeWindow;
        emit EpochOpened(epochId, challengeWindow);
    }

    /// Only while OPEN. Each obligation is folded into the inputs root.
    function recordObligation(bytes32 epochId, address debtor, address creditor, uint128 amount) external onlyOperator {
        Epoch storage e = epochs[epochId];
        if (e.status != EpochStatus.Open) revert EpochNotOpen();
        if (debtor == address(0) || creditor == address(0) || debtor == creditor) revert SameParty();
        if (amount == 0) revert ZeroAmount();
        if (e.obligationCount >= MAX_OBLIGATIONS) revert TooMany();

        obligations[epochId].push(Obligation({debtor: debtor, creditor: creditor, amount: amount, excluded: false, reasonHash: bytes32(0)}));
        e.inputsRoot = keccak256(abi.encode(e.inputsRoot, debtor, creditor, amount));
        emit ObligationRecorded(epochId, e.obligationCount, debtor, creditor, amount);
        unchecked { ++e.obligationCount; }
    }

    /// OPEN → FROZEN. The input set and its root are final from here.
    function freezeEpoch(bytes32 epochId) external onlyOperator {
        Epoch storage e = epochs[epochId];
        if (e.status != EpochStatus.Open) revert EpochNotOpen();
        if (e.obligationCount == 0) revert EmptyEpoch();
        e.status = EpochStatus.Frozen;
        emit EpochFrozen(epochId, e.inputsRoot, e.obligationCount);
    }

    /// FROZEN, PROPOSED or CHALLENGED → PROPOSED, with a fresh challenge window.
    /// `net` must conserve every net position over the non-excluded obligations.
    function proposeResult(bytes32 epochId, TransferInstruction[] calldata net, bytes32 resultHash) external onlyOperator {
        Epoch storage e = epochs[epochId];
        if (e.status != EpochStatus.Frozen && e.status != EpochStatus.Proposed && e.status != EpochStatus.Challenged) {
            revert EpochNotFrozen();
        }
        if (net.length > MAX_TRANSFERS) revert TooMany();
        _requireConserved(obligations[epochId], net);

        delete transfers[epochId];
        for (uint256 i = 0; i < net.length; ++i) transfers[epochId].push(net[i]);
        e.resultHash = resultHash;
        unchecked { ++e.proposalVersion; }
        e.challengeExpiresAt = uint64(block.timestamp) + e.challengeWindow;
        e.status = EpochStatus.Proposed;
        emit ResultProposed(epochId, resultHash, e.proposalVersion, e.challengeExpiresAt, net.length);
    }

    /// PROPOSED → CHALLENGED, by the debtor or creditor of obligation `index`, inside
    /// the window. The leg is excluded and keeps its reason; the result must be
    /// re-proposed without it.
    function challengeObligation(bytes32 epochId, uint256 index, bytes32 reasonHash) external {
        Epoch storage e = epochs[epochId];
        if (e.status != EpochStatus.Proposed) revert NoResult();
        if (block.timestamp >= e.challengeExpiresAt) revert ChallengeWindowClosed();
        if (index >= obligations[epochId].length) revert UnknownIndex();
        Obligation storage o = obligations[epochId][index];
        if (msg.sender != o.debtor && msg.sender != o.creditor) revert NotAParty();
        if (o.excluded) revert AlreadyExcluded();
        o.excluded = true;
        o.reasonHash = reasonHash;
        e.status = EpochStatus.Challenged;
        emit ObligationChallenged(epochId, index, msg.sender, reasonHash);
    }

    /// PROPOSED → FINALIZED (or SETTLED when nothing is left to move). Permissionless
    /// once the window closes; a challenged result never finalizes; single-shot (F47).
    function finalizeEpoch(bytes32 epochId) external returns (EpochStatus) {
        Epoch storage e = epochs[epochId];
        EpochStatus s = e.status;
        if (s == EpochStatus.None) revert UnknownEpoch();
        if (s == EpochStatus.Finalized || s == EpochStatus.Settling || s == EpochStatus.Settled) revert AlreadyFinalized();
        if (s == EpochStatus.Challenged) revert ResultChallenged();
        if (s != EpochStatus.Proposed) revert NoResult();
        if (block.timestamp < e.challengeExpiresAt) revert ChallengeWindowOpen();

        uint256 n = transfers[epochId].length;
        emit EpochFinalized(epochId, e.resultHash, n);
        if (n == 0) {
            e.status = EpochStatus.Settled;
            emit EpochSettled(epochId);
        } else {
            e.status = EpochStatus.Finalized;
            receipts[epochId] = new bytes32[](n);
        }
        return e.status;
    }

    /// FINALIZED/SETTLING → SETTLING/SETTLED: attaches the receipt of one residual
    /// transfer (§14.5 SETTLED: "Onchain settlement receipts are attached").
    function recordReceipt(bytes32 epochId, uint256 transferIndex, bytes32 receiptHash) external onlyOperator {
        Epoch storage e = epochs[epochId];
        if (e.status != EpochStatus.Finalized && e.status != EpochStatus.Settling) revert NotFinalized();
        if (transferIndex >= transfers[epochId].length) revert UnknownIndex();
        if (receiptHash == bytes32(0)) revert ZeroReceipt();
        if (receipts[epochId][transferIndex] != bytes32(0)) revert ReceiptAlreadyRecorded();

        receipts[epochId][transferIndex] = receiptHash;
        unchecked { ++e.receiptCount; }
        emit ReceiptRecorded(epochId, transferIndex, receiptHash);
        if (e.receiptCount == transfers[epochId].length) {
            e.status = EpochStatus.Settled;
            emit EpochSettled(epochId);
        } else {
            e.status = EpochStatus.Settling;
        }
    }

    /// Every address's balance (obligations owed, less transfers paid) must be zero.
    function _requireConserved(Obligation[] storage obs, TransferInstruction[] calldata net) internal view {
        address[] memory who = new address[](2 * (obs.length + net.length));
        int256[] memory bal = new int256[](who.length);
        uint256 n;
        for (uint256 i = 0; i < obs.length; ++i) {
            Obligation storage o = obs[i];
            if (o.excluded) continue;
            n = _add(who, bal, n, o.debtor, -int256(uint256(o.amount)));
            n = _add(who, bal, n, o.creditor, int256(uint256(o.amount)));
        }
        for (uint256 i = 0; i < net.length; ++i) {
            TransferInstruction calldata t = net[i];
            if (t.from == address(0) || t.to == address(0) || t.from == t.to) revert SameParty();
            if (t.amount == 0) revert ZeroAmount();
            n = _add(who, bal, n, t.from, int256(uint256(t.amount)));
            n = _add(who, bal, n, t.to, -int256(uint256(t.amount)));
        }
        for (uint256 i = 0; i < n; ++i) if (bal[i] != 0) revert ResultNotConserved();
    }

    function _add(address[] memory who, int256[] memory bal, uint256 n, address a, int256 delta) private pure returns (uint256) {
        for (uint256 i = 0; i < n; ++i) {
            if (who[i] == a) { bal[i] += delta; return n; }
        }
        who[n] = a;
        bal[n] = delta;
        return n + 1;
    }

    function transfersOf(bytes32 epochId) external view returns (TransferInstruction[] memory) {
        return transfers[epochId];
    }

    function obligationsOf(bytes32 epochId) external view returns (Obligation[] memory) {
        return obligations[epochId];
    }

    function receiptsOf(bytes32 epochId) external view returns (bytes32[] memory) {
        return receipts[epochId];
    }
}
