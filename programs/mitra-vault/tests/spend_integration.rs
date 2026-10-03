//! Phase 3c — driving the REAL `spend_authorized` handler in-process.
//!
//! **This file exists because of a gap the mutation audit found, and the reason
//! is worth recording.** The first version of the Phase 3c tests exercised
//! `Authorization::spendable_at` — the *type*. Mutation testing then showed that
//! deleting the consume-on-spend write from the *handler* broke **zero** tests,
//! while deleting the same check from the type broke three. The suite was green
//! against a build where the replay guarantee had been removed outright.
//!
//! The cause: the security claim lives in the handler (it writes `consumed` and
//! moves lamports), and the tests only tested the type. A test that covers a
//! method but not its caller has not tested the property anyone actually relies
//! on.
//!
//! So these tests call `mitra_vault::dispatch` with real `AccountInfo`s. They
//! still cannot exercise PDA creation, `invoke_signed`, or real lamport
//! ownership — those need a chain, and the devnet harness covers them. What they
//! *do* cover is the ordering and consumption logic, which is where the mutation
//! audit found the hole.

use mitra_vault::anchor_parity::{err, ix};
use mitra_vault::anchor_parity::{find_vault_pda, vault_seeds};
use mitra_vault::state::{Authorization, Mandate, MandateBinding, Vault, AUTHORIZATION_LEN, MANDATE_LEN, VAULT_LEN};
use solana_program::account_info::AccountInfo;
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

/// Owns every buffer an `AccountInfo` borrows, so the borrows outlive the infos.
/// A local in the test body would not: `AccountInfo::new` takes `&'a mut`, and
/// the borrow must last as long as the struct that holds it.
struct Fixture {
    program_id: Pubkey,
    vault: Pubkey,
    mandate: Pubkey,
    auth: Pubkey,
    recipient: Pubkey,
    vault_lamports: u64,
    vault_data: Vec<u8>,
    mandate_data: Vec<u8>,
    auth_data: Vec<u8>,
    recipient_lamports: u64,
}

const NOW: u64 = 1_000_000;
const FUNDED: u64 = 10_000;
const PERMIT: u64 = 2_500;

fn fixture() -> Fixture {
    let program_id = Pubkey::new_unique();
    let mandate = Pubkey::new_unique();
    let auth = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();

    // The vault is the PRINCIPAL's PDA, and the principal is the one recorded on
    // the mandate. This fixture used an arbitrary key for the vault and a random
    // authority for its state — a vault unrelated to the mandate it was spent
    // under — and every test passed, because the handler never asked (F51).
    let principal = Pubkey::new_unique();
    let (vault, vault_bump) = find_vault_pda(&vault_seeds(&principal), &program_id).unwrap();
    let mut v = Vault::new(principal, vault_bump);
    v.deposit(FUNDED).unwrap();

    // The holder is SHARED between the mandate and the permit, and that is the
    // point: the handler refuses a permit whose holder is not the mandate's
    // holder (UNAUTHORIZED / 6008), because a permit from one mandate must not
    // be spendable against another's vault. The first draft of this fixture gave
    // them independent keys and every test failed on 6008 — the handler was
    // right and the fixture was modelling a cross-mandate replay, which is
    // exactly the confusion it is built to refuse.
    let holder = Pubkey::new_unique();
    let m = Mandate {
        holder,
        limit: 5_000,
        version: 3,
        expires_at: NOW + 10_000,
        revoked: false,
        ceiling: 50_000,
        binding: Some(MandateBinding { principal, policy_engine: Pubkey::new_unique() }),
    };
    let a = Authorization {
        holder,
        action_hash: [7u8; 32],
        amount: PERMIT,
        mandate_version: 3,
        expires_at: NOW + 10_000,
        consumed: false,
        bump: 254,
        recipient,
    };
    let _ = (MANDATE_LEN, AUTHORIZATION_LEN, VAULT_LEN);

    Fixture {
        program_id,
        vault,
        mandate,
        auth,
        recipient,
        vault_lamports: 1_000_000_000,
        vault_data: v.to_bytes().to_vec(),
        mandate_data: m.to_bytes().to_vec(),
        auth_data: a.to_bytes().to_vec(),
        recipient_lamports: 0,
    }
}

impl Fixture {
    /// Run `spend_authorized` for `[7u8; 32]`. Every account is owned by
    /// `program_id`, which is what the handler's owner checks require.
    fn spend(&mut self, now: u64) -> Result<(), ProgramError> {
        let mut instr = [0u8; 8];
        instr.copy_from_slice(&ix::SPEND_AUTHORIZED);
        let mut data = Vec::with_capacity(40);
        data.extend_from_slice(&instr);
        data.extend_from_slice(&[7u8; 32]);

        let program_id = self.program_id;
        let vault_key = self.vault;
        let mandate_key = self.mandate;
        let auth_key = self.auth;
        let recipient_key = self.recipient;
        let owner = self.program_id;

        let mut vault_lamports = self.vault_lamports;
        let mut vault_data = std::mem::take(&mut self.vault_data);
        let mut mandate_data = std::mem::take(&mut self.mandate_data);
        let mut auth_data = std::mem::take(&mut self.auth_data);
        let mut recipient_lamports = self.recipient_lamports;

        let mut zero_a: u64 = 0;
        let mut zero_m: u64 = 0;
        let result = {
            let accounts = [
                AccountInfo::new(&recipient_key, false, true, &mut recipient_lamports, &mut [], &owner, false, 0),
                AccountInfo::new(&vault_key, false, true, &mut vault_lamports, &mut vault_data, &owner, false, 0),
                AccountInfo::new(&auth_key, false, true, &mut zero_a, &mut auth_data, &owner, false, 0),
                AccountInfo::new(&mandate_key, false, false, &mut zero_m, &mut mandate_data, &owner, false, 0),
            ];
            mitra_vault::dispatch(&program_id, &accounts, &data, now)
        };

        // Read results back regardless of outcome: a rejected spend must leave the
        // permit *unconsumed*, and asserting that needs the bytes.
        self.vault_lamports = vault_lamports;
        self.vault_data = vault_data;
        self.mandate_data = mandate_data;
        self.auth_data = auth_data;
        self.recipient_lamports = recipient_lamports;
        result
    }

    fn permit(&self) -> Authorization {
        Authorization::try_from_bytes(&self.auth_data).unwrap()
    }
    fn vault(&self) -> Vault {
        Vault::from_bytes(&self.vault_data).unwrap()
    }
}

#[test]
fn a_valid_spend_moves_value_and_consumes_the_permit() {
    let mut f = fixture();
    f.spend(NOW).expect("the permit is valid; the spend must succeed");

    assert_eq!(f.permit().consumed, true, "the permit must be consumed");
    assert_eq!(f.vault().available, FUNDED - PERMIT, "capital must leave the vault");
    assert_eq!(f.vault().total, FUNDED - PERMIT);
    assert_eq!(f.recipient_lamports, PERMIT, "value must reach the recipient");
    assert_eq!(f.vault_lamports, 1_000_000_000 - PERMIT);
    // The reconciliation invariant must still hold after a policy-mediated spend.
    f.vault().reconcile().expect("vault must still reconcile");
}

#[test]
fn replaying_the_same_permit_is_refused_and_moves_nothing() {
    // THE test. This is the property the whole Phase 3 exists to provide, and it
    // is the one the earlier type-only suite failed to cover.
    let mut f = fixture();
    f.spend(NOW).expect("first spend succeeds");
    let after_first_recipient = f.recipient_lamports;
    let after_first_available = f.vault().available;

    let replay = f.spend(NOW);
    assert_eq!(
        replay.unwrap_err(),
        err::custom(err::AUTHORIZATION_CONSUMED),
        "the second spend must be refused as a replay"
    );
    // Not merely "it errored" — the chain must be unchanged by the attempt.
    assert_eq!(f.recipient_lamports, after_first_recipient, "replay moved value");
    assert_eq!(f.vault().available, after_first_available, "replay moved capital");
    assert_eq!(f.recipient_lamports, PERMIT, "recipient got exactly one permit's worth");
}

/// Ten replays, not two. A single retry is a special case; what matters is that
/// no number of attempts produces a second movement.
#[test]
fn repeated_replays_never_move_value() {
    let mut f = fixture();
    f.spend(NOW).unwrap();
    for _ in 0..10 {
        assert!(f.spend(NOW).is_err(), "every later attempt must fail");
    }
    assert_eq!(f.recipient_lamports, PERMIT);
    assert_eq!(f.vault().available, FUNDED - PERMIT);
}

#[test]
fn a_spend_after_expiry_is_refused_and_leaves_the_permit_unconsumed() {
    // The refusal ordering matters: a *refused* spend must not burn the permit.
    // Otherwise a stale attempt would destroy a still-valid permit, which turns
    // an expiry into a denial-of-service against the holder.
    let mut f = fixture();
    assert_eq!(
        f.spend(NOW + 1_000_000).unwrap_err(),
        err::custom(err::MANDATE_EXPIRED)
    );
    assert_eq!(f.permit().consumed, false, "a refused spend must not consume");
    assert_eq!(f.recipient_lamports, 0, "nothing moved");
    assert_eq!(f.vault().available, FUNDED);
}

#[test]
fn a_spend_for_a_different_action_is_refused_even_once() {
    // Proves the *handler* enforces action-binding, not just the type: the
    // instruction data is the only thing naming the action, and the handler must
    // compare it against the permit rather than trusting either.
    let mut f = fixture();
    let mut instr = [0u8; 8];
    instr.copy_from_slice(&ix::SPEND_AUTHORIZED);
    let mut data = Vec::new();
    data.extend_from_slice(&instr);
    data.extend_from_slice(&[9u8; 32]); // not [7u8; 32]

    let owner = f.program_id;
    let mut vault_lamports = f.vault_lamports;
    let mut vault_data = std::mem::take(&mut f.vault_data);
    let mut mandate_data = std::mem::take(&mut f.mandate_data);
    let mut auth_data = std::mem::take(&mut f.auth_data);
    let mut recipient_lamports = f.recipient_lamports;
    {
        let mut zero_a: u64 = 0;
        let mut zero_m: u64 = 0;
        let accounts = [
            AccountInfo::new(&f.recipient, false, true, &mut recipient_lamports, &mut [], &owner, false, 0),
            AccountInfo::new(&f.vault, false, true, &mut vault_lamports, &mut vault_data, &owner, false, 0),
            AccountInfo::new(&f.auth, false, true, &mut zero_a, &mut auth_data, &owner, false, 0),
            AccountInfo::new(&f.mandate, false, false, &mut zero_m, &mut mandate_data, &owner, false, 0),
        ];
        let e = mitra_vault::dispatch(&f.program_id, &accounts, &data, NOW).unwrap_err();
        assert_eq!(e, err::custom(err::ACTION_HASH_MISMATCH));
    }
    f.vault_lamports = vault_lamports;
    f.vault_data = vault_data;
    f.mandate_data = mandate_data;
    f.auth_data = auth_data;
    f.recipient_lamports = recipient_lamports;
    assert_eq!(f.recipient_lamports, 0);
    assert_eq!(f.permit().consumed, false);
}

/// The permit names the amount; the instruction carries none. So the transfer is
/// exactly the permit's amount even though the caller supplied no number at all.
#[test]
fn the_amount_transferred_is_the_permits_own() {
    let mut f = fixture();
    f.spend(NOW).unwrap();
    assert_eq!(f.recipient_lamports, PERMIT);
    assert_eq!(f.permit().amount, PERMIT);
}
