// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MitraVault} from "../src/MitraVault.sol";

contract Token is ERC20 {
    constructor() ERC20("Test USD", "TUSD") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
    function decimals() public pure override returns (uint8) { return 6; }
}

/// Takes 1% of every transfer, to check deposit credits what arrived.
contract FeeToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
    function _update(address from, address to, uint256 v) internal override {
        if (from != address(0) && to != address(0)) { uint256 fee = v / 100; super._update(from, address(0xdead), fee); v -= fee; }
        super._update(from, to, v);
    }
}

/// A contract wallet engine (ERC-1271) owned by one EOA.
contract WalletEngine is IERC1271 {
    address public immutable owner;
    constructor(address o) { owner = o; }
    function isValidSignature(bytes32 h, bytes calldata sig) external view returns (bytes4) {
        return ECDSA.recover(h, sig) == owner ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

contract MitraVaultTest is Test {
    MitraVault vault;
    Token usdc;
    uint256 enginePk = 0xE11E;
    address engine;
    address principal = address(0xA11CE);
    address victim = address(0xB0B);
    address holder = address(0x4011);
    address payee = address(0xFEE);
    address relayer = address(0x7E1A);

    function setUp() public {
        vault = new MitraVault();
        usdc = new Token();
        engine = vm.addr(enginePk);
        for (uint256 i; i < 2; i++) {
            address who = i == 0 ? principal : victim;
            usdc.mint(who, 1_000e6);
            vm.startPrank(who);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(address(usdc), 500e6);
            vm.stopPrank();
        }
        vm.prank(principal);
        vault.openMandate(holder, engine, address(usdc), 100e6, 250e6, uint64(block.timestamp + 1 days));
    }

    function permit(bytes32 action, uint256 amount) internal view returns (MitraVault.SpendPermit memory p) {
        p = MitraVault.SpendPermit({principal: principal, holder: holder, token: address(usdc), actionHash: action,
            amount: amount, recipient: payee, mandateVersion: 1, deadline: uint64(block.timestamp + 1 hours)});
    }

    function sign(uint256 pk, MitraVault.SpendPermit memory p) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.permitDigest(p));
        return abi.encodePacked(r, s, v);
    }

    // ── the happy path ───────────────────────────────────────────────────────

    function test_aRelayerSubmitsAnEngineSignedPermitAndThePayeeIsPaid() public {
        MitraVault.SpendPermit memory p = permit(keccak256("settlement-1"), 40e6);
        vm.expectEmit(true, true, true, true);
        emit MitraVault.SpendExecuted(principal, holder, payee, address(usdc), 40e6, p.actionHash, 1);
        vm.prank(relayer);
        vault.spendAuthorized(p, sign(enginePk, p));
        assertEq(usdc.balanceOf(payee), 40e6);
        (uint256 available,,) = vault.positions(principal, address(usdc));
        assertEq(available, 460e6);
    }

    // ── F51, each attack refused ─────────────────────────────────────────────

    function test_F51a_aPermitCannotDebitAVaultItsMandateDoesNotGovern() public {
        // A valid permit for the principal's mandate, relabelled to the victim's vault.
        MitraVault.SpendPermit memory p = permit(keccak256("x"), 10e6);
        bytes memory sig = sign(enginePk, p);
        p.principal = victim;
        vm.expectRevert(MitraVault.NoMandate.selector);
        vault.spendAuthorized(p, sig);
    }

    function test_F51b_aStrangerCannotAuthorizeAgainstAMandate() public {
        MitraVault.SpendPermit memory p = permit(keccak256("x"), 10e6);
        bytes memory sig_p1 = sign(0xBAD, p);
        vm.expectRevert(MitraVault.EngineSignatureInvalid.selector);
        vault.spendAuthorized(p, sig_p1);
    }

    function test_F51c_aSubmitterCannotRedirectThePayee() public {
        MitraVault.SpendPermit memory p = permit(keccak256("x"), 10e6);
        bytes memory sig = sign(enginePk, p);
        p.recipient = relayer;
        vm.expectRevert(MitraVault.EngineSignatureInvalid.selector);
        vault.spendAuthorized(p, sig);
    }

    function test_F51c_orChangeTheAmount() public {
        MitraVault.SpendPermit memory p = permit(keccak256("x"), 10e6);
        bytes memory sig = sign(enginePk, p);
        p.amount = 20e6;
        vm.expectRevert(MitraVault.EngineSignatureInvalid.selector);
        vault.spendAuthorized(p, sig);
    }

    function test_F51_aHolderCannotGrantItselfAMandateOnSomeoneElsesVault() public {
        // openMandate always binds msg.sender's own vault: the holder opening one
        // creates a mandate over the HOLDER's (empty) vault, not the victim's.
        vm.prank(holder);
        vault.openMandate(holder, holder, address(usdc), 1e6, 1e6, uint64(block.timestamp + 1));
        (address eng,,,,,,,) = vault.mandates(victim, holder);
        assertEq(eng, address(0), "the victim's vault has no mandate for the holder");
    }

    function test_mandatesForOneHolderUnderTwoPrincipalsAreIndependent_noSquatting() public {
        vm.prank(victim);
        vault.openMandate(holder, engine, address(usdc), 5e6, 5e6, uint64(block.timestamp + 1 days));
        (, , uint128 limitA,,,,,) = vault.mandates(principal, holder);
        (, , uint128 limitB,,,,,) = vault.mandates(victim, holder);
        assertEq(limitA, 100e6);
        assertEq(limitB, 5e6);
    }

    // ── single use, limits, freeze, expiry, revocation, versions ────────────

    function test_aPermitIsSingleUse() public {
        MitraVault.SpendPermit memory p = permit(keccak256("once"), 10e6);
        bytes memory sig = sign(enginePk, p);
        vault.spendAuthorized(p, sig);
        vm.expectRevert(MitraVault.AlreadyConsumed.selector);
        vault.spendAuthorized(p, sig);
    }

    function test_perSpendLimitAndCumulativeCeiling() public {
        MitraVault.SpendPermit memory big = permit(keccak256("big"), 101e6);
        bytes memory sig_big1 = sign(enginePk, big);
        vm.expectRevert(MitraVault.ExceedsLimit.selector);
        vault.spendAuthorized(big, sig_big1);
        for (uint256 i; i < 2; i++) {
            MitraVault.SpendPermit memory p = permit(keccak256(abi.encode(i)), 100e6);
            vault.spendAuthorized(p, sign(enginePk, p));
        }
        MitraVault.SpendPermit memory over = permit(keccak256("over"), 51e6);
        bytes memory sig_over1 = sign(enginePk, over);
        vm.expectRevert(MitraVault.ExceedsCeiling.selector);
        vault.spendAuthorized(over, sig_over1);
    }

    function test_aFrozenVaultSpendsNothingAndWithdrawsNothing() public {
        vm.prank(principal);
        vault.setFrozen(address(usdc), true);
        MitraVault.SpendPermit memory p = permit(keccak256("f"), 1e6);
        bytes memory sig_p3 = sign(enginePk, p);
        vm.expectRevert(MitraVault.VaultFrozen.selector);
        vault.spendAuthorized(p, sig_p3);
        vm.prank(principal);
        vm.expectRevert(MitraVault.VaultFrozen.selector);
        vault.withdraw(address(usdc), 1e6, principal);
    }

    function test_expiredPermitAndExpiredMandateAreRefused() public {
        MitraVault.SpendPermit memory p = permit(keccak256("late"), 1e6);
        bytes memory sig = sign(enginePk, p);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(MitraVault.PermitExpired.selector);
        vault.spendAuthorized(p, sig);
        p.deadline = uint64(block.timestamp + 2 days);
        sig = sign(enginePk, p);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(MitraVault.MandateExpired.selector);
        vault.spendAuthorized(p, sig);
    }

    function test_theHolderMayRevokeItselfAStrangerMayNot() public {
        vm.prank(relayer);
        vm.expectRevert(MitraVault.NotPrincipalOrHolder.selector);
        vault.revokeMandate(principal, holder);
        vm.prank(holder);
        vault.revokeMandate(principal, holder);
        MitraVault.SpendPermit memory p = permit(keccak256("r"), 1e6);
        bytes memory sig_p5 = sign(enginePk, p);
        vm.expectRevert(MitraVault.MandateIsRevoked.selector);
        vault.spendAuthorized(p, sig_p5);
    }

    function test_amendingBumpsTheVersionAndKillsEarlierPermitsButKeepsSpendHistory() public {
        MitraVault.SpendPermit memory p = permit(keccak256("v1"), 100e6);
        vault.spendAuthorized(p, sign(enginePk, p));
        MitraVault.SpendPermit memory stale = permit(keccak256("v1-unspent"), 1e6);
        bytes memory staleSig = sign(enginePk, stale);
        vm.prank(principal);
        vault.openMandate(holder, engine, address(usdc), 100e6, 150e6, uint64(block.timestamp + 1 days));
        vm.expectRevert(MitraVault.VersionMismatch.selector);
        vault.spendAuthorized(stale, staleSig);
        // 100 already spent against a new ceiling of 150: an amendment is not a new budget.
        MitraVault.SpendPermit memory p2 = permit(keccak256("v2"), 60e6);
        p2.mandateVersion = 2;
        bytes memory sig_p21 = sign(enginePk, p2);
        vm.expectRevert(MitraVault.ExceedsCeiling.selector);
        vault.spendAuthorized(p2, sig_p21);
    }

    function test_aContractWalletEngineWorksThroughERC1271() public {
        WalletEngine wallet = new WalletEngine(engine);
        vm.prank(principal);
        vault.openMandate(holder, address(wallet), address(usdc), 100e6, 250e6, uint64(block.timestamp + 1 days));
        MitraVault.SpendPermit memory p = permit(keccak256("1271"), 5e6);
        p.mandateVersion = 2;
        vault.spendAuthorized(p, sign(enginePk, p));
        assertEq(usdc.balanceOf(payee), 5e6);
    }

    function test_badMandateTermsAreRefused() public {
        vm.startPrank(principal);
        vm.expectRevert(MitraVault.BadMandateTerms.selector);
        vault.openMandate(holder, engine, address(usdc), 0, 1, uint64(block.timestamp + 1));
        vm.expectRevert(MitraVault.BadMandateTerms.selector);
        vault.openMandate(holder, engine, address(usdc), 10, 5, uint64(block.timestamp + 1));
        vm.expectRevert(MitraVault.BadMandateTerms.selector);
        vault.openMandate(holder, engine, address(usdc), 1, 1, uint64(block.timestamp));
        vm.stopPrank();
    }

    function test_depositCreditsWhatArrivedNotWhatWasAsked() public {
        FeeToken fee = new FeeToken();
        fee.mint(principal, 1_000);
        vm.startPrank(principal);
        fee.approve(address(vault), 1_000);
        vault.deposit(address(fee), 1_000);
        vm.stopPrank();
        (uint256 available,,) = vault.positions(principal, address(fee));
        assertEq(available, 990);
    }

    // ── escrow ───────────────────────────────────────────────────────────────

    function test_escrow_onlyTheClientReleases() public {
        vm.prank(principal);
        vault.lockEscrow("job", payee, address(usdc), 30e6, uint64(block.timestamp + 1 days));
        vm.prank(payee);
        vm.expectRevert(MitraVault.NotClient.selector);
        vault.releaseEscrow("job");
        vm.prank(principal);
        vault.releaseEscrow("job");
        assertEq(usdc.balanceOf(payee), 30e6);
        vm.prank(principal);
        vm.expectRevert(MitraVault.EscrowNotOpen.selector);
        vault.releaseEscrow("job");
    }

    function test_escrow_clientRefundsOnlyAfterTimeout_providerAnytime() public {
        vm.startPrank(principal);
        vault.lockEscrow("a", payee, address(usdc), 10e6, uint64(block.timestamp + 1 days));
        vault.lockEscrow("b", payee, address(usdc), 10e6, uint64(block.timestamp + 1 days));
        vm.expectRevert(MitraVault.RefundNotAllowedYet.selector);
        vault.refundEscrow("a");
        vm.stopPrank();
        vm.prank(payee);
        vault.refundEscrow("b");
        vm.warp(block.timestamp + 1 days);
        vm.prank(principal);
        vault.refundEscrow("a");
        (uint256 available, uint256 escrowed,) = vault.positions(principal, address(usdc));
        assertEq(available, 500e6);
        assertEq(escrowed, 0);
        vm.prank(relayer);
        vm.expectRevert(MitraVault.EscrowNotOpen.selector);
        vault.refundEscrow("a");
    }

    function test_escrowedCapitalCannotBeSpentOrWithdrawn() public {
        vm.prank(principal);
        vault.lockEscrow("all", payee, address(usdc), 500e6, uint64(block.timestamp + 1 days));
        MitraVault.SpendPermit memory p = permit(keccak256("e"), 1e6);
        bytes memory sig_p7 = sign(enginePk, p);
        vm.expectRevert(MitraVault.InsufficientAvailable.selector);
        vault.spendAuthorized(p, sig_p7);
        vm.prank(principal);
        vm.expectRevert(MitraVault.InsufficientAvailable.selector);
        vault.withdraw(address(usdc), 1, principal);
    }
}
