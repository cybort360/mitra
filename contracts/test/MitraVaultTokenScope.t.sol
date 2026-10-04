// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MitraVault} from "../MitraVault.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract Usd6 is ERC20 {
    constructor(address who) ERC20("USD", "USD") { _mint(who, 1_000_000e6); }
    function decimals() public pure override returns (uint8) { return 6; }
}

contract Btc8 is ERC20 {
    constructor(address who) ERC20("BTC", "BTC") { _mint(who, 100e8); }
    function decimals() public pure override returns (uint8) { return 8; }
}

/// F61 — RESOLVED. The reproduction is retained and INVERTED, per the test's own
/// instruction: a fix that deletes the reproduction has destroyed the evidence.
///
/// Before: mandates were keyed by [principal][holder] with no token, so `limit` and
/// `ceiling` were raw atomic units. A principal who set a ceiling meaning "500 USD"
/// had also authorised 500e6 raw units of every other token in the vault — here, 5 BTC.
/// The engine chooses the token, so a leaked engine key could take 5 BTC under a
/// 500 USD ceiling: the on-chain bound failed to bound value.
///
/// After: mandates are keyed by [principal][holder][token]. A mandate opened for USD
/// does not exist for BTC, so the permit resolves to no mandate at all. This test now
/// asserts the REVOKE, which is the whole point of the fix.
contract MitraVaultTokenScopeTest is Test {
    MitraVault vault;
    Usd6 usd;
    Btc8 btc;
    address principal = address(0xA11CE);
    address holder = address(0xB0B);
    address thief = address(0xBAD);
    uint256 enginePk = 0xE16;

    function setUp() public {
        vault = new MitraVault();
        usd = new Usd6(principal);
        btc = new Btc8(principal);
        vm.startPrank(principal);
        usd.approve(address(vault), type(uint256).max);
        btc.approve(address(vault), type(uint256).max);
        vault.deposit(address(usd), 1_000e6);
        vault.deposit(address(btc), 10e8);
        // Meant as: 100 USD per spend, 500 USD in total.
        vault.openMandate(holder, address(usd), uint64(100e6), uint64(500e6), uint64(block.timestamp + 1 days), vm.addr(enginePk));
        vm.stopPrank();
    }

    function test_F61_a_usd_sized_ceiling_lets_a_leaked_engine_key_take_5_btc() public {
        // Same permit that drained 5 BTC before the fix: a valid engine signature
        // over a BTC token, sized at 5e8, sent to an attacker.
        MitraVault.SpendPermit memory p = MitraVault.SpendPermit({
            principal: principal, holder: holder, token: address(btc), actionHash: keccak256("drain"),
            amount: 5e8, recipient: thief, mandateVersion: 1, deadline: uint64(block.timestamp + 1 hours)
        });
        bytes32 structHash = keccak256(abi.encode(
            vault.PERMIT_TYPEHASH(), p.principal, p.holder, p.token, p.actionHash, p.amount, p.recipient, p.mandateVersion, p.deadline
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(enginePk, keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash)));

        // The mandate was opened for USD. Spending BTC must not resolve to it.
        vm.prank(thief);
        vm.expectRevert("PRINCIPAL_MISMATCH");
        vault.spendAuthorized(p, abi.encodePacked(r, s, v));

        assertEq(btc.balanceOf(thief), 0, "no BTC may leave the vault under a USD-scoped mandate");
        (,,,, uint64 spent,,,,) = vault.mandates(principal, holder, address(usd));
        assertEq(spent, 0, "the USD mandate ceiling is untouched");
    }

    /// The scope boundary must hold in BOTH directions: a mandate opened for USD
    /// must not be reachable via BTC, and the USD path itself must still work.
    function test_F61_scoped_mandate_still_spends_its_own_token() public {
        MitraVault.SpendPermit memory p = MitraVault.SpendPermit({
            principal: principal, holder: holder, token: address(usd), actionHash: keccak256("pay"),
            amount: 50e6, recipient: thief, mandateVersion: 1, deadline: uint64(block.timestamp + 1 hours)
        });
        bytes32 structHash = keccak256(abi.encode(
            vault.PERMIT_TYPEHASH(), p.principal, p.holder, p.token, p.actionHash, p.amount, p.recipient, p.mandateVersion, p.deadline
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(enginePk, keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash)));

        vm.prank(thief);
        vault.spendAuthorized(p, abi.encodePacked(r, s, v));

        assertEq(usd.balanceOf(thief), 50e6, "the scoped token is still spendable");
        assertEq(btc.balanceOf(thief), 0);
    }
}
