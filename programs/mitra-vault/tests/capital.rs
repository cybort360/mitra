//! Tests for the capital-boundary logic.
//!
//! These are the properties that make the vault a boundary rather than a
//! counter. Each is written as a property that must hold for *any* sequence of
//! operations, not as an assertion about one script, because the threat is a
//! sequence nobody wrote down.

use mitra_vault::anchor_parity::err;
use mitra_vault::state::{Vault, VAULT_LEN};
use solana_program::pubkey::Pubkey;

const LAMPORTS: u64 = 1_000_000_000;

fn funded(amount: u64) -> Vault {
    let mut v = Vault::new(Pubkey::new_unique(), 254);
    v.deposit(amount).expect("deposit must succeed");
    v
}

#[test]
fn fresh_vault_reconciles_and_is_empty() {
    let v = Vault::new(Pubkey::new_unique(), 254);
    assert_eq!(v.total, 0);
    assert_eq!(v.available, 0);
    assert!(!v.is_frozen());
    v.reconcile().expect("a fresh vault must reconcile");
}

#[test]
fn six_positions_always_sum_to_total() {
    // The invariant that replaces a state machine (ADR-0002). Exercised across
    // a mix of operations, because a reconciler that only holds for deposits is
    // not a reconciler.
    let mut v = funded(10_000);
    v.reserve(3_000).unwrap();
    v.release(1_000).unwrap();
    v.reserve(2_000).unwrap();
    v.deposit(500).unwrap();
    assert_eq!(v.available + v.reserved + v.escrowed + v.encumbered + v.settling + v.frozen, v.total);
    v.reconcile().unwrap();
}

#[test]
fn reserve_cannot_exceed_available() {
    let mut v = funded(1_000);
    let err = v.reserve(1_001).unwrap_err();
    assert_eq!(err, solana_program::program_error::ProgramError::Custom(err::INSUFFICIENT_AVAILABLE));
    // And the vault is unchanged — a rejected operation must not half-apply.
    assert_eq!(v.available, 1_000);
    assert_eq!(v.reserved, 0);
    v.reconcile().unwrap();
}

#[test]
fn reserve_at_exactly_available_is_allowed() {
    // The boundary matters: rejecting this would make the vault unable to commit
    // all of its capital, which is a real capability loss.
    let mut v = funded(1_000);
    v.reserve(1_000).unwrap();
    assert_eq!(v.available, 0);
    assert_eq!(v.reserved, 1_000);
    v.reconcile().unwrap();
}

#[test]
fn release_cannot_exceed_reserved() {
    let mut v = funded(1_000);
    v.reserve(500).unwrap();
    assert!(v.release(501).is_err());
    assert_eq!(v.reserved, 500, "a rejected release must not move capital");
    v.reconcile().unwrap();
}

#[test]
fn frozen_vault_refuses_new_reservations() {
    let mut v = funded(1_000);
    v.frozen = 100;
    v.total += 100;
    v.reconcile().unwrap();

    let e = v.reserve(1).unwrap_err();
    assert_eq!(e, solana_program::program_error::ProgramError::Custom(err::VAULT_FROZEN));
    assert_eq!(v.available, 1_000, "a refused reservation must not move capital");
}

#[test]
fn frozen_vault_still_allows_release() {
    // The reason `frozen` is a position and not a status. A freeze that trapped
    // in-flight obligations would be a worse failure than the one it prevents:
    // capital already committed would be stranded by an emergency meant to stop
    // new commitments.
    let mut v = funded(1_000);
    v.reserve(500).unwrap();
    v.frozen = 100;
    v.total += 100;
    v.reconcile().unwrap();

    v.release(500).expect("release must work while frozen");
    assert_eq!(v.reserved, 0);
    assert_eq!(v.available, 1_000);
    v.reconcile().unwrap();
}

#[test]
fn reconciliation_fails_when_positions_disagree_with_total() {
    // The check must be able to fail, or it is not a check.
    let mut v = funded(1_000);
    v.total += 1;
    assert!(v.reconcile().is_err());
}

#[test]
fn serialization_round_trips() {
    let mut v = funded(12_345);
    v.reserve(1_000).unwrap();
    v.escrowed = 500;
    v.total += 500;
    v.reconcile().unwrap();

    let bytes = v.to_bytes();
    assert_eq!(bytes.len(), VAULT_LEN);
    let back = Vault::from_bytes(&bytes).expect("round trip must succeed");
    assert_eq!(v, back);
}

#[test]
fn deserialization_rejects_foreign_accounts() {
    // The discriminator check is load-bearing. A PDA can hold any bytes; without
    // it, an attacker could pass an account they own and have it read as a zeroed
    // Vault — which is exactly the "caller supplies their own state" failure
    // this program exists to prevent.
    let mut foreign = [0u8; VAULT_LEN];
    foreign[0] = 0xAA;
    assert_eq!(
        Vault::from_bytes(&foreign).unwrap_err(),
        solana_program::program_error::ProgramError::Custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH)
    );

    // Wrong length is rejected too, rather than read partially.
    assert!(Vault::from_bytes(&[0u8; 10]).is_err());
}

#[test]
fn deserialization_refuses_a_vault_that_does_not_reconcile() {
    // A structurally valid Vault whose positions do not sum to total was never
    // produced by this program. Loading it would mean trusting forged state.
    //
    // The byte offset matters: `total` is the *seventh* u64, at offset 89, not
    // the final 8 bytes of the buffer. The first version of this test wrote at
    // `len - 8` and silently corrupted part of `available` instead — which still
    // reconciled, so the test failed for the wrong reason and the assertion about
    // forged state was never actually being made.
    const TOTAL_OFFSET: usize = 41 + 6 * 8; // discriminator(8) + authority(32) + bump(1) + 6 fields
    let mut v = funded(1_000);
    let mut bytes = v.to_bytes();
    bytes[TOTAL_OFFSET..TOTAL_OFFSET + 8].copy_from_slice(&(2_000u64).to_le_bytes());
    assert!(
        Vault::from_bytes(&bytes).is_err(),
        "a Vault whose positions do not sum to total must be rejected"
    );
}

#[test]
fn deposit_adds_to_total_and_available_together() {
    // If these moved separately, `total` could drift from the positions and the
    // reconciler would be reporting on fiction.
    let mut v = funded(LAMPORTS);
    v.deposit(LAMPORTS).unwrap();
    assert_eq!(v.total, 2 * LAMPORTS);
    assert_eq!(v.available, 2 * LAMPORTS);
    v.reconcile().unwrap();
}

#[test]
fn large_values_do_not_overflow_silently() {
    // `checked_*` throughout, so a u64::MAX-scale deposit fails loudly rather
    // than wrapping to a small number that still reconciles.
    let mut v = funded(u64::MAX - 1);
    assert!(v.deposit(10).is_err(), "deposit past u64::MAX must fail");
    assert_eq!(v.total, u64::MAX - 1, "a failed deposit must not change total");
}
