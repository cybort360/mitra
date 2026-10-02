//! Rent, via the runtime syscall.
//!
//! A thin wrapper so `initialize_vault` reads as account creation rather than
//! syscall plumbing, and so the on-chain and in-process paths have one name.

use solana_program::program_error::ProgramError;
use solana_program::sysvar::rent::Rent;
use solana_program::sysvar::Sysvar;

/// Minimum balance for `bytes` of account data to be rent-exempt.
pub fn rent_exempt_minimum(bytes: usize) -> Result<u64, ProgramError> {
    Ok(Rent::get()?.minimum_balance(bytes))
}
