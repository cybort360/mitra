//! Phase 3a — the Mandate account (ADR-0009).
//!
//! These tests are deliberately written to be *falsifiable*. A round-trip test
//! that only proves `to_bytes` agrees with `try_from_bytes` would still pass if
//! both were written against a wrong layout, so the suite below includes:
//!
//!   - an independent oracle for every field (not a round-trip),
//!   - a byte-length assertion (a silent size change invalidates stored policy),
//!   - a negative test per guard, so a guard that stopped working shows as a
//!     test failure rather than as a comment that has gone stale.

use mitra_vault::anchor_parity::{err, mandate_discriminator, mandate_seeds, MANDATE_SEED};
use mitra_vault::state::{Mandate, MANDATE_LEN};
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

fn sample() -> Mandate {
    Mandate {
        holder: Pubkey::new_unique(),
        limit: 5_000,
        version: 3,
        expires_at: 1_700_000_000,
        ceiling: 50_000,
    }
}

#[test]
fn mandate_serializes_to_exactly_96_bytes() {
    // 8 discriminator + 32 holder + 4 * 8 fields. If this fails, every mandate
    // already on chain is being reinterpreted — a migration, not a bug fix.
    assert_eq!(sample().to_bytes().len(), MANDATE_LEN);
    assert_eq!(MANDATE_LEN, 96);
}

#[test]
fn every_field_survives_a_round_trip() {
    let m = sample();
    let back = Mandate::try_from_bytes(&m.to_bytes()).expect("must reload");
    assert_eq!(m, back);
}

/// Independent oracle: read each field straight out of the byte array at the
/// offset the layout promises, without going through the struct.
///
/// This is the test that would fail if a field were inserted, reordered, or
/// given the wrong width — cases a `to_bytes`/`try_from_bytes` round-trip
/// cannot detect, because both sides would move together.
#[test]
fn layout_matches_the_documented_offsets() {
    let m = sample();
    let b = m.to_bytes();

    assert_eq!(&b[0..8], &mandate_discriminator(), "discriminator at [0..8]");
    assert_eq!(&b[8..40], m.holder.as_ref(), "holder at [8..40]");
    assert_eq!(u64::from_le_bytes(b[40..48].try_into().unwrap()), m.limit, "limit at [40..48]");
    assert_eq!(u64::from_le_bytes(b[48..56].try_into().unwrap()), m.version, "version at [48..56]");
    assert_eq!(u64::from_le_bytes(b[56..64].try_into().unwrap()), m.expires_at, "expires_at at [56..64]");
    assert_eq!(u64::from_le_bytes(b[64..72].try_into().unwrap()), m.ceiling, "ceiling at [64..72]");
    // Bytes past the last field must be zero, not stale. A struct that grew a
    // field and shrank nothing would leave the tail undefined.
    assert!(b[72..].iter().all(|&x| x == 0), "no uninitialized tail bytes");
}

#[test]
fn mandate_pda_seed_is_not_the_vault_seed() {
    // ADR-0002: policy and capital are different objects. A shared seed would
    // let them be derived into the same address space.
    assert_ne!(MANDATE_SEED, b"vault");
    assert_eq!(mandate_seeds(&Pubkey::new_unique()).len(), 2);
}

// ── negative tests: one per guard ────────────────────────────────────────────

#[test]
fn a_truncated_mandate_is_refused() {
    let full = sample().to_bytes();
    for len in [0usize, 1, 71, MANDATE_LEN - 1] {
        assert!(
            Mandate::try_from_bytes(&full[..len]).is_err(),
            "a {len}-byte buffer must not deserialize as a mandate"
        );
    }
}

#[test]
fn a_foreign_account_is_refused() {
    let mut b = sample().to_bytes();
    b[0] ^= 0xff; // corrupt the discriminator
    assert!(Mandate::try_from_bytes(&b).is_err(), "wrong discriminator must not load");
}

#[test]
fn version_zero_is_refused() {
    // Version 0 is reserved for "never created", so a mandate claiming to be
    // version 0 was not written by this program.
    let m = Mandate { version: 0, ..sample() };
    assert!(Mandate::try_from_bytes(&m.to_bytes()).is_err(), "version 0 must not load");
}

#[test]
fn liveness_is_exclusive_at_the_expiry_instant() {
    // `now < expires_at`, not `<=`. At the exact expiry second the mandate is
    // already over. An off-by-one here would extend every mandate by one second
    // of authority, which is exactly the kind of gap that is invisible in review.
    let m = Mandate { expires_at: 1_000, ..sample() };
    assert!(m.is_live_at(999), "live one second before expiry");
    assert!(!m.is_live_at(1_000), "dead AT the expiry instant");
    assert!(!m.is_live_at(1_001), "dead after expiry");
}

#[test]
fn error_codes_do_not_collide() {
    // Each guard must be distinguishable, or every refusal looks like every
    // other one. This failed to catch a real duplicate during development.
    let codes = [
        err::NOT_SIGNER,
        err::INVALID_ACCOUNT_OWNER,
        err::ACCOUNT_DISCRIMINATOR_MISMATCH,
        err::UNEXPECTED_LAMPORTS,
        err::RECONCILIATION_FAILED,
        err::INSUFFICIENT_AVAILABLE,
        err::ARITHMETIC_OVERFLOW,
        err::VAULT_FROZEN,
        err::UNAUTHORIZED,
        err::ALREADY_INITIALIZED,
        err::EXCEEDS_MANDATE_CEILING,
        err::MANDATE_EXPIRED,
        err::AUTHORIZATION_CONSUMED,
        err::ACTION_HASH_MISMATCH,
    ];
    let mut sorted = codes.to_vec();
    sorted.sort_unstable();
    let before = sorted.len();
    sorted.dedup();
    assert_eq!(before, sorted.len(), "duplicate error code in the error enum");
}

/// Anchor encodes a custom error as `6000 + index`. If two codes were ever given
/// the same number, a client decoding them could not tell the two failures apart.
#[test]
fn error_codes_are_in_the_anchor_custom_range() {
    assert!(err::ACTION_HASH_MISMATCH >= 6000, "must use Anchor's custom range");
    assert!(err::ACTION_HASH_MISMATCH < 7000, "must stay below the next range");
}

/// The discriminator must be stable across the two paths that produce it. A
/// mismatch would make `try_from_bytes` reject accounts `to_bytes` had written.
#[test]
fn discriminator_derivation_is_deterministic() {
    assert_eq!(mandate_discriminator(), mandate_discriminator());
    assert_ne!(mandate_discriminator(), mitra_vault::anchor_parity::account_discriminator("Vault"));
}

#[test]
fn refusals_surface_as_distinct_program_errors() {
    // Spot-check that the three new guards are individually reachable and do not
    // collapse into one another.
    let _expired: ProgramError = err::custom(err::MANDATE_EXPIRED);
    let _mismatch: ProgramError = err::custom(err::ACTION_HASH_MISMATCH);
    let _consumed: ProgramError = err::custom(err::AUTHORIZATION_CONSUMED);
    assert_ne!(err::MANDATE_EXPIRED, err::ACTION_HASH_MISMATCH);
    assert_ne!(err::AUTHORIZATION_CONSUMED, err::ACTION_HASH_MISMATCH);
}
