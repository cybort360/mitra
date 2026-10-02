//! Phase 3c — the consumable authorization and its refusals (ADR-0009).
//!
//! The security-relevant claims are all *negative*: that a permit cannot be
//! spent twice, cannot be spent for a different action, cannot outlive its
//! mandate, and cannot be inflated by a caller. Positive tests would pass just
//! as well with no guards at all, so most of what follows is about proving the
//! refusals actually refuse.
//!
//! The permit decision is made in-process on `Authorization`, which is where the
//! guards live, so these tests are exact rather than approximate. What in-process
//! tests *cannot* cover — PDA creation, signer privilege, lamport ownership — is
//! covered by the devnet harness instead, and that split is deliberate.

use mitra_vault::anchor_parity::err;
use mitra_vault::state::Authorization;
use solana_program::pubkey::Pubkey;

const NOW: u64 = 1_000_000;

fn action(seed: u8) -> [u8; 32] {
    [seed; 32]
}

fn permit(action_hash: [u8; 32], amount: u64, expires_at: u64) -> Authorization {
    Authorization {
        holder: Pubkey::new_unique(),
        action_hash,
        amount,
        mandate_version: 1,
        expires_at,
        consumed: false,
        bump: 254,
    }
}

#[test]
fn a_fresh_permit_is_spendable_for_its_own_action() {
    let a = action(1);
    assert!(permit(a, 100, NOW + 100).spendable_at(&a, NOW).is_ok());
}

#[test]
fn a_spent_permit_is_refused_as_consumed_not_as_invalid() {
    // The distinction is the point. `AUTHORIZATION_CONSUMED` names a replay;
    // `ACTION_HASH_MISMATCH` would blame the wrong thing and send an integrator
    // looking for a corrupted permit that is perfectly intact.
    let a = action(1);
    let mut p = permit(a, 100, NOW + 100);
    p.consumed = true;
    assert_eq!(
        p.spendable_at(&a, NOW).unwrap_err(),
        err::custom(err::AUTHORIZATION_CONSUMED)
    );
}

#[test]
fn a_permit_is_refused_for_any_other_action() {
    // The core of action-binding. Even a perfectly valid, unspent, unexpired
    // permit dies when the action it names is not the action attempted.
    let p = permit(action(1), 100, NOW + 100);
    assert_eq!(
        p.spendable_at(&action(2), NOW).unwrap_err(),
        err::custom(err::ACTION_HASH_MISMATCH)
    );
}

#[test]
fn a_permit_dies_at_its_expiry_instant() {
    let a = action(1);
    let p = permit(a, 100, NOW);
    assert!(p.spendable_at(&a, NOW - 1).is_ok(), "one second before");
    assert_eq!(
        p.spendable_at(&a, NOW).unwrap_err(),
        err::custom(err::MANDATE_EXPIRED),
        "must be dead AT the instant, not after it"
    );
}

#[test]
fn replay_is_refused_on_the_second_attempt_only() {
    // Models the actual sequence: attempt, consume, attempt again. If the
    // consume step were ever skipped, or the flag written after the value moved,
    // this test is the one that would catch it.
    let a = action(1);
    let mut p = permit(a, 100, NOW + 100);
    assert!(p.spendable_at(&a, NOW).is_ok(), "first attempt succeeds");
    p.consumed = true; // the program sets this as value moves
    assert!(p.spendable_at(&a, NOW).is_err(), "second attempt must fail");
}

#[test]
fn consumed_is_read_as_true_for_any_nonzero_byte() {
    // Corruption must fail *closed*. A stray 0xFF in the flag byte has to read as
    // spent; reading it as unspent would convert memory corruption into value.
    let mut p = permit(action(1), 100, NOW + 100);
    for byte in [1u8, 2, 0x7f, 0xff] {
        let mut bytes = p.to_bytes();
        bytes[96] = byte;
        let loaded = Authorization::try_from_bytes(&bytes).expect("must still parse");
        assert!(loaded.consumed, "byte {byte:#x} must read as consumed");
        assert!(loaded.spendable_at(&p.action_hash, NOW).is_err());
    }
}

#[test]
fn the_amount_lives_in_the_permit_not_the_instruction() {
    // A structural property, asserted as a fact about the type: there is no
    // amount field in the instruction argument, so a caller has nothing to
    // inflate. The handler reads `authorization.amount` and nothing else.
    let a = action(1);
    let p = permit(a, 7, NOW + 100);
    assert_eq!(p.amount, 7);
    // The serialized permit carries the amount; the 32-byte action hash does not
    // displace it.
    let bytes = p.to_bytes();
    assert_eq!(u64::from_le_bytes(bytes[72..80].try_into().unwrap()), 7);
}

#[test]
fn every_field_survives_a_round_trip() {
    let p = permit(action(9), 4_242, NOW + 5_000);
    assert_eq!(p, Authorization::try_from_bytes(&p.to_bytes()).unwrap());
}

#[test]
fn a_truncated_or_foreign_permit_is_refused() {
    let p = permit(action(1), 100, NOW + 100);
    let full = p.to_bytes();
    assert_eq!(full.len(), 98);
    assert!(Authorization::try_from_bytes(&full[..97]).is_err());
    let mut bad = full;
    bad[0] ^= 0xff;
    assert!(Authorization::try_from_bytes(&bad).is_err());
}

#[test]
fn refusals_are_indistinguishable_from_one_another_only_when_they_should_be() {
    // Three refusals, three different causes, three different codes. If two ever
    // collapsed into one, an integrator could not tell a replay from a confused
    // deputy — which is the difference between "retry with a new permit" and
    // "something is wrong, stop."
    let a = action(1);
    let mut consumed = permit(a, 1, NOW + 100);
    consumed.consumed = true;
    let mismatch = permit(a, 1, NOW + 100);
    let expired = permit(a, 1, NOW);

    let codes = [
        consumed.spendable_at(&a, NOW).unwrap_err(),
        mismatch.spendable_at(&action(2), NOW).unwrap_err(),
        expired.spendable_at(&a, NOW).unwrap_err(),
    ];
    let mut sorted = codes.to_vec();
    sorted.sort_by_key(|e| format!("{e:?}"));
    sorted.dedup_by(|x, y| format!("{x:?}") == format!("{y:?}"));
    assert_eq!(sorted.len(), 3, "all three refusals must be distinguishable");
}
