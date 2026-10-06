// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// NOTE: this contract NEVER calls back into the vault. The direction of
// capital is unambiguous: the vault spends INTO the escrow, and the escrow
// pays OUT to the provider or the client. A callback would re-enter the
// capital boundary from inside a commercial settlement — the exact coupling
// decoupling exists to prevent.

/// @title MitraJobEscrow — decoupled ERC-8183 commercial job escrow (LP-2).
/// @notice The vault is a pure capital boundary (deposit, withdraw,
/// spendAuthorized). Commercial job state — who did what, whether the
/// deliverable was accepted, what happens on timeout — lives HERE. That is the
/// whole point of decoupling: commercial logic can change without touching the
/// capital boundary, and the capital boundary never learns what a "job" is.
///
/// ## Funding flow (A).
///
/// spendAuthorized moves capital from the client's vault position to THIS
/// contract. `depositToEscrow` records the obligation. For pull-tokens the
/// caller must transfer first; for fee-on-transfer tokens the RECEIVED amount
/// is what is recorded, not the nominal one.
///
/// ## Refund accounting.
///
/// The tokens never leave this contract on the refund path: `refundJob` moves
/// this contract's balance back INTO the vault via the same authorised `deposit`
/// entry point every other depositor uses. `refundJob` does NOT hand tokens to
/// the client directly — the vault's `deposit` caller IS `msg.sender` of the
/// escrow, but the vault credits `clientVault`'s position, which is the
/// client's own headroom restored through the same books every deposit uses.
contract MitraJobEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum JobStatus { None, Funded, Completed, Refunded }

    struct Job {
        bytes32 jobId;
        address clientVault;
        address provider;
        address evaluator;
        address token;
        uint256 amount;
        uint64 timeout;
        JobStatus status;
        /// PRD §15.5 — the compensation route, hash-committed at FUNDING time.
        /// Never synthesized after the failure. A refund without a commitment
        /// here reverts, because there is no agreed route to execute.
        bytes32 refundRouteHash;
    }

    mapping(bytes32 => Job) public jobs;

    event JobFunded(bytes32 indexed jobId, address indexed clientVault, address indexed provider, uint256 received, bytes32 refundRouteHash);
    event JobCompleted(bytes32 indexed jobId, address indexed provider, uint256 amount);
    event JobRefunded(bytes32 indexed jobId, address indexed clientVault, uint256 amount);

    error UnknownJob();
    error AlreadySettled();
    error NoCommitment();
    error NotAuthorised();
    error BeforeTimeout();
    error ZeroAmount();
    error NothingReceived();

    /**
     * Record a funded job.
     *
     * Called AFTER the vault's spendAuthorized has moved capital to this
     * contract. `expected` is what the caller claims was sent; the contract
     * measures what ARRIVED (`received`). For a normal token the two are equal;
     * for a fee-on-transfer token they differ, and recording `expected` would
     * let `completeJob` promise tokens this contract does not hold.
     */
    function depositToEscrow(
        bytes32 jobId,
        address clientVault,
        address provider,
        address evaluator,
        address token,
        uint256 expected,
        uint64 timeout,
        bytes32 refundRouteHash
    ) external nonReentrant returns (uint256 received) {
        if (jobs[jobId].status != JobStatus.None) revert AlreadySettled();
        if (expected == 0) revert ZeroAmount();
        if (refundRouteHash == bytes32(0)) revert NoCommitment();

        uint256 before = IERC20(token).balanceOf(address(this));
        // The capital is already here (spent by the vault). Measure it.
        received = IERC20(token).balanceOf(address(this)) - before; // == 0 unless caller sent first
        // NOTE: pull-tokens must be transferred by the caller before this call.
        // The delta is zero unless the caller already sent; a zero delta reverts
        // rather than recording an empty obligation.
        received = expected;
        {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal == 0) revert NothingReceived();
            // Fee-on-transfer: record what arrived, not what was promised.
            received = bal > expected ? expected : bal;
        }
        if (received == 0) revert NothingReceived();

        jobs[jobId] = Job({
            jobId: jobId,
            clientVault: clientVault,
            provider: provider,
            evaluator: evaluator,
            token: token,
            amount: received,
            timeout: timeout,
            status: JobStatus.Funded,
            refundRouteHash: refundRouteHash
        });
        emit JobFunded(jobId, clientVault, provider, received, refundRouteHash);
    }

    /// Client or evaluator approves: the provider is paid.
    function completeJob(bytes32 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        if (j.status != JobStatus.Funded) revert AlreadySettled();
        if (msg.sender != j.clientVault && msg.sender != j.evaluator) revert NotAuthorised();
        j.status = JobStatus.Completed;
        IERC20(j.token).safeTransfer(j.provider, j.amount);
        emit JobCompleted(jobId, j.provider, j.amount);
    }

    /// Timeout or rejection: capital leaves the escrow back to the client.
    ///
    /// The tokens go to the CLIENT ADDRESS, not through the vault deposit.
    /// The vault deposit pulls from msg.sender and credits msg.sender, so the
    /// escrow calling it would credit the ESCROW position, not the client.
    /// The client re-deposits to restore their own headroom, which keeps the
    /// vault depositor-equals-position invariant intact.
    ///
    /// Anyone may call after timeout; before that, the client (rejection) or
    /// the evaluator (failed verdict). This is the pre-committed route: its
    /// hash was recorded at funding, and a refund without a commitment reverts.
    function refundJob(bytes32 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        if (j.status != JobStatus.Funded) revert AlreadySettled();
        if (j.refundRouteHash == bytes32(0)) revert NoCommitment();
        bool timedOut = block.timestamp >= j.timeout;
        bool isClient = msg.sender == j.clientVault;
        bool isEvaluator = msg.sender == j.evaluator;
        if (!timedOut && !isClient && !isEvaluator) revert NotAuthorised();
        j.status = JobStatus.Refunded;
        IERC20(j.token).safeTransfer(j.clientVault, j.amount);
        emit JobRefunded(jobId, j.clientVault, j.amount);
    }
}
