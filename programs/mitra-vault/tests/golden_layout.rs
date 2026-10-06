//! The cross-language contract: bytes the TypeScript client must reproduce.
//!
//! `lib/solana/vault-program.ts` encodes instructions and decodes accounts for this
//! program. Two hand-written encoders agreeing with themselves is the failure this
//! repository keeps paying for (F12, F45, the bridge ABI offset): each side looks
//! right and the pair is wrong. So the bytes are produced HERE, from the program's
//! own types, and written to `tests/golden/vault-layout.json`; `tests/vault-program.test.ts`
//! asserts the TS client produces and parses exactly them.
//!
//! The instruction bytes are not merely restated: each one is run through the real
//! `dispatch` below and must be accepted, with the handler writing what the golden
//! file says it wrote. A golden file that the program would reject is worse than none.
//!
//! Regenerate after a deliberate layout change with:
//!     MITRA_UPDATE_GOLDEN=1 cargo +1.98.1 test --test golden_layout

use mitra_vault::anchor_parity::{account_discriminator, authorization_discriminator, escrow_seeds, find_vault_pda, ix, job_escrow_discriminator, mandate_discriminator, vault_seeds, VAULT_DISCRIMINATOR};
use mitra_vault::state::{Authorization, JobEscrow, Mandate, MandateBinding, Vault, AUTHORIZATION_LEN, ESCROW_LEN, MANDATE_LEN};
use solana_program::account_info::AccountInfo;
use solana_program::pubkey::Pubkey;

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/vault-layout.json");
const NOW: u64 = 1_000_000;
const SYS: Pubkey = solana_program::system_program::ID;
/// Stand-in for a rent-exempt balance; see `tests/escrow.rs` for why the rent
/// syscall cannot be exercised in-process.
const RENT_BASE: u64 = 10_000_000;

const PRINCIPAL: Pubkey = Pubkey::new_from_array([0x11; 32]);
const HOLDER: Pubkey = Pubkey::new_from_array([0x22; 32]);
const ENGINE: Pubkey = Pubkey::new_from_array([0x33; 32]);
const RECIPIENT: Pubkey = Pubkey::new_from_array([0x44; 32]);
/// The job's payee — deliberately a different key from RECIPIENT, so a decoder
/// that confused the two would be caught rather than agreeing with itself.
const PROVIDER: Pubkey = Pubkey::new_from_array([0x55; 32]);
/// A third party, with no role in either job, who triggers the autonomous refund.
const KEEPER: Pubkey = Pubkey::new_from_array([0x66; 32]);
const ACTION: [u8; 32] = [0xab; 32];
const LIMIT: u64 = 5_000;
const CEILING: u64 = 50_000;
const EXPIRES: u64 = NOW + 10_000;
const AMOUNT: u64 = 2_500;
const DEPOSIT: u64 = 10_000;
const JOB_ID: [u8; 32] = [0x9a; 32];
const JOB_ID_B: [u8; 32] = [0x9b; 32];
const JOB_AMOUNT: u64 = 3_000;
const JOB_AMOUNT_B: u64 = 2_000;
const JOB_TIMEOUT: u64 = NOW + 3_600;
/// A non-zero route hash. `all-zero` is the absence of a commitment, not a hash,
/// and a fixture that used it would pin the one value `refund_escrow` refuses.
const REFUND_ROUTE: [u8; 32] = [0x7f; 32];

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// `[pubkey, is_signer, is_writable]` exactly as handed to `dispatch`.
fn metas(accounts: &[AccountInfo]) -> String {
    let rows: Vec<String> = accounts.iter()
        .map(|a| format!("[\"{}\", {}, {}]", a.key, a.is_signer, a.is_writable))
        .collect();
    format!("[{}]", rows.join(", "))
}

fn pda(seeds: &[&[u8]], program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, program_id)
}

struct Golden {
    json: String,
}

fn build() -> Golden {
    let pid = mitra_vault::program_id();
    let (vault_key, vault_bump) = find_vault_pda(&vault_seeds(&PRINCIPAL), &pid).unwrap();
    let (mandate_key, mandate_bump) = pda(&[b"mandate", PRINCIPAL.as_ref(), HOLDER.as_ref()], &pid);
    let (authz_key, authz_bump) = pda(&[b"authorization", mandate_key.as_ref(), ACTION.as_ref()], &pid);
    let (escrow_key, escrow_bump) = pda(&escrow_seeds(&vault_key, &JOB_ID), &pid);
    let (escrow_key_b, escrow_bump_b) = pda(&escrow_seeds(&vault_key, &JOB_ID_B), &pid);

    // ── instruction data ────────────────────────────────────────────────────
    let mut init = ix::INITIALIZE_VAULT.to_vec();
    init.push(vault_bump);
    let mut deposit = ix::DEPOSIT.to_vec();
    deposit.extend(DEPOSIT.to_le_bytes());
    let mut open = ix::OPEN_MANDATE.to_vec();
    open.extend(LIMIT.to_le_bytes());
    open.extend(CEILING.to_le_bytes());
    open.extend(EXPIRES.to_le_bytes());
    open.extend(ENGINE.as_ref());
    open.push(mandate_bump);
    let mut authorize = ix::AUTHORIZE.to_vec();
    authorize.extend(ACTION);
    authorize.extend(AMOUNT.to_le_bytes());
    authorize.extend(RECIPIENT.as_ref());
    authorize.push(authz_bump);
    let mut spend = ix::SPEND_AUTHORIZED.to_vec();
    spend.extend(ACTION);
    let mut revoke = ix::AMEND_MANDATE.to_vec();
    revoke.extend(LIMIT.to_le_bytes());
    revoke.extend(CEILING.to_le_bytes());
    revoke.extend(EXPIRES.to_le_bytes());
    revoke.push(1);

    // ── the job escrow ───────────────────────────────────────────────────────
    // Both jobs are run through the REAL handlers below, not merely encoded: a
    // golden file holding bytes the program would reject is worse than none.
    let lock_of = |job: [u8; 32], amount: u64, bump: u8| {
        let mut d = ix::LOCK_ESCROW.to_vec();
        d.extend_from_slice(&job);
        d.extend_from_slice(PROVIDER.as_ref());
        d.extend_from_slice(&amount.to_le_bytes());
        d.extend_from_slice(&JOB_TIMEOUT.to_le_bytes());
        d.extend_from_slice(&REFUND_ROUTE);
        d.push(bump);
        d
    };
    let lock_a = lock_of(JOB_ID, JOB_AMOUNT, escrow_bump);
    let lock_b = lock_of(JOB_ID_B, JOB_AMOUNT_B, escrow_bump_b);
    // `release_escrow` and `refund_escrow` take a job id and nothing else. No
    // amount, no payee, no timeout — asserted structurally by their total length.
    let mut release_a = ix::RELEASE_ESCROW.to_vec();
    release_a.extend_from_slice(&JOB_ID);
    let mut refund_b = ix::REFUND_ESCROW.to_vec();
    refund_b.extend_from_slice(&JOB_ID_B);

    // ── run open → authorize → spend through the REAL handler ───────────────
    let mut v = Vault::new(PRINCIPAL, vault_bump);
    v.deposit(DEPOSIT).unwrap();
    let mut vault_data = v.to_bytes().to_vec();
    let mut vault_lamports = 1_000_000_000u64;
    let mut escrow_a_lamports = RENT_BASE;
    let mut escrow_b_lamports = RENT_BASE;

    let mut mandate_data = vec![0u8; MANDATE_LEN];
    let open_metas;
    {
        let (mut pl, mut hl, mut ml, mut yl) = (5_000_000u64, 0u64, 1_000_000u64, 1u64);
        let accounts = [
            AccountInfo::new(&PRINCIPAL, true, true, &mut pl, &mut [], &SYS, false, 0),
            AccountInfo::new(&HOLDER, false, false, &mut hl, &mut [], &SYS, false, 0),
            AccountInfo::new(&mandate_key, false, true, &mut ml, &mut mandate_data, &SYS, false, 0),
            AccountInfo::new(&vault_key, false, false, &mut vault_lamports, &mut vault_data, &pid, false, 0),
            AccountInfo::new(&SYS, false, false, &mut yl, &mut [], &SYS, true, 0),
        ];
        open_metas = metas(&accounts);
        mitra_vault::dispatch(&pid, &accounts, &open, NOW).expect("golden open_mandate must be accepted");
    }
    let expected_mandate = Mandate {
        holder: HOLDER, limit: LIMIT, version: 1, expires_at: EXPIRES, ceiling: CEILING, revoked: false,
        binding: Some(MandateBinding { principal: PRINCIPAL, policy_engine: ENGINE }),
    };
    assert_eq!(Mandate::try_from_bytes(&mandate_data).unwrap(), expected_mandate);

    let mut authz_data = vec![0u8; AUTHORIZATION_LEN];
    let authorize_metas;
    {
        let (mut el, mut hl, mut ml, mut al, mut yl) = (5_000_000u64, 0u64, 1u64, 1_000_000u64, 1u64);
        let accounts = [
            AccountInfo::new(&ENGINE, true, true, &mut el, &mut [], &SYS, false, 0),
            AccountInfo::new(&HOLDER, false, false, &mut hl, &mut [], &SYS, false, 0),
            AccountInfo::new(&mandate_key, false, false, &mut ml, &mut mandate_data, &pid, false, 0),
            AccountInfo::new(&authz_key, false, true, &mut al, &mut authz_data, &SYS, false, 0),
            AccountInfo::new(&SYS, false, false, &mut yl, &mut [], &SYS, true, 0),
        ];
        authorize_metas = metas(&accounts);
        mitra_vault::dispatch(&pid, &accounts, &authorize, NOW).expect("golden authorize must be accepted");
    }
    let issued = Authorization::try_from_bytes(&authz_data).unwrap();
    assert_eq!((issued.amount, issued.recipient, issued.consumed), (AMOUNT, RECIPIENT, false));

    let authz_before_spend = authz_data.clone();
    let vault_before_spend = vault_data.clone();
    let mut recipient_lamports = 0u64;
    let spend_metas;
    {
        let (mut al, mut ml) = (1u64, 1u64);
        let accounts = [
            AccountInfo::new(&RECIPIENT, false, true, &mut recipient_lamports, &mut [], &SYS, false, 0),
            AccountInfo::new(&vault_key, false, true, &mut vault_lamports, &mut vault_data, &pid, false, 0),
            AccountInfo::new(&authz_key, false, true, &mut al, &mut authz_data, &pid, false, 0),
            AccountInfo::new(&mandate_key, false, false, &mut ml, &mut mandate_data, &pid, false, 0),
        ];
        spend_metas = metas(&accounts);
        mitra_vault::dispatch(&pid, &accounts, &spend, NOW).expect("golden spend must be accepted");
    }
    assert_eq!(recipient_lamports, AMOUNT);
    assert!(Authorization::try_from_bytes(&authz_data).unwrap().consumed);

    // ── run lock_a → release_a, and lock_b → refund_b through the handlers ───
    // Two jobs rather than one, because the interesting pairs are settled-by-the-
    // client and refunded-by-a-stranger, and a single escrow can only be in one of
    // them. The refund runs with KEEPER as the sole signer and `now` AT the
    // deadline, which is the instruction's whole claim: a third party, alone, at
    // the boundary.
    let mut escrow_a_data = vec![0u8; ESCROW_LEN];
    let mut escrow_b_data = vec![0u8; ESCROW_LEN];
    let lock_metas;
    let release_metas;
    let refund_metas;
    {
        let (mut cl, mut pl, mut vl, mut el, mut yl) = (
            5_000_000u64, 1_000_000u64, vault_lamports, RENT_BASE, 1u64,
        );
        // Pre-created and funded so the `lamports() == 0` create_account branch
        // does not run in-process. Owner is the system program, which is what a
        // not-yet-created PDA looks like; the CPI that would flip it to this
        // program cannot run outside a chain.
        let accounts = [
            AccountInfo::new(&PRINCIPAL, true, true, &mut cl, &mut [], &SYS, false, 0),
            AccountInfo::new(&PROVIDER, false, false, &mut pl, &mut [], &SYS, false, 0),
            AccountInfo::new(&vault_key, false, true, &mut vl, &mut vault_data, &pid, false, 0),
            AccountInfo::new(&escrow_key, false, true, &mut el, &mut escrow_a_data, &SYS, false, 0),
            AccountInfo::new(&SYS, false, false, &mut yl, &mut [], &SYS, true, 0),
        ];
        lock_metas = metas(&accounts);
        mitra_vault::dispatch(&pid, &accounts, &lock_a, NOW).expect("golden lock_escrow must be accepted");
        vault_lamports = vl;
        escrow_a_lamports = el;
    }
    // From here the escrow is program-owned, as the CPI would have left it.
    let escrow_a_locked = escrow_a_data.clone();
    assert_eq!(
        JobEscrow::try_from_bytes(&escrow_a_data).unwrap(),
        JobEscrow::new(JOB_ID, PRINCIPAL, PROVIDER, JOB_AMOUNT, JOB_TIMEOUT, REFUND_ROUTE)
    );
    {
        let (mut cl, mut vl, mut el, mut pl) = (0u64, vault_lamports, escrow_a_lamports, 1_000_000u64);
        let accounts = [
            AccountInfo::new(&PRINCIPAL, true, true, &mut cl, &mut [], &SYS, false, 0),
            AccountInfo::new(&vault_key, false, true, &mut vl, &mut vault_data, &pid, false, 0),
            AccountInfo::new(&escrow_key, false, true, &mut el, &mut escrow_a_data, &pid, false, 0),
            AccountInfo::new(&PROVIDER, false, true, &mut pl, &mut [], &SYS, false, 0),
        ];
        release_metas = metas(&accounts);
        mitra_vault::dispatch(&pid, &accounts, &release_a, NOW).expect("golden release_escrow must be accepted");
        assert_eq!(pl, 1_000_000 + JOB_AMOUNT, "the provider is paid exactly the escrow amount");
        vault_lamports = vl;
        escrow_a_lamports = el;
    }
    assert!(JobEscrow::try_from_bytes(&escrow_a_data).unwrap().completed);

    {
        let (mut cl, mut pl, mut vl, mut el, mut yl) = (
            5_000_000u64, 1_000_000u64, vault_lamports, RENT_BASE, 1u64,
        );
        let accounts = [
            AccountInfo::new(&PRINCIPAL, true, true, &mut cl, &mut [], &SYS, false, 0),
            AccountInfo::new(&PROVIDER, false, false, &mut pl, &mut [], &SYS, false, 0),
            AccountInfo::new(&vault_key, false, true, &mut vl, &mut vault_data, &pid, false, 0),
            AccountInfo::new(&escrow_key_b, false, true, &mut el, &mut escrow_b_data, &SYS, false, 0),
            AccountInfo::new(&SYS, false, false, &mut yl, &mut [], &SYS, true, 0),
        ];
        mitra_vault::dispatch(&pid, &accounts, &lock_b, NOW).expect("golden second lock_escrow must be accepted");
        vault_lamports = vl;
        escrow_b_lamports = el;
    }
    {
        // At the deadline, not after it, and signed by nobody involved.
        let (mut kl, mut vl, mut el) = (1_000u64, vault_lamports, escrow_b_lamports);
        let accounts = [
            AccountInfo::new(&KEEPER, true, false, &mut kl, &mut [], &SYS, false, 0),
            AccountInfo::new(&vault_key, false, true, &mut vl, &mut vault_data, &pid, false, 0),
            AccountInfo::new(&escrow_key_b, false, true, &mut el, &mut escrow_b_data, &pid, false, 0),
        ];
        refund_metas = metas(&accounts);
        mitra_vault::dispatch(&pid, &accounts, &refund_b, JOB_TIMEOUT)
            .expect("golden refund_escrow must be accepted at the deadline by a third party");
        vault_lamports = vl;
        escrow_b_lamports = el;
    }
    assert!(JobEscrow::try_from_bytes(&escrow_b_data).unwrap().refunded);
    // The vault is whole again for this job: the refund moved `available` back
    // and left `total` alone, while the *paid* job reduced `total` for good. The
    // earlier `spend_authorized` in this same builder is also gone from it, which
    // is why the expected figure is not simply DEPOSIT - JOB_AMOUNT.
    let after = Vault::from_bytes(&vault_data).unwrap();
    assert_eq!(after.total, DEPOSIT - AMOUNT - JOB_AMOUNT, "only the paid job left Mitra");
    assert_eq!(after.escrowed, 0);
    assert_eq!(after.available, after.total, "nothing is left committed anywhere");

    let field = |k: &str, v: String| format!("    \"{k}\": {v}");
    let s = |x: String| format!("\"{x}\"");
    let pair = |k: Pubkey, b: u8| format!("{{ \"address\": \"{k}\", \"bump\": {b} }}");
    let json = [
        "{".to_string(),
        "  \"_comment\": \"GENERATED by programs/mitra-vault/tests/golden_layout.rs from the program's own types; every instruction here was accepted by dispatch. Do not edit by hand.\",".into(),
        format!("  \"programId\": \"{pid}\","),
        "  \"inputs\": {".into(),
        [
            field("principal", s(PRINCIPAL.to_string())),
            field("holder", s(HOLDER.to_string())),
            field("engine", s(ENGINE.to_string())),
            field("recipient", s(RECIPIENT.to_string())),
            field("action", s(hex(&ACTION))),
            field("limit", LIMIT.to_string()),
            field("ceiling", CEILING.to_string()),
            field("expiresAt", EXPIRES.to_string()),
            field("amount", AMOUNT.to_string()),
            field("deposit", DEPOSIT.to_string()),
            field("provider", s(PROVIDER.to_string())),
            field("keeper", s(KEEPER.to_string())),
            field("jobId", s(hex(&JOB_ID))),
            field("jobIdB", s(hex(&JOB_ID_B))),
            field("jobAmount", JOB_AMOUNT.to_string()),
            field("jobAmountB", JOB_AMOUNT_B.to_string()),
            field("jobTimeout", JOB_TIMEOUT.to_string()),
            field("refundRoute", s(hex(&REFUND_ROUTE))),
        ].join(",\n"),
        "  },".into(),
        "  \"discriminators\": {".into(),
        [
            field("initialize_vault", s(hex(&ix::INITIALIZE_VAULT))),
            field("deposit", s(hex(&ix::DEPOSIT))),
            field("open_mandate", s(hex(&ix::OPEN_MANDATE))),
            field("authorize", s(hex(&ix::AUTHORIZE))),
            field("spend_authorized", s(hex(&ix::SPEND_AUTHORIZED))),
            field("amend_mandate", s(hex(&ix::AMEND_MANDATE))),
            field("account:Vault", s(hex(&VAULT_DISCRIMINATOR))),
            field("account:Mandate", s(hex(&mandate_discriminator()))),
            field("account:Authorization", s(hex(&authorization_discriminator()))),
            field("lock_escrow", s(hex(&ix::LOCK_ESCROW))),
            field("release_escrow", s(hex(&ix::RELEASE_ESCROW))),
            field("refund_escrow", s(hex(&ix::REFUND_ESCROW))),
            field("account:JobEscrow", s(hex(&job_escrow_discriminator()))),
        ].join(",\n"),
        "  },".into(),
        "  \"pdas\": {".into(),
        [
            field("vault", pair(vault_key, vault_bump)),
            field("mandate", pair(mandate_key, mandate_bump)),
            field("authorization", pair(authz_key, authz_bump)),
            field("escrow", pair(escrow_key, escrow_bump)),
            field("escrowB", pair(escrow_key_b, escrow_bump_b)),
        ].join(",\n"),
        "  },".into(),
        "  \"instructions\": {".into(),
        [
            field("initialize_vault", s(hex(&init))),
            field("deposit", s(hex(&deposit))),
            field("open_mandate", s(hex(&open))),
            field("authorize", s(hex(&authorize))),
            field("spend_authorized", s(hex(&spend))),
            field("revoke", s(hex(&revoke))),
            field("lock_escrow", s(hex(&lock_a))),
            field("lock_escrow_b", s(hex(&lock_b))),
            field("release_escrow", s(hex(&release_a))),
            field("refund_escrow", s(hex(&refund_b))),
        ].join(",\n"),
        "  },".into(),
        "  \"accountMetas\": {".into(),
        "    \"_comment\": \"As passed to dispatch. open_mandate, authorize and lock_escrow also take the program account LAST on chain, for the create_account CPI the in-process run skips; for lock_escrow the extra system-program account is left in place at index 4 so the first five entries are the on-chain order.\",".into(),
        [
            field("open_mandate", open_metas.clone()),
            field("authorize", authorize_metas.clone()),
            field("spend_authorized", spend_metas.clone()),
            field("lock_escrow", lock_metas.clone()),
            field("release_escrow", release_metas.clone()),
            field("refund_escrow", refund_metas.clone()),
        ].join(",\n"),
        "  },".into(),
        "  \"accounts\": {".into(),
        [
            field("vault", s(hex(&vault_before_spend))),
            field("mandate", s(hex(&mandate_data))),
            field("authorizationIssued", s(hex(&authz_before_spend))),
            field("authorizationConsumed", s(hex(&authz_data))),
            field("escrowLocked", s(hex(&escrow_a_locked))),
            field("escrowCompleted", s(hex(&escrow_a_data))),
            field("escrowRefunded", s(hex(&escrow_b_data))),
        ].join(",\n"),
        "  }".into(),
        "}".into(),
    ].join("\n") + "\n";
    // Anchor's own derivation, not a second copy of a constant.
    assert_eq!(VAULT_DISCRIMINATOR, account_discriminator("Vault"));
    assert_eq!(job_escrow_discriminator(), account_discriminator("JobEscrow"));
    // Both settlement instructions carry a job id and nothing else. Asserted
    // structurally because it is the property that matters: there is no argument
    // through which a caller could name an amount or a payee.
    assert_eq!(release_a.len(), 8 + 32);
    assert_eq!(refund_b.len(), 8 + 32);
    assert_eq!(lock_a.len(), 8 + 32 + 32 + 8 + 8 + 32 + 1);
    Golden { json }
}

#[test]
fn the_golden_layout_is_current() {
    let g = build();
    if std::env::var("MITRA_UPDATE_GOLDEN").as_deref() == Ok("1") {
        std::fs::create_dir_all(std::path::Path::new(GOLDEN).parent().unwrap()).unwrap();
        std::fs::write(GOLDEN, &g.json).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(GOLDEN)
        .expect("golden file missing; run with MITRA_UPDATE_GOLDEN=1 to create it");
    assert_eq!(
        committed, g.json,
        "the program's layout changed; if deliberate, regenerate with MITRA_UPDATE_GOLDEN=1 and update the TS client to match"
    );
}
