// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MitraJobEscrow} from "../src/ERC8183/MitraJobEscrow.sol";

contract FeeToken is ERC20 {
    uint256 public feeBps;
    constructor(address who, uint256 _feeBps) ERC20("Fee", "FEE") {
        _mint(who, 1_000_000e6);
        feeBps = _feeBps;
    }
    function _update(address from, address to, uint256 value) internal override {
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, to, value - fee);
        if (fee > 0) super._update(from, address(this), fee);
    }
}

contract PlainToken is ERC20 {
    constructor(address who) ERC20("Plain", "PLN") { _mint(who, 1_000_000e6); }
}

/// LP-2 — MitraJobEscrow, the decoupled commercial escrow.
///
/// Two things this suite pins that the design could have gotten wrong:
///
///  1. Fee-on-transfer tokens record what ARRIVED, not what was promised.
///     Recording `expected` would let `completeJob` promise tokens the escrow
///     does not hold — the same "asked vs arrived" failure the vault's
///     deposit already guards (positions credit what arrived).
///
///  2. Refunds pay the CLIENT, not the vault's deposit. Calling `deposit` from
///     the escrow would credit the ESCROW's vault position; the client's
///     headroom would still read zero.
contract MitraJobEscrowTest is Test {
    MitraJobEscrow escrow;
    PlainToken token;
    address client = address(0xC11E);
    address provider = address(0x9B0);
    address evaluator = address(0xEA1);
    bytes32 jobId = keccak256("job-1");
    bytes32 route = keccak256("refund-route-1");

    function setUp() public {
        escrow = new MitraJobEscrow();
        token = new PlainToken(address(this));
        token.transfer(address(escrow), 100e6);
        escrow.depositToEscrow(jobId, client, provider, evaluator, address(token), 100e6, uint64(block.timestamp + 1 days), route);
    }

    function test_funded_records_the_committed_route() public view {
        MitraJobEscrow.Job memory jj0 = _job(jobId);
        assertTrue(jj0.status == MitraJobEscrow.JobStatus.Funded);
        assertEq(jj0.refundRouteHash, route);
    }

    function test_complete_pays_the_provider() public {
        uint256 before = token.balanceOf(provider);
        vm.prank(evaluator);
        escrow.completeJob(jobId);
        assertEq(token.balanceOf(provider) - before, 100e6);
    }

    function test_stranger_cannot_complete() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(MitraJobEscrow.NotAuthorised.selector);
        escrow.completeJob(jobId);
    }

    function test_refund_without_commitment_reverts() public {
        bytes32 j2 = keccak256("job-nocommit");
        token.transfer(address(escrow), 10e6);
        vm.expectRevert(MitraJobEscrow.NoCommitment.selector);
        escrow.depositToEscrow(j2, client, provider, evaluator, address(token), 10e6, uint64(block.timestamp - 1), bytes32(0));
    }

    function test_refund_after_timeout_pays_the_client() public {
        bytes32 j2 = keccak256("job-timeout");
        token.transfer(address(escrow), 50e6);
        escrow.depositToEscrow(j2, client, provider, evaluator, address(token), 50e6, uint64(block.timestamp + 1 hours), route);
        vm.warp(block.timestamp + 2 hours);
        // Anyone may call after timeout — including the test contract itself.
        uint256 before = token.balanceOf(client);
        escrow.refundJob(j2);
        assertEq(token.balanceOf(client) - before, 50e6);
        MitraJobEscrow.Job memory jj2 = _job(j2);
        assertTrue(jj2.status == MitraJobEscrow.JobStatus.Refunded);
    }

    function test_settlement_is_single_shot() public {
        vm.prank(evaluator);
        escrow.completeJob(jobId);
        vm.expectRevert(MitraJobEscrow.AlreadySettled.selector);
        escrow.refundJob(jobId);
    }

    function test_fee_on_transfer_records_what_arrived() public {
        FeeToken fee = new FeeToken(address(this), 100); // 1%
        bytes32 j3 = keccak256("job-fee");
        fee.transfer(address(escrow), 100e6);
        // 100e6 sent, 99e6 arrived. Recording 100e6 would over-promise.
        escrow.depositToEscrow(j3, client, provider, evaluator, address(fee), 100e6, uint64(block.timestamp + 1 days), route);
        MitraJobEscrow.Job memory jj3 = _job(j3);
        assertEq(jj3.amount, 99e6, "recorded amount must be what arrived, not what was promised");
    }

    // ── F95: the escrow must not owe more than it holds ────────────────────────
    //
    // `depositToEscrow` used to measure the deposit against `balanceOf(this)` — the WHOLE
    // balance, which includes every other live job. So a second job could be funded with
    // ZERO tokens arriving: it read the first job's tokens as its own, and the contract
    // over-promised by that amount. The shortfall surfaced on the first payout, by which
    // point it was unrecoverable and unattributable to either job.
    //
    // `totalAllocated` tracks commitments per token, and the delta is measured against that.

    /// A second job cannot be funded out of the first job's tokens.
    function test_second_deposit_requires_its_own_tokens() public {
        bytes32 j2 = keccak256("job-2");
        uint256 heldBefore = token.balanceOf(address(escrow));

        // Nothing new was sent, yet the balance is non-zero — which is exactly what the old
        // `bal == 0` check failed to notice.
        vm.expectRevert(MitraJobEscrow.NothingReceived.selector);
        escrow.depositToEscrow(j2, client, provider, evaluator, address(token), 50e6, uint64(block.timestamp + 1 days), route);

        assertEq(token.balanceOf(address(escrow)), heldBefore, "a refused deposit moves no tokens");
        assertEq(uint8(_job(j2).status), uint8(MitraJobEscrow.JobStatus.None), "and records no job");
    }

    /// A second job funded with SOME tokens records only what those tokens cover.
    function test_partial_second_deposit_cannot_claim_the_whole_balance() public {
        bytes32 j2 = keccak256("job-3");
        token.transfer(address(escrow), 20e6); // 20 arrives, 50 is asked for

        escrow.depositToEscrow(j2, client, provider, evaluator, address(token), 50e6, uint64(block.timestamp + 1 days), route);

        assertEq(_job(j2).amount, 20e6, "records what THIS deposit brought, never the whole balance");
        assertEq(escrow.totalAllocated(address(token)), 120e6, "job 1 (100) + job 2 (20)");
    }

    /// Settlement frees the commitment, so freed tokens are headroom again.
    function test_settling_frees_the_commitment_for_the_next_job() public {
        assertEq(escrow.totalAllocated(address(token)), 100e6, "one live job");

        vm.prank(client);
        escrow.completeJob(jobId);

        assertEq(escrow.totalAllocated(address(token)), 0, "a completed job no longer holds tokens");

        // A fresh deposit of the same size must now succeed. If `totalAllocated` only ever
        // grew, a long-lived escrow would refuse every future job forever.
        token.transfer(address(escrow), 40e6);
        escrow.depositToEscrow(keccak256("job-4"), client, provider, evaluator, address(token), 40e6, uint64(block.timestamp + 1 days), route);
        assertEq(escrow.totalAllocated(address(token)), 40e6);
    }

    /// A refund frees the commitment too.
    function test_refunding_frees_the_commitment() public {
        bytes32 j5 = keccak256("job-5");
        token.transfer(address(escrow), 30e6);
        escrow.depositToEscrow(j5, client, provider, evaluator, address(token), 30e6, uint64(block.timestamp + 1 days), route);
        assertEq(escrow.totalAllocated(address(token)), 130e6);

        vm.warp(block.timestamp + 2 days);
        escrow.refundJob(j5);
        assertEq(escrow.totalAllocated(address(token)), 100e6, "only the refunded job released its claim");
    }

    /// An over-send leaves headroom rather than being swallowed as allocation.
    function test_an_oversend_stays_available_to_the_next_deposit() public {
        token.transfer(address(escrow), 150e6); // 100 committed + 50 surplus
        escrow.depositToEscrow(keccak256("job-6"), client, provider, evaluator, address(token), 30e6, uint64(block.timestamp + 1 days), route);

        assertEq(_job(keccak256("job-6")).amount, 30e6, "capped at what it asked for");
        assertEq(escrow.totalAllocated(address(token)), 130e6, "surplus is NOT allocated, so it remains headroom");
    }

    /// The contract never owes more than it holds.
    function test_obligations_never_exceed_the_balance() public {
        token.transfer(address(escrow), 10e6);
        escrow.depositToEscrow(keccak256("job-7"), client, provider, evaluator, address(token), 10e6, uint64(block.timestamp + 1 days), route);

        assertLe(escrow.totalAllocated(address(token)), token.balanceOf(address(escrow)),
            "committed tokens must never exceed held tokens");
    }

    function _job(bytes32 j) internal view returns (MitraJobEscrow.Job memory) {
        (bytes32 a, address b, address c, address d, address e, uint256 f, uint64 t, MitraJobEscrow.JobStatus g, bytes32 h) = escrow.jobs(j);
        return MitraJobEscrow.Job({jobId: a, clientVault: b, provider: c, evaluator: d, token: e, amount: f, timeout: t, status: g, refundRouteHash: h});
    }
}
