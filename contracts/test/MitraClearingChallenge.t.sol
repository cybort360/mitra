// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MitraClearing} from "../MitraClearing.sol";

/// F64 — reproductions against PRD §14.4–14.8, and the fix's challenge,
/// conservation and settlement rules (decision ctx_79718f2aadabac9b).
contract MitraClearingChallengeTest is Test {
    MitraClearing clearing;
    address operator = address(0xAA);
    address stranger = address(0xCC);
    address alice = address(0x11);
    address bob = address(0x22);
    address carol = address(0x33);
    bytes32 epochId = keccak256("epoch-1");
    uint64 constant WINDOW = 3600;

    function setUp() public {
        clearing = new MitraClearing(operator);
    }

    function _net(address from, address to, uint128 amount) internal pure returns (MitraClearing.TransferInstruction[] memory net) {
        net = new MitraClearing.TransferInstruction[](1);
        net[0] = MitraClearing.TransferInstruction({from: from, to: to, amount: amount});
    }

    /// alice owes bob 100, bob owes carol 60: nets to alice→bob 40, alice→carol 60.
    function _frozenChain() internal {
        vm.startPrank(operator);
        clearing.openEpoch(epochId, WINDOW);
        clearing.recordObligation(epochId, alice, bob, 100e6);
        clearing.recordObligation(epochId, bob, carol, 60e6);
        clearing.freezeEpoch(epochId);
        vm.stopPrank();
    }

    function _chainResult() internal view returns (MitraClearing.TransferInstruction[] memory net) {
        net = new MitraClearing.TransferInstruction[](2);
        net[0] = MitraClearing.TransferInstruction({from: alice, to: bob, amount: 40e6});
        net[1] = MitraClearing.TransferInstruction({from: alice, to: carol, amount: 60e6});
    }

    function _proposedChain() internal {
        _frozenChain();
        vm.prank(operator);
        clearing.proposeResult(epochId, _chainResult(), keccak256("result-1"));
    }

    // ── F64 reproductions ────────────────────────────────────────────────────

    /// §14.8 requires a challenge outcome. A challenged epoch must not finalize
    /// on the strength of the result that was challenged.
    function test_a_challenged_epoch_cannot_finalize_its_challenged_result() public {
        _proposedChain();
        vm.prank(bob);
        clearing.challengeObligation(epochId, 1, keccak256("never-delivered"));
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(stranger);
        vm.expectRevert(MitraClearing.ResultChallenged.selector);
        clearing.finalizeEpoch(epochId);
    }

    /// §14.5 FROZEN: "New obligations are excluded from the epoch snapshot."
    function test_no_obligation_enters_a_frozen_epoch() public {
        _frozenChain();
        vm.prank(operator);
        vm.expectRevert(MitraClearing.EpochNotOpen.selector);
        clearing.recordObligation(epochId, bob, alice, 1);
    }

    /// A result replaced late in the window gets a full window of its own.
    function test_replacing_the_result_restarts_the_challenge_window() public {
        _proposedChain();
        vm.warp(block.timestamp + WINDOW - 1);
        // Same net positions, different instruction order: still conserving.
        MitraClearing.TransferInstruction[] memory reordered = new MitraClearing.TransferInstruction[](2);
        reordered[0] = _chainResult()[1];
        reordered[1] = _chainResult()[0];
        vm.prank(operator);
        clearing.proposeResult(epochId, reordered, keccak256("result-2"));
        vm.warp(block.timestamp + 2);
        vm.prank(stranger);
        vm.expectRevert(MitraClearing.ChallengeWindowOpen.selector);
        clearing.finalizeEpoch(epochId);
    }

    // ── inputs are bound on-chain ────────────────────────────────────────────

    function test_the_inputs_root_is_the_hash_of_the_recorded_obligations() public {
        _frozenChain();
        bytes32 expected = keccak256(abi.encode(
            keccak256(abi.encode(bytes32(0), alice, bob, uint128(100e6))), bob, carol, uint128(60e6)));
        (, , , , bytes32 inputsRoot, , ,) = clearing.epochs(epochId);
        assertEq(inputsRoot, expected);
    }

    function test_an_empty_epoch_cannot_freeze() public {
        vm.startPrank(operator);
        clearing.openEpoch(epochId, WINDOW);
        vm.expectRevert(MitraClearing.EmptyEpoch.selector);
        clearing.freezeEpoch(epochId);
        vm.stopPrank();
    }

    // ── conservation ─────────────────────────────────────────────────────────

    /// The swap the deployed contract allowed: the operator pays itself.
    function test_a_result_that_pays_anyone_what_the_obligations_do_not_net_to_is_refused() public {
        _frozenChain();
        MitraClearing.TransferInstruction[] memory swapped = _chainResult();
        swapped[1].to = operator;
        vm.prank(operator);
        vm.expectRevert(MitraClearing.ResultNotConserved.selector);
        clearing.proposeResult(epochId, swapped, keccak256("swapped"));
    }

    function test_a_result_that_moves_too_little_is_refused() public {
        _frozenChain();
        vm.prank(operator);
        vm.expectRevert(MitraClearing.ResultNotConserved.selector);
        clearing.proposeResult(epochId, _net(alice, bob, 40e6), keccak256("short"));
    }

    function test_a_perfect_cycle_nets_to_nothing_and_settles_on_finalize() public {
        vm.startPrank(operator);
        clearing.openEpoch(epochId, WINDOW);
        clearing.recordObligation(epochId, alice, bob, 50e6);
        clearing.recordObligation(epochId, bob, carol, 50e6);
        clearing.recordObligation(epochId, carol, alice, 50e6);
        clearing.freezeEpoch(epochId);
        clearing.proposeResult(epochId, new MitraClearing.TransferInstruction[](0), keccak256("empty"));
        vm.stopPrank();
        vm.warp(block.timestamp + WINDOW);
        assertEq(uint8(clearing.finalizeEpoch(epochId)), uint8(MitraClearing.EpochStatus.Settled));
    }

    // ── challenges ───────────────────────────────────────────────────────────

    function test_only_a_party_to_the_obligation_may_challenge_it() public {
        _proposedChain();
        vm.prank(carol); // party to obligation 1, not obligation 0
        vm.expectRevert(MitraClearing.NotAParty.selector);
        clearing.challengeObligation(epochId, 0, keccak256("not-mine"));
        vm.prank(stranger);
        vm.expectRevert(MitraClearing.NotAParty.selector);
        clearing.challengeObligation(epochId, 1, keccak256("grief"));
    }

    function test_no_challenge_after_the_window() public {
        _proposedChain();
        vm.warp(block.timestamp + WINDOW);
        vm.prank(bob);
        vm.expectRevert(MitraClearing.ChallengeWindowClosed.selector);
        clearing.challengeObligation(epochId, 1, keccak256("late"));
    }

    /// The outcome: the leg is excluded and visible, the result must be re-proposed
    /// without it, and the new result gets a full window before it can finalize.
    function test_a_challenged_leg_is_excluded_and_the_result_reproposed_without_it() public {
        _proposedChain();
        bytes32 reason = keccak256("never-delivered");
        vm.prank(carol);
        clearing.challengeObligation(epochId, 1, reason);

        MitraClearing.Obligation[] memory obs = clearing.obligationsOf(epochId);
        assertTrue(obs[1].excluded);
        assertEq(obs[1].reasonHash, reason);
        assertFalse(obs[0].excluded);

        // The old result still counts the excluded leg, so it no longer conserves.
        vm.prank(operator);
        vm.expectRevert(MitraClearing.ResultNotConserved.selector);
        clearing.proposeResult(epochId, _chainResult(), keccak256("result-1"));

        vm.prank(operator);
        clearing.proposeResult(epochId, _net(alice, bob, 100e6), keccak256("result-2"));
        vm.warp(block.timestamp + WINDOW);
        assertEq(uint8(clearing.finalizeEpoch(epochId)), uint8(MitraClearing.EpochStatus.Finalized));
    }

    function test_an_excluded_leg_cannot_be_challenged_twice() public {
        _proposedChain();
        vm.prank(bob);
        clearing.challengeObligation(epochId, 1, keccak256("a"));
        vm.prank(operator);
        clearing.proposeResult(epochId, _net(alice, bob, 100e6), keccak256("result-2"));
        vm.prank(carol);
        vm.expectRevert(MitraClearing.AlreadyExcluded.selector);
        clearing.challengeObligation(epochId, 1, keccak256("b"));
    }

    // ── settlement receipts (§14.5 SETTLING → SETTLED) ───────────────────────

    function test_settled_once_every_residual_transfer_has_a_receipt() public {
        _proposedChain();
        vm.warp(block.timestamp + WINDOW);
        clearing.finalizeEpoch(epochId);

        vm.prank(stranger);
        vm.expectRevert(MitraClearing.NotOperator.selector);
        clearing.recordReceipt(epochId, 0, keccak256("rcpt-0"));

        vm.startPrank(operator);
        clearing.recordReceipt(epochId, 0, keccak256("rcpt-0"));
        (MitraClearing.EpochStatus status,,,,,,,) = clearing.epochs(epochId);
        assertEq(uint8(status), uint8(MitraClearing.EpochStatus.Settling));

        vm.expectRevert(MitraClearing.ReceiptAlreadyRecorded.selector);
        clearing.recordReceipt(epochId, 0, keccak256("rcpt-0-again"));

        clearing.recordReceipt(epochId, 1, keccak256("rcpt-1"));
        vm.stopPrank();
        (status,,,,,,,) = clearing.epochs(epochId);
        assertEq(uint8(status), uint8(MitraClearing.EpochStatus.Settled));
        assertEq(clearing.receiptsOf(epochId)[1], keccak256("rcpt-1"));
    }

    function test_no_receipt_before_finalization() public {
        _proposedChain();
        vm.prank(operator);
        vm.expectRevert(MitraClearing.NotFinalized.selector);
        clearing.recordReceipt(epochId, 0, keccak256("early"));
    }
}
