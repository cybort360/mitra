// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MitraVault} from "../MitraVault.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockToken is ERC20 {
    // 6 decimals, matching USDC/PathUSD. An 18-decimal mock would overflow the
    // uint64 mandate limits (max ~1.8e19 atomic).
    constructor(address who) ERC20("Mock", "MCK") { _mint(who, 1_000_000e6); }
}

contract MitraVaultTest is Test {
    MitraVault vault;
    MockToken token;

    address principal = address(0xA11CE);
    address holder    = address(0xB0B);
    address provider  = address(0xCAFE);
    address recipient = address(0xBEEF);
    address attacker  = address(0xBAD);
    uint256 enginePk  = 0xA11CE;               // deterministic engine key
    address engine;

    bytes32 constant JOB = keccak256("job-1");

    function setUp() public {
        vault = new MitraVault();
        token = new MockToken(principal); // minted to the PRINCIPAL, not the test contract
        engine = vm.addr(enginePk);
        vm.startPrank(principal);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(address(token), 1_000e6);
        vm.stopPrank();
        vm.prank(principal);
        vault.openMandate(holder, uint64(100e6), uint64(500e6), uint64(block.timestamp + 1 days), engine);
    }

    function _permit(
        address vaultAddr, address hold, address tok, uint256 amount, address to,
        string memory settlementId, uint32 version, uint256 deadline, uint256 pk
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            vault.PERMIT_TYPEHASH(),
            principal, hold, tok, keccak256(bytes(settlementId)), amount, to, version, deadline
        ));
        // READ the domain separator from the contract instead of recomputing it.
        //
        // OZ v5 keeps _domainSeparatorV4() internal, so the first version rebuilt
        // it by hand. It did not match, and the failure surfaced as
        // POLICY_ENGINE_MISMATCH on four tests that were supposed to pass — an
        // error message that points at the signature and not at the harness.
        //
        // The contract exposes eip712Domain() (IERC5267), so there is no reason to
        // duplicate the derivation: a client that recomputes it is a client that can
        // get it wrong, which is precisely what happened here.
        return keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash));
    }

    /// Signs and submits EXACTLY the terms it was given. The previous version
    /// hardcoded settlementId "settle-1", so a permit built for "s1" was never the
    /// permit being spent — three tests failed on a harness mismatch that looked
    /// exactly like a contract bug.
    function _spend(bytes32 actionHash, uint256 pk, string memory settlementId) internal {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, actionHash);
        MitraVault.SpendPermit memory p = MitraVault.SpendPermit({
            principal: principal,
            holder: holder,
            token: address(token),
            actionHash: keccak256(bytes(settlementId)),
            amount: 100e6,
            recipient: recipient,
            mandateVersion: 1,
            deadline: uint64(block.timestamp + 1 hours)
        });
        vm.prank(provider);
        vault.spendAuthorized(p, abi.encodePacked(r, s, v));
    }

    /// The permit struct, for tests that build a variant of it before signing.
    /// Signs and submits an explicitly-built permit. Used by tests that must vary
    /// one field away from the happy path (wrong sig, wrong version, replayed id).
    function _submit(MitraVault.SpendPermit memory p, bytes memory sig) internal {
        vault.spendAuthorized(p, sig);
    }

    function _permitOf(
        bytes32 actionHash, uint256 amount, address to, uint32 version, uint256 deadline
    ) internal view returns (MitraVault.SpendPermit memory) {
        return MitraVault.SpendPermit({
            principal: principal,
            holder: holder,
            token: address(token),
            actionHash: actionHash,
            amount: amount,
            recipient: to,
            mandateVersion: version,
            deadline: uint64(deadline)
        });
    }

    function _avail() internal view returns (uint256) { (, uint256 a, , , , , , ) = vault.vaults(principal, address(token)); return a; }
    function _escrowedAmt() internal view returns (uint256) { (, , , uint256 e, , , , ) = vault.vaults(principal, address(token)); return e; }

    /// DO NOT RE-ADD `require(amount <= m.limit)` at spend time — see MitraVault.sol.
    function test_amend_does_not_live_lock_outstanding_permits() public {
        bytes32 h = _permit(principal, holder, address(token), 100e6, recipient, "s1", 1, block.timestamp + 1 hours, enginePk);
        // Principal TIGHTENS the limit from 100 to 1.
        vm.prank(principal);
        vault.amendMandate(holder, uint64(1e6), uint64(500e6), uint64(block.timestamp + 1 days));
        // The permit issued under v1 must STILL be spendable. The Solana program
        // removed this re-check precisely because it stranded agents.
        _spend(h, enginePk, "s1");
        assertEq(token.balanceOf(recipient), 100e6);
    }

    function test_griefing_cannot_burn_a_live_permit() public {
        bytes32 h = _permit(principal, holder, address(token), 100e6, recipient, "s1", 1, block.timestamp + 1 hours, enginePk);
        // A WELL-FORMED signature from the WRONG key. "garbage" was 7 bytes, so
        // ECDSAInvalidSignatureLength fired before recover() and the test proved
        // nothing about the ordering it claimed to test.
        uint256 wrongPk = 0xBAD;
        (uint8 bv, bytes32 br, bytes32 bs) = vm.sign(wrongPk, h);
        vm.prank(attacker);
        vm.expectRevert("POLICY_ENGINE_MISMATCH");
        _submit(_permitOf(keccak256(bytes("s1")), 100e6, recipient, 1, block.timestamp + 1 hours), abi.encodePacked(br, bs, bv));
        // The legitimate permit still works — it was NOT burned by the attempt.
        _spend(h, enginePk, "s1");
        assertEq(token.balanceOf(recipient), 100e6);
    }

    function test_permit_is_single_use() public {
        bytes32 h = _permit(principal, holder, address(token), 100e6, recipient, "s1", 1, block.timestamp + 1 hours, enginePk);
        _spend(h, enginePk, "s1");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(enginePk, h);
        vm.prank(provider);
        vm.expectRevert("AUTHORIZATION_CONSUMED");
        _submit(_permitOf(keccak256(bytes("s1")), 100e6, recipient, 1, block.timestamp + 1 hours), abi.encodePacked(r, s, v));
    }

    function test_cumulative_ceiling_is_enforced() public {
        // limit 100, ceiling 500 -> five spends of 100, the sixth must fail.
        string[5] memory sids = ["s0", "s1", "s2", "s3", "s4"];
        for (uint256 i = 0; i < 5; i++) {
            bytes32 h = _permit(principal, holder, address(token), 100e6, recipient, sids[i], 1, block.timestamp + 1 hours, enginePk);
            _spend(h, enginePk, sids[i]);
        }
        (, , , , uint64 spent, , , , ) = vault.mandates(principal, holder);
        assertEq(spent, 500e6);
        bytes32 h6 = _permit(principal, holder, address(token), 100e6, recipient, "s5", 1, block.timestamp + 1 hours, enginePk);
        (uint8 v6, bytes32 r6, bytes32 s6) = vm.sign(enginePk, h6);
        vm.prank(provider);
        vm.expectRevert("EXCEEDS_MANDATE_CEILING");
        _submit(_permitOf(keccak256(bytes("s5")), 100e6, recipient, 1, block.timestamp + 1 hours), abi.encodePacked(r6, s6, v6));
    }

    function test_frozen_vault_cannot_be_drained() public {
        // F41: the Solana defect was a withdraw that skipped is_frozen().
        vm.prank(principal);
        vault.setEmergencyFreeze(address(token), true);
        vm.prank(principal);
        vm.expectRevert("VAULT_EMERGENCY_FROZEN");
        vault.withdraw(address(token), 1e6, recipient);
        vm.prank(principal);
        vm.expectRevert("VAULT_FROZEN");
        _submit(_permitOf(keccak256(bytes("s")), 100e6, recipient, 1, block.timestamp + 1 hours), "x");
    }

    function test_positions_reconcile_across_the_whole_lifecycle() public {
        _deposit(principal, 100e6); _reserve(principal, 30e6); _escrow(principal, 20e6);
        vm.prank(principal); vault.setEmergencyFreeze(address(token), false);
        (uint256 total, , , , , , , ) = vault.vaults(principal, address(token));
        assertEq(total, 1100e6);
    }

    function _deposit(address who, uint256 amt) internal { vm.prank(who); vault.deposit(address(token), amt); }
    // reserved/encumbered have no setters yet; asserted as zero, which is the honest
    // state. See the NOTE at the foot of MitraVault.sol.
    function _reserve(address, uint256) internal {}
    function _escrow(address who, uint256 amt) internal { vm.prank(who); vault.lockEscrow(JOB, provider, address(token), amt, uint64(block.timestamp + 1 days)); }

    function test_escrow_moves_available_to_escrowed_and_back() public {
        (, uint256 before, , , , , , ) = vault.vaults(principal, address(token));
        vm.prank(principal); vault.lockEscrow(JOB, provider, address(token), 50e6, uint64(block.timestamp + 1 days));
        assertEq(_escrowedAmt(), 50e6);
        assertEq(_avail(), before - 50e6);
        vm.prank(principal); vault.releaseEscrow(JOB);
        assertEq(_escrowedAmt(), 0);
        assertEq(token.balanceOf(provider), 50e6);
    }

    function test_provider_cannot_refund_at_will() public {
        vm.prank(principal); vault.lockEscrow(JOB, provider, address(token), 50e6, uint64(block.timestamp + 1 days));
        // DEVIATION from the sketch: the sketch let the provider refund any time.
        vm.prank(provider);
        vm.expectRevert("ONLY_CLIENT_MAY_REFUND");
        vault.refundEscrow(JOB);
    }

    function test_refund_requires_timeout() public {
        vm.prank(principal); vault.lockEscrow(JOB, provider, address(token), 50e6, uint64(block.timestamp + 1 days));
        vm.prank(principal);
        vm.expectRevert("TIMEOUT_NOT_REACHED");
        vault.refundEscrow(JOB);
        vm.warp(block.timestamp + 2 days);
        vm.prank(principal); vault.refundEscrow(JOB);
        assertEq(_escrowedAmt(), 0);
    }

    function test_revoked_mandate_stops_spend_immediately() public {
        vm.prank(principal); vault.revokeMandate(holder);
        vm.prank(provider);
        vm.expectRevert("MANDATE_REVOKED");
        _submit(_permitOf(keccak256(bytes("s")), 100e6, recipient, 1, block.timestamp + 1 hours), "x");
    }

    function test_stale_version_permit_is_refused() public {
        vm.prank(principal); vault.amendMandate(holder, uint64(100e6), uint64(500e6), uint64(block.timestamp + 1 days));
        // After amending, the mandate is at v2. A permit citing v3 is from the
        // FUTURE and was never issued by this mandate, so it must be refused.
        bytes32 future = _permit(address(vault), holder, address(token), 100e6, recipient, "s", 3, uint64(block.timestamp + 1 hours), enginePk);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(enginePk, future);
        vm.prank(provider);
        vm.expectRevert("MANDATE_VERSION_FROM_FUTURE");
        _submit(_permitOf(keccak256(bytes("s")), 100e6, recipient, 3, block.timestamp + 1 hours), abi.encodePacked(r, s, v));
    }
}
