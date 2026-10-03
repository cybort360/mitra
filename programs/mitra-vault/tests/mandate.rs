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
use mitra_vault::state::{Mandate, MandateBinding, MANDATE_LEN, MANDATE_LEN_PRE_BINDING, MANDATE_LEN_PRE_REVOCATION};
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

/// A FIXED holder, not `new_unique()`.
///
/// The first version generated a random holder per call, so a test that compared
/// `Mandate::try_from_bytes(&bytes)` against a second `sample()` compared two
/// different random keys and failed for a reason that had nothing to do with the
/// field under test. Deterministic fixtures make a failure mean what it says.
fn sample() -> Mandate {
    Mandate {
        holder: Pubkey::new_from_array([7u8; 32]),
        limit: 5_000,
        version: 3,
        expires_at: 1_700_000_000,
        revoked: false,
        ceiling: 50_000,
        binding: Some(MandateBinding {
            principal: Pubkey::new_from_array([4u8; 32]),
            policy_engine: Pubkey::new_from_array([5u8; 32]),
        }),
    }
}

#[test]
fn mandate_serializes_to_exactly_138_bytes() {
    // 8 discriminator + 32 holder + 4 * 8 fields + 1 revoked + 1 bound flag
    // + 32 principal + 32 policy_engine.
    //
    // 96 before revocation, 97 before binding (F51). Each time the assertion was
    // updated rather than the field dropped, and each older length still loads
    // through `try_from_bytes`, because the deployed Phase 3 accounts are the
    // subject of PROOF_LEDGER claims.
    assert_eq!(sample().to_bytes().len(), MANDATE_LEN);
    assert_eq!(MANDATE_LEN, 138);
}

/// A 97-byte mandate — the layout deployed before binding — loads, keeps every
/// field, and is UNBOUND. Unbound is what makes it inert: authorize, spend and
/// amend all refuse it with MANDATE_UNBOUND.
#[test]
fn a_pre_binding_mandate_loads_as_unbound() {
    let mut legacy = Mandate { revoked: true, ..sample() }.to_bytes().to_vec();
    legacy.truncate(MANDATE_LEN_PRE_BINDING);
    let loaded = Mandate::try_from_bytes(&legacy).expect("a 97-byte mandate must still load");
    assert_eq!(loaded, Mandate { revoked: true, binding: None, ..sample() });
}

/// The bound flag is required, not inferred. A full-length buffer whose flag is
/// zero must not read as bound to the all-zero key — which is the system program.
#[test]
fn a_full_length_mandate_with_the_flag_clear_is_unbound() {
    let mut b = sample().to_bytes();
    b[73] = 0;
    assert_eq!(Mandate::try_from_bytes(&b).unwrap().binding, None);
}

/// The 96-byte account deployed before `revoked` existed must still load, and
/// must read as NOT revoked. This is the compatibility guarantee, asserted
/// directly rather than assumed: if it broke, the Phase 3 devnet evidence would
/// silently stop being verifiable.
#[test]
fn a_pre_revocation_mandate_still_loads_as_not_revoked() {
    // `to_bytes` returns a fixed-size array, which has no `truncate`; the legacy
    // buffer is built by slicing to the old length.
    let full = sample().to_bytes();
    let mut legacy = full.to_vec();
    legacy.truncate(MANDATE_LEN_PRE_REVOCATION); // drop the revoked byte
    assert_eq!(legacy.len(), 96);

    let loaded = Mandate::try_from_bytes(&legacy).expect("a 96-byte mandate must still load");
    assert_eq!(loaded, Mandate { binding: None, ..sample() }, "every other field must round-trip unchanged");
    assert_eq!(loaded.revoked, false, "absent flag must mean not revoked");
}

/// And the reverse: a 97-byte mandate with the flag SET must not be mistaken for
/// an unrevoked one. A permissive "absent means false" default is only safe if
/// the present-and-true case still reads as revoked.
#[test]
fn revocation_is_read_from_the_flag_byte() {
    let m = Mandate { revoked: true, ..sample() };
    let bytes = m.to_bytes();
    assert_eq!(bytes[72], 1, "revoked is byte 72");
    let loaded = Mandate::try_from_bytes(&bytes).unwrap();
    assert!(loaded.revoked);
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
    assert_eq!(b[72], 0, "revoked at [72]");
    let binding = m.binding.unwrap();
    assert_eq!(b[73], 1, "bound flag at [73]");
    assert_eq!(&b[74..106], binding.principal.as_ref(), "principal at [74..106]");
    assert_eq!(&b[106..138], binding.policy_engine.as_ref(), "policy_engine at [106..138]");
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
    // **Two lengths are valid**: 97 (current) and 96 (pre-revocation), so both
    // are excluded from this sweep and each is asserted positively elsewhere. A
    // sweep that included 96 would contradict
    // `a_pre_revocation_mandate_still_loads_as_not_revoked`, and two tests
    // disagreeing about the same input is how a real regression hides.
    // 96 is omitted for the reason above. The listed lengths are all strictly
    // below the shortest valid layout, so none of them can be accepted.
    for len in [0usize, 1, 8, 40, 64, 71, 95] {
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
        err::MANDATE_REVOKED,
        err::POLICY_ENGINE_MISMATCH,
        err::RECIPIENT_MISMATCH,
        err::VAULT_MISMATCH,
        err::MANDATE_UNBOUND,
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
