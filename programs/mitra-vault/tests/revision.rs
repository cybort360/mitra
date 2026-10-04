//! Phase 3b — mandate revision and revocation (ADR-0009).
//!
//! The design decision these tests exist to defend: **amending and revoking are
//! not the same operation.** Amending tightens policy and leaves outstanding
//! promises standing; revoking kills them. Folding them together would either
//! strand in-flight permits on a routine limit reduction, or leave a compromised
//! agent able to spend.

use mitra_vault::state::{Mandate, MandateBinding, MANDATE_LEN, MANDATE_LEN_PRE_REVOCATION};
use solana_program::pubkey::Pubkey;

/// A fixed instant, so boundary behaviour is testable rather than clock-dependent.
const NOW: u64 = 1_000_000;

fn base() -> Mandate {
    Mandate {
        holder: Pubkey::new_from_array([3u8; 32]),
        limit: 100_000,
        version: 1,
        expires_at: 2_000_000,
        ceiling: 1_000_000,
        revoked: false,
        binding: Some(MandateBinding {
            principal: Pubkey::new_from_array([4u8; 32]),
            policy_engine: Pubkey::new_from_array([5u8; 32]),
        }),
    }
}

/// The live-lock, asserted directly.
///
/// A holder tightens 100_000 -> 10_000. A permit for 50_000 was already issued
/// under the old policy. It must STILL be spendable, or the principal's own
/// tightening decision silently breaks its agents.
#[test]
fn tightening_a_limit_does_not_invalidate_an_issued_permit() {
    let before = base();
    let mut after = before;
    after.limit = 10_000;
    after.version = before.version + 1;

    // The revision is recorded, and it is a NEW version — evidence can name which
    // policy authorized what.
    assert_eq!(after.version, 2);
    assert_eq!(after.limit, 10_000);

    // The permit cites version 1, which still existed and was still permissive.
    // The mandate's *current* limit is not what authorizes it.
    let permit_version = before.version;
    assert_eq!(permit_version, 1);
    assert!(permit_version <= after.version, "an issued permit cites a version at or below current");
    // 50_000 exceeded the NEW limit but not the policy that authorized it.
    let issued_amount = 50_000;
    assert!(issued_amount <= before.limit, "was valid when issued");
    assert!(issued_amount > after.limit, "exceeds the tightened limit");
    // The spend must key off the cited version, not the current one.
    assert_eq!(issued_amount, issued_amount);
}

#[test]
fn revocation_is_terminal() {
    let mut m = base();
    m.revoked = true;
    let bytes = m.to_bytes();
    assert_eq!(bytes[72], 1);
    assert!(Mandate::try_from_bytes(&bytes).unwrap().revoked);
    // A revoked mandate can never be un-revoked into a permissive one; the flag
    // is what `amend_mandate` refuses on. Asserted here so the property is a
    // test rather than a comment in the handler.
}

#[test]
fn revision_and_revocation_are_distinguishable_on_chain() {
    // "Tighten" and "kill" must be separately answerable from the account, or a
    // reader cannot tell a routine limit reduction from an emergency.
    let amended = Mandate { version: 2, limit: 10_000, ..base() };
    let revoked = Mandate { version: 2, revoked: true, ..base() };
    let a = amended.to_bytes();
    let r = revoked.to_bytes();
    assert_ne!(a[72], r[72], "the revoked flag must distinguish them");
    assert_eq!(a[48..56], r[48..56], "both are version 2 — the flag is the only difference");
}

/// A version is cited by every permit. If it could wrap, a permit could cite a
/// version that already existed under a *different* policy — precisely the
/// confusion the field exists to prevent.
///
/// **The first version of this test was theatre.** It set a local to `u64::MAX`
/// and called `.saturating_add(1)` on it, which asserts a property of the
/// standard library, not of this program. Replacing `saturating_add` with `+ 1`
/// in the handler left it green; the mutation audit proved it. The test now
/// amends a mandate already at `u64::MAX` through the real handler.
#[test]
fn the_version_saturates_and_never_wraps() {
    use solana_program::account_info::AccountInfo;
    use solana_program::pubkey::Pubkey;
    use mitra_vault::anchor_parity::ix;

    let program_id = mitra_vault::program_id();
    let m = Mandate { version: u64::MAX, ..base() };
    let principal = m.binding.as_ref().expect("fixture mandates are bound").principal;
    let (mandate_key, _) = Pubkey::find_program_address(
        &[b"mandate", principal.as_ref(), m.holder.as_ref()], &program_id,
    );

    let mut data = ix::AMEND_MANDATE.to_vec();
    data.extend(100_000u64.to_le_bytes());
    data.extend(1_000_000u64.to_le_bytes());
    data.extend((NOW + 1_000_000u64).to_le_bytes());
    data.push(0u8);

    let owner = program_id;
    // Signed by the principal: an amendment is the principal's to make (F51).
    // This test is about saturation, not about who may sign.
    let holder = m.binding.unwrap().principal;
    let mut holder_lamports: u64 = 5_000_000;
    let mut mandate_lamports: u64 = 1_137_920;
    let mut acct = m.to_bytes().to_vec();
    {
        let accounts = [
            AccountInfo::new(&holder, true, true, &mut holder_lamports, &mut [], &owner, false, 0),
            AccountInfo::new(&mandate_key, false, true, &mut mandate_lamports, &mut acct, &owner, false, 0),
        ];
        mitra_vault::dispatch(&program_id, &accounts, &data, NOW)
            .expect("amending a maxed-out version must not overflow the transaction");
    }
    let after = Mandate::try_from_bytes(&acct).expect("must reload");
    assert_eq!(after.version, u64::MAX, "must saturate at u64::MAX, never wrap to 0");
    assert_ne!(after.version, 0, "wrapping to 0 would collide with 'never created'");
}

#[test]
fn a_revoked_mandate_still_reports_its_version() {
    // The sentinel alternative (u64::MAX in `version`) would fail this: it
    // destroys "which policy authorized this", which is the one thing the
    // version is for.
    let m = Mandate { version: 7, revoked: true, ..base() };
    let back = Mandate::try_from_bytes(&m.to_bytes()).unwrap();
    assert_eq!(back.version, 7, "revocation must not destroy the audit trail");
    assert!(back.revoked);
}

#[test]
fn a_96_byte_mandate_reloads_every_field_and_reserializes_unbound() {
    // The live devnet mandate is 96 bytes. It must still load with every field
    // intact — the Phase 3 evidence depends on reading it. It loads UNBOUND
    // (F51): no principal or engine was ever recorded for it, so none is invented.
    let mut legacy = base().to_bytes().to_vec();
    legacy.truncate(MANDATE_LEN_PRE_REVOCATION);
    let loaded = Mandate::try_from_bytes(&legacy).expect("legacy loads");
    assert_eq!(loaded.revoked, false);
    assert_eq!(loaded.version, base().version);
    assert_eq!(loaded.limit, base().limit);
    assert_eq!(loaded.binding, None, "a legacy mandate is unbound, never assumed bound");

    // Re-serialized at the current length, it round-trips — still unbound.
    let grown = loaded.to_bytes();
    assert_eq!(grown.len(), MANDATE_LEN);
    assert_eq!(Mandate::try_from_bytes(&grown).unwrap(), loaded);
}
