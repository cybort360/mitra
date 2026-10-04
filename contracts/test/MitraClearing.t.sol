// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MitraClearing} from "../MitraClearing.sol";

contract MitraClearingTest is Test {
    MitraClearing clearing;
    address operator = address(0xAA);
    address challenger = address(0xBB);
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

    function test_stranger_cannot_open_or_commit_epoch() public {
        vm.prank(stranger);
        vm.expectRevert(MitraClearing.NotOperator.selector);
        clearing.openEpoch(epochId);

        vm.prank(stranger);
        vm.expectRevert(MitraClearing.NotOperator.selector);
        clearing.commitEpoch(epochId, 3600, keccak256("inputs"));
    }

    function test_happy_path_clearing_lifecycle() public {
        vm.prank(operator);
        clearing.commitEpoch(epochId, 3600, keccak256("inputs"));

        vm.prank(operator);
        clearing.recordObligation(epochId, alice, bob, 100e6);

        MitraClearing.TransferInstruction[] memory net = new MitraClearing.TransferInstruction[](1);
        net[0] = MitraClearing.TransferInstruction({from: alice, to: bob, amount: 100e6});

        vm.prank(operator);
        clearing.recordSettlement(epochId, net, keccak256("results"));

        // Finalize before challenge window expires should fail
        vm.prank(stranger);
        vm.expectRevert(MitraClearing.ChallengeWindowOpen.selector);
        clearing.finalizeEpoch(epochId);

        // Warp past challenge window
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

    function test_permissionless_challenge_within_window() public {
        vm.prank(operator);
        clearing.commitEpoch(epochId, 3600, keccak256("inputs"));

        bytes32 reason = keccak256("bogus-netting");
        vm.prank(challenger);
        clearing.challengeEpoch(epochId, reason);

        (MitraClearing.EpochStatus status,,,,,,,) = clearing.epochs(epochId);
        assertEq(uint8(status), uint8(MitraClearing.EpochStatus.Challenged));
    }
}
