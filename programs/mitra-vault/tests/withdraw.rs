//! FR-VAULT-006 — withdrawal, which existed untested until F41.
//!
//! **Why this file exists.** `FR-VAULT-006` ("agent authority does not imply
//! principal withdrawal authority") was recorded `UNTESTED` with the rationale
//! "no withdrawal path exists to test". That rationale was wrong: `withdraw` has
//! been in `lib.rs` the whole time. It was untested, and untested code in a
//! security path is worse than absent code, because absent code cannot be
//! depended upon by mistake.
//!
//! **The defect it found.** `withdraw` did its arithmetic inline in the handler:
//!
//! ```ignore
//! vault.available -= amount;
//! vault.total -= amount;
//! ```
//!
//! Its sibling `reserve` checks `is_frozen()`; `withdraw` did not. **A frozen vault
//! could be drained.** An emergency freeze is the control you reach for when value
//! is at risk, and the one operation it most needs to stop was the one operation it
//! did not stop.
//!
//! The fix moves the rules into `Vault::withdraw` so they are state-level,
//! unit-testable, and cannot be bypassed by a handler that does the arithmetic
//! itself. These tests cover the TYPE. The handler-level guarantee — that
//! `withdraw` actually routes through it — is the subject of a separate mutation
//! check, because a test covering a method but not its caller has not tested the
//! property anyone relies on.

use mitra_vault::anchor_parity::err;
use mitra_vault::state::Vault;
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

fn funded(amount: u64) -> Vault {
    let mut v = Vault::new(Pubkey::new_unique(), 254);
    v.deposit(amount).expect("deposit must succeed");
    v
}

fn frozen_funded(amount: u64) -> Vault {
    let mut v = funded(amount);
    v.frozen = amount;
    v.total = amount + v.frozen; // keep the reconciliation invariant true
    v.reconcile().expect("a frozen vault must still reconcile");
    v
}

// --- the defect -------------------------------------------------------------

#[test]
fn a_frozen_vault_refuses_withdrawal() {
    // THE regression test. Before F41 this succeeded and emptied the vault.
    let mut v = frozen_funded(1_000);
    let err = v.withdraw(1_000).unwrap_err();
    assert_eq!(err, ProgramError::Custom(err::VAULT_FROZEN));
    // And nothing moved: a refused operation must not half-apply.
    assert_eq!(v.total, 2_000);
    assert_eq!(v.available, 1_000);
    v.reconcile().unwrap();
}

#[test]
fn a_frozen_vault_refuses_a_partial_withdrawal_too() {
    // A freeze that blocks only some amounts is not a freeze.
    let mut v = frozen_funded(1_000);
    assert_eq!(v.withdraw(1).unwrap_err(), ProgramError::Custom(err::VAULT_FROZEN));
    assert_eq!(v.available, 1_000);
}

#[test]
fn release_is_still_permitted_while_frozen() {
    // The asymmetry is deliberate and must not be "fixed" by making both refuse.
    // A freeze that strands reserved capital traps in-flight obligations.
    let mut v = funded(1_000);
    v.reserve(1_000).unwrap();
    v.frozen = 500;
    v.total += 500;
    v.release(1_000).expect("release must remain permitted while frozen");
    assert_eq!(v.available, 1_000);
    v.reconcile().unwrap();
}

// --- the capital rules -------------------------------------------------------

#[test]
fn withdrawal_does_not_exceed_available() {
    let mut v = funded(1_000);
    assert_eq!(
        v.withdraw(1_001).unwrap_err(),
        ProgramError::Custom(err::INSUFFICIENT_AVAILABLE)
    );
    assert_eq!(v.available, 1_000);
    assert_eq!(v.total, 1_000);
    v.reconcile().unwrap();
}

#[test]
fn reserved_capital_is_not_withdrawable() {
    // The whole point of a reservation: committed capital is not the authority's
    // to take back. An agent that can reserve can therefore not drain.
    let mut v = funded(1_000);
    v.reserve(600).unwrap();
    assert_eq!(
        v.withdraw(600).unwrap_err(),
        ProgramError::Custom(err::INSUFFICIENT_AVAILABLE),
        "reserved capital must not be withdrawable"
    );
    // The available 400 is still withdrawable.
    v.withdraw(400).expect("available capital remains withdrawable");
    assert_eq!(v.available, 0);
    assert_eq!(v.reserved, 600);
    assert_eq!(v.total, 600);
    v.reconcile().unwrap();
}

#[test]
fn withdrawing_everything_leaves_an_empty_consistent_vault() {
    let mut v = funded(1_000);
    v.withdraw(1_000).unwrap();
    assert_eq!(v.available, 0);
    assert_eq!(v.total, 0);
    v.reconcile().unwrap();
}

#[test]
fn withdraw_and_deposit_round_trip_exactly() {
    // No lamports created or destroyed by the round trip.
    let mut v = funded(1_000);
    v.withdraw(250).unwrap();
    assert_eq!(v.total, 750);
    v.deposit(250).unwrap();
    assert_eq!(v.total, 1_000);
    assert_eq!(v.available, 1_000);
    v.reconcile().unwrap();
}

#[test]
fn repeated_partial_withdrawals_never_exceed_the_original_total() {
    // The threat is a sequence nobody wrote down.
    let mut v = funded(1_000);
    for _ in 0..100 {
        v.withdraw(10).unwrap();
    }
    assert_eq!(v.available, 0);
    assert_eq!(v.total, 0);
    assert_eq!(
        v.withdraw(1).unwrap_err(),
        ProgramError::Custom(err::INSUFFICIENT_AVAILABLE),
        "an emptied vault must refuse further withdrawals"
    );
    v.reconcile().unwrap();
}

#[test]
fn oversized_withdrawals_are_refused() {
    let mut v = funded(1_000);
    assert_eq!(
        v.withdraw(u64::MAX).unwrap_err(),
        ProgramError::Custom(err::INSUFFICIENT_AVAILABLE)
    );
    assert_eq!(v.total, 1_000);
    v.reconcile().unwrap();
}

#[test]
fn zero_is_a_no_op_at_the_state_layer_and_is_refused_by_the_handler() {
    // Recorded because the first version of this test asserted that
    // `withdraw(0)` returns INSUFFICIENT_AVAILABLE, and it does not — it succeeds.
    //
    // That is correct and consistent: `deposit(0)` and `reserve(0)` also succeed,
    // because zero moves no capital and the reconciliation invariant still holds.
    // The `amount == 0` rejection lives in the *handler*
    // (`if amount == 0 { return Err(InvalidArgument) }`), which is the boundary
    // where a malformed instruction should be refused rather than interpreted as a
    // no-op.
    //
    // So this test pins the split of responsibility instead of inventing a rule
    // the rest of the type does not follow.
    let mut v = funded(1_000);
    v.withdraw(0).expect("zero is a no-op at the state layer");
    assert_eq!(v.total, 1_000);
    assert_eq!(v.available, 1_000);
    v.reconcile().unwrap();
}

#[test]
fn withdrawal_never_breaks_the_six_position_invariant() {
    // Across a mixed sequence, which is the only shape in which a reconciler that
    // only holds for deposits would be caught.
    let mut v = funded(10_000);
    v.withdraw(1_000).unwrap();
    v.reserve(2_000).unwrap();
    v.release(1_000).unwrap();
    v.withdraw(500).unwrap();
    v.deposit(250).unwrap();
    assert_eq!(
        v.available + v.reserved + v.escrowed + v.encumbered + v.settling + v.frozen,
        v.total
    );
    v.reconcile().unwrap();
}

// ---------------------------------------------------------------------------
// Handler-level tests
// ---------------------------------------------------------------------------
//
// ## Why this second half exists
//
// The type tests above pass even when the `withdraw` HANDLER does its arithmetic
// inline and never calls `Vault::withdraw`. That was verified, not assumed: a
// mutation restoring the pre-F41 handler shape
//
// ```ignore
// if amount <= vault.available { vault.available -= amount; vault.total -= amount; ... }
// ```
//
// left the **entire** Rust suite green — 9 of these 10 type tests and all 72
// others. So the type tests prove the rules exist; they do not prove the security
// property `FR-VAULT-006` actually depends on, which is that capital cannot leave a
// FROZEN vault through the instruction anybody can send.
//
// This is the same gap `spend_integration.rs` was written for, found again in a
// different handler. The fix is the same: call the real `dispatch` with real
// `AccountInfo`s.
//
// What these still cannot cover: `invoke_signed` and genuine lamport ownership,
// which need a chain. `scripts/vault-devnet.mjs` is the counterpart.

use mitra_vault::anchor_parity::{find_vault_pda, ix, vault_seeds};
use solana_program::account_info::AccountInfo;
use solana_program::system_program;

struct HandlerFixture {
    program_id: Pubkey,
    authority: Pubkey,
    vault: Pubkey,
    authority_key: Pubkey,
    vault_key: Pubkey,
    authority_lamports: u64,
    vault_lamports: u64,
    vault_data: Vec<u8>,
}

impl HandlerFixture {
    fn new(frozen: bool, funded: u64) -> Self {
        let program_id = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        // The REAL PDA for this authority, so `check_vault_account` accepts it.
        let (vault, bump) = find_vault_pda(&vault_seeds(&authority), &program_id).unwrap();

        let mut v = Vault::new(authority, bump);
        v.deposit(funded).unwrap();
        if frozen {
            v.frozen = funded;
            v.total += funded;
        }
        v.reconcile().unwrap();

        Self {
            program_id,
            authority,
            vault,
            authority_key: Pubkey::new_unique(),
            vault_key: Pubkey::new_unique(),
            // Rent-exempt minimum, so a later mutation cannot fail for want of
            // lamports and be mistaken for passing.
            authority_lamports: 10_000_000,
            vault_lamports: 10_000_000 + funded,
            vault_data: v.to_bytes().to_vec(),
        }
    }

    fn withdraw(&mut self, amount: u64) -> Result<(), ProgramError> {
        let mut data = [0u8; 8];
        data.copy_from_slice(&amount.to_le_bytes());
        let mut ix_data = ix::WITHDRAW.to_vec();
        ix_data.extend_from_slice(&data);

        let owner = Pubkey::new_unique();
        let sys = system_program::ID;
        let authority_acc = AccountInfo::new(
            &self.authority, true, true, &mut self.authority_lamports, &mut [], &owner, false, 0,
        );
        let vault_acc = AccountInfo::new(
            &self.vault, false, true, &mut self.vault_lamports, &mut self.vault_data, &self.program_id, false, 0,
        );
        // `&mut 0u64` would be a temporary freed before `dispatch` uses it.
        let mut sys_lamports = 0u64;
        let sys_acc = AccountInfo::new(&sys, false, false, &mut sys_lamports, &mut [], &owner, false, 0);

        mitra_vault::dispatch(
            &self.program_id,
            &[authority_acc.clone(), vault_acc, sys_acc],
            &ix_data,
            0,
        )
    }

    fn state(&self) -> Vault {
        Vault::from_bytes(&self.vault_data).unwrap()
    }
}

#[test]
fn the_handler_refuses_withdrawal_from_a_frozen_vault() {
    // THE test that kills the surviving mutation. Before F41 this succeeded.
    let mut f = HandlerFixture::new(true, 1_000);
    let err = f.withdraw(1_000).unwrap_err();
    assert_eq!(err, ProgramError::Custom(err::VAULT_FROZEN));

    // No lamports moved and no state changed. The vault's baseline is
    // RENT_EXEMPT-ish 10_000_000 PLUS the funded amount; the first version of this
    // assertion compared against 11_000 and failed with left: 10001000 — which
    // looked like the freeze check had not fired, and was really a wrong baseline.
    assert_eq!(f.vault_lamports, 10_001_000);
    assert_eq!(f.authority_lamports, 10_000_000);
    assert_eq!(f.state().total, 2_000);
}

#[test]
fn the_handler_refuses_a_partial_withdrawal_from_a_frozen_vault() {
    let mut f = HandlerFixture::new(true, 1_000);
    assert_eq!(f.withdraw(1).unwrap_err(), ProgramError::Custom(err::VAULT_FROZEN));
    assert_eq!(f.vault_lamports, 10_001_000);
}

#[test]
fn the_handler_permits_withdrawal_from_an_unfrozen_vault() {
    // The negative case. Without it, "always refuse" would pass every test above
    // while breaking the product.
    let mut f = HandlerFixture::new(false, 1_000);
    f.withdraw(400).expect("an unfrozen vault must allow withdrawal");
    assert_eq!(f.state().available, 600);
    assert_eq!(f.state().total, 600);
}

#[test]
fn the_handler_refuses_withdrawing_more_than_available() {
    let mut f = HandlerFixture::new(false, 1_000);
    assert_eq!(
        f.withdraw(1_001).unwrap_err(),
        ProgramError::Custom(err::INSUFFICIENT_AVAILABLE)
    );
    assert_eq!(f.state().available, 1_000);
}

#[test]
fn the_handler_refuses_a_non_signing_caller() {
    // Authority is re-derived from vault data; seeds alone are not authorization.
    let mut f = HandlerFixture::new(false, 1_000);
    let owner = Pubkey::new_unique();
    let sys = system_program::ID;
    let mut authority_lamports = 10_000_000;
    let mut data = [0u8; 8];
    data.copy_from_slice(&100u64.to_le_bytes());
    let mut ix_data = ix::WITHDRAW.to_vec();
    ix_data.extend_from_slice(&data);

    let authority_acc = AccountInfo::new(
        &f.authority, false, true, &mut authority_lamports, &mut [], &owner, false, 0,
    );
    let vault_acc = AccountInfo::new(
        &f.vault, false, true, &mut f.vault_lamports, &mut f.vault_data, &f.program_id, false, 0,
    );
    let mut sys_lamports = 0u64;
    let sys_acc = AccountInfo::new(&sys, false, false, &mut sys_lamports, &mut [], &owner, false, 0);

    let err = mitra_vault::dispatch(
        &f.program_id,
        &[authority_acc, vault_acc, sys_acc],
        &ix_data,
        0,
    )
    .unwrap_err();
    assert_eq!(err, ProgramError::Custom(err::NOT_SIGNER));
}
