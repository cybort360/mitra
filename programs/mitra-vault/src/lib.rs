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
pub mod state;

use anchor_parity::{err, find_vault_pda, ix, vault_seeds};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
};
use state::Vault;

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
fn check_vault_account(
    account: &AccountInfo,
    program_id: &Pubkey,
    authority: &Pubkey,
    expected: &Pubkey,
) -> ProgramResult {
    if !account.is_signer {
        return Err(err::custom(err::NOT_SIGNER));
    }
    if account.owner != program_id {
        return Err(err::custom(err::INVALID_ACCOUNT_OWNER));
    }
    // A PDA carries its own bump; re-deriving proves the address really is the
    // vault for this authority, not merely one the caller passed in.
    let (derived, bump) = find_vault_pda(&vault_seeds(authority), program_id)?;
    if &derived != expected {
        return Err(ProgramError::InvalidSeeds);
    }
    let vault = Vault::from_bytes(&account.try_borrow_data()?)?;
    if vault.authority != *authority {
        return Err(err::custom(err::UNAUTHORIZED));
    }
    if vault.bump != bump {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(())
}

/// `initialize_vault(bump)` — creates the PDA for `authority`.
fn initialize_vault(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let mut it = accounts.iter();
    let authority = next_account_info(&mut it)?;
    let vault_account = next_account_info(&mut it)?;
    let system_program = next_account_info(&mut it)?;

    if !authority.is_signer {
        return Err(err::custom(err::NOT_SIGNER));
    }
    // A system-owned, empty account is how Anchor creates a PDA.
    if vault_account.owner != &solana_program::system_program::ID {
        return Err(err::custom(err::INVALID_ACCOUNT_OWNER));
    }
    if system_program.key != &solana_program::system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let bump = args.first().copied().unwrap_or(255);
    let (expected, _) = find_vault_pda(&vault_seeds(authority.key), program_id)?;
    if expected != *vault_account.key {
        return Err(ProgramError::InvalidSeeds);
    }

    let vault = Vault::new(*authority.key, bump);
    vault_account.try_borrow_mut_data()?.copy_from_slice(&vault.to_bytes());
    msg!("vault initialized for {}", authority.key);
    Ok(())
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

    **depositor.try_borrow_mut_lamports()? = depositor.lamports()
        .checked_sub(amount).ok_or(err::custom(err::ARITHMETIC_OVERFLOW))?;
    **vault_account.try_borrow_mut_lamports()? = vault_account.lamports()
        .checked_add(amount).ok_or(err::custom(err::ARITHMETIC_OVERFLOW))?;
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
    check_vault_account(authority, program_id, authority.key, vault_account.key)?;
    if amount > Vault::from_bytes(&vault_account.try_borrow_data()?)?.available {
        return Err(err::custom(err::INSUFFICIENT_AVAILABLE));
    }

    let mut data = vault_account.try_borrow_mut_data()?;
    let mut vault = Vault::from_bytes(&data)?;
    vault.available -= amount;
    vault.total -= amount;
    vault.reconcile()?;
    data.copy_from_slice(&vault.to_bytes());
    drop(data);

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
    check_vault_account(authority, program_id, authority.key, vault_account.key)?;

    let mut data = vault_account.try_borrow_mut_data()?;
    let mut vault = Vault::from_bytes(&data)?;
    if vault.authority != *authority.key {
        return Err(err::custom(err::UNAUTHORIZED));
    }
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
    check_vault_account(authority, program_id, authority.key, vault_account.key)?;

    let mut data = vault_account.try_borrow_mut_data()?;
    let mut vault = Vault::from_bytes(&data)?;
    if vault.authority != *authority.key {
        return Err(err::custom(err::UNAUTHORIZED));
    }
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
fn check_no_surplus_lamports(vault: &AccountInfo, expected: u64) -> ProgramResult {
    if vault.lamports() != expected {
        return Err(err::custom(err::UNEXPECTED_LAMPORTS));
    }
    Ok(())
}
