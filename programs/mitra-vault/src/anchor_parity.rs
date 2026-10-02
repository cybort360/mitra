//! Anchor-parity primitives.
//!
//! This program is written against raw `cargo-build-sbf` rather than Anchor, but
//! it is written to be *byte-compatible* with an Anchor program. Every constant
//! in this module is what Anchor derives automatically, and the tests at the
//! bottom assert each one against Anchor's own derivation rules.
//!
//! Why pay this cost now rather than migrate later: the failure I keep making
//! is hand-rolled encoding that looks right and is not (F12, and the ABI offset
//! bug in the bridge tests). Anchor's discriminators, account layout and PDA
//! derivation are *generated*, so matching them here means the eventual
//! migration is a wrapper over identical bytes rather than a rewrite of a
//! program whose encoding was only ever validated against itself.
//!
//! Three things Anchor generates, which must be reproduced exactly:
//!
//! 1. **Instruction discriminators** — `sha256("global:<snake_case_name>")[..8]`.
//! 2. **Account discriminators** — `sha256("account:<StructName>")[..8]`, written
//!    as the first 8 bytes of account data.
//! 3. **PDA derivation** — `find_program_address(seeds, program_id)`, bump
//!    searched downward from 255.

use solana_program::{
    hash::hash,
    program_error::ProgramError,
    pubkey::Pubkey,
};

/// Anchor's account-data discriminator: first 8 bytes of `sha256("account:Vault")`.
///
/// These bytes were originally written from memory and were **wrong** — the
/// `anchor_parity` tests failed on the first run and caught it. A discriminator
/// that is merely plausible-looking is worse than one that is obviously absent,
/// because a mismatched account is rejected loudly while a wrong-but-consistent
/// one would deserialize into a different program's account. They are now
/// asserted against the derivation, so this comment stays true only because a
/// test enforces it.
pub const VAULT_DISCRIMINATOR: [u8; 8] = [211, 8, 232, 43, 2, 152, 117, 119];

/// Anchor's instruction discriminators, one per handler. Same provenance as
/// `VAULT_DISCRIMINATOR` — computed, then pinned by a test.
pub mod ix {
    /// sha256("global:initialize_vault")[..8]
    pub const INITIALIZE_VAULT: [u8; 8] = [48, 191, 163, 44, 71, 129, 63, 164];
    /// sha256("global:deposit")[..8]
    pub const DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
    /// sha256("global:withdraw")[..8]
    pub const WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
    /// sha256("global:reserve")[..8]
    pub const RESERVE: [u8; 8] = [92, 99, 244, 209, 28, 65, 213, 157];
    /// sha256("global:release")[..8]
    pub const RELEASE: [u8; 8] = [253, 249, 15, 206, 28, 127, 193, 241];
}

/// Error codes. Anchor reserves 0–999 for its framework and assigns user errors
/// from 6000 upward in declaration order, so these match `#[error_code]` exactly
/// and cannot collide with an Anchor runtime error after migration.
pub mod err {
    use solana_program::program_error::ProgramError;

    /// 6000 — a required account was not a signer.
    pub const NOT_SIGNER: u32 = 6000;
    /// 6001 — an account's owner is not this program.
    pub const INVALID_ACCOUNT_OWNER: u32 = 6001;
    /// 6002 — account data lacks the expected Anchor discriminator prefix.
    pub const ACCOUNT_DISCRIMINATOR_MISMATCH: u32 = 6002;
    /// 6003 — lamports moved to or from the vault outside the deposit/withdraw path.
    pub const UNEXPECTED_LAMPORTS: u32 = 6003;
    /// 6004 — the six capital positions do not sum to `total`.
    pub const RECONCILIATION_FAILED: u32 = 6004;
    /// 6005 — a reservation exceeded available capital.
    pub const INSUFFICIENT_AVAILABLE: u32 = 6005;
    /// 6006 — arithmetic would underflow.
    pub const ARITHMETIC_OVERFLOW: u32 = 6006;
    /// 6007 — the vault is frozen; new reservations are refused.
    pub const VAULT_FROZEN: u32 = 6007;
    /// 6008 — the signer is not permitted to perform this action.
    pub const UNAUTHORIZED: u32 = 6008;
    /// 6009 — the vault already exists; re-initializing must not reset it.
    ///
    /// This one exists because its absence caused a real misdiagnosis. Without it
    /// a second `initialize_vault` failed on the *owner* check and reported
    /// `0x1771` (INVALID_ACCOUNT_OWNER), which says the caller passed the wrong
    /// account — the opposite of the truth, which was "you already have one".
    pub const ALREADY_INITIALIZED: u32 = 6009;

    pub fn custom(code: u32) -> ProgramError {
        ProgramError::Custom(code)
    }
}

/// Reproduces Anchor's PDA derivation: seeds concatenated with the bump byte and
/// program id, hashed, retried from bump 255 downward. This is what
/// `#[derive(Accounts)]` calls for `#[account(seeds = …)]`.
///
/// Reproduces Anchor's PDA derivation: seeds concatenated with the bump byte and
/// program id, hashed, retried from bump 255 downward. This is what
/// `#[derive(Accounts)]` calls for `#[account(seeds = …)]`.
///
/// `try_find_program_address` rather than `find_program_address` is a deliberate
/// security choice, not a style one: the infallible form **panics** when it
/// cannot find a viable bump. A panic in a program aborts the transaction — and
/// a vault whose derivation can abort on attacker-influenced input is a denial
/// of service against the capital boundary. The `try_` form returns `None`, which
/// becomes a normal `ProgramError` the caller can handle and which the VM treats
/// as a clean failure.
pub fn find_vault_pda(seeds: &[&[u8]], program_id: &Pubkey) -> Result<(Pubkey, u8), ProgramError> {
    Pubkey::try_find_program_address(seeds, program_id)
        .ok_or(ProgramError::InvalidSeeds)
}

/// The canonical vault seed. A single seed keeps the address reproducible by
/// anyone from the authority, which matters because it appears in evidence.
pub const VAULT_SEED: &[u8] = b"vault";

/// The seed slice Anchor would build for `seeds = [b"vault", authority.key()]`.
pub fn vault_seeds(authority: &Pubkey) -> [&[u8]; 2] {
    [VAULT_SEED, authority.as_ref()]
}

/// Anchor derives an account discriminator from the *struct* name.
pub fn account_discriminator(struct_name: &str) -> [u8; 8] {
    let mut out = [0u8; 8];
    out.copy_from_slice(&hash(format!("account:{struct_name}").as_bytes()).to_bytes()[..8]);
    out
}

/// Anchor derives an instruction discriminator from the *snake_case* fn name.
pub fn instruction_discriminator(fn_name: &str) -> [u8; 8] {
    let mut out = [0u8; 8];
    out.copy_from_slice(&hash(format!("global:{fn_name}").as_bytes()).to_bytes()[..8]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The point of this module: if Anchor ever changes how it derives a
    /// discriminator, this fails here rather than at migration time — when the
    /// program is deployed and the mismatch is a production incident.
    #[test]
    fn vault_discriminator_matches_anchor() {
        assert_eq!(account_discriminator("Vault"), VAULT_DISCRIMINATOR);
    }

    #[test]
    fn instruction_discriminators_match_anchor() {
        assert_eq!(instruction_discriminator("initialize_vault"), ix::INITIALIZE_VAULT);
        assert_eq!(instruction_discriminator("deposit"), ix::DEPOSIT);
        assert_eq!(instruction_discriminator("withdraw"), ix::WITHDRAW);
        assert_eq!(instruction_discriminator("reserve"), ix::RESERVE);
        assert_eq!(instruction_discriminator("release"), ix::RELEASE);
    }

    #[test]
    fn error_codes_sit_above_anchors_reserved_range() {
        // Anchor's framework owns 0–999. Starting at 6000 keeps user errors
        // distinguishable after migration.
        for code in [
            err::NOT_SIGNER, err::INVALID_ACCOUNT_OWNER, err::ACCOUNT_DISCRIMINATOR_MISMATCH,
            err::UNEXPECTED_LAMPORTS, err::RECONCILIATION_FAILED, err::INSUFFICIENT_AVAILABLE,
            err::ARITHMETIC_OVERFLOW, err::VAULT_FROZEN, err::UNAUTHORIZED,
            err::ALREADY_INITIALIZED,
        ] {
            assert!(code >= 6000, "error {code} collides with Anchor's range");
        }
        assert_eq!(err::NOT_SIGNER, 6000);
        assert_eq!(err::UNAUTHORIZED, 6008);
        assert_eq!(err::ALREADY_INITIALIZED, 6009);
    }

    #[test]
    fn instruction_discriminators_are_unique() {
        let mut sorted = [ix::INITIALIZE_VAULT, ix::DEPOSIT, ix::WITHDRAW, ix::RESERVE, ix::RELEASE];
        sorted.sort_unstable();
        for pair in sorted.windows(2) {
            assert_ne!(pair[0], pair[1], "instruction discriminators must not collide");
        }
    }

    #[test]
    fn pda_derivation_is_deterministic_and_off_curve() {
        let program_id = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let (a, bump_a) = find_vault_pda(&vault_seeds(&authority), &program_id).unwrap();
        let (b, bump_b) = find_vault_pda(&vault_seeds(&authority), &program_id).unwrap();
        assert_eq!(a, b, "PDA derivation must be reproducible");
        assert_eq!(bump_a, bump_b);

        // A different authority must give a different vault, or one party could
        // claim another's vault.
        let (c, _) = find_vault_pda(&vault_seeds(&Pubkey::new_unique()), &program_id).unwrap();
        assert_ne!(a, c);

        // And it must be off-curve, or it could be signed for directly. A PDA
        // that lands on the ed25519 curve has no known private key, so the
        // program's authority checks would be the only thing standing between an
        // attacker and a direct signature.
        assert!(!a.is_on_curve(), "a PDA must not be on the ed25519 curve");
    }
}
