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

/// F61 reproduction — OPEN finding against the canonical v2 contract, not a fix.
///
/// A v2 mandate has no token: `limit` and `ceiling` are raw units, and
/// `spendAuthorized` debits whichever token the permit names. A principal who sets a
/// ceiling meaning "500 USD" has also authorised 500e6 raw units of every other token
/// in their vault — here, 5 BTC. The engine is trusted to choose the token, so this is
/// the exposure if the engine key leaks: the on-chain bound the mandate exists to
/// provide does not bound value.
///
/// This test asserts TODAY's behaviour so the finding is executed evidence. When the
/// contract binds a mandate to a token, invert it (expect a revert) — do not delete it.
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
        vault.openMandate(holder, uint64(100e6), uint64(500e6), uint64(block.timestamp + 1 days), vm.addr(enginePk));
        vm.stopPrank();
    }

    function test_F61_a_usd_sized_ceiling_lets_a_leaked_engine_key_take_5_btc() public {
        MitraVault.SpendPermit memory p = MitraVault.SpendPermit({
            principal: principal, holder: holder, token: address(btc), actionHash: keccak256("drain"),
            amount: 5e8, recipient: thief, mandateVersion: 1, deadline: uint64(block.timestamp + 1 hours)
        });
        bytes32 structHash = keccak256(abi.encode(
            vault.PERMIT_TYPEHASH(), p.principal, p.holder, p.token, p.actionHash, p.amount, p.recipient, p.mandateVersion, p.deadline
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(enginePk, keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash)));

        vm.prank(thief);
        vault.spendAuthorized(p, abi.encodePacked(r, s, v));

        assertEq(btc.balanceOf(thief), 5e8, "5 BTC left under a ceiling meant as 500 USD");
        (,,,, uint64 spent,,,,) = vault.mandates(principal, holder);
        assertEq(spent, 5e8, "the ceiling counted raw units, whatever the token");
    }
}
