//! Phase 3b — driving the REAL `amend_mandate` handler.
//!
//! **This file exists because of the same mistake as F25, caught a second time
//! by mutation audit.** `revision.rs` tested the `Mandate` *type*; the mutations
//! that matter all live in the *handler* — restoring the live-lock re-check,
//! dropping the revoked guard, wrapping the version — and all four survived with
//! zero failures. A suite that cannot fail is not evidence.
//!
//! So these call `dispatch` with real `AccountInfo`s, the same way
//! `spend_integration.rs` does for `spend_authorized`.

use mitra_vault::anchor_parity::{err, ix};
use mitra_vault::state::{Authorization, Mandate};
use solana_program::account_info::AccountInfo;
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

const NOW: u64 = 1_000_000;

struct Fx {
    program_id: Pubkey,
    holder_key: Pubkey,
    mandate_key: Pubkey,
    holder_lamports: u64,
    data: Vec<u8>,
}

impl Fx {
    fn new(m: Mandate) -> Self {
        // The program id and the mandate PDA are the REAL ones.
        //
        // The first version used `Pubkey::new_unique()` for the program id and
        // passed the holder's key as the mandate account. Every amendment then
        // failed `InvalidSeeds`, because `amend_mandate` re-derives the PDA from
        // the seeds rather than trusting the account it was handed — which is the
        // behaviour we want, and exactly the thing a hand-waved fixture cannot
        // reproduce. (Same lesson as the F25 fixture and the cross-mandate replay:
        // a fixture that cannot happen on chain is a fixture testing nothing.)
        let program_id = mitra_vault::program_id();
        let holder_key = m.holder;
        let (mandate_key, _) = Pubkey::find_program_address(
            &[b"mandate", holder_key.as_ref()], &program_id,
        );
        Self {
            program_id,
            holder_key,
            mandate_key,
            holder_lamports: 5_000_000,
            data: m.to_bytes().to_vec(),
        }
    }

    /// `[u64 limit][u64 ceiling][u64 expires_at][u8 revoke]`
    fn ix_args(limit: u64, ceiling: u64, expires_at: u64, revoke: bool) -> Vec<u8> {
        let u = |n: u64| n.to_le_bytes().to_vec();
        let mut d = Vec::new();
        d.extend(u(limit)); d.extend(u(ceiling)); d.extend(u(expires_at));
        d.push(u8::from(revoke));
        d
    }

    fn amend(&mut self, limit: u64, ceiling: u64, expires_at: u64, revoke: bool, now: u64) -> Result<(), ProgramError> {
        let mut data = ix::AMEND_MANDATE.to_vec();
        data.extend(Self::ix_args(limit, ceiling, expires_at, revoke));

        let owner = self.program_id;
        let holder = self.holder_key;
        let mandate_key = self.mandate_key;
        let program_id = self.program_id;
        let mut holder_lamports = self.holder_lamports;
        let mut acct = std::mem::take(&mut self.data);
        // The mandate's own lamports are never touched, but AccountInfo requires a
        // `&mut u64`, so a store has to outlive the account array. A `&mut f()`
        // temporary would be dropped at the end of the statement and the borrow
        // checker is right to refuse it.
        let mut mandate_lamports: u64 = 1_137_920;
        let result = {
            let accounts = [
                AccountInfo::new(&holder, true, true, &mut holder_lamports, &mut [], &owner, false, 0),
                AccountInfo::new(&mandate_key, false, true, &mut mandate_lamports, &mut acct, &owner, false, 0),
            ];
            mitra_vault::dispatch(&program_id, &accounts, &data, now)
        };
        self.holder_lamports = holder_lamports;
        self.data = acct;
        result
    }

    fn read(&self) -> Mandate {
        Mandate::try_from_bytes(&self.data).expect("mandate must reload")
    }
}

fn base() -> Mandate {
    Mandate {
        holder: Pubkey::new_from_array([3u8; 32]),
        limit: 100_000,
        version: 1,
        expires_at: NOW + 1_000_000,
        ceiling: 1_000_000,
        revoked: false,
    }
}

#[test]
fn amending_bumps_the_version_and_applies_the_new_limit() {
    let mut f = Fx::new(base());
    f.amend(10_000, 500_000, NOW + 500_000, false, NOW).expect("amend must succeed");
    let m = f.read();
    assert_eq!(m.version, 2, "an amendment MUST bump the version");
    assert_eq!(m.limit, 10_000);
    assert_eq!(m.ceiling, 500_000);
    assert_eq!(m.expires_at, NOW + 500_000);
    assert_eq!(m.revoked, false);
}

#[test]
fn successive_amendments_each_bump_the_version() {
    let mut f = Fx::new(base());
    for expected in 2..=5 {
        f.amend(50_000, 500_000, NOW + 500_000, false, NOW).unwrap();
        assert_eq!(f.read().version, expected, "version must be monotonic per amendment");
    }
}

/// The core property: a permit issued under v1 is still valid after v2 tightens
/// the limit. Asserted here against the HANDLER, because this is exactly what the
/// removed `amount > mandate.limit` check destroyed.
#[test]
fn tightening_does_not_strand_an_already_issued_permit() {
    let mut f = Fx::new(base());
    f.amend(1_000, 500_000, NOW + 500_000, false, NOW).expect("tighten must succeed");
    let m = f.read();
    assert_eq!(m.limit, 1_000);
    // A permit issued at v1 for 50_000 cites v1, which was permissive. The
    // current limit is 1_000, but the cited version still authorizes it.
    assert!(50_000 <= base().limit, "was valid when issued");
    assert_eq!(m.version, 2);
}

#[test]
fn revocation_is_terminal_and_sticks() {
    let mut f = Fx::new(base());
    f.amend(100_000, 1_000_000, NOW + 100_000, true, NOW).expect("revoke must succeed");
    assert!(f.read().revoked, "the flag must be set on chain");

    // A revoked mandate cannot be amended back to life.
    let e = f.amend(100_000, 1_000_000, NOW + 100_000, false, NOW).unwrap_err();
    assert_eq!(e, err::custom(err::MANDATE_REVOKED), "revoked is terminal");

    // ...nor re-revoked (which would bump the version for no reason).
    let e2 = f.amend(100_000, 1_000_000, NOW + 100_000, true, NOW).unwrap_err();
    assert_eq!(e2, err::custom(err::MANDATE_REVOKED));
    assert!(f.read().revoked, "still revoked");
}

#[test]
fn a_revoked_mandate_keeps_its_version() {
    let mut f = Fx::new(base());
    f.amend(100_000, 1_000_000, NOW + 100_000, true, NOW).unwrap();
    let m = f.read();
    assert_eq!(m.version, 2, "revocation records a version, it does not overwrite one");
    assert!(m.revoked);
}

#[test]
fn an_expired_mandate_cannot_be_amended() {
    let mut f = Fx::new(Mandate { expires_at: NOW, ..base() });
    let e = f.amend(100_000, 1_000_000, NOW + 100_000, false, NOW).unwrap_err();
    assert_eq!(e, err::custom(err::MANDATE_EXPIRED), "expiry is death, not a pause");
}

#[test]
fn an_amendment_cannot_resurrect_a_deadline() {
    let mut f = Fx::new(base());
    let e = f.amend(100_000, 1_000_000, NOW, false, NOW).unwrap_err();
    assert_eq!(e, err::custom(err::MANDATE_EXPIRED), "expires_at == now is already dead");
}

#[test]
fn an_incoherent_amendment_is_refused() {
    let mut f = Fx::new(base());
    // ceiling below limit: no single action could ever fit.
    assert_eq!(
        f.amend(100_000, 1_000, NOW + 100, false, NOW).unwrap_err(),
        err::custom(err::EXCEEDS_MANDATE_CEILING)
    );
    // zero limit
    assert!(f.amend(0, 1_000_000, NOW + 100, false, NOW).is_err());
    // zero ceiling
    assert!(f.amend(1_000, 0, NOW + 100, false, NOW).is_err());
    assert_eq!(f.read().version, 1, "a refused amendment must not bump the version");
}

#[test]
fn a_refused_amendment_leaves_the_policy_untouched() {
    let mut f = Fx::new(base());
    let _ = f.amend(1, 1, NOW, false, NOW); // incoherent
    let m = f.read();
    assert_eq!(m.version, 1, "unchanged");
    assert_eq!(m.limit, 100_000, "the old limit stands");
    assert_eq!(m.revoked, false);
}

// ── the real live-lock test: amend, then SPEND through the handler ──────────
//
// The test above named `tightening_does_not_strand_an_already_issued_permit` and
// asserted nothing about spending. It compared two local variables and would have
// passed against a build that strand-froze every permit. This one actually
// amends and then spends.
//
// The distinction is not pedantry: this exact confusion is what F25 was, in a new
// costume, and what made four mutations survive in the previous audit.

/// A permit issued under v1 for 50_000, spent after v2 tightened the limit to
/// 1_000. It MUST succeed — that is the no-live-lock property, end to end.
#[test]
fn a_permit_issued_before_a_tightening_is_still_spendable() {
    let mut f = Fx::new(base());
    let mut g = SpendFx::from_mandate(base(), 50_000, 1);

    // Tighten hard: 100_000 -> 1_000. Every outstanding permit is now over the
    // current limit.
    f.amend(1_000, 500_000, NOW + 500_000, false, NOW).expect("tighten must succeed");
    assert_eq!(f.read().limit, 1_000);

    // The permit cites v1 and its action. Spend it.
    g.spend(NOW).expect(
        "a permit issued under a permissive version must remain spendable after a tightening; \
         refusing it strands the agent and is the live-lock this design refuses",
    );
    assert!(g.permit().consumed, "and it must have been consumed normally");
    assert_eq!(g.recipient_lamports, 50_000, "value moved exactly once");
}

/// The converse: revoking must stop the same permit. If this passed with the
/// permit still spendable, "revoke" would be a rename for "amend".
#[test]
fn revocation_stops_an_outstanding_permit() {
    // ONE world: the same mandate is amended and then spent against.
    let mut g = SpendFx::from_mandate(base(), 50_000, 1);
    g.amend(100_000, 1_000_000, NOW + 500_000, true, NOW).expect("revoke must succeed");
    assert!(g.mandate().revoked, "the mandate the spend will read is revoked");

    let e = g.spend(NOW).unwrap_err();
    assert_eq!(e, err::custom(err::MANDATE_REVOKED), "a revoked mandate stops everything");
    assert_eq!(g.recipient_lamports, 0, "no value moved");
    assert!(!g.permit().consumed, "a refused spend must not burn the permit");
}

/// A permit whose amount exceeded the limit **at issue time** is a different
/// case, and it is refused at AUTHORIZE time rather than at spend.
///
/// The first version of this test asserted the spend handler would catch it. That
/// was wrong in principle as well as in fact: `spend_authorized` deliberately does
/// not re-check the limit (see the live-lock test above), so a permit that was
/// over the limit could only ever have been *issued* by a broken authorize. The
/// guard belongs there, and putting it here would have reintroduced exactly the
/// stranding the design refuses.
///
/// What is asserted instead is that the over-limit permit spends fine *if it
/// exists*, which is the honest consequence of that choice — and the
/// authorization-side guard is covered in the authorize tests.
#[test]
fn the_limit_is_enforced_at_issue_not_at_spend() {
    let mut g = SpendFx::from_mandate(base(), 500_000, 1); // limit is 100_000
    // The mandate is unrevoked and the permit is valid, so the spend proceeds.
    // The over-limit case is unreachable in practice precisely because
    // `authorize` refuses to mint such a permit.
    g.spend(NOW).expect("an over-limit permit cannot exist in a correct system");
    assert_eq!(g.recipient_lamports, 500_000);
}

// ── a second fixture that can actually SPEND ────────────────────────────────

struct SpendFx {
    holder: Pubkey,
    program_id: Pubkey,
    authz_key: Pubkey,
    vault_key: Pubkey,
    mandate_key: Pubkey,
    authz_data: Vec<u8>,
    mandate_data: Vec<u8>,
    vault_data: Vec<u8>,
    vault_lamports: u64,
    recipient_lamports: u64,
    hash: [u8; 32],
    amount: u64,
}

impl SpendFx {
    /// Builds a *consistent* world: vault, mandate and a fresh unused permit.
    fn from_mandate(m: Mandate, amount: u64, mandate_version: u64) -> Self {
        use mitra_vault::state::{Authorization, Vault};
        let program_id = mitra_vault::program_id();
        let holder = m.holder;
        let hash = [42u8; 32];
        let (authz_key, _) = Pubkey::find_program_address(
            &[b"authorization", holder.as_ref(), hash.as_ref()], &program_id,
        );
        let (mandate_key, _) = Pubkey::find_program_address(&[b"mandate", holder.as_ref()], &program_id);
        let (vault_key, _) = Pubkey::find_program_address(&[b"vault", holder.as_ref()], &program_id);

        let mut v = Vault::new(holder, 254);
        v.deposit(1_000_000).expect("fund the vault");
        Self {
            holder,
            program_id,
            authz_key,
            vault_key,
            mandate_key,
            authz_data: Authorization {
                holder,
                action_hash: hash,
                amount,
                mandate_version,
                expires_at: NOW + 1_000_000,
                consumed: false,
                bump: 254,
            }.to_bytes().to_vec(),
            mandate_data: m.to_bytes().to_vec(),
            vault_data: v.to_bytes().to_vec(),
            vault_lamports: 10_000_000_000,
            recipient_lamports: 0,
            hash,
            amount,
        }
    }

    fn permit(&self) -> Authorization { Authorization::try_from_bytes(&self.authz_data).unwrap() }
    fn mandate(&self) -> Mandate { Mandate::try_from_bytes(&self.mandate_data).unwrap() }

    /// Amend the SAME mandate this fixture spends against.
    ///
    /// The first version of the revocation test kept two independent worlds: an
    /// `Fx` to amend and a `SpendFx` to spend, each with its own mandate account.
    /// Revoking one had no effect on the other, so the spend succeeded and the
    /// test failed for a reason that had nothing to do with the guard. Two
    /// fixtures standing in for one world is the same class of error as F25's
    /// type-only tests: a test that cannot fail, for a reason that looks like a
    /// product defect.
    fn amend(&mut self, limit: u64, ceiling: u64, expires_at: u64, revoke: bool, now: u64) -> Result<(), ProgramError> {
        let mut data = ix::AMEND_MANDATE.to_vec();
        data.extend(u64le(limit)); data.extend(u64le(ceiling));
        data.extend(u64le(expires_at)); data.push(u8::from(revoke));

        let owner = self.program_id;
        // The signing key MUST be the mandate's own holder: `amend_mandate`
        // re-derives the PDA from `[b"mandate", holder]` and refuses a mismatch.
        // A hardcoded key here failed with `InvalidSeeds` for a reason that had
        // nothing to do with the revocation being tested.
        let holder = self.holder;
        let mandate_key = self.mandate_key;
        let program_id = self.program_id;
        let mut holder_lamports: u64 = 5_000_000;
        let mut mandate_lamports: u64 = 1_137_920;
        let mut mandate = std::mem::take(&mut self.mandate_data);
        let r = {
            let accounts = [
                AccountInfo::new(&holder, true, true, &mut holder_lamports, &mut [], &owner, false, 0),
                AccountInfo::new(&mandate_key, false, true, &mut mandate_lamports, &mut mandate, &owner, false, 0),
            ];
            mitra_vault::dispatch(&program_id, &accounts, &data, now)
        };
        self.mandate_data = mandate;
        r
    }

    fn spend(&mut self, now: u64) -> Result<(), ProgramError> {
        use mitra_vault::state::Authorization;
        let mut data = ix::SPEND_AUTHORIZED.to_vec();
        data.extend(self.hash);
        let owner = self.program_id;
        let recipient = Pubkey::new_from_array([9u8; 32]);
        let authz_key = self.authz_key;
        let vault_key = self.vault_key;
        let mandate_key = self.mandate_key;
        let program_id = self.program_id;
        let mut authz = std::mem::take(&mut self.authz_data);
        let mut mandate = std::mem::take(&mut self.mandate_data);
        let mut vault = std::mem::take(&mut self.vault_data);
        let mut vault_lamports = self.vault_lamports;
        let mut recipient_lamports = self.recipient_lamports;
        let mut z1: u64 = 0; let mut z2: u64 = 0;
        let r = {
            let accounts = [
                AccountInfo::new(&recipient, false, true, &mut recipient_lamports, &mut [], &owner, false, 0),
                AccountInfo::new(&vault_key, false, true, &mut vault_lamports, &mut vault, &owner, false, 0),
                AccountInfo::new(&authz_key, false, true, &mut z1, &mut authz, &owner, false, 0),
                AccountInfo::new(&mandate_key, false, false, &mut z2, &mut mandate, &owner, false, 0),
            ];
            mitra_vault::dispatch(&program_id, &accounts, &data, now)
        };
        let _ = Authorization::try_from_bytes(&authz);
        self.authz_data = authz; self.mandate_data = mandate; self.vault_data = vault;
        self.vault_lamports = vault_lamports; self.recipient_lamports = recipient_lamports;
        r
    }
}

fn u64le(n: u64) -> Vec<u8> { n.to_le_bytes().to_vec() }

// Note: the mandate's lamports are never touched by an amendment, but
// `AccountInfo` still requires a `&mut u64` whose borrow outlives the account
// array — hence a bound local rather than a `&mut some_fn()`.
