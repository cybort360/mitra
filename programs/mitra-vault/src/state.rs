//! The Vault account: capital as six independent positions.
//!
//! **No status field, deliberately** (ADR-0002). A vault is routinely in several
//! positions at once — frozen *and* mid-settlement, encumbered *and* escrowed
//! for different obligations — and any single `status` must pick one, encoding a
//! total order over combinations the product genuinely needs. So capital is
//! arithmetic plus guards, and the guard that replaces a state machine is the
//! reconciliation invariant: the six positions always sum to `total`.
//!
//! The layout is borsh, field-for-field what Anchor's `#[account]` would emit
//! for the same struct, preceded by the 8-byte Anchor discriminator. That is
//! what makes the eventual Anchor migration a wrapper rather than a rewrite.

use crate::anchor_parity::{err, VAULT_DISCRIMINATOR};
use solana_program::{entrypoint::ProgramResult, program_error::ProgramError, pubkey::Pubkey};

/// The six capital positions from PRD §4.12, plus the total they must sum to.
///
/// Borsh is sequential with no padding: `8 + 32 + 1 + 8*7 = 97` after the
/// discriminator, so a full account is `105` bytes. The layout tests assert that
/// exact length, because a silent size change would corrupt every deployed vault.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Vault {
    /// PRD §4.12 authority. The only account permitted to withdraw principal.
    pub authority: Pubkey,
    /// PDA bump, stored so the address is reconstructible from account data
    /// alone — evidence must not depend on re-deriving with a live node.
    pub bump: u8,
    /// Capital that exists and is unattached to any obligation.
    pub available: u64,
    /// Held against a reservation that has not been spent or released.
    pub reserved: u64,
    /// Committed to an obligation in progress.
    pub escrowed: u64,
    /// Pledged against something outside Mitra's control.
    pub encumbered: u64,
    /// In flight to a settlement path.
    pub settling: u64,
    /// Frozen by an emergency. Halts new reservations without stranding capital
    /// already in flight — which is exactly why it is a position, not a status.
    pub frozen: u64,
    /// Total capital held. **Invariant:** the six positions sum to this.
    pub total: u64,
}

/// Bytes of account data, including the 8-byte Anchor discriminator.
pub const VAULT_LEN: usize = 105;

impl Vault {
    /// A zeroed vault. The only way `total` becomes non-zero is a deposit, so a
    /// fresh vault is trivially reconciling.
    pub fn new(authority: Pubkey, bump: u8) -> Self {
        Self {
            authority, bump,
            available: 0, reserved: 0, escrowed: 0,
            encumbered: 0, settling: 0, frozen: 0, total: 0,
        }
    }

    /// True when frozen. A freeze blocks *new* reservations and leaves in-flight
    /// capital alone.
    pub fn is_frozen(&self) -> bool {
        self.frozen > 0
    }

    /// The reconciliation invariant that replaces a state machine.
    ///
    /// Checked after every mutating instruction. This is the single property
    /// that makes "reported spendable capital never exceeds actual available"
    /// (`forge/INVARIANTS.md`) enforceable rather than aspirational.
    pub fn reconcile(&self) -> ProgramResult {
        let sum = self.available
            .checked_add(self.reserved)
            .and_then(|v| v.checked_add(self.escrowed))
            .and_then(|v| v.checked_add(self.encumbered))
            .and_then(|v| v.checked_add(self.settling))
            .and_then(|v| v.checked_add(self.frozen))
            .ok_or_else(|| err::custom(err::RECONCILIATION_FAILED))?;
        if sum != self.total {
            return Err(err::custom(err::RECONCILIATION_FAILED));
        }
        Ok(())
    }

    /// Moves `amount` from `available` to `reserved`.
    ///
    /// Distinguishes "not enough capital" from "arithmetic would underflow",
    /// because conflating them is how a guard stops being diagnostic.
    pub fn reserve(&mut self, amount: u64) -> ProgramResult {
        if self.is_frozen() {
            return Err(err::custom(err::VAULT_FROZEN));
        }
        if amount > self.available {
            return Err(err::custom(err::INSUFFICIENT_AVAILABLE));
        }
        self.available = self.available.checked_sub(amount)
            .ok_or_else(|| err::custom(err::ARITHMETIC_OVERFLOW))?;
        self.reserved = self.reserved.checked_add(amount)
            .ok_or_else(|| err::custom(err::ARITHMETIC_OVERFLOW))?;
        self.reconcile()
    }

    /// Returns `amount` from `reserved` to `available` — a reservation released
    /// or refunded. Permitted **while frozen**: a freeze must not strand capital
    /// that is not at risk, or an emergency would trap in-flight obligations.
    pub fn release(&mut self, amount: u64) -> ProgramResult {
        if amount > self.reserved {
            return Err(err::custom(err::INSUFFICIENT_AVAILABLE));
        }
        self.reserved = self.reserved.checked_sub(amount)
            .ok_or_else(|| err::custom(err::ARITHMETIC_OVERFLOW))?;
        self.available = self.available.checked_add(amount)
            .ok_or_else(|| err::custom(err::ARITHMETIC_OVERFLOW))?;
        self.reconcile()
    }

    /// Adds lamports, increasing `total` and `available` together.
    pub fn deposit(&mut self, amount: u64) -> ProgramResult {
        self.total = self.total.checked_add(amount)
            .ok_or_else(|| err::custom(err::ARITHMETIC_OVERFLOW))?;
        self.available = self.available.checked_add(amount)
            .ok_or_else(|| err::custom(err::ARITHMETIC_OVERFLOW))?;
        self.reconcile()
    }

    /// Serializes to Anchor's on-chain layout: discriminator, then borsh fields.
    pub fn to_bytes(&self) -> [u8; VAULT_LEN] {
        let mut out = [0u8; VAULT_LEN];
        out[..8].copy_from_slice(&VAULT_DISCRIMINATOR);
        out[8..40].copy_from_slice(self.authority.as_ref());
        out[40] = self.bump;
        for (i, v) in [
            self.available, self.reserved, self.escrowed,
            self.encumbered, self.settling, self.frozen, self.total,
        ].iter().enumerate() {
            let at = 41 + i * 8;
            out[at..at + 8].copy_from_slice(&v.to_le_bytes());
        }
        out
    }

    /// Deserializes, rejecting anything without the Anchor discriminator.
    ///
    /// The discriminator check is what Anchor's `AccountDeserialize` does, and it
    /// matters for a reason specific to PDAs: a PDA can hold *any* bytes. Without
    /// it, an attacker could point a vault instruction at an account they control
    /// and have it deserialize as a zeroed Vault.
    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != VAULT_LEN {
            return Err(err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH));
        }
        if data[..8] != VAULT_DISCRIMINATOR {
            return Err(err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH));
        }
        let read_u64 = |i: usize| {
            let mut b = [0u8; 8];
            b.copy_from_slice(&data[41 + i * 8..49 + i * 8]);
            u64::from_le_bytes(b)
        };
        let vault = Self {
            authority: Pubkey::try_from(&data[8..40])
                .map_err(|_| err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH))?,
            bump: data[40],
            available: read_u64(0), reserved: read_u64(1), escrowed: read_u64(2),
            encumbered: read_u64(3), settling: read_u64(4), frozen: read_u64(5),
            total: read_u64(6),
        };
        // A Vault that does not reconcile was never created by this program, or
        // was corrupted. Refusing to load it beats loading a lie.
        vault.reconcile()?;
        Ok(vault)
    }
}
