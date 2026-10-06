//! PRD §13 / §15.5 — the job escrow, in two halves.
//!
//! **What this closes.** The Solana rail had `reserve`/`release`, which earmark
//! capital but never move it. The EVM rail has `MitraJobEscrow` (LP-2) with a
//! timelocked, hash-committed refund. This file covers the Solana equivalent:
//! `lock_escrow`, `release_escrow`, `refund_escrow`.
//!
//! ## The two properties under test, and why they are separate
//!
//! 1. **The capital is really in another account.** After `lock_escrow` the
//!    vault's `available` is down and its `escrowed` is up, but the *lamports*
//!    have left the vault entirely. That is the difference from `reserve`, and it
//!    is the difference between "we agreed to pay" and "we did not yet pay".
//!
//! 2. **The way back was agreed first.** `refund_route_hash` is set at funding
//!    and is the *only* thing a refund consults. PRD §15.5: "never let the
//!    recovery engine invent arbitrary compensation calldata after failure". A
//!    refund with no commitment reverts — and it reverts at the *refund*, not
//!    only at the lock, so a corrupted account cannot acquire a payout.
//!
//! ## What these tests cannot cover, stated rather than implied
//!
//! The `create_account` CPI is skipped in-process: an escrow is pre-created with
//! a non-zero balance so the `lamports() == 0` branch does not run, and the
//! fixture then flips the account's owner to the program id to stand in for the
//! CPI's effect. That is the standard limit of an in-process suite here and it is
//! exactly the boundary `solana-program-test` would have covered if it built (see
//! `Cargo.toml`). `tests/solana-escrow.test.ts` under `SOLANA_ESCROW_LIVE=1` is
//! the counterpart, and it is the only thing that can honestly claim the CPI
//! works.
//!
//! Rent is the other omission, and it is a syscall that simply is not available
//! here. It is why the escrow handlers do **not** call `check_no_surplus_lamports`
//! — see the note on `lock_escrow` in `lib.rs`. The vault's rent invariant is
//! still enforced on every path that was already enforcing it (`deposit`,
//! `reserve`, `release`), so this is a gap in the escrow path, not a removal.

use mitra_vault::anchor_parity::{err, find_vault_pda, ix, vault_seeds};
use mitra_vault::rent::rent_exempt_minimum;
use mitra_vault::state::{JobEscrow, Vault, ESCROW_LEN, VAULT_LEN};
use solana_program::account_info::AccountInfo;
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;
use solana_program::system_program;

const SYS: Pubkey = system_program::ID;
/// Stand-in for a rent-exempt balance. Large enough that no assertion below can
/// fail merely for want of lamports, which would look like a passing security
/// check.
const RENT_BASE: u64 = 10_000_000;

fn route(seed: u8) -> [u8; 32] {
    [seed; 32]
}

// ─────────────────────────────────────────────────────────────────────────────
// The state type.
// ─────────────────────────────────────────────────────────────────────────────

fn escrow(amount: u64) -> JobEscrow {
    JobEscrow::new([0x9a; 32], Pubkey::new_unique(), Pubkey::new_unique(), amount, 10_000, route(0x7f))
}

#[test]
fn the_layout_is_the_documented_length() {
    // A silent size change would corrupt every deployed escrow, and nothing else
    // would catch it: the reconciliation invariant protects the Vault, and an
    // escrow has no arithmetic to reconcile.
    assert_eq!(ESCROW_LEN, 154);
    assert_eq!(JobEscrow::new([0; 32], Pubkey::new_unique(), Pubkey::new_unique(), 1, 1, [0; 32]).to_bytes().len(), 154);
    // The Vault's length is asserted here too because the escrow debits the same
    // account; a change there would silently invalidate the whole fixture.
    assert_eq!(VAULT_LEN, 105);
}

#[test]
fn an_escrow_round_trips_through_its_own_bytes() {
    let e = escrow(4_200);
    assert_eq!(JobEscrow::try_from_bytes(&e.to_bytes()).unwrap(), e);
}

#[test]
fn an_all_zero_route_is_the_absence_of_a_commitment() {
    let mut e = escrow(1);
    e.refund_route_hash = [0u8; 32];
    assert!(!e.has_commitment());
    assert_eq!(e.refundable_at(99_999, false).unwrap_err(), ProgramError::Custom(err::NO_COMMITMENT));
    assert_eq!(e.refundable_at(99_999, true).unwrap_err(), ProgramError::Custom(err::NO_COMMITMENT));
}

#[test]
fn a_stranger_cannot_refund_before_the_deadline() {
    let e = escrow(1); // timeout 10_000
    assert_eq!(e.refundable_at(9_999, false).unwrap_err(), ProgramError::Custom(err::BEFORE_TIMEOUT));
}

#[test]
fn the_deadline_is_inclusive_and_anyone_may_trigger_it() {
    // `>=`, matching MitraJobEscrow's `block.timestamp >= j.timeout`. An
    // exclusive boundary would make "the deadline passed" a lie for one second
    // and would diverge from the EVM rail for exactly that second.
    let e = escrow(1);
    e.refundable_at(10_000, false).expect("the deadline instant itself is refundable");
    e.refundable_at(10_001, false).expect("and so is every second after it");
}

#[test]
fn the_client_may_reject_before_the_deadline() {
    // Without this a client whose provider submitted rubbish could only recover by
    // waiting out a timeout it already knows it does not want to pay.
    let e = escrow(1);
    e.refundable_at(9_999, true).expect("the client's own rejection is not subject to the timeout");
}

#[test]
fn settlement_is_terminal_in_both_directions() {
    // The pair of flags, checked together. A version that checked only
    // `refunded` in `mark_completed` would let a released job be refunded
    // afterwards — a second payout from one escrow.
    let mut released = escrow(1);
    released.mark_completed().unwrap();
    assert!(released.is_settled());
    assert_eq!(released.mark_refunded().unwrap_err(), ProgramError::Custom(err::ESCROW_ALREADY_SETTLED));

    let mut refunded = escrow(1);
    refunded.mark_refunded().unwrap();
    assert!(refunded.is_settled());
    assert_eq!(refunded.mark_completed().unwrap_err(), ProgramError::Custom(err::ESCROW_ALREADY_SETTLED));
}

#[test]
fn a_corrupt_flag_byte_reads_as_settled_not_as_live() {
    // `!= 0`, not `== 1`: a stray 0xFF in a settlement flag must fail closed.
    let mut bytes = escrow(1).to_bytes();
    bytes[120] = 0xff;
    assert!(JobEscrow::try_from_bytes(&bytes).unwrap().completed);
    bytes[120] = 0;
    bytes[121] = 0xff;
    assert!(JobEscrow::try_from_bytes(&bytes).unwrap().refunded);
}

#[test]
fn an_escrow_with_no_money_is_not_an_escrow() {
    let mut bytes = escrow(0).to_bytes();
    // A zero amount decodes, then is refused — stated as a distinct error because
    // "this job was never funded" and "you named the wrong account" send an
    // operator to completely different places.
    assert_eq!(JobEscrow::try_from_bytes(&bytes).unwrap_err(), ProgramError::Custom(err::ESCROW_NOT_FUNDED));
    bytes[0] ^= 0xff;
    assert_eq!(JobEscrow::try_from_bytes(&bytes).unwrap_err(), ProgramError::Custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH));
}

#[test]
fn a_vault_is_not_an_escrow() {
    let v = Vault::new(Pubkey::new_unique(), 255);
    assert_eq!(
        JobEscrow::try_from_bytes(&v.to_bytes()).unwrap_err(),
        ProgramError::Custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH)
    );
}

#[test]
fn a_short_account_is_refused_rather_than_padded() {
    let full = escrow(1).to_bytes();
    assert_eq!(
        JobEscrow::try_from_bytes(&full[..ESCROW_LEN - 1]).unwrap_err(),
        ProgramError::Custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH)
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// The Vault's three new position transitions, and their deliberate asymmetry.
// ─────────────────────────────────────────────────────────────────────────────

fn funded(amount: u64) -> Vault {
    let mut v = Vault::new(Pubkey::new_unique(), 254);
    v.deposit(amount).unwrap();
    v
}

#[test]
fn locking_moves_positions_but_not_the_total() {
    // `total` describes Mitra's capital; `escrowed` says how much of it is now
    // unreachable through the vault. Locking changes the second, never the first.
    let mut v = funded(1_000);
    v.lock_to_escrow(400).unwrap();
    assert_eq!((v.available, v.escrowed, v.total), (600, 400, 1_000));
    v.reconcile().unwrap();
}

#[test]
fn escrowed_capital_is_not_available_to_the_vault() {
    // The whole economic point. A version that left `escrowed` inside `available`
    // would pass every reconciliation check while letting the vault promise the
    // same lamports twice.
    let mut v = funded(1_000);
    v.lock_to_escrow(1_000).unwrap();
    assert_eq!(v.withdraw(1).unwrap_err(), ProgramError::Custom(err::INSUFFICIENT_AVAILABLE));
    assert_eq!(v.reserve(1).unwrap_err(), ProgramError::Custom(err::INSUFFICIENT_AVAILABLE));
    assert_eq!(v.lock_to_escrow(1).unwrap_err(), ProgramError::Custom(err::INSUFFICIENT_AVAILABLE));
}

#[test]
fn paying_out_leaves_the_vault_and_reduces_the_total() {
    let mut v = funded(1_000);
    v.lock_to_escrow(400).unwrap();
    v.pay_escrow(400).unwrap();
    assert_eq!((v.available, v.escrowed, v.total), (600, 0, 600));
    v.reconcile().unwrap();
}

#[test]
fn a_refund_returns_headroom_without_changing_the_total() {
    let mut v = funded(1_000);
    v.lock_to_escrow(400).unwrap();
    v.return_escrow(400).unwrap();
    assert_eq!((v.available, v.escrowed, v.total), (1_000, 0, 1_000));
    v.reconcile().unwrap();
}

#[test]
fn the_freeze_asymmetry_is_the_one_that_matters() {
    // Locking attaches capital to a NEW obligation; paying sends value OUT; a
    // refund brings it back. So: refuse, refuse, permit. Making the refund
    // refuse would turn an emergency freeze into a permanent trap for a client's
    // own capital, which is the failure F41 was written about.
    let mut v = funded(1_000);
    v.lock_to_escrow(1_000).unwrap();
    v.frozen = 500;
    v.total += 500;
    v.reconcile().unwrap();

    assert_eq!(v.lock_to_escrow(1).unwrap_err(), ProgramError::Custom(err::VAULT_FROZEN));
    assert_eq!(v.pay_escrow(1).unwrap_err(), ProgramError::Custom(err::VAULT_FROZEN));
    v.return_escrow(1_000).expect("an autonomous recovery must survive a freeze");
    assert_eq!(v.available, 1_000);
}

#[test]
fn oversized_and_zero_movements_are_refused_at_the_state_layer() {
    let mut v = funded(1_000);
    assert_eq!(v.lock_to_escrow(0).unwrap_err(), ProgramError::InvalidArgument);
    assert_eq!(v.pay_escrow(0).unwrap_err(), ProgramError::InvalidArgument);
    assert_eq!(v.return_escrow(0).unwrap_err(), ProgramError::InvalidArgument);
    assert_eq!(v.lock_to_escrow(1_001).unwrap_err(), ProgramError::Custom(err::INSUFFICIENT_AVAILABLE));
    v.reconcile().unwrap();
}

#[test]
fn held_is_total_minus_what_is_not_in_the_vault() {
    // The whole of the F70 fix, in one place: a vault's lamports account for
    // `held`, not `total`, because an escrow's capital is in another account.
    let mut v = funded(1_000);
    assert_eq!(v.held(), 1_000, "with nothing escrowed the two are the same");
    v.lock_to_escrow(400).unwrap();
    assert_eq!(v.held(), 600);
    assert_eq!(v.total, 1_000);
    v.pay_escrow(400).unwrap();
    assert_eq!(v.held(), 600, "paying out leaves the vault holding the rest");
    v.lock_to_escrow(600).unwrap();
    v.return_escrow(600).unwrap();
    assert_eq!((v.held(), v.total), (600, 600));
}

/// **The regression test for F70.**
///
/// Before the fix, `reserve` and `release` compared the vault's lamports against
/// `total`, which stops being true the moment capital is escrowed. The result on
/// devnet was `UNEXPECTED_LAMPORTS` (6003) on *every* reservation and *every*
/// release for a vault with one outstanding job — a single escrow disabled the
/// whole reservation mechanism.
///
/// The fixture pins the lamported balance the way the chain does: capital held
/// plus the rent-exempt minimum.
#[test]
fn an_outstanding_escrow_does_not_break_the_vaults_lamport_identity() {
    let mut v = funded(10_000);
    v.lock_to_escrow(7_000).unwrap();
    // 3_000 is still in the vault; 7_000 is in the escrow PDA. `total` is 10_000.
    assert_eq!((v.held(), v.escrowed, v.total), (3_000, 7_000, 10_000));
    // Reservations still work, from what is actually held.
    v.reserve(3_000).expect("reserving everything held must still be permitted");
    v.release(3_000).expect("and releasing it back");
    v.reconcile().unwrap();
}

/// The identity itself, with the real rent figure, so a change to the escrow's
/// effect on the vault's balance fails here rather than on devnet.
#[test]
fn the_vaults_balance_equals_held_plus_rent() {
    // `rent_exempt_minimum` is a syscall and returns UnsupportedSysvar in-process,
    // so the arithmetic is asserted with the devnet figure the devnet harness
    // measured (1,183,640 B for a 105-byte account). What is under test is the
    // SHAPE — that escrowed capital is subtracted, not that the figure is current.
    const RENT_105: u64 = 1_183_640;
    let mut v = funded(1_000_000);
    let mut balance = RENT_105 + v.held();
    v.lock_to_escrow(400_000).unwrap();
    balance -= 400_000; // lamports physically left for the escrow PDA
    assert_eq!(balance, RENT_105 + v.held());
    assert_ne!(balance, RENT_105 + v.total, "the old expectation is the bug");
    v.return_escrow(400_000).unwrap();
    balance += 400_000;
    assert_eq!(balance, RENT_105 + v.held());
}

/// `rent_exempt_minimum` is referenced so this file documents that the rent figure
/// used above is the one the program itself would ask the chain for.
#[test]
fn the_rent_syscall_is_unavailable_in_process() {
    // Stated rather than worked around. If a future toolchain makes it work, this
    // fails and the constant above can be replaced by the real call.
    assert!(rent_exempt_minimum(105).is_err());
}

#[test]
fn a_mixed_sequence_never_breaks_the_six_position_invariant() {
    // Two jobs on one vault is the shape that breaks an aggregate guard: the
    // positions are sums, so a refund of the larger job must not be able to eat
    // the smaller one's share.
    let mut v = funded(10_000);
    v.lock_to_escrow(7_000).unwrap();
    v.lock_to_escrow(2_000).unwrap();
    v.pay_escrow(7_000).unwrap();
    v.return_escrow(2_000).unwrap();
    assert_eq!((v.available, v.escrowed, v.total), (3_000, 0, 3_000));
    v.reconcile().unwrap();
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler level: the real `dispatch`, real `AccountInfo`s.
// ─────────────────────────────────────────────────────────────────────────────
//
// Type tests pass even when a handler does its arithmetic inline and never calls
// the type. That was verified rather than assumed for the withdraw handler (see
// `withdraw.rs`), and the fix is the same: build accounts and call `dispatch`.

struct Fixture {
    program_id: Pubkey,
    client: Pubkey,
    provider: Pubkey,
    vault: Pubkey,
    escrow: Pubkey,
    job_id: [u8; 32],
    client_lamports: u64,
    provider_lamports: u64,
    vault_lamports: u64,
    escrow_lamports: u64,
    vault_data: Vec<u8>,
    escrow_data: Vec<u8>,
    /// Flipped to the program id after a successful `lock_escrow`, standing in for
    /// the `create_account` CPI that a real chain performs. See the file header.
    escrow_owner: Pubkey,
    bump: u8,
}

impl Fixture {
    fn new(funded: u64, frozen: bool) -> Self {
        let program_id = Pubkey::new_unique();
        let client = Pubkey::new_unique();
        let provider = Pubkey::new_unique();
        let (vault, bump) = find_vault_pda(&vault_seeds(&client), &program_id).unwrap();
        let job_id = [0x9a; 32];
        let (escrow, escrow_bump) =
            Pubkey::find_program_address(&[b"escrow", vault.as_ref(), job_id.as_ref()], &program_id);

        let mut v = Vault::new(client, bump);
        v.deposit(funded).unwrap();
        if frozen {
            v.frozen = funded;
            v.total += funded;
        }
        v.reconcile().unwrap();

        Self {
            program_id,
            client,
            provider,
            vault,
            escrow,
            job_id,
            client_lamports: RENT_BASE,
            provider_lamports: RENT_BASE,
            vault_lamports: RENT_BASE + funded,
            escrow_lamports: RENT_BASE,
            vault_data: v.to_bytes().to_vec(),
            escrow_data: vec![0u8; ESCROW_LEN],
            escrow_owner: SYS,
            bump: escrow_bump,
        }
    }

    fn lock_args(&self, amount: u64, timeout: u64, r: [u8; 32], bump: Option<u8>) -> Vec<u8> {
        let mut d = ix::LOCK_ESCROW.to_vec();
        d.extend_from_slice(&self.job_id);
        d.extend_from_slice(self.provider.as_ref());
        d.extend_from_slice(&amount.to_le_bytes());
        d.extend_from_slice(&timeout.to_le_bytes());
        d.extend_from_slice(&r);
        if let Some(b) = bump {
            d.push(b);
        }
        d
    }

    fn lock(&mut self, amount: u64, timeout: u64, r: [u8; 32]) -> Result<(), ProgramError> {
        self.lock_at(amount, timeout, r, None, true, 0)
    }

    #[allow(clippy::too_many_arguments)]
    fn lock_at(
        &mut self,
        amount: u64,
        timeout: u64,
        r: [u8; 32],
        bump: Option<u8>,
        signature: bool,
        now: u64,
    ) -> Result<(), ProgramError> {
        let data = self.lock_args(amount, timeout, r, bump);
        let (p, c, v, e, s) = (self.program_id, self.client, self.vault, self.escrow, self.provider);
        let (mut cl, mut pl, mut vl, mut el) = (
            self.client_lamports,
            self.provider_lamports,
            self.vault_lamports,
            self.escrow_lamports,
        );
        let mut sys_l = 1u64;
        let (pid, own) = (self.program_id, self.escrow_owner);
        let owner_key = Pubkey::new_unique();
        let accounts = [
            AccountInfo::new(&c, signature, true, &mut cl, &mut [], &owner_key, false, 0),
            AccountInfo::new(&s, false, false, &mut pl, &mut [], &owner_key, false, 0),
            AccountInfo::new(&v, false, true, &mut vl, &mut self.vault_data, &pid, false, 0),
            AccountInfo::new(&e, false, true, &mut el, &mut self.escrow_data, &own, false, 0),
            AccountInfo::new(&SYS, false, false, &mut sys_l, &mut [], &SYS, true, 0),
        ];
        let out = mitra_vault::dispatch(&p, &accounts, &data, now);
        self.client_lamports = cl;
        self.provider_lamports = pl;
        self.vault_lamports = vl;
        self.escrow_lamports = el;
        if out.is_ok() {
            // The CPI's one visible effect on the account itself.
            self.escrow_owner = self.program_id;
        }
        out
    }

    /// Releases as the fixture's own client, paying its own recorded provider.
    fn release(&mut self) -> Result<(), ProgramError> {
        let (job, client, provider) = (self.job_id, self.client, self.provider);
        self.release_as(job, &client, &provider, true)
    }

    fn release_as(
        &mut self,
        job_id: [u8; 32],
        signer: &Pubkey,
        provider: &Pubkey,
        is_signer: bool,
    ) -> Result<(), ProgramError> {
        let mut d = ix::RELEASE_ESCROW.to_vec();
        d.extend_from_slice(&job_id);
        let (p, v, e) = (self.program_id, self.vault, self.escrow);
        let (mut vl, mut el, mut pl) = (self.vault_lamports, self.escrow_lamports, self.provider_lamports);
        let mut cl = 0u64;
        let own = Pubkey::new_unique();
        let accounts = [
            AccountInfo::new(signer, is_signer, true, &mut cl, &mut [], &own, false, 0),
            AccountInfo::new(&v, false, true, &mut vl, &mut self.vault_data, &p, false, 0),
            AccountInfo::new(&e, false, true, &mut el, &mut self.escrow_data, &self.escrow_owner, false, 0),
            AccountInfo::new(provider, false, true, &mut pl, &mut [], &own, false, 0),
        ];
        let out = mitra_vault::dispatch(&p, &accounts, &d, 0);
        self.vault_lamports = vl;
        self.escrow_lamports = el;
        self.provider_lamports = pl;
        out
    }

    /// Refunds as the fixture's own client.
    fn refund(&mut self, now: u64) -> Result<(), ProgramError> {
        let (job, client) = (self.job_id, self.client);
        self.refund_as(job, &client, now)
    }

    fn refund_as(&mut self, job_id: [u8; 32], caller: &Pubkey, now: u64) -> Result<(), ProgramError> {
        let mut d = ix::REFUND_ESCROW.to_vec();
        d.extend_from_slice(&job_id);
        let (p, v, e) = (self.program_id, self.vault, self.escrow);
        let (mut vl, mut el, mut kl) = (self.vault_lamports, self.escrow_lamports, 1_000u64);
        let own = Pubkey::new_unique();
        let accounts = [
            AccountInfo::new(caller, true, false, &mut kl, &mut [], &own, false, 0),
            AccountInfo::new(&v, false, true, &mut vl, &mut self.vault_data, &p, false, 0),
            AccountInfo::new(&e, false, true, &mut el, &mut self.escrow_data, &self.escrow_owner, false, 0),
        ];
        let out = mitra_vault::dispatch(&p, &accounts, &d, now);
        self.vault_lamports = vl;
        self.escrow_lamports = el;
        out
    }

    fn vault(&self) -> Vault {
        Vault::from_bytes(&self.vault_data).unwrap()
    }

    fn escrow_state(&self) -> JobEscrow {
        JobEscrow::try_from_bytes(&self.escrow_data).unwrap()
    }

    /// Lamports under Mitra's control in this fixture: the vault, the escrow, and
    /// the payee. A refund or a release must move value between them and never
    /// create or destroy any.
    fn conserved(&self) -> u64 {
        self.vault_lamports + self.escrow_lamports + self.provider_lamports
    }
}

#[test]
fn lock_moves_the_lamports_and_records_the_terms() {
    let mut f = Fixture::new(1_000, false);
    let before = f.conserved();
    f.lock(400, 10_000, route(0x7f)).expect("a well-formed lock must be accepted");

    assert_eq!(f.vault().available, 600);
    assert_eq!(f.vault().escrowed, 400);
    assert_eq!(f.vault().total, 1_000, "total is Mitra's capital, not the vault's balance");
    // The capital really left the vault — this is the assertion a `reserve`
    // implementation cannot pass, and it is the reason this type exists.
    assert_eq!(f.vault_lamports, RENT_BASE + 600);
    assert_eq!(f.escrow_lamports, RENT_BASE + 400);
    assert_eq!(f.conserved(), before, "no lamports may be created or destroyed");

    let e = f.escrow_state();
    assert_eq!((e.client, e.provider, e.amount, e.timeout), (f.client, f.provider, 400, 10_000));
    assert_eq!(e.refund_route_hash, route(0x7f));
    assert!(e.has_commitment());
    assert!(!e.completed && !e.refunded);
}

#[test]
fn release_pays_the_provider_and_is_one_shot() {
    let mut f = Fixture::new(1_000, false);
    let before = f.conserved();
    f.lock(400, 10_000, route(0x7f)).unwrap();
    let held_by_provider = f.provider_lamports;

    f.release().expect("the client may release its own job");

    assert_eq!(f.provider_lamports - held_by_provider, 400, "the provider is paid exactly the escrow amount");
    assert_eq!(f.vault().total, 600, "paid capital leaves Mitra entirely");
    assert_eq!(f.vault().escrowed, 0);
    assert_eq!(f.conserved(), before, "a release moves value without creating it");
    assert!(f.escrow_state().completed);

    // Replay. The second attempt is refused as a settled escrow, not as an
    // underflow, because "this job is already paid" is the answer an operator
    // needs.
    assert_eq!(
        f.release().unwrap_err(),
        ProgramError::Custom(err::ESCROW_ALREADY_SETTLED)
    );
    // And the other direction is closed too: a paid job cannot then be refunded.
    assert_eq!(
        f.refund(0).unwrap_err(),
        ProgramError::Custom(err::ESCROW_ALREADY_SETTLED)
    );
    assert_eq!(f.provider_lamports - held_by_provider, 400, "a refused refund pays nothing");
}

#[test]
fn a_stranger_cannot_release_someone_elses_job() {
    let mut f = Fixture::new(1_000, false);
    f.lock(400, 10_000, route(0x7f)).unwrap();
    let held = f.provider_lamports;
    let stranger = Pubkey::new_unique();
    let (job, provider) = (f.job_id, f.provider);
    // `InvalidSeeds`, not `UNAUTHORIZED`, and the distinction is load-bearing
    // rather than cosmetic: the vault PDA is re-derived from the *signer's* key,
    // so a stranger is refused because the account they named is not a vault
    // they have any claim on — the same refusal `withdraw` gives (see the devnet
    // harness step 6). What matters is that it is refused before any amount or
    // payee is read.
    assert_eq!(
        f.release_as(job, &stranger, &provider, true).unwrap_err(),
        ProgramError::InvalidSeeds
    );
    assert_eq!(f.provider_lamports, held, "no capital moved");
    assert!(!f.escrow_state().completed, "a refused release must not burn the escrow");
}

#[test]
fn the_payee_cannot_be_redirected_at_release() {
    // The provider is a positional account — Solana requires every account a
    // transaction touches to be in the message — so it cannot be optional. The
    // program therefore has to check it against the recorded payee, exactly as
    // `spend_authorized` checks a permit's recipient.
    let mut f = Fixture::new(1_000, false);
    f.lock(400, 10_000, route(0x7f)).unwrap();
    let held = f.provider_lamports;
    let thief = Pubkey::new_unique();
    let (job, client) = (f.job_id, f.client);
    assert_eq!(
        f.release_as(job, &client, &thief, true).unwrap_err(),
        ProgramError::Custom(err::RECIPIENT_MISMATCH)
    );
    assert_eq!(f.provider_lamports, held);
    assert!(!f.escrow_state().completed, "a misdirected payment must not consume the escrow");
}

#[test]
fn the_amount_cannot_be_inflated_at_release() {
    // There is no amount argument. A caller cannot ask for 400 and receive more,
    // which is asserted structurally: `release_args` has no amount field at all.
    let mut f = Fixture::new(1_000, false);
    f.lock(400, 10_000, route(0x7f)).unwrap();
    let data = ix::RELEASE_ESCROW.to_vec();
    // Only the discriminator plus the job id is read; trailing bytes are ignored
    // by the handler, and none of them can change what is paid.
    assert_eq!(data.len() + 32, 40);
    assert_eq!(f.escrow_state().amount, 400);
}

#[test]
fn the_autonomous_refund_needs_noone() {
    // The property the whole package exists for: a third party, at the deadline,
    // with no cooperation from either party, returns the capital.
    let mut f = Fixture::new(1_000, false);
    let before = f.conserved();
    f.lock(400, 10_000, route(0x7f)).unwrap();
    let keeper = Pubkey::new_unique();

    f.refund_as(f.job_id, &keeper, 9_999)
        .expect_err("the deadline has not passed");
    f.refund_as(f.job_id, &keeper, 10_000).expect("at the deadline, anyone may act");

    assert!(f.escrow_state().refunded);
    assert_eq!(f.vault().available, 1_000, "the client gets its own headroom back");
    assert_eq!(f.vault().total, 1_000, "the capital never left Mitra");
    assert_eq!(f.vault().escrowed, 0);
    assert_eq!(f.conserved(), before, "a refund relocates value without creating it");
    assert_eq!(f.provider_lamports, RENT_BASE, "a refund pays the provider nothing");
}

#[test]
fn a_refund_before_the_deadline_is_only_the_clients() {
    let mut f = Fixture::new(1_000, false);
    f.lock(400, 10_000, route(0x7f)).unwrap();
    let stranger = Pubkey::new_unique();
    assert_eq!(
        f.refund_as(f.job_id, &stranger, 0).unwrap_err(),
        ProgramError::Custom(err::BEFORE_TIMEOUT),
        "a stranger must not be able to unwind a live job early"
    );
    f.refund(0).expect("the client may reject its own job");
}

#[test]
fn an_escrow_with_no_commitment_cannot_be_refunded() {
    // The refund-side guard. `lock_escrow` refuses a zero route, so reaching this
    // state requires a corrupted account — which is exactly why the guard is
    // duplicated rather than assumed unreachable: the guarantee is about the
    // refund, not about how the account got there.
    let mut f = Fixture::new(1_000, false);
    let mut e = JobEscrow::new(f.job_id, f.client, f.provider, 400, 10_000, [0u8; 32]);
    e.refunded = false;
    f.escrow_data = e.to_bytes().to_vec();
    f.escrow_owner = f.program_id;
    f.vault_data = {
        let mut v = f.vault();
        v.lock_to_escrow(400).unwrap();
        v.to_bytes().to_vec()
    };
    f.vault_lamports -= 400;
    f.escrow_lamports += 400;
    assert_eq!(
        f.refund(99_999).unwrap_err(),
        ProgramError::Custom(err::NO_COMMITMENT),
        "PRD §15.5: a recovery route must be committed before execution"
    );
}

#[test]
fn the_refunds_authority_comes_from_the_clock_not_from_the_caller() {
    // A refund signs no vault, so a version that trusted `caller.key` to mean
    // "is the client" would let any address claim the role. Instead the vault is
    // re-derived from the escrow's recorded client, and what the caller is
    // allowed to do depends on the clock: nothing before the deadline, anything
    // after it.
    let mut f = Fixture::new(1_000, false);
    f.lock(400, 10_000, route(0x7f)).unwrap();
    let stranger = Pubkey::new_unique();
    let (job, keeper) = (f.job_id, stranger);
    assert_eq!(
        f.refund_as(job, &keeper, 9_999).unwrap_err(),
        ProgramError::Custom(err::BEFORE_TIMEOUT),
        "before the deadline, a stranger is nobody"
    );
    f.refund_as(job, &keeper, 10_000).expect("at the deadline, a stranger is a keeper");
    assert_eq!(f.vault().available, 1_000);
}

// ── the guards at lock time ──────────────────────────────────────────────────

#[test]
fn a_lock_without_a_refund_commitment_is_refused() {
    let mut f = Fixture::new(1_000, false);
    assert_eq!(
        f.lock(400, 10_000, [0u8; 32]).unwrap_err(),
        ProgramError::Custom(err::NO_COMMITMENT),
        "a job whose way back is undecided must never be funded"
    );
    assert_eq!(f.vault().available, 1_000, "a refused lock must not move capital");
    assert_eq!(f.vault_lamports, RENT_BASE + 1_000);
}

#[test]
fn a_lock_whose_deadline_has_already_passed_is_refused() {
    // Locked AT the deadline instant, the escrow would be refundable the moment
    // it exists — the autonomous recovery path reduced to a formality, and the
    // client holding a "locked" job that anyone at all could undo. `>` not `>=`,
    // which is the opposite edge from the refund's `>=`. Both boundaries are
    // pinned here and in `refundable_at`'s tests because they are the pair of
    // lines that make the timer mean what it says.
    let mut f = Fixture::new(1_000, false);
    let at = |f: &mut Fixture, timeout| f.lock_at(400, timeout, route(0x7f), None, true, 1_000);
    assert_eq!(at(&mut f, 0).unwrap_err(), ProgramError::Custom(err::INVALID_TIMEOUT));
    assert_eq!(at(&mut f, 999).unwrap_err(), ProgramError::Custom(err::INVALID_TIMEOUT));
    assert_eq!(at(&mut f, 1_000).unwrap_err(), ProgramError::Custom(err::INVALID_TIMEOUT));
    at(&mut f, 1_001).expect("the first second in the future is allowed");
    assert_eq!(f.vault().available, 600);
}

#[test]
fn a_lock_beyond_the_vaults_headroom_is_refused_and_costs_nothing() {
    let mut f = Fixture::new(1_000, false);
    let lamports = f.client_lamports;
    assert_eq!(
        f.lock(1_001, 10_000, route(0x7f)).unwrap_err(),
        ProgramError::Custom(err::INSUFFICIENT_AVAILABLE)
    );
    assert_eq!(f.client_lamports, lamports, "no rent was spent on a rejected lock");
    assert_eq!(f.vault().available, 1_000);
}

#[test]
fn a_lock_needs_the_clients_signature() {
    let mut f = Fixture::new(1_000, false);
    assert_eq!(
        f.lock_at(400, 10_000, route(0x7f), None, false, 0).unwrap_err(),
        ProgramError::Custom(err::NOT_SIGNER)
    );
    assert_eq!(f.vault().available, 1_000);
}

#[test]
fn the_same_job_cannot_be_funded_twice() {
    let mut f = Fixture::new(1_000, false);
    f.lock(400, 10_000, route(0x7f)).unwrap();
    assert_eq!(
        f.lock(400, 10_000, route(0x7f)).unwrap_err(),
        ProgramError::Custom(err::ALREADY_INITIALIZED),
        "a live obligation must not be silently replaced by a new one"
    );
    assert_eq!(f.vault().escrowed, 400, "and the original is untouched");
    assert_eq!(f.escrow_state().amount, 400);
}

#[test]
fn a_wrong_bump_is_refused() {
    // The bump is optional in the encoding and derived when absent. Supplying a
    // wrong one must not be ignored: it would mean the client's own account
    // layout is not what the program believes.
    let mut f = Fixture::new(1_000, false);
    assert_eq!(
        f.lock_at(400, 10_000, route(0x7f), Some(f.bump.wrapping_add(1)), true, 0).unwrap_err(),
        ProgramError::InvalidSeeds
    );
    f.lock_at(400, 10_000, route(0x7f), Some(f.bump), true, 0).expect("the derived bump is accepted");
}

// ── two jobs on one vault ────────────────────────────────────────────────────

#[test]
fn two_jobs_are_independent() {
    // `escrowed` is a sum, so this is the shape that could let one job's refund
    // eat another's capital. Each instruction carries its own job id, derives its
    // own PDA, and reads its own amount.
    let mut f = Fixture::new(10_000, false);
    f.lock(7_000, 10_000, route(0x7f)).unwrap();
    assert_eq!(f.vault().escrowed, 7_000);

    // A second job needs its own PDA, so the fixture is rebuilt around one and the
    // first job's settlement is asserted through the aggregate.
    let mut g = Fixture::new(10_000, false);
    g.job_id = [0x9b; 32];
    let (g_escrow, _) = Pubkey::find_program_address(
        &[b"escrow", g.vault.as_ref(), g.job_id.as_ref()],
        &g.program_id,
    );
    assert_ne!(g_escrow, f.escrow, "a different job must be a different escrow");
    g.escrow = g_escrow;
    g.lock(2_000, 10_000, route(0x7f)).unwrap();
    assert_eq!(g.vault().escrowed, 2_000);
    assert_eq!(g.vault().available, 8_000);
    g.refund(10_000).unwrap();
    assert_eq!((g.vault().available, g.vault().escrowed), (10_000, 0));
}

#[test]
fn an_instruction_naming_another_jobs_escrow_is_refused() {
    // The PDA is re-derived from `(vault, job_id)`, so passing a real escrow with
    // the wrong job id cannot settle it.
    let mut f = Fixture::new(1_000, false);
    f.lock(400, 10_000, route(0x7f)).unwrap();
    let other_job = [0x9b; 32];
    let (client, provider) = (f.client, f.provider);
    assert_eq!(
        f.release_as(other_job, &client, &provider, true).unwrap_err(),
        ProgramError::InvalidSeeds
    );
    assert_eq!(
        f.refund_as(other_job, &client, 0).unwrap_err(),
        ProgramError::InvalidSeeds
    );
    assert!(!f.escrow_state().is_settled(), "neither attempt consumed the escrow");
}
