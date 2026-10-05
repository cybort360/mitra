// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MitraClearing} from "../MitraClearing.sol";

/// The lead's original suite, on the PRD §14.4 lifecycle (F64): open → record →
/// freeze → propose → finalize. Assertions unchanged: operator gating, the
/// challenge window, and single finalization (F47).
contract MitraClearingTest is Test {
    MitraClearing clearing;
    address operator = address(0xAA);
    address stranger = address(0xCC);
    address alice = address(0x11);
    address bob = address(0x22);

    bytes32 epochId = keccak256("epoch-1");

    function setUp() public {
        clearing = new MitraClearing(operator);
    }

    function test_initial_operator_set() public view {
        assertEq(clearing.operator(), operator);
    }

    function test_stranger_cannot_open_or_freeze_epoch() public {
        vm.prank(stranger);
        vm.expectRevert(MitraClearing.NotOperator.selector);
        clearing.openEpoch(epochId, 3600);

        vm.prank(operator);
        clearing.openEpoch(epochId, 3600);
        vm.prank(stranger);
        vm.expectRevert(MitraClearing.NotOperator.selector);
        clearing.freezeEpoch(epochId);
    }

    function test_happy_path_clearing_lifecycle() public {
        vm.startPrank(operator);
        clearing.openEpoch(epochId, 3600);
        clearing.recordObligation(epochId, alice, bob, 100e6);
        clearing.freezeEpoch(epochId);
        MitraClearing.TransferInstruction[] memory net = new MitraClearing.TransferInstruction[](1);
        net[0] = MitraClearing.TransferInstruction({from: alice, to: bob, amount: 100e6});
        clearing.proposeResult(epochId, net, keccak256("results"));
        vm.stopPrank();

        // Finalize before challenge window expires should fail
        vm.prank(stranger);
        vm.expectRevert(MitraClearing.ChallengeWindowOpen.selector);
        clearing.finalizeEpoch(epochId);

        vm.warp(block.timestamp + 3601);

        // Anyone can finalize
        vm.prank(stranger);
        MitraClearing.EpochStatus status = clearing.finalizeEpoch(epochId);
        assertEq(uint8(status), uint8(MitraClearing.EpochStatus.Finalized));

        // F47: double finalization reverts
        vm.prank(stranger);
        vm.expectRevert(MitraClearing.AlreadyFinalized.selector);
        clearing.finalizeEpoch(epochId);
    }

    function test_a_party_may_challenge_within_window() public {
        vm.startPrank(operator);
        clearing.openEpoch(epochId, 3600);
        clearing.recordObligation(epochId, alice, bob, 100e6);
        clearing.freezeEpoch(epochId);
        MitraClearing.TransferInstruction[] memory net = new MitraClearing.TransferInstruction[](1);
        net[0] = MitraClearing.TransferInstruction({from: alice, to: bob, amount: 100e6});
        clearing.proposeResult(epochId, net, keccak256("results"));
        vm.stopPrank();

        bytes32 reason = keccak256("bogus-netting");
        vm.prank(alice);
        clearing.challengeObligation(epochId, 0, reason);

        (MitraClearing.EpochStatus status,,,,,,,) = clearing.epochs(epochId);
        assertEq(uint8(status), uint8(MitraClearing.EpochStatus.Challenged));
    }
}
