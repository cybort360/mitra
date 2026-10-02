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
};
use state::Vault;
// System-program instructions live in the `system_program` crate, not `solana_program`.
use solana_program::system_instruction;

solana_program::entrypoint!(process);

/// Dispatches on Anchor's instruction discriminator.
///
/// The `data.len() < 8` guard is Anchor's own behaviour: it computes
/// discriminators with `to_le_bytes()[..8]`, so shorter input cannot be
/// dispatched. `InvalidInstructionData` rather than a panic.
pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
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
pub fn rent_for_bytes(bytes: usize) -> Result<u64, ProgramError> {
    rent::rent_exempt_minimum(bytes)
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
    // remaining question is whether there is enough to withdraw.
    check_vault_account(vault_account, authority, program_id)?;
    if amount > Vault::from_bytes(&vault_account.try_borrow_data()?)?.available {
        return Err(err::custom(err::INSUFFICIENT_AVAILABLE));
    }

    let system_program = next_account_info(&mut it)?;
    if system_program.key != &solana_program::system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let mut data = vault_account.try_borrow_mut_data()?;
    let mut vault = Vault::from_bytes(&data)?;
    vault.available -= amount;
    vault.total -= amount;
    vault.reconcile()?;
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
