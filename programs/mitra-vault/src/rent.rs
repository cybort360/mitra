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

/// Minimum balance for `bytes`, **plus headroom**.
///
/// The bare `minimum_balance` is exactly enough for the account to be
/// rent-exempt *at creation time*, and that is the problem: an account created
/// with precisely the minimum cannot be written to afterwards. The runtime
/// rejects any transaction that would leave a data-carrying account below its
/// minimum, so consuming a permit — which flips one byte in a 98-byte
/// authorization — failed on devnet with:
///
///   Transaction results in an account (2) with insufficient funds for rent
///
/// while the vault, funded the same way, was fine. The difference is that the
/// vault's lamports *move through* it, so it keeps a balance, while the
/// authorization was created at the bare minimum and only ever needed to be
/// written.
///
/// The multiplier is a deliberate margin, not a computed fudge: rent parameters
/// change with cluster-wide vote, and an account created at the bare minimum
/// today can fall below the minimum tomorrow, at which point it is not just
/// unspendable but *uncloseable*. Two years of headroom is cheap (a few
/// thousand lamports) and removes the failure mode entirely.
pub const RENT_HEADROOM_MULTIPLIER: u64 = 2;

/// Rent-exempt minimum for `bytes` with headroom.
pub fn rent_exempt_with_headroom(bytes: usize) -> Result<u64, ProgramError> {
    rent_exempt_minimum(bytes)?
        .checked_mul(RENT_HEADROOM_MULTIPLIER)
        .ok_or(ProgramError::InvalidArgument)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headroom_is_always_above_the_bare_minimum() {
        // The whole point of the function. If this ever fails, accounts will be
        // created at the bare minimum and become unwritable on first write.
        assert!(RENT_HEADROOM_MULTIPLIER >= 2, "a multiplier of 1 is the bug itself");
    }
}
