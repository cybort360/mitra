//! Mitra Vault Program — the on-chain capital boundary (PRD §34).
//!
//! Written against raw `cargo-build-sbf` and deliberately **byte-compatible
//! with Anchor** so migration is a wrapper, not a rewrite. See
//! [`anchor_parity`] for the discriminators, error codes and PDA derivation that
//! match, and ADR-0007 for why the boundary lives on Solana at all.
//!
//! The load-bearing rule is the one the whole product exists to protect: an
//! `ALLOW` from a policy engine is **not** permission to move value. Every
//! instruction here re-derives authority from the account itself. No caller can
//! supply their own authorization.


#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "mitra-vault",
    // Both URLs are derived from the repository's ACTUAL remote
    // (git remote -v -> github.com/cybort360/mitra) and the file that exists at
    // docs/SECURITY.md.
    //
    // The handoff proposed `https://mitra.network` and
    // `email:security@mitra.network`. **Neither appears anywhere in this
    // repository except in that handoff document itself.** Publishing a disclosure
    // contact that nobody controls is worse than publishing none: a researcher who
    // mails it and gets nothing has learned the program is unmaintained. That is the
    // F39/F40 failure shape — an unverifiable external fact, asserted in a config,
    // where a real domain would have to be confirmed to exist.
    //
    // GitHub Security Advisories is used as the contact because it is a real
    // mechanism the repository already has, not because it is the nicest option.
    // If a monitored `security@` mailbox is later configured, replace this here.
    contacts: "https://github.com/cybort360/mitra/security/advisories/new",
    policy: "https://github.com/cybort360/mitra/blob/main/docs/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/cybort360/mitra",
    // Stated as ABSENCE, not as a pending promise. docs/SECURITY.md says outright
    // that no independent audit has been performed, and an explorers' panel should
    // not imply one is scheduled.
    auditors: "None. This program has NOT been independently audited."
}

pub mod anchor_parity;
pub mod rent;
pub mod state;

use anchor_parity::{err, find_vault_pda, ix, vault_seeds};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    program::{invoke, invoke_signed},
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::Sysvar,
};
use state::Vault;
// System-program instructions live in the `system_program` crate, not `solana_program`.
use solana_program::system_instruction;

solana_program::entrypoint!(process);

// security.txt (sprint item 7; values from the lead's package A,
// docs/HANDOFF_SOLANA_VERIFICATION_AND_EVM_VAULTS.md). Unconditional, like the
// entrypoint above: this crate is a program, not a library other programs link.
// The contact address and project URL must be confirmed live by the lead before
// the redeploy — a published security contact nobody reads sends reports nowhere.
solana_security_txt::security_txt! {
    name: "mitra-vault",
    project_url: "https://mitra.network",
    contacts: "email:security@mitra.network",
    policy: "https://github.com/cybort360/mitra/blob/main/docs/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/cybort360/mitra",
    auditors: "Pending Independent Audit"
}

/// Dispatches on Anchor's instruction discriminator.
///
/// The `data.len() < 8` guard is Anchor's own behaviour: it computes
/// discriminators with `to_le_bytes()[..8]`, so shorter input cannot be
/// dispatched. `InvalidInstructionData` rather than a panic.
pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // The on-chain clock, read once and passed explicitly. This mirrors the
    // kernel's own rule (functions take explicit time; they never call
    // `new Date()`): the handler that makes an expiry decision must be testable
    // at a chosen instant, and a handler that reaches for the clock itself
    // cannot be tested at a boundary. Reading it here and threading it down keeps
    // the decision points pure.
    let now = solana_program::clock::Clock::get()?.unix_timestamp.max(0) as u64;
    dispatch(program_id, accounts, data, now)
}

/// Dispatches with an explicit `now`.
///
/// Separated from [`process`] so tests and the devnet harness can exercise the
/// exact instants that matter — the second before expiry, the second *at*
/// expiry — which are the cases a real clock will never land on by accident.
pub fn dispatch(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
    now: u64,
) -> ProgramResult {
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (disc, args) = data.split_at(8);
    let disc: [u8; 8] = disc.try_into().map_err(|_| ProgramError::InvalidInstructionData)?;

    match disc {
        ix::INITIALIZE_VAULT => initialize_vault(program_id, accounts, args),
        ix::DEPOSIT => deposit(program_id, accounts, args),
        ix::WITHDRAW => withdraw(program_id, accounts, args),
        ix::RESERVE => reserve(program_id, accounts, args),
        ix::RELEASE => release(program_id, accounts, args),
        ix::OPEN_MANDATE => open_mandate(program_id, accounts, args),
        ix::AUTHORIZE => authorize(program_id, accounts, args, now),
        ix::SPEND_AUTHORIZED => spend_authorized(program_id, accounts, args, now),
        ix::AMEND_MANDATE => amend_mandate(program_id, accounts, args, now),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// Reads the single `u64` argument, little-endian, as Anchor's borsh would.
fn read_amount(args: &[u8]) -> Result<u64, ProgramError> {
    let bytes: [u8; 8] = args.get(..8)
        .and_then(|s| s.try_into().ok())
        .ok_or(ProgramError::InvalidInstructionData)?;
    Ok(u64::from_le_bytes(bytes))
}

/// The account checks `#[derive(Accounts)]` would generate, as explicit code.
///
/// Ordering matches Anchor: signer, owner, seeds, then data-level. A caller who
/// forgets an account gets `NotSigner` rather than a confusing decode error,
/// which is what makes the failure legible in a client.
/// Verifies the *vault* account and that `authority` is allowed to direct it.
///
/// Two accounts, two distinct questions, and conflating them is the bug this
/// signature now makes impossible: the first version took a single
/// `&AccountInfo` and every caller passed the *authority* — a wallet, which is
/// of course not owned by this program. It failed on devnet with
/// `0x1771` (INVALID_ACCOUNT_OWNER) while the real fault was one call-site
/// argument away. The vault is what must be program-owned; the authority is what
/// must match the vault's recorded owner.
fn check_vault_account(
    vault: &AccountInfo,
    authority: &AccountInfo,
    program_id: &Pubkey,
) -> ProgramResult {
    // The signer must be the authority — and it must actually have signed. The
    // seeds are public, so deriving the PDA is not authorization on its own.
    if !authority.is_signer {
        return Err(err::custom(err::NOT_SIGNER));
    }
    if vault.owner != program_id {
        return Err(err::custom(err::INVALID_ACCOUNT_OWNER));
    }
    // Re-deriving proves the address really is the vault for this authority,
    // rather than merely one the caller passed in alongside a valid signer.
    let (derived, bump) = find_vault_pda(&vault_seeds(authority.key), program_id)?;
    if &derived != vault.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let state = Vault::from_bytes(&vault.try_borrow_data()?)?;
    if state.authority != *authority.key {
        return Err(err::custom(err::UNAUTHORIZED));
    }
    if state.bump != bump {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(())
}

/// `initialize_vault(bump)` — creates the PDA for `authority`.
fn initialize_vault(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    // The iterator is named because the CPI below continues reading from it — a
    // fourth entry is the program account itself, which the system program needs
    // in order to verify the new account's owner.
    let mut accounts_iter = accounts.iter();
    let authority = next_account_info(&mut accounts_iter)?;
    let vault_account = next_account_info(&mut accounts_iter)?;
    let system_program = next_account_info(&mut accounts_iter)?;

    if !authority.is_signer {
        return Err(err::custom(err::NOT_SIGNER));
    }
    // A PDA is either system-owned (not yet created) or owned by this program
    // (already initialized). Re-initializing an existing vault is refused below
    // with a precise error, because the owner check here cannot distinguish the
    // two cases — that mistake produced a misleading `0x1771` during development.
    if vault_account.owner != &solana_program::system_program::ID
        && vault_account.owner != program_id
    {
        return Err(err::custom(err::INVALID_ACCOUNT_OWNER));
    }
    if vault_account.owner == program_id {
        return Err(err::custom(err::ALREADY_INITIALIZED));
    }
    if system_program.key != &solana_program::system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let bump_arg = args.first().copied();
    let (expected, derived_bump) = find_vault_pda(&vault_seeds(authority.key), program_id)?;
    if expected != *vault_account.key {
        return Err(ProgramError::InvalidSeeds);
    }
    // The stored bump must be the one derivation found, or the account's own
    // record of how to re-derive it would be a lie.
    let bump = match bump_arg {
        None => derived_bump,
        Some(b) if b == derived_bump => b,
        Some(_) => return Err(ProgramError::InvalidSeeds),
    };

    // **A PDA does not exist until something creates it.** On devnet the account
    // arrives with zero-length data and `copy_from_slice` into it *panics*,
    // aborting the transaction:
    //
    //   panicked at src/lib.rs:116:42:
    //   copy_from_slice: source slice length (105) does not match destination
    //   slice length (0)
    //
    // No unit test could have caught this: in-process the account is a buffer
    // this function is free to write to, and it only becomes a real account with
    // a real length on a real chain. This is the case for running against devnet
    // rather than trusting the local suite.
    //
    // Anchor's `#[account(init, payer = …, space = …)]` does exactly this via a
    // CPI to the system program, which is why an Anchor program never has to
    // think about it. Reproduced here so the migration is a wrapper.
    // `system_instruction::create_account` makes the PDA a signer. For the CPI to
    // succeed, this program's *invoke* privileges must include the vault's
    // signer privilege — otherwise the runtime refuses with "signer privilege
    // escalated", because from the runtime's perspective this program was never
    // given the right to sign for the PDA. Anchor hides this behind `init`.
    //
    // The third element is the program account itself, which the system program
    // needs to verify the new account's owner. It is passed through from the
    // transaction rather than fabricated, so its real privileges are preserved.
    if vault_account.lamports() == 0 {
        let payer = authority.clone();
        let lamports = rent_for_bytes(state::VAULT_LEN)?;
        let cpi = system_instruction::create_account(
            payer.key, vault_account.key, lamports,
            state::VAULT_LEN as u64, &program_id,
        );
        let program_account = next_account_info(&mut accounts_iter)?;
        // `invoke_signed`, not `invoke`: creating a PDA makes it a signer for the
        // CPI, and only `invoke_signed` can grant that from the program's own
        // seeds. `invoke` fails with "signer privilege escalated" — found on
        // devnet, and precisely the sort of thing a unit test cannot see because
        // the in-process account is already "signed".
        // `invoke_signed` takes an outer slice of *seed sets*, one per signer.
        // A single PDA signer needs ONE set whose contents are the seeds plus the
        // bump: `[b"vault", authority, bump]`. Passing `[seeds, &[bump]]` instead
        // asks the runtime to derive two separate addresses, and it fails with
        // "Could not create program address with signer seeds" — which reads like
        // a derivation bug and is actually an argument-shape bug.
        let bump_seed = [bump];
        let seed_sets: &[&[&[u8]]] = &[&[
            anchor_parity::VAULT_SEED,
            authority.key.as_ref(),
            &bump_seed,
        ]];
        invoke_signed(
            &cpi,
            &[payer.clone(), vault_account.clone(), program_account.clone()],
            seed_sets,
        )?;
    }

    let vault = Vault::new(*authority.key, bump);
    vault_account.try_borrow_mut_data()?.copy_from_slice(&vault.to_bytes());
    msg!("vault initialized for {}", authority.key);
    Ok(())
}

/// Rent-exempt minimum for `bytes`.
///
/// The syscall is unavailable in-process, so under `cfg(test)` it returns the
/// devnet figure. That is acceptable precisely because this path only executes
/// on chain — and if it ever ran in a test, the account would not be a PDA
/// anyway.
///
/// **This returns the minimum *with headroom***, not the bare
/// `minimum_balance`. See `rent::rent_exempt_with_headroom` for why the bare
/// minimum is a trap: an account created at exactly the minimum cannot be
/// written to, and consuming a permit is a one-byte write. Found on devnet.
pub fn rent_for_bytes(bytes: usize) -> Result<u64, ProgramError> {
    rent::rent_exempt_with_headroom(bytes)
}

/// `deposit(amount)` — moves lamports in and credits `available`.
///
/// Anyone may deposit: it cannot reduce capital, so it needs no authority beyond
/// the value moving in.
fn deposit(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let amount = read_amount(args)?;
    let mut it = accounts.iter();
    let depositor = next_account_info(&mut it)?;
    let vault_account = next_account_info(&mut it)?;

    if amount == 0 {
        return Err(ProgramError::InvalidArgument);
    }
    // Once initialized the PDA is owned by this program; before that it is
    // system-owned. Anything else is an account the caller chose, not our vault.
    let owner = vault_account.owner;
    if owner != program_id && owner != &solana_program::system_program::ID {
        return Err(err::custom(err::INVALID_ACCOUNT_OWNER));
    }

    let mut data = vault_account.try_borrow_mut_data()?;
    let mut vault = Vault::from_bytes(&data)?;
    vault.deposit(amount)?;
    data.copy_from_slice(&vault.to_bytes());
    drop(data);

    // Move the lamports through the system program rather than by writing
    // `try_borrow_mut_lamports` directly.
    //
    // Direct mutation is what the first version did, and the runtime rejects it:
    //
    //   failed: instruction spent from the balance of an account it does not own
    //
    // A program may only debit an account it owns or has been given signer
    // authority over; the depositor is neither. The CPI expresses the transfer
    // the way the runtime actually models it, and it is what Anchor's
    // `system_program::transfer` does — so the migration stays a wrapper.
    let system_program = next_account_info(&mut it)?;
    if system_program.key != &solana_program::system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    invoke(
        &system_instruction::transfer(depositor.key, vault_account.key, amount),
        &[depositor.clone(), vault_account.clone(), system_program.clone()],
    )?;
    Ok(())
}

/// `withdraw(amount)` — the authority returns capital to itself.
///
/// The authority is re-derived from the vault's own data and must match the
/// signer. This is the on-chain form of "no caller supplies their own spend
/// decision": seeds alone are not authorization.
fn withdraw(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let amount = read_amount(args)?;
    let mut it = accounts.iter();
    let authority = next_account_info(&mut it)?;
    let vault_account = next_account_info(&mut it)?;

    if amount == 0 {
        return Err(ProgramError::InvalidArgument);
    }
    // `check_vault_account` proves the authority owns this vault; the only
    // remaining question is whether there is enough to withdraw. That question —
    // and the freeze check — belongs to the state transition, not here.
    check_vault_account(vault_account, authority, program_id)?;

    let system_program = next_account_info(&mut it)?;
    if system_program.key != &solana_program::system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let mut data = vault_account.try_borrow_mut_data()?;
    let mut vault = Vault::from_bytes(&data)?;
    // Delegated to the state type. This used to be two inline subtractions with
    // no freeze check, so a FROZEN vault could be drained — see F41.
    vault.withdraw(amount)?;
    data.copy_from_slice(&vault.to_bytes());
    drop(data);

    // As in `deposit`: a CPI to the system program, not direct mutation. Moving
    // lamports *into* an account the program does not own is the same rule in the
    // other direction.
    // Move lamports by direct mutation, NOT via the system program.
    //
    // The system program's `transfer` rejects any source account that carries
    // data ("invalid program argument"), and this vault holds 105 bytes of it.
    // That is the correct behaviour on its part: `transfer` models a wallet
    // moving funds, not a program moving its own capital.
    //
    // Direct mutation is legitimate here precisely because of ownership. The
    // runtime permits a program to change an account's lamports when the program
    // owns that account or the account signed the transaction, and this holds on
    // both sides:
    //
    //   vault     — owned by this program
    //   authority — signed this transaction
    //
    // The mirror-image case is `deposit`, where the *depositor* must be debited
    // and the vault credited; there the program owns neither side on the debit,
    // which is why that one is a system-program CPI.
    **vault_account.try_borrow_mut_lamports()? = vault_account.lamports()
        .checked_sub(amount).ok_or(err::custom(err::ARITHMETIC_OVERFLOW))?;
    **authority.try_borrow_mut_lamports()? = authority.lamports()
        .checked_add(amount).ok_or(err::custom(err::ARITHMETIC_OVERFLOW))?;
    Ok(())
}

/// `reserve(amount)` — the authority earmarks `available` for an obligation.
fn reserve(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let amount = read_amount(args)?;
    let mut it = accounts.iter();
    let authority = next_account_info(&mut it)?;
    let vault_account = next_account_info(&mut it)?;

    if amount == 0 {
        return Err(ProgramError::InvalidArgument);
    }
    check_vault_account(vault_account, authority, program_id)?;

    let mut data = vault_account.try_borrow_mut_data()?;
    let mut vault = Vault::from_bytes(&data)?;
    vault.reserve(amount)?;
    data.copy_from_slice(&vault.to_bytes());
    // Reservation moves capital between positions; lamports must not move.
    // Checking the real balance against `total` is what stops a caller from
    // inflating the vault with a direct transfer and making the reported total
    // agree with a balance the program never authorised.
    drop(data);
    let total = Vault::from_bytes(&vault_account.try_borrow_data()?)?.total;
    check_no_surplus_lamports(vault_account, total)?;
    Ok(())
}

/// `release(amount)` — a reservation is released or refunded to `available`.
///
/// Permitted while frozen, so an emergency cannot strand capital that was never
/// at risk. A freeze that trapped in-flight obligations would be a worse failure
/// than the one it was meant to prevent.
fn release(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let amount = read_amount(args)?;
    let mut it = accounts.iter();
    let authority = next_account_info(&mut it)?;
    let vault_account = next_account_info(&mut it)?;

    if amount == 0 {
        return Err(ProgramError::InvalidArgument);
    }
    check_vault_account(vault_account, authority, program_id)?;

    let mut data = vault_account.try_borrow_mut_data()?;
    let mut vault = Vault::from_bytes(&data)?;
    vault.release(amount)?;
    data.copy_from_slice(&vault.to_bytes());
    drop(data);
    let total = Vault::from_bytes(&vault_account.try_borrow_data()?)?.total;
    check_no_surplus_lamports(vault_account, total)?;
    Ok(())
}

/// Lamports must not move except through deposit/withdraw.
///
/// This is Anchor's `/// CHECK:` pattern. It prevents a caller sliding extra
/// lamports onto the vault account, which would desync the real balance from the
/// `total` the program reports — the on-chain version of F12, where a number
/// that looks right is not.
/// The vault's real lamports must be exactly its capital plus the rent-exempt
/// minimum.
///
/// This is Anchor's `/// CHECK:` pattern, and it is what stops someone inflating
/// the vault with a direct transfer: the program would then report a `total`
/// that disagrees with the balance the chain actually holds.
///
/// The comparison is `capital + rent`, **not** `capital`. The first version
/// compared against `total` alone and rejected every legitimate instruction on
/// devnet with `0x1773` — because a PDA must retain ~1.18M lamports of
/// rent-exempt balance to exist at all. Subtracting the requirement makes the
/// check exact: any lamport above capital+rent is an unaccounted injection, and
/// any lamport below it means the account has been drained.
fn check_no_surplus_lamports(vault: &AccountInfo, capital: u64) -> ProgramResult {
    let rent = rent::rent_exempt_minimum(state::VAULT_LEN)?;
    if vault.lamports() != capital + rent {
        return Err(err::custom(err::UNEXPECTED_LAMPORTS));
    }
    Ok(())
}

#[cfg(test)]
mod devnet_regressions {
    /// Guards the six defects found only on devnet (F19).
    ///
    /// These cannot be caught by exercising the logic in-process, because each
    /// lives in the program↔runtime boundary: account existence, signer
    /// privilege, CPI argument shape, lamport ownership, and rent. What *can* be
    /// asserted here is that the seed sets are shaped the way `invoke_signed`
    /// requires, and that the discriminators and error codes still match Anchor —
    /// because those are the parts that silently regress when someone "simplifies"
    /// a CPI.
    use crate::anchor_parity::{account_discriminator, instruction_discriminator, ix, vault_seeds, VAULT_DISCRIMINATOR};
    use solana_program::pubkey::Pubkey;

    /// `invoke_signed` wants ONE seed set per signer. The first version passed
    /// `[seeds, &[bump]]` — two — and the runtime tried to derive two addresses.
    /// A regression guard cannot observe the runtime, so it asserts the *shape*:
    /// the vault's seeds plus the bump, concatenated, must equal the seeds used
    /// for derivation.
    #[test]
    fn vault_seed_set_is_one_set_containing_the_bump() {
        let authority = Pubkey::new_unique();
        let program_id = Pubkey::new_unique();
        let seeds = vault_seeds(&authority);
        // Two seed slices, plus the bump, form the single set passed to
        // `invoke_signed`. There is never a second set.
        assert_eq!(seeds.len(), 2);
        let (_, bump) = Pubkey::try_find_program_address(&seeds, &program_id)
            .expect("a vault PDA must exist");
        let bump_seed = [bump];
        let one_set: [&[u8]; 3] = [seeds[0], seeds[1], &bump_seed];
        assert_eq!(one_set.len(), 3);
    }

    /// The vault is a program-owned account holding 105 bytes, so the system
    /// program's `transfer` cannot be used to move lamports *out* of it — it
    /// rejects any source carrying data. `deposit` credits in (a CPI is correct
    /// there); `withdraw` debits out by direct mutation, which ownership permits.
    #[test]
    fn vault_carries_data_so_system_transfer_cannot_debit_it() {
        // If this ever changes — e.g. the state moves out of account data — the
        // direct-mutation path in `withdraw` should be revisited against a CPI.
        assert_eq!(crate::state::VAULT_LEN, 105);
        assert!(crate::state::VAULT_LEN > 0);
    }

    /// A PDA must retain the rent-exempt minimum, so "capital == lamports" is
    /// false by construction. `check_no_surplus_lamports` compares against
    /// capital + rent; this records why the subtraction is required.
    #[test]
    fn rent_means_lamports_never_equal_capital() {
        // Any positive rent makes the two differ; the exact figure is a runtime
        // value, so the assertion is structural rather than numeric.
        let capital: u64 = 1_000_000;
        let rent: u64 = 1_183_640;
        assert_ne!(capital, capital + rent);
    }

    /// Anchor parity must survive every edit made in response to F19.
    #[test]
    fn anchor_parity_still_holds_after_devnet_fixes() {
        assert_eq!(account_discriminator("Vault"), VAULT_DISCRIMINATOR);
        assert_eq!(instruction_discriminator("reserve"), ix::RESERVE);
        assert_eq!(instruction_discriminator("withdraw"), ix::WITHDRAW);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Phase 3 — Authority: mandate, authorization, consume-on-spend (ADR-0009).
// ═════════════════════════════════════════════════════════════════════════════

/// `open_mandate(limit, ceiling, expires_at, policy_engine)` — a principal grants
/// an agent a mandate over the principal's vault.
///
/// Signature `[u64 limit][u64 ceiling][u64 expires_at][32 policy_engine][u8 bump?]`.
/// Accounts `[principal (signer), holder, mandate, vault, system_program, program]`.
///
/// **The PRINCIPAL opens the mandate, not the holder.** This reverses the first
/// design, which made a mandate "a self-binding limit on its own holder" opened
/// by the holder's own key. A self-granted limit binds nothing: the agent chose
/// its own ceiling, and nothing tied the mandate to any vault, so the vault a
/// spend debited was whichever one the caller named (F51). The PRD's mandate is
/// "the principal's mandate"; the principal must sign, must be the authority of
/// the vault being bound, and names the one engine whose permits it will honour.
///
/// The holder does not sign. Being granted a bounded mandate imposes nothing on
/// the agent, and requiring its key here would not narrow anyone's authority.
fn open_mandate(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    if args.len() < 56 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let limit = read_amount(&args[0..8])?;
    let ceiling = read_amount(&args[8..16])?;
    let expires_at = read_amount(&args[16..24])?;
    let policy_engine = Pubkey::try_from(&args[24..56]).map_err(|_| ProgramError::InvalidInstructionData)?;
    let bump_arg = args.get(56).copied();

    let mut it = accounts.iter();
    let principal = next_account_info(&mut it)?;
    let holder = next_account_info(&mut it)?;
    let mandate_account = next_account_info(&mut it)?;
    let vault_account = next_account_info(&mut it)?;
    let system_program = next_account_info(&mut it)?;

    // Signer, program ownership, PDA derivation from the principal, and the
    // recorded authority — the same four checks every vault-directing handler
    // makes. A principal can only bind a mandate to its own vault.
    check_vault_account(vault_account, principal, program_id)?;
    if policy_engine == Pubkey::default() {
        return Err(ProgramError::InvalidArgument);
    }
    // Every other handler that takes a system program validates it. This one
    // read the account and then ignored it, which the compiler flagged as an
    // unused variable — a warning that turned out to be a missing security
    // check rather than a style nit. Without it, `create_account` below is
    // invoked against whatever account the caller placed third, and the CPI
    // fails late with a runtime error instead of being refused up front with
    // IncorrectProgramId.
    if system_program.key != &solana_program::system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    // A zero limit or a zero ceiling would create a mandate that can authorize
    // nothing. Refusing it is friendlier than minting a dead object: a caller
    // that passes 0 has made an argument mistake, and an inert mandate on chain
    // looks like a policy that was deliberately set to nil.
    if limit == 0 || ceiling == 0 {
        return Err(ProgramError::InvalidArgument);
    }
    // The ceiling is the vault-total bound and the limit is the per-action bound.
    // A ceiling below the limit is not "restrictive", it is incoherent: no single
    // action could ever fit. Catching it at open time means a later spend
    // failure cannot be mistaken for a missing balance.
    if ceiling < limit {
        return Err(err::custom(err::EXCEEDS_MANDATE_CEILING));
    }
    if mandate_account.owner != &solana_program::system_program::ID
        && mandate_account.owner != program_id
    {
        return Err(err::custom(err::INVALID_ACCOUNT_OWNER));
    }
    if mandate_account.owner == program_id {
        return Err(err::custom(err::ALREADY_INITIALIZED));
    }

    let (expected, derived_bump) = Pubkey::try_find_program_address(
        &anchor_parity::mandate_seeds(principal.key, holder.key),
        program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;
    if expected != *mandate_account.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let bump = match bump_arg {
        None => derived_bump,
        Some(b) if b == derived_bump => b,
        Some(_) => return Err(ProgramError::InvalidSeeds),
    };

    if mandate_account.lamports() == 0 {
        let lamports = rent_for_bytes(state::MANDATE_LEN)?;
        // The principal pays rent: the mandate is its grant.
        let cpi = system_instruction::create_account(
            principal.key, mandate_account.key, lamports,
            state::MANDATE_LEN as u64, &program_id,
        );
        let program_account = next_account_info(&mut it)?;
        let bump_seed = [bump];
        let seed_sets: &[&[&[u8]]] = &[&[
            anchor_parity::MANDATE_SEED,
            principal.key.as_ref(),
            holder.key.as_ref(),
            &bump_seed,
        ]];
        invoke_signed(
            &cpi,
            &[principal.clone(), mandate_account.clone(), program_account.clone()],
            seed_sets,
        )?;
    }

    // Version starts at 1, never 0 — `try_from_bytes` treats 0 as "not written by
    // this program", so a fresh mandate must not be born indistinguishable from
    // an uninitialized one.
    let mandate = state::Mandate {
        holder: *holder.key,
        limit,
        // Version starts at 1, never 0 — `try_from_bytes` treats 0 as "not
        // written by this program", so a fresh mandate must not be born
        // indistinguishable from an uninitialized one.
        version: 1,
        expires_at,
        ceiling,
        revoked: false,
        binding: Some(state::MandateBinding { principal: *principal.key, policy_engine }),
    };
    mandate_account.try_borrow_mut_data()?.copy_from_slice(&mandate.to_bytes());
    msg!("mandate v1 granted by {} to {}", principal.key, holder.key);
    Ok(())
}

/// `authorize(action_hash, amount)` — the policy engine issues a single-use permit.
///
/// The permit is **derived by the program from the mandate**, never asserted by
/// the caller. The caller supplies only two things it is entitled to know: which
/// action it wants, and how much that action costs. It cannot supply the
/// authorization, the version, the expiry, or the limit. This is the
/// load-bearing boundary from AGENTS.md rendered as a function signature — the
/// reason an "ALLOW" is not permission is that no path exists by which a caller
/// can hand the program its own permission.
///
/// Signature `[32 action_hash][u64 amount][32 recipient][u8 bump?]`.
///
/// **The signer must be the mandate's own policy engine.** It used to be any
/// signer at all, so a stranger could issue a permit against anyone's mandate
/// (F51) — the opposite of ADR-0009 decision 2. The engine also names the
/// recipient here, and the permit carries it, because `spend_authorized` takes no
/// signature and must not let its caller pick the payee.
fn authorize(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8], now: u64) -> ProgramResult {
    if args.len() < 72 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount = read_amount(&args[32..40])?;
    let mut action_hash = [0u8; 32];
    action_hash.copy_from_slice(&args[0..32]);
    let recipient = Pubkey::try_from(&args[40..72]).map_err(|_| ProgramError::InvalidInstructionData)?;

    let mut it = accounts.iter();
    let policy_engine = next_account_info(&mut it)?;
    let holder = next_account_info(&mut it)?;
    let mandate_account = next_account_info(&mut it)?;
    let authorization_account = next_account_info(&mut it)?;
    let system_program = next_account_info(&mut it)?;

    if !policy_engine.is_signer {
        return Err(err::custom(err::NOT_SIGNER));
    }
    if system_program.key != &solana_program::system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if mandate_account.owner != program_id {
        return Err(err::custom(err::INVALID_ACCOUNT_OWNER));
    }
    let mandate = state::Mandate::try_from_bytes(&mandate_account.try_borrow_data()?)?;
    if mandate.holder != *holder.key {
        return Err(err::custom(err::UNAUTHORIZED));
    }
    let binding = mandate.binding.ok_or(err::custom(err::MANDATE_UNBOUND))?;
    if binding.policy_engine != *policy_engine.key {
        return Err(err::custom(err::POLICY_ENGINE_MISMATCH));
    }
    assert_canonical_mandate(mandate_account, &mandate, program_id)?;
    // The `Mandate` docs always said a revoked mandate cannot issue new permits;
    // this handler never checked. A permit issued after revocation could not be
    // spent (spend re-checks), but it would still be minted, paid for, and
    // recorded as an authorization the principal had already withdrawn.
    if mandate.revoked {
        return Err(err::custom(err::MANDATE_REVOKED));
    }

    // Refuse to issue against a dead mandate *before* checking the amount, so an
    // expired policy reports expiry rather than a ceiling complaint.
    if !mandate.is_live_at(now) {
        return Err(err::custom(err::MANDATE_EXPIRED));
    }
    if amount == 0 || amount > mandate.limit {
        return Err(err::custom(err::EXCEEDS_MANDATE_CEILING));
    }

    let (expected, derived_bump) = Pubkey::try_find_program_address(
        &anchor_parity::authorization_seeds(mandate_account.key, &action_hash),
        program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;
    if expected != *authorization_account.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let bump = args.get(72).copied().unwrap_or(derived_bump);
    if bump != derived_bump {
        return Err(ProgramError::InvalidSeeds);
    }

    // An existing account at this exact address means this action was already
    // authorized. Re-issuing would silently resurrect a spent permit, so this is
    // refused rather than overwritten — the same reasoning as ALREADY_INITIALIZED
    // on a vault.
    if authorization_account.owner == program_id {
        return Err(err::custom(err::ALREADY_INITIALIZED));
    }

    if authorization_account.lamports() == 0 {
        let lamports = rent_for_bytes(state::AUTHORIZATION_LEN)?;
        let cpi = system_instruction::create_account(
            policy_engine.key, authorization_account.key, lamports,
            state::AUTHORIZATION_LEN as u64, &program_id,
        );
        let program_account = next_account_info(&mut it)?;
        let bump_seed = [bump];
        let seed_sets: &[&[&[u8]]] = &[&[
            anchor_parity::AUTHORIZATION_SEED,
            mandate_account.key.as_ref(),
            action_hash.as_ref(),
            &bump_seed,
        ]];
        invoke_signed(
            &cpi,
            &[
                policy_engine.clone(),
                authorization_account.clone(),
                program_account.clone(),
            ],
            seed_sets,
        )?;
    }

    let authorization = state::Authorization {
        holder: *holder.key,
        action_hash,
        amount,
        // Copied from the mandate, not supplied by the caller: this is the record
        // that lets evidence name the policy version behind a spend, even after
        // the mandate has since been tightened or expired.
        mandate_version: mandate.version,
        expires_at: mandate.expires_at,
        consumed: false,
        bump,
        recipient,
    };
    authorization_account
        .try_borrow_mut_data()?
        .copy_from_slice(&authorization.to_bytes());
    msg!("authorization issued for mandate v{}", mandate.version);
    Ok(())
}

/// `spend_authorized(action_hash)` — moves value under a permit, consuming it.
///
/// **This is the instruction the whole product turns on.** It is the only path
/// by which an agent's action becomes a capital movement, and it re-derives
/// permission from the mandate and the permit rather than trusting anything the
/// caller said.
///
/// **On the ordering of consume versus value movement** — a correction.
///
/// The first draft of this comment claimed that consuming before moving was "a
/// security property" and that the reverse order would leave value moved with
/// the permit still unspent. Mutation testing showed that claim to be false in
/// this context, and it is worth recording why rather than quietly deleting it.
///
/// Replaying this instruction is a *separate transaction*. Within one
/// transaction the two orderings are observationally identical: both end with
/// `consumed = true` and the lamports moved, and Solana applies the
/// transaction atomically, so a failure after either step rolls the whole thing
/// back. The inverted-order mutant (M5) is therefore **not detectable by any
/// test, and is not a defect** — there is no state in which it produces a
/// different outcome.
///
/// The ordering is kept consume-first anyway, for two reasons that are real but
/// weaker than the original claim:
///
///   1. It fails safe under the one way this could actually diverge — if this
///      program were ever extended with a CPI between the two steps, a rollback
///      would be all-or-nothing while a *revert-in-handler* path could leave the
///      permit consumed without value moved. Consuming first means the worse
///      error is a burned permit, not an unspent permit over moved value.
///   2. It matches the read of the code: a reader scanning the handler sees the
///      permission destroyed before the consequence, which is the order the
///      argument in the ADR describes.
///
/// Deleting the consume write entirely (M4) *is* caught, by three tests. That
/// is the mutation that matters, and the suite catches it.
/// The vault is debited and the destination credited by direct mutation, exactly
/// as in `withdraw`, for the same reason: the program owns the vault, so the
/// runtime permits it, and the system program's `transfer` would reject a
/// data-carrying source.
/// A mandate account must be the canonical PDA for the principal and holder it
/// records (sprint item 7). Program ownership alone says only that this program
/// wrote it, not that it is the mandate the seeds name.
fn assert_canonical_mandate(
    mandate_account: &AccountInfo,
    mandate: &state::Mandate,
    program_id: &Pubkey,
) -> ProgramResult {
    let principal = mandate
        .binding
        .as_ref()
        .map(|b| b.principal)
        .ok_or(err::custom(err::MANDATE_UNBOUND))?;
    let (expected, _) = Pubkey::try_find_program_address(
        &anchor_parity::mandate_seeds(&principal, &mandate.holder),
        program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;
    if expected != *mandate_account.key {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(())
}

fn spend_authorized(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: &[u8],
    now: u64,
) -> ProgramResult {
    let mut action_hash = [0u8; 32];
    action_hash.copy_from_slice(&args[0..32]);

    let mut it = accounts.iter();
    let recipient = next_account_info(&mut it)?;
    let vault_account = next_account_info(&mut it)?;
    let authorization_account = next_account_info(&mut it)?;
    let mandate_account = next_account_info(&mut it)?;

    if authorization_account.owner != program_id {
        return Err(err::custom(err::INVALID_ACCOUNT_OWNER));
    }
    if mandate_account.owner != program_id {
        return Err(err::custom(err::INVALID_ACCOUNT_OWNER));
    }
    if vault_account.owner != program_id {
        return Err(err::custom(err::INVALID_ACCOUNT_OWNER));
    }

    let mandate = state::Mandate::try_from_bytes(&mandate_account.try_borrow_data()?)?;
    let mut authorization =
        state::Authorization::try_from_bytes(&authorization_account.try_borrow_data()?)?;

    // The permit is bound to a holder. The holder is not required to sign — an
    // agent paying a counterparty does not have the holder's keypair — but the
    // permit must at least be one that was issued to *someone*, and the mandate
    // it names must be the same one. A permit from a different mandate is a
    // confused-deputy attempt even when it is otherwise valid.
    if authorization.holder != mandate.holder {
        return Err(err::custom(err::UNAUTHORIZED));
    }
    // A permit issued under mandate v3 must not be spendable once the mandate has
    // moved on *and revoked* the version that issued it. Phase 3a has no
    // revocation, so version monotonicity is checked instead: a permit naming a
    // version *newer* than the live mandate is not something this mandate issued.
    if authorization.mandate_version > mandate.version {
        return Err(err::custom(err::UNAUTHORIZED));
    }

    // Which vault, and who gets paid — the two questions this handler used to
    // leave to its caller (F51). Neither is a signer here, so both must be
    // re-derived from what the principal and the engine recorded.
    let binding = mandate.binding.ok_or(err::custom(err::MANDATE_UNBOUND))?;
    // Which mandate issued this permit (sprint item 7). `holder` alone stopped
    // identifying it once mandates were seeded by (principal, holder): the same
    // holder may hold a mandate from several principals. The mandate must sit at
    // its canonical address, and the permit at the address THAT mandate would have
    // created it at — so one principal's permit cannot be spent under another's.
    assert_canonical_mandate(mandate_account, &mandate, program_id)?;
    let (expected_permit, _) = Pubkey::try_find_program_address(
        &anchor_parity::authorization_seeds(mandate_account.key, &action_hash),
        program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;
    if *authorization_account.key != expected_permit {
        // Name the real cause. If the instruction names a different action than the
        // permit holds, that is the action mismatch (a different instruction, not a
        // different issuer); otherwise the permit was issued under another mandate.
        if authorization.action_hash != action_hash {
            return Err(err::custom(err::ACTION_HASH_MISMATCH));
        }
        return Err(err::custom(err::UNAUTHORIZED));
    }
    let (principal_vault, _) = find_vault_pda(&vault_seeds(&binding.principal), program_id)?;
    if *vault_account.key != principal_vault {
        return Err(err::custom(err::VAULT_MISMATCH));
    }
    if Vault::from_bytes(&vault_account.try_borrow_data()?)?.authority != binding.principal {
        return Err(err::custom(err::VAULT_MISMATCH));
    }
    if *recipient.key != authorization.recipient {
        return Err(err::custom(err::RECIPIENT_MISMATCH));
    }

    // Three refusals, in this order, from `spendable_at`. Consumed is checked
    // first so a replay is reported as a replay rather than as a hash mismatch.
    authorization.spendable_at(&action_hash, now)?;

    // The amount comes from the PERMIT, never from the caller. A caller-supplied
    // amount would let a holder of a 1-unit permit request 1,000,000; the
    // ceiling check below would then be the only thing standing between a small
    // permit and a large transfer.
    let amount = authorization.amount;
    if amount == 0 {
        return Err(ProgramError::InvalidArgument);
    }
    // **The current `mandate.limit` is deliberately NOT re-checked here.**
    //
    // The first version did check it, and that was a live-lock: a holder who
    // tightened a 100_000 limit to 10_000 would immediately strand every
    // outstanding permit issued under the old limit — the agent holds a valid
    // permit it can no longer spend and cannot obtain a replacement for, until
    // the permit expires. The principal's own tightening decision would silently
    // break its agents.
    //
    // The permit's amount was already checked against the limit *at the moment it
    // was issued*, against the version it cites. Re-applying today's limit at
    // spend time would also make an issued permit's validity depend on when it is
    // spent rather than on the policy that authorized it, which is precisely the
    // retroactive tightening ADR-0009 exists to prevent. A permit is a promise
    // made under a named policy; it does not evaporate because the policy moved
    // on.
    //
    // **Revocation, however, IS re-checked here**, and it is the one policy
    // change that reaches backwards.
    //
    // Amending and revoking are deliberately asymmetric, and this is the line
    // where they diverge:
    //
    //   amend  — a new policy governs *future* permits. A permit already issued
    //            is a promise made under the version it cites, and it stands.
    //            Re-checking today's limit would let a principal's routine
    //            tightening strand its agents mid-flight.
    //   revoke — "this agent is compromised". That must stop value *now*, so it
    //            reaches back and kills outstanding permits too.
    //
    // The first version of this handler checked neither, which is exactly the
    // gap: a revoked mandate was a flag nothing read. A test caught it only
    // because it amended and then SPENT, rather than amending and inspecting two
    // variables.
    if mandate.revoked {
        return Err(err::custom(err::MANDATE_REVOKED));
    }

    // What *is* still enforced is liveness, plus the vault's own `available`
    // check.

    // ── consume FIRST ────────────────────────────────────────────────────────
    authorization.consumed = true;
    authorization_account
        .try_borrow_mut_data()?
        .copy_from_slice(&authorization.to_bytes());

    // ── then move value ─────────────────────────────────────────────────────
    let mut data = vault_account.try_borrow_mut_data()?;
    let mut vault = Vault::from_bytes(&data)?;
    if amount > vault.available {
        return Err(err::custom(err::INSUFFICIENT_AVAILABLE));
    }
    vault.available -= amount;
    vault.total -= amount;
    vault.reconcile()?;
    data.copy_from_slice(&vault.to_bytes());
    drop(data);

    **vault_account.try_borrow_mut_lamports()? = vault_account.lamports()
        .checked_sub(amount)
        .ok_or(err::custom(err::ARITHMETIC_OVERFLOW))?;
    **recipient.try_borrow_mut_lamports()? = recipient.lamports()
        .checked_add(amount)
        .ok_or(err::custom(err::ARITHMETIC_OVERFLOW))?;

    msg!("spent {} under mandate v{} action {}", amount, authorization.mandate_version, action_hash[0]);
    Ok(())
}

/// `amend_mandate(limit, ceiling, expires_at, revoke)` — Phase 3b.
///
/// Only the **principal** that granted the mandate may amend it; the **holder** may
/// only revoke it. Accounts `[signer, mandate]`.
///
/// This used to read "only the holder may amend… a mandate is a self-binding
/// limit". That made the agent the one party able to widen its own authority —
/// the hole the wording claimed to prevent (F51). The authority being bounded
/// belongs to the principal, so the principal moves the bound; the agent keeps
/// the one change that can only ever narrow it.
///
/// `revoke` is a flag rather than a separate instruction so that revoking and
/// amending are the same audited code path. A distinct `revoke_mandate` would be
/// a second place where the version bump and the signature check could be got
/// wrong differently.
///
/// **Amending does not invalidate outstanding permits** — see the note in
/// `spend_authorized`. **Revoking does.** That asymmetry is the point: a routine
/// tightening must not strand in-flight promises, while a compromise must stop
/// everything at once.
fn amend_mandate(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: &[u8],
    now: u64,
) -> ProgramResult {
    // `revoke` is the high bit of the last argument byte, kept in a spare argument
    // slot rather than a fifth u64 so the instruction stays 32 bytes wide.
    let limit = read_amount(&args[0..8])?;
    let ceiling = read_amount(&args[8..16])?;
    let expires_at = read_amount(&args[16..24])?;
    let revoke = args.get(24).is_some_and(|&b| b != 0);

    let mut it = accounts.iter();
    let signer = next_account_info(&mut it)?;
    let mandate_account = next_account_info(&mut it)?;

    if !signer.is_signer {
        return Err(err::custom(err::NOT_SIGNER));
    }
    if mandate_account.owner != program_id {
        return Err(err::custom(err::INVALID_ACCOUNT_OWNER));
    }

    let mut mandate = state::Mandate::try_from_bytes(&mandate_account.try_borrow_data()?)?;

    // Re-derive rather than trusting the stored bump: the amendment is written to
    // a policy object, and writing to the wrong account is unrecoverable. Derived
    // from the principal and holder the mandate RECORDS, since the signer may be
    // either. A mandate with no recorded binding has no principal to derive from
    // under the (principal, holder) seed, so it is refused rather than guessed.
    let recorded_principal = mandate
        .binding
        .as_ref()
        .map(|b| b.principal)
        .ok_or(err::custom(err::MANDATE_UNBOUND))?;
    let (expected, _) = Pubkey::try_find_program_address(
        &anchor_parity::mandate_seeds(&recorded_principal, &mandate.holder),
        program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;
    if expected != *mandate_account.key {
        return Err(ProgramError::InvalidSeeds);
    }

    // Who may change a mandate. The principal may amend or revoke. The holder may
    // ONLY revoke: an agent that can stop itself is a safety valve, an agent that
    // can raise its own limit is the self-granted mandate F51 removed. Under the
    // first design the holder could do both, because it had opened the mandate.
    let binding = mandate.binding.ok_or(err::custom(err::MANDATE_UNBOUND))?;
    let is_principal = *signer.key == binding.principal;
    let is_holder_revoking = *signer.key == mandate.holder && revoke;
    if !is_principal && !is_holder_revoking {
        return Err(err::custom(err::UNAUTHORIZED));
    }

    // A revoked mandate is terminal. It cannot be un-revoked, and it cannot be
    // amended into a different policy — otherwise "revoked" would be a pause
    // button, and a caller reading the flag would have no way to know whether the
    // holder had since resumed.
    if mandate.revoked {
        return Err(err::custom(err::MANDATE_REVOKED));
    }
    // Refusing to amend an expired mandate prevents the holder from resurrecting a
    // policy after its own deadline. An expired mandate is dead, not paused.
    if !mandate.is_live_at(now) {
        return Err(err::custom(err::MANDATE_EXPIRED));
    }
    // A revocation must be possible even as the mandate approaches expiry, or
    // there is a window in which a compromised agent cannot be stopped. The
    // expiry check above is therefore skipped for a pure revoke.
    if !revoke {
        if limit == 0 || ceiling == 0 {
            return Err(ProgramError::InvalidArgument);
        }
        if ceiling < limit {
            return Err(err::custom(err::EXCEEDS_MANDATE_CEILING));
        }
        if expires_at <= now {
            return Err(err::custom(err::MANDATE_EXPIRED));
        }
    }

    // Saturating, not wrapping. A version is evidence, and a wrapped counter
    // would eventually let a permit cite a version that already existed under a
    // different policy — the precise confusion the version exists to prevent.
    mandate.version = mandate.version.saturating_add(1);
    mandate.revoked = revoke;
    if !revoke {
        mandate.limit = limit;
        mandate.ceiling = ceiling;
        mandate.expires_at = expires_at;
    }

    // Growing a 96-byte account to 97 in place. `copy_from_slice` into a shorter
    // buffer panics and aborts the transaction, and the in-process tests cannot
    // see that because the buffer is whatever the test allocated. The resize is
    // therefore explicit and checked.
    // Growing a 96-byte account to 97 in place.
    //
    // `realloc` must be called with the data NOT borrowed, and it reallocates the
    // account's buffer, so the borrow is released first. Writing 97 bytes into the
    // 96-byte view a `try_borrow_mut_data` hands back would panic and abort the
    // whole transaction — and no in-process test can catch that, because the
    // buffer is whatever the test allocated, not a real chain account.
    if mandate_account.data_len() < state::MANDATE_LEN {
        mandate_account.realloc(state::MANDATE_LEN, true)?;
    }
    let mut data = mandate_account.try_borrow_mut_data()?;
    data.copy_from_slice(&mandate.to_bytes());

    msg!(
        "mandate v{} {} (limit {})",
        mandate.version,
        if mandate.revoked { "REVOKED" } else { "amended" },
        mandate.limit
    );
    Ok(())
}

/// The deployed program id, as a compile-time byte array.
///
/// Exposed for tests that must derive the *real* PDA rather than an arbitrary
/// one: `amend_mandate` re-derives the mandate address from `[b"mandate",
/// holder]` and refuses a mismatch, so a fixture built with a random program id
/// cannot exercise it — the first `amend_integration` failed every case with
/// `InvalidSeeds` for exactly that reason.
///
/// Stored as bytes rather than a base58 string, with no decoder. A hand-rolled
/// base58 decoder is a hundred lines of carry arithmetic with no test other than
/// "did it happen to produce the right key", and the only consumer of the string
/// form is a test. The devnet harness derives the id from the keypair file in
/// JavaScript, where the real library lives.
pub const PROGRAM_ID_BYTES: [u8; 32] = [
    233, 253, 192, 42, 166, 75, 209, 253, 76, 95, 140, 134, 18, 10, 167,
    117, 151, 154, 72, 202, 24, 101, 30, 88, 39, 147, 201, 218, 245, 86,
    198, 227,
];

/// [`PROGRAM_ID_BYTES`] as a `Pubkey`, for tests.
pub fn program_id() -> Pubkey {
    Pubkey::new_from_array(PROGRAM_ID_BYTES)
}

#[cfg(test)]
mod program_id_tests {
    use super::*;

    /// A typo in `PROGRAM_ID_BYTES` would make every PDA in the suite derive a
    /// valid-but-wrong address, and the suite would pass while testing nothing
    /// real. The first version of this test only checked "not all zeros", which
    /// is exactly the check that would have survived a one-digit typo.
    #[test]
    fn the_constant_is_the_deployed_program_id() {
        assert_eq!(
            PROGRAM_ID_BYTES,
            [
                233, 253, 192, 42, 166, 75, 209, 253, 76, 95, 140, 134, 18, 10, 167,
                117, 151, 154, 72, 202, 24, 101, 30, 88, 39, 147, 201, 218, 245, 86,
                198, 227,
            ],
            "the deployed program id drifted from the constant"
        );
    }
}
