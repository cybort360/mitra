//! F51 — who may grant a mandate, who may issue a permit, and where it may pay.
//!
//! Each of these was a way for a stranger to move a principal's capital, and each
//! was reproduced against the real `dispatch` before it was fixed:
//!
//!   1. `spend_authorized` debited whatever vault the caller named. An attacker's
//!      own permit drained a victim's vault (`Ok(())`, 5_000 lamports moved).
//!   2. `authorize` accepted any signer as the policy engine. A stranger issued a
//!      5_000-unit permit against a victim's mandate (`Ok(())`).
//!   3. `spend_authorized` takes no signature and the payee was the caller's
//!      choice, so anyone who saw an unspent permit could redeem it to themselves.
//!   4. The agent opened — and could amend — its own mandate, so the "limit" was
//!      whatever the agent chose.
//!
//! Every test here drives the HANDLER with real `AccountInfo`s, not the types:
//! F25 and F41 both survived type-level tests and died to handler-level ones.
//! Each refusal is paired with the legitimate case, so a program that refuses
//! everything cannot pass either.

use mitra_vault::anchor_parity::{err, find_vault_pda, ix, vault_seeds};
use mitra_vault::state::{Authorization, Mandate, MandateBinding, Vault, AUTHORIZATION_LEN, MANDATE_LEN, MANDATE_LEN_PRE_BINDING};
use solana_program::account_info::AccountInfo;
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

const NOW: u64 = 1_000_000;
const FUNDED: u64 = 10_000;
const LIMIT: u64 = 5_000;
const SYS: Pubkey = solana_program::system_program::ID;

/// One principal, one agent, one engine, one payee — distinct keys, so a test
/// that passes cannot be passing because two roles happen to coincide.
#[derive(Clone, Copy)]
struct Keys {
    principal: Pubkey,
    holder: Pubkey,
    engine: Pubkey,
    payee: Pubkey,
}

fn keys(seed: u8) -> Keys {
    Keys {
        principal: Pubkey::new_from_array([seed; 32]),
        holder: Pubkey::new_from_array([seed + 1; 32]),
        engine: Pubkey::new_from_array([seed + 2; 32]),
        payee: Pubkey::new_from_array([seed + 3; 32]),
    }
}

/// A vault account as `initialize_vault` + `deposit` would leave it.
struct VaultAcct {
    key: Pubkey,
    lamports: u64,
    data: Vec<u8>,
}

fn vault_of(program_id: &Pubkey, principal: Pubkey) -> VaultAcct {
    let (key, bump) = find_vault_pda(&vault_seeds(&principal), program_id).unwrap();
    let mut v = Vault::new(principal, bump);
    v.deposit(FUNDED).unwrap();
    VaultAcct { key, lamports: 1_000_000_000, data: v.to_bytes().to_vec() }
}

/// `[b"mandate", principal, holder]` — reseeded in sprint item 7.
fn mandate_key(program_id: &Pubkey, principal: &Pubkey, holder: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"mandate", principal.as_ref(), holder.as_ref()], program_id).0
}

/// The mandate address a stored mandate lives at, from the principal it records.
fn mandate_key_of(program_id: &Pubkey, mandate: &[u8]) -> Pubkey {
    let m = Mandate::try_from_bytes(mandate).unwrap();
    let principal = m.binding.map(|b| b.principal).unwrap_or(m.holder);
    mandate_key(program_id, &principal, &m.holder)
}

/// `[b"authorization", mandate, action]` — keyed by the issuing mandate (sprint item 7).
fn authorization_key(program_id: &Pubkey, mandate: &Pubkey, action: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"authorization", mandate.as_ref(), action.as_ref()], program_id)
}

fn bound_mandate(k: Keys) -> Mandate {
    Mandate {
        holder: k.holder,
        limit: LIMIT,
        version: 1,
        expires_at: NOW + 10_000,
        ceiling: 50_000,
        revoked: false,
        binding: Some(MandateBinding { principal: k.principal, policy_engine: k.engine }),
    }
}

// ── instruction drivers ─────────────────────────────────────────────────────

/// `open_mandate`. The mandate PDA is pre-funded and system-owned so the handler
/// skips its `create_account` CPI, which cannot run in-process; every check
/// before and after it does.
fn open_mandate(
    program_id: &Pubkey,
    signer: Pubkey,
    signed: bool,
    holder: Pubkey,
    vault: &mut VaultAcct,
    engine: Pubkey,
) -> (Result<(), ProgramError>, Vec<u8>) {
    // The program derives the mandate from the SIGNER as principal.
    let mkey = mandate_key(program_id, &signer, &holder);
    let mut data = ix::OPEN_MANDATE.to_vec();
    data.extend(LIMIT.to_le_bytes());
    data.extend(50_000u64.to_le_bytes());
    data.extend((NOW + 10_000).to_le_bytes());
    data.extend(engine.as_ref());

    let (mut sl, mut hl, mut ml, mut yl) = (5_000_000u64, 0u64, 1_000_000u64, 1u64);
    let mut mdata = vec![0u8; MANDATE_LEN];
    let r = {
        let accounts = [
            AccountInfo::new(&signer, signed, true, &mut sl, &mut [], &SYS, false, 0),
            AccountInfo::new(&holder, false, false, &mut hl, &mut [], &SYS, false, 0),
            AccountInfo::new(&mkey, false, true, &mut ml, &mut mdata, &SYS, false, 0),
            AccountInfo::new(&vault.key, false, false, &mut vault.lamports, &mut vault.data, program_id, false, 0),
            AccountInfo::new(&SYS, false, false, &mut yl, &mut [], &SYS, true, 0),
        ];
        mitra_vault::dispatch(program_id, &accounts, &data, NOW)
    };
    (r, mdata)
}

/// `authorize`, returning the permit bytes it wrote.
fn authorize(
    program_id: &Pubkey,
    signer: Pubkey,
    mandate: &[u8],
    action: [u8; 32],
    amount: u64,
    recipient: Pubkey,
) -> (Result<(), ProgramError>, Vec<u8>) {
    let mkey = mandate_key_of(program_id, mandate);
    authorize_at(program_id, signer, mkey, mandate, action, amount, recipient)
}

/// `authorize` with the mandate account's address named explicitly.
fn authorize_at(
    program_id: &Pubkey,
    signer: Pubkey,
    mkey: Pubkey,
    mandate: &[u8],
    action: [u8; 32],
    amount: u64,
    recipient: Pubkey,
) -> (Result<(), ProgramError>, Vec<u8>) {
    let holder = Mandate::try_from_bytes(mandate).unwrap().holder;
    let (akey, abump) = authorization_key(program_id, &mkey, &action);
    let mut data = ix::AUTHORIZE.to_vec();
    data.extend(action);
    data.extend(amount.to_le_bytes());
    data.extend(recipient.as_ref());
    data.push(abump);

    let mut mdata = mandate.to_vec();
    let mut adata = vec![0u8; AUTHORIZATION_LEN];
    let (mut sl, mut hl, mut ml, mut al, mut yl) = (5_000_000u64, 0u64, 1u64, 1_000_000u64, 1u64);
    let r = {
        let accounts = [
            AccountInfo::new(&signer, true, true, &mut sl, &mut [], &SYS, false, 0),
            AccountInfo::new(&holder, false, false, &mut hl, &mut [], &SYS, false, 0),
            AccountInfo::new(&mkey, false, false, &mut ml, &mut mdata, program_id, false, 0),
            AccountInfo::new(&akey, false, true, &mut al, &mut adata, &SYS, false, 0),
            AccountInfo::new(&SYS, false, false, &mut yl, &mut [], &SYS, true, 0),
        ];
        mitra_vault::dispatch(program_id, &accounts, &data, NOW)
    };
    (r, adata)
}

struct SpendOutcome {
    result: Result<(), ProgramError>,
    paid: u64,
    permit_consumed: bool,
    vault_available: u64,
}

/// `spend_authorized` with no signer at all — exactly what any observer can send.
/// The permit account is the one the given mandate would have issued.
fn spend(
    program_id: &Pubkey,
    recipient: Pubkey,
    vault: &mut VaultAcct,
    permit: &[u8],
    mandate: &[u8],
    action: [u8; 32],
) -> SpendOutcome {
    let akey = permit_key_for(program_id, mandate, &action);
    spend_at(program_id, recipient, vault, akey, permit, mandate, action)
}

/// Where `mandate` would have put its permit for `action`.
fn permit_key_for(program_id: &Pubkey, mandate: &[u8], action: &[u8; 32]) -> Pubkey {
    authorization_key(program_id, &mandate_key_of(program_id, mandate), action).0
}

/// `spend_authorized` with the permit account named explicitly — what an attacker
/// does when presenting one mandate's permit alongside a different mandate.
fn spend_at(
    program_id: &Pubkey,
    recipient: Pubkey,
    vault: &mut VaultAcct,
    akey: Pubkey,
    permit: &[u8],
    mandate: &[u8],
    action: [u8; 32],
) -> SpendOutcome {
    spend_with_mandate_at(program_id, recipient, vault, akey, permit, mandate_key_of(program_id, mandate), mandate, action)
}

/// `spend_authorized` with both the permit's and the mandate's addresses named.
fn spend_with_mandate_at(
    program_id: &Pubkey,
    recipient: Pubkey,
    vault: &mut VaultAcct,
    akey: Pubkey,
    permit: &[u8],
    mkey: Pubkey,
    mandate: &[u8],
    action: [u8; 32],
) -> SpendOutcome {
    let mut data = ix::SPEND_AUTHORIZED.to_vec();
    data.extend(action);

    let mut adata = permit.to_vec();
    let mut mdata = mandate.to_vec();
    let (mut rl, mut al, mut ml) = (0u64, 1u64, 1u64);
    let result = {
        let accounts = [
            AccountInfo::new(&recipient, false, true, &mut rl, &mut [], &SYS, false, 0),
            AccountInfo::new(&vault.key, false, true, &mut vault.lamports, &mut vault.data, program_id, false, 0),
            AccountInfo::new(&akey, false, true, &mut al, &mut adata, program_id, false, 0),
            AccountInfo::new(&mkey, false, false, &mut ml, &mut mdata, program_id, false, 0),
        ];
        mitra_vault::dispatch(program_id, &accounts, &data, NOW)
    };
    SpendOutcome {
        result,
        paid: rl,
        permit_consumed: Authorization::try_from_bytes(&adata).unwrap().consumed,
        vault_available: Vault::from_bytes(&vault.data).unwrap().available,
    }
}

fn amend(program_id: &Pubkey, signer: Pubkey, mandate: &mut Vec<u8>, limit: u64, revoke: bool) -> Result<(), ProgramError> {
    let holder = Mandate::try_from_bytes(mandate).unwrap().holder;
    let mkey = mandate_key_of(program_id, mandate);
    let mut data = ix::AMEND_MANDATE.to_vec();
    data.extend(limit.to_le_bytes());
    data.extend(500_000u64.to_le_bytes());
    data.extend((NOW + 10_000).to_le_bytes());
    data.push(u8::from(revoke));
    let (mut sl, mut ml) = (5_000_000u64, 1_000_000u64);
    let accounts = [
        AccountInfo::new(&signer, true, true, &mut sl, &mut [], &SYS, false, 0),
        AccountInfo::new(&mkey, false, true, &mut ml, mandate, program_id, false, 0),
    ];
    mitra_vault::dispatch(program_id, &accounts, &data, NOW)
}

// ── the legitimate path, end to end ─────────────────────────────────────────

/// Principal grants → engine authorizes to a named payee → anyone submits the
/// spend → exactly the permit's amount reaches exactly that payee, from exactly
/// the principal's vault. Every refusal below is a variation on this one world.
#[test]
fn the_granted_path_moves_value_from_the_principals_vault_to_the_named_payee() {
    let pid = mitra_vault::program_id();
    let k = keys(10);
    let mut vault = vault_of(&pid, k.principal);

    let (r, mandate) = open_mandate(&pid, k.principal, true, k.holder, &mut vault, k.engine);
    r.expect("the principal may grant a mandate over its own vault");
    let m = Mandate::try_from_bytes(&mandate).unwrap();
    assert_eq!(m.binding, Some(MandateBinding { principal: k.principal, policy_engine: k.engine }));

    let action = [1u8; 32];
    let (r, permit) = authorize(&pid, k.engine, &mandate, action, 2_500, k.payee);
    r.expect("the named engine may issue a permit");
    assert_eq!(Authorization::try_from_bytes(&permit).unwrap().recipient, k.payee);

    let s = spend(&pid, k.payee, &mut vault, &permit, &mandate, action);
    s.result.expect("the permit's own payee, from the principal's vault, must succeed");
    assert_eq!(s.paid, 2_500);
    assert!(s.permit_consumed);
    assert_eq!(s.vault_available, FUNDED - 2_500);
}

// ── gap 1: the vault ────────────────────────────────────────────────────────

#[test]
fn a_permit_cannot_spend_a_vault_its_mandate_was_not_granted_over() {
    // The original repro: the attacker is principal, engine and payee of their
    // own world, and names the VICTIM's vault.
    let pid = mitra_vault::program_id();
    let attacker = keys(20);
    let victim = keys(40);
    let mut attacker_vault = vault_of(&pid, attacker.principal);
    let mut victim_vault = vault_of(&pid, victim.principal);

    let (_, mandate) = open_mandate(&pid, attacker.principal, true, attacker.holder, &mut attacker_vault, attacker.engine);
    let action = [2u8; 32];
    let (_, permit) = authorize(&pid, attacker.engine, &mandate, action, LIMIT, attacker.payee);

    let s = spend(&pid, attacker.payee, &mut victim_vault, &permit, &mandate, action);
    assert_eq!(s.result.unwrap_err(), err::custom(err::VAULT_MISMATCH));
    assert_eq!(s.paid, 0, "nothing may leave the victim's vault");
    assert_eq!(s.vault_available, FUNDED);
    assert!(!s.permit_consumed, "a refused spend must not burn the permit");

    // The same permit against its own vault still works: the refusal is about
    // WHICH vault, not about the permit.
    let ok = spend(&pid, attacker.payee, &mut attacker_vault, &permit, &mandate, action);
    ok.result.expect("the mandate's own vault must still pay");
}

#[test]
fn a_vault_at_the_right_address_with_the_wrong_authority_is_refused() {
    // Defence in depth: the address check and the recorded-authority check are
    // independent, so a corrupted or substituted account at the PDA still fails.
    let pid = mitra_vault::program_id();
    let k = keys(50);
    let mut vault = vault_of(&pid, k.principal);
    let (_, mandate) = open_mandate(&pid, k.principal, true, k.holder, &mut vault, k.engine);
    let action = [3u8; 32];
    let (_, permit) = authorize(&pid, k.engine, &mandate, action, 1_000, k.payee);

    let mut forged = Vault::from_bytes(&vault.data).unwrap();
    forged.authority = Pubkey::new_from_array([99u8; 32]);
    vault.data = forged.to_bytes().to_vec();
    let s = spend(&pid, k.payee, &mut vault, &permit, &mandate, action);
    assert_eq!(s.result.unwrap_err(), err::custom(err::VAULT_MISMATCH));
    assert_eq!(s.paid, 0);
}

#[test]
fn an_account_that_claims_the_principal_but_is_not_its_vault_pda_is_refused() {
    // The converse of the test above: right recorded authority, wrong address.
    // Only the address check can refuse this one — the authority check passes.
    let pid = mitra_vault::program_id();
    let k = keys(55);
    let mut vault = vault_of(&pid, k.principal);
    let (_, mandate) = open_mandate(&pid, k.principal, true, k.holder, &mut vault, k.engine);
    let action = [3u8; 32];
    let (_, permit) = authorize(&pid, k.engine, &mandate, action, 1_000, k.payee);

    let mut impostor = vault_of(&pid, k.principal);
    impostor.key = Pubkey::new_from_array([98u8; 32]);
    let s = spend(&pid, k.payee, &mut impostor, &permit, &mandate, action);
    assert_eq!(s.result.unwrap_err(), err::custom(err::VAULT_MISMATCH));
    assert_eq!(s.paid, 0);
}

// ── gap 2: the engine ───────────────────────────────────────────────────────

#[test]
fn a_stranger_cannot_issue_a_permit_against_someone_elses_mandate() {
    let pid = mitra_vault::program_id();
    let k = keys(60);
    let mut vault = vault_of(&pid, k.principal);
    let (_, mandate) = open_mandate(&pid, k.principal, true, k.holder, &mut vault, k.engine);
    let stranger = Pubkey::new_from_array([77u8; 32]);

    let (r, permit) = authorize(&pid, stranger, &mandate, [4u8; 32], LIMIT, stranger);
    assert_eq!(r.unwrap_err(), err::custom(err::POLICY_ENGINE_MISMATCH));
    assert!(Authorization::try_from_bytes(&permit).is_err(), "no permit may be written");

    // Not the holder, not the principal either: only the named engine decides.
    for not_engine in [k.holder, k.principal] {
        let (r, _) = authorize(&pid, not_engine, &mandate, [5u8; 32], LIMIT, k.payee);
        assert_eq!(r.unwrap_err(), err::custom(err::POLICY_ENGINE_MISMATCH));
    }
}

#[test]
fn a_revoked_mandate_cannot_issue_a_permit() {
    let pid = mitra_vault::program_id();
    let k = keys(70);
    let mut m = bound_mandate(k).to_bytes().to_vec();
    amend(&pid, k.principal, &mut m, LIMIT, true).expect("principal revokes");
    let (r, _) = authorize(&pid, k.engine, &m, [6u8; 32], 1, k.payee);
    assert_eq!(r.unwrap_err(), err::custom(err::MANDATE_REVOKED));
}

// ── gap 3: the payee ────────────────────────────────────────────────────────

#[test]
fn an_observer_cannot_redeem_someone_elses_permit_to_themselves() {
    let pid = mitra_vault::program_id();
    let k = keys(80);
    let mut vault = vault_of(&pid, k.principal);
    let (_, mandate) = open_mandate(&pid, k.principal, true, k.holder, &mut vault, k.engine);
    let action = [7u8; 32];
    let (_, permit) = authorize(&pid, k.engine, &mandate, action, LIMIT, k.payee);

    let observer = Pubkey::new_from_array([88u8; 32]);
    let s = spend(&pid, observer, &mut vault, &permit, &mandate, action);
    assert_eq!(s.result.unwrap_err(), err::custom(err::RECIPIENT_MISMATCH));
    assert_eq!(s.paid, 0);
    assert_eq!(s.vault_available, FUNDED);
    assert!(!s.permit_consumed, "the real payee must still be able to collect");

    spend(&pid, k.payee, &mut vault, &permit, &mandate, action).result
        .expect("the named payee still collects after the redirect was refused");
}

// ── gap 4: who grants and who amends ────────────────────────────────────────

#[test]
fn an_agent_cannot_grant_itself_a_mandate() {
    let pid = mitra_vault::program_id();
    let k = keys(90);
    let mut vault = vault_of(&pid, k.principal);
    // The holder signs, naming the principal's vault: refused, because the vault
    // is not the signer's.
    let (r, _) = open_mandate(&pid, k.holder, true, k.holder, &mut vault, k.engine);
    assert_eq!(r.unwrap_err(), ProgramError::InvalidSeeds, "the vault is not the signer's PDA");
}

#[test]
fn a_mandate_needs_the_principals_signature() {
    let pid = mitra_vault::program_id();
    let k = keys(100);
    let mut vault = vault_of(&pid, k.principal);
    let (r, _) = open_mandate(&pid, k.principal, false, k.holder, &mut vault, k.engine);
    assert_eq!(r.unwrap_err(), err::custom(err::NOT_SIGNER));
}

#[test]
fn the_holder_may_revoke_but_not_widen_its_own_mandate() {
    let pid = mitra_vault::program_id();
    let k = keys(110);
    let mut m = bound_mandate(k).to_bytes().to_vec();

    let e = amend(&pid, k.holder, &mut m, LIMIT * 100, false).unwrap_err();
    assert_eq!(e, err::custom(err::UNAUTHORIZED), "an agent must not raise its own limit");
    assert_eq!(Mandate::try_from_bytes(&m).unwrap().limit, LIMIT, "the limit is unchanged");

    amend(&pid, k.holder, &mut m, LIMIT, true).expect("an agent may always stop itself");
    assert!(Mandate::try_from_bytes(&m).unwrap().revoked);
}

#[test]
fn the_principal_may_amend_and_a_stranger_may_do_neither() {
    let pid = mitra_vault::program_id();
    let k = keys(120);
    let mut m = bound_mandate(k).to_bytes().to_vec();
    let stranger = Pubkey::new_from_array([66u8; 32]);

    assert_eq!(amend(&pid, stranger, &mut m, 1, false).unwrap_err(), err::custom(err::UNAUTHORIZED));
    assert_eq!(amend(&pid, stranger, &mut m, 1, true).unwrap_err(), err::custom(err::UNAUTHORIZED));
    assert_eq!(amend(&pid, k.engine, &mut m, 1, false).unwrap_err(), err::custom(err::UNAUTHORIZED),
        "the engine decides permits, not policy");

    amend(&pid, k.principal, &mut m, 1_000, false).expect("the principal moves the bound");
    assert_eq!(Mandate::try_from_bytes(&m).unwrap().limit, 1_000);
}

// ── legacy accounts fail closed ─────────────────────────────────────────────

/// A mandate deployed before binding records no principal and no engine. It must
/// be inert: inventing either one would hand it to whoever the default names.
#[test]
fn a_pre_binding_mandate_can_neither_authorize_spend_nor_amend() {
    let pid = mitra_vault::program_id();
    let k = keys(130);
    let mut legacy = bound_mandate(k).to_bytes().to_vec();
    legacy.truncate(MANDATE_LEN_PRE_BINDING);

    let (r, _) = authorize(&pid, k.engine, &legacy, [8u8; 32], 1, k.payee);
    assert_eq!(r.unwrap_err(), err::custom(err::MANDATE_UNBOUND));

    let permit = Authorization {
        holder: k.holder, action_hash: [8u8; 32], amount: 1, mandate_version: 1,
        expires_at: NOW + 10, consumed: false, bump: 254, recipient: k.payee,
    }.to_bytes();
    let mut vault = vault_of(&pid, k.principal);
    let s = spend(&pid, k.payee, &mut vault, &permit, &legacy, [8u8; 32]);
    assert_eq!(s.result.unwrap_err(), err::custom(err::MANDATE_UNBOUND));
    assert_eq!(s.paid, 0);

    for (signer, revoke) in [(k.holder, true), (k.holder, false), (k.principal, false)] {
        assert_eq!(amend(&pid, signer, &mut legacy, 1, revoke).unwrap_err(), err::custom(err::MANDATE_UNBOUND));
    }
}

#[test]
fn a_mandate_must_name_a_real_policy_engine() {
    // The all-zero key is the system program's id. A mandate naming it as its
    // engine would be either dead or, under a future bug, everyone's.
    let pid = mitra_vault::program_id();
    let k = keys(140);
    let mut vault = vault_of(&pid, k.principal);
    let (r, _) = open_mandate(&pid, k.principal, true, k.holder, &mut vault, Pubkey::default());
    assert_eq!(r.unwrap_err(), ProgramError::InvalidArgument);
}

// ── the reseed (sprint item 7): one holder, two principals ──────────────────

/// After the mandate reseed, one agent can hold mandates from several principals.
/// A permit then has to be bound to the MANDATE that issued it, not only to the
/// holder: otherwise principal A's engine could issue a permit for the shared
/// holder and spend it against principal B's mandate, draining B's vault — F51's
/// confused deputy, re-opened by the reseed itself. Found before the redeploy.
#[test]
fn a_permit_from_one_principals_mandate_cannot_spend_another_principals_vault_through_a_shared_holder() {
    let pid = mitra_vault::program_id();
    let attacker = keys(60);
    let victim = keys(80);
    let shared_holder = attacker.holder;
    let mut attacker_vault = vault_of(&pid, attacker.principal);
    let mut victim_vault = vault_of(&pid, victim.principal);

    let (r, attacker_mandate) = open_mandate(&pid, attacker.principal, true, shared_holder, &mut attacker_vault, attacker.engine);
    r.expect("the attacker grants the shared holder a mandate over the attacker's own vault");
    let (r, victim_mandate) = open_mandate(&pid, victim.principal, true, shared_holder, &mut victim_vault, victim.engine);
    r.expect("after the reseed a second principal can grant the same holder");

    let action = [9u8; 32];
    let (r, permit) = authorize(&pid, attacker.engine, &attacker_mandate, action, LIMIT, attacker.payee);
    r.expect("the attacker's own engine may issue under the attacker's mandate");
    let permit_key = permit_key_for(&pid, &attacker_mandate, &action);

    let s = spend_at(&pid, attacker.payee, &mut victim_vault, permit_key, &permit, &victim_mandate, action);
    assert!(s.result.is_err(), "a permit issued under the attacker's mandate must not spend under the victim's");
    assert_eq!(s.paid, 0, "nothing may leave the victim's vault");
    assert_eq!(s.vault_available, FUNDED);
    assert!(!s.permit_consumed, "a refused spend must not burn the permit");

    // The same permit, with the mandate that issued it, still works.
    let s = spend(&pid, attacker.payee, &mut attacker_vault, &permit, &attacker_mandate, action);
    s.result.expect("the permit is valid under its own mandate");
    assert_eq!(s.paid, LIMIT);
}

/// Defence in depth: a mandate the program did not create at its canonical
/// (principal, holder) address is refused by `authorize` and `spend_authorized`,
/// even though program ownership is satisfied. No honest flow produces such an
/// account today; the check is what keeps a future migration or bug that writes a
/// mandate elsewhere from becoming a second, unchecked mandate for a holder.
#[test]
fn a_program_owned_mandate_at_a_non_canonical_address_is_refused() {
    let pid = mitra_vault::program_id();
    let k = keys(150);
    let mut vault = vault_of(&pid, k.principal);
    let mandate = bound_mandate(k).to_bytes().to_vec();
    let elsewhere = Pubkey::new_unique();

    let (r, _) = authorize_at(&pid, k.engine, elsewhere, &mandate, [3u8; 32], 1, k.payee);
    assert_eq!(r.unwrap_err(), ProgramError::InvalidSeeds);

    // A permit legitimately issued under the canonical mandate, presented with the
    // same mandate's bytes at a non-canonical address.
    let (r, permit) = authorize(&pid, k.engine, &mandate, [3u8; 32], 1, k.payee);
    r.expect("the canonical mandate authorizes");
    let akey = permit_key_for(&pid, &mandate, &[3u8; 32]);
    let s = spend_with_mandate_at(&pid, k.payee, &mut vault, akey, &permit, elsewhere, &mandate, [3u8; 32]);
    assert_eq!(s.result.unwrap_err(), ProgramError::InvalidSeeds);
    assert_eq!(s.paid, 0);
}

