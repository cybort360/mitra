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

use crate::anchor_parity::{
    authorization_discriminator, err, job_escrow_discriminator, mandate_discriminator,
    VAULT_DISCRIMINATOR,
};
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

    /// The capital the vault's **own lamports** must account for: everything except
    /// what is sitting in an escrow PDA.
    ///
    /// ## Why this exists, and what it cost to find out
    ///
    /// The vault's lamports are checked against its capital on every
    /// `reserve`/`release` (see `check_no_surplus_lamports`), and that check was
    /// written when every lamport of `total` was in the vault account. Adding the
    /// job escrow broke the assumption: `lock_escrow` moves lamports *out* to the
    /// escrow PDA while `total` deliberately does not change, so a vault with one
    /// outstanding job reports `lamports == total - escrowed + rent` and the check
    /// — written as `total + rent` — fails.
    ///
    /// The consequence was not a wrong number in a report. It was that **a single
    /// outstanding escrow disabled `reserve` and `release` for the entire vault**:
    /// every reservation returned `UNEXPECTED_LAMPORTS` (6003). Found on devnet
    /// (F70), where `total - escrowed + rent` reconciled to the lamported balance
    /// to the lamport — which is what identified the fix as exact rather than
    /// approximate. An in-process suite could not have found it: nothing in the
    /// escrow tests runs `reserve` against a vault that has an outstanding escrow.
    ///
    /// Subtracting `escrowed` is not a weakening. `escrowed` is written only by
    /// the three escrow transitions, each of which moves exactly the lamports it
    /// accounts for, and the account is a program-owned PDA whose data nothing
    /// else can alter. So `total - escrowed` is still precisely the capital the
    /// vault holds, and any lamport above or below it is still an unaccounted
    /// injection or a drain.
    pub fn held(&self) -> u64 {
        self.total.checked_sub(self.escrowed)
            .expect("a reconciling vault never has more escrowed than total")
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

    /// Removes `amount` from `available` and `total` together — capital leaving
    /// the vault.
    ///
    /// **Refused while frozen**, unlike `release`. The two are not symmetric and
    /// the asymmetry is deliberate:
    ///
    /// - `release` moves `reserved -> available`. The capital stays inside the
    ///   vault the whole time, and a freeze must not strand it or an emergency
    ///   would trap in-flight obligations.
    /// - `withdraw` moves capital *out* of the vault. A freeze exists precisely to
    ///   stop value leaving during an incident, so permitting a withdrawal during
    ///   one would make the switch advisory for the only operation it most needs to
    ///   stop.
    ///
    /// This method did not exist until FR-VAULT-006 was tested. `withdraw` in
    /// `lib.rs` previously did the arithmetic inline (`vault.available -= amount`),
    /// which is why it had no state-level guard, could not be unit-tested, and
    /// silently skipped the freeze check its sibling `reserve` enforces.
    ///
    /// The authority is re-derived from vault data by the caller; this method only
    /// enforces the capital rules.
    pub fn withdraw(&mut self, amount: u64) -> ProgramResult {
        if self.is_frozen() {
            return Err(err::custom(err::VAULT_FROZEN));
        }
        if amount > self.available {
            return Err(err::custom(err::INSUFFICIENT_AVAILABLE));
        }
        self.available = self.available.checked_sub(amount)
            .ok_or_else(|| err::custom(err::ARITHMETIC_OVERFLOW))?;
        self.total = self.total.checked_sub(amount)
            .ok_or_else(|| err::custom(err::ARITHMETIC_OVERFLOW))?;
        self.reconcile()
    }

    /// Moves `amount` from `available` to `escrowed` — capital committed to one
    /// named job, held in its own escrow account.
    ///
    /// **Refused while frozen**, like `reserve`: this attaches capital to a *new*
    /// obligation, which is exactly what a freeze exists to stop.
    ///
    /// The lamports themselves leave for the escrow PDA, so unlike `reserve` the
    /// capital is no longer reachable through the vault at all. That is the
    /// difference between earmarking and escrowing, and it is why `total` is
    /// unchanged here: the money is still Mitra's, just not the vault's.
    pub fn lock_to_escrow(&mut self, amount: u64) -> ProgramResult {
        if self.is_frozen() {
            return Err(err::custom(err::VAULT_FROZEN));
        }
        if amount == 0 {
            return Err(ProgramError::InvalidArgument);
        }
        if amount > self.available {
            return Err(err::custom(err::INSUFFICIENT_AVAILABLE));
        }
        self.available = self.available.checked_sub(amount)
            .ok_or_else(|| err::custom(err::ARITHMETIC_OVERFLOW))?;
        self.escrowed = self.escrowed.checked_add(amount)
            .ok_or_else(|| err::custom(err::ARITHMETIC_OVERFLOW))?;
        self.reconcile()
    }

    /// Moves `amount` out of `escrowed` **and out of the vault** — the provider is
    /// paid. This is `withdraw` for one job.
    ///
    /// **Refused while frozen**, for the reason `withdraw` is: value leaving the
    /// vault is what the freeze exists to prevent, and permitting it here would
    /// make the freeze advisory for the one payment most likely to be illegitimate
    /// during an incident.
    pub fn pay_escrow(&mut self, amount: u64) -> ProgramResult {
        if self.is_frozen() {
            return Err(err::custom(err::VAULT_FROZEN));
        }
        if amount == 0 {
            return Err(ProgramError::InvalidArgument);
        }
        if amount > self.escrowed {
            return Err(err::custom(err::INSUFFICIENT_AVAILABLE));
        }
        self.escrowed = self.escrowed.checked_sub(amount)
            .ok_or_else(|| err::custom(err::ARITHMETIC_OVERFLOW))?;
        self.total = self.total.checked_sub(amount)
            .ok_or_else(|| err::custom(err::ARITHMETIC_OVERFLOW))?;
        self.reconcile()
    }

    /// Moves `amount` from `escrowed` back to `available` — a refund. The capital
    /// never left Mitra, and returns to the client's own headroom.
    ///
    /// **Permitted while frozen**, like `release`. This is the autonomous recovery
    /// path: it is exercised precisely when something has gone wrong, and a freeze
    /// that could block it would turn an emergency stop into a permanent trap for
    /// the client's own capital.
    pub fn return_escrow(&mut self, amount: u64) -> ProgramResult {
        if amount == 0 {
            return Err(ProgramError::InvalidArgument);
        }
        if amount > self.escrowed {
            return Err(err::custom(err::INSUFFICIENT_AVAILABLE));
        }
        self.escrowed = self.escrowed.checked_sub(amount)
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

// ─────────────────────────────────────────────────────────────────────────────
// Mandate: the persistent, versioned authority object (ADR-0009).
// ─────────────────────────────────────────────────────────────────────────────
//
// Engraving contributes the *semantics* here, and ADR-0009 records exactly what
// was reused and what was refused. The two refusals are load-bearing, so they
// are stated in the type itself rather than only in a document:
//
//   REFUSED — Engraving's four-state `EngravingStatus` machine. A mandate may
//   be live, expired, or revoked; it may not be "spent". Spend is a property of
//   an *authorization*, not of the mandate, and folding it in would make the
//   mandate a one-shot object that cannot authorize a second action — which is
//   the normal case. This type therefore has no `status` field at all.
//
//   REFUSED — COTI's implementation. This is borsh with explicit byte offsets,
//   not COTI's protobuf. The mandate *account* is a product concept in Mitra's
//   own canonical serialization, not an import.
//
// What is kept from Engraving: the mandate is persistent, it is versioned, and
// a proposal is evaluated against a *specific* version so that a decision can
// name the policy text that produced it.


/// Byte length of a serialized Mandate: 8 discriminator + 32 holder + 32 limit +
/// 8 version + 8 expires_at + 8 ceiling = 96.
///
/// Fixed and asserted by the layout tests. A mandate's size changing silently
/// would invalidate every stored policy, and unlike the vault there is no
/// reconciliation invariant to catch it at load.
pub const MANDATE_LEN: usize = 138;

/// The length a Mandate had before `revoked` existed. Still loadable — see
/// [`Mandate::try_from_bytes`].
pub const MANDATE_LEN_PRE_REVOCATION: usize = 96;

/// The length a Mandate had before it carried a [`MandateBinding`]. Still
/// loadable, as an UNBOUND mandate that can neither authorize nor spend.
pub const MANDATE_LEN_PRE_BINDING: usize = 97;

/// Who granted a mandate, and who may issue permits under it.
///
/// **Before this existed, neither question had an answer on chain.** The agent
/// opened its own mandate with any limit it liked, `authorize` accepted any
/// signer as the policy engine, and `spend_authorized` debited whatever vault the
/// caller named. Each gap alone let a stranger move a principal's capital. See
/// FAILURES.md F51.
///
/// The PRD's mandate is *"the principal's mandate"* (§3): the principal grants it
/// to an agent over a vault the principal controls, and names the engine whose
/// decisions it will honour. ADR-0009 decision 2 — *"only the program may author
/// an Authorization"* — is only true if the program knows which engine's request
/// to act on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MandateBinding {
    /// The vault authority who granted this mandate. The only vault it can spend
    /// from is this key's vault PDA, and only this key may amend it.
    pub principal: Pubkey,
    /// The only signer `authorize` accepts for this mandate.
    pub policy_engine: Pubkey,
}

/// A mandate is live until this timestamp. The *only* lifecycle field that is
/// not a version or a limit.
///
/// Phase 3a scope: expiry is stored and enforced at authorization time. Revocation
/// is Phase 3b — it needs a bump of `version` plus a terminal flag, and adding a
/// flag now would mean shipping a layout I had not yet needed to change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mandate {
    /// The agent this mandate authorizes. The PDA is derived from this key, so
    /// the account cannot be reassigned to a different agent.
    pub holder: Pubkey,
    /// Largest single action this mandate can authorize, in base units.
    ///
    /// A per-action ceiling, not a total. A cumulative counter would need to be
    /// mutated by the program on every spend, which is a *stateful* budget and
    /// re-introduces exactly the sequencing the ceiling is meant to avoid. The
    /// per-action bound is what the vault's own `available` check is for.
    pub limit: u64,
    /// Monotonic policy version. Every change to `limit` or `expires_at`
    /// increments it.
    ///
    /// This is Engraving's central idea: a proposal is evaluated against a
    /// *named* version, so "this was permitted" is answerable after the fact even
    /// if the mandate has since changed. Without it, any tightening is
    /// retroactively retroactive and no evidence survives.
    pub version: u64,
    /// Unix timestamp. A proposal carrying a version created after this instant
    /// is refused with MANDATE_EXPIRED.
    pub expires_at: u64,
    /// Cumulative ceiling the vault enforces, copied here at authorization time
    /// so the two constraints can be checked against the same instant.
    pub ceiling: u64,
    /// Terminal. A revoked mandate can neither amend itself nor issue new
    /// permits, and every outstanding permit stops being spendable.
    ///
    /// **Revocation is not a version bump.** The two answer different questions:
    /// amending says "here is a tighter policy, existing promises stand";
    /// revoking says "the agent is compromised, everything stops now". Folding
    /// them together would make a routine limit reduction indistinguishable from
    /// an emergency kill switch, and the caller would be unable to tell from the
    /// version number which had happened.
    pub revoked: bool,
    /// `None` only for a mandate written under a layout that predates binding.
    /// Such a mandate is inert: it cannot authorize, spend, or be amended. Fail
    /// closed — there is no safe principal or engine to assume for it.
    pub binding: Option<MandateBinding>,
}

impl Mandate {
    /// Borsh-serialize, prefixing the Anchor discriminator.
    pub fn to_bytes(&self) -> [u8; MANDATE_LEN] {
        let mut out = [0u8; MANDATE_LEN];
        out[0..8].copy_from_slice(&mandate_discriminator());
        out[8..40].copy_from_slice(self.holder.as_ref());
        out[40..48].copy_from_slice(&self.limit.to_le_bytes());
        out[48..56].copy_from_slice(&self.version.to_le_bytes());
        out[56..64].copy_from_slice(&self.expires_at.to_le_bytes());
        out[64..72].copy_from_slice(&self.ceiling.to_le_bytes());
        out[72] = u8::from(self.revoked);
        if let Some(b) = self.binding {
            out[73] = 1;
            out[74..106].copy_from_slice(b.principal.as_ref());
            out[106..138].copy_from_slice(b.policy_engine.as_ref());
        }
        out
    }

    /// Load a mandate, verifying the discriminator.
    ///
    /// The version must be non-zero: version 0 is reserved for "never created",
    /// so a mandate claiming to be version 0 is not one this program wrote.
    pub fn try_from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        // Both the current length and the pre-revocation length are accepted.
        //
        // A mandate created before `revoked` existed is 96 bytes with no way to
        // carry the flag; it is read as not-revoked, which is the correct
        // default for an account the program wrote under the older layout. The
        // alternative — refusing 96 — would leave the deployed Phase 3 evidence
        // unreadable, which is a worse failure than a permissive default on a
        // layout version that provably predates the field.
        if data.len() != MANDATE_LEN
            && data.len() != MANDATE_LEN_PRE_BINDING
            && data.len() != MANDATE_LEN_PRE_REVOCATION
        {
            return Err(err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH));
        }
        if data[0..8] != mandate_discriminator() {
            return Err(err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH));
        }
        // Offsets are named rather than derived from `i * 8`. The arithmetic does
        // happen to work out (40 is 8-aligned, so `i*8` lands on each field), but
        // that alignment is a coincidence of *this* layout — a field inserted at
        // byte 48 would silently shift every later read by three bytes and still
        // compile. Naming the offsets makes the next edit safe by construction.
        let read_u64 = |from: usize| {
            let mut b = [0u8; 8];
            b.copy_from_slice(&data[from..from + 8]);
            u64::from_le_bytes(b)
        };
        const OFF_LIMIT: usize = 40;
        const OFF_VERSION: usize = 48;
        const OFF_EXPIRES: usize = 56;
        const OFF_CEILING: usize = 64;
        const OFF_REVOKED: usize = 72;
        const OFF_BOUND: usize = 73;
        const OFF_PRINCIPAL: usize = 74;
        const OFF_ENGINE: usize = 106;
        let version = read_u64(OFF_VERSION);
        if version == 0 {
            return Err(err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH));
        }
        Ok(Self {
            holder: Pubkey::try_from(&data[8..40])
                .map_err(|_| err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH))?,
            limit: read_u64(OFF_LIMIT),
            version,
            expires_at: read_u64(OFF_EXPIRES),
            ceiling: read_u64(OFF_CEILING),
            // A 96-byte account has no flag byte; absent means not revoked.
            revoked: data.get(OFF_REVOKED).is_some_and(|&b| b != 0),
            // The flag byte is required, not inferred from the length: a zeroed
            // principal would otherwise read as the system program's key.
            binding: if data.len() == MANDATE_LEN && data[OFF_BOUND] == 1 {
                Some(MandateBinding {
                    principal: Pubkey::try_from(&data[OFF_PRINCIPAL..OFF_ENGINE])
                        .map_err(|_| err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH))?,
                    policy_engine: Pubkey::try_from(&data[OFF_ENGINE..MANDATE_LEN])
                        .map_err(|_| err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH))?,
                })
            } else {
                None
            },
        })
    }

    /// Does this mandate still permit *any* action at `now`?
    ///
    /// Split from `authorize` so that a caller can distinguish "this mandate is
    /// over" from "this action is too big". Merging them would make every
    /// refusal look like a ceiling problem and hide expiry entirely.
    pub fn is_live_at(&self, now: u64) -> bool {
        now < self.expires_at
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Authorization: a single-use, action-bound permit (ADR-0009, decision 4).
// ─────────────────────────────────────────────────────────────────────────────
//
// **The type that makes the load-bearing mechanism structural.** AGENTS.md is
// blunt that "an ALLOW decision is never itself permission to move value", and
// that an ALLOW which skips re-derivation "is not a weaker guarantee — it is no
// guarantee". An `Authorization` is that re-derivation, made into an object the
// chain can hold.
//
// Why one account per action (design option (a)) rather than a replay bitmap on
// the mandate (option (b)):
//
//   The rejected alternative was a bitmap. It is cheaper — one account, no rent
//   per action — and it was refused because it makes evidence *unnnameable*: with
//   a bitmap, "was this specific authorization used?" is a question about the
//   whole mandate, not about any addressable object, so a dispute over one action
//   forces a reader to load and decode the entire policy history to answer a
//   yes/no question. The whole purpose of the versioned mandate is that a
//   decision can cite the policy text that produced it, and a bitmap forfeits
//   that. Rent is a price; unnameable evidence is a design error.
//
// **Single-use is enforced by a program-mutated flag, not by the caller.** The
// caller cannot assert "I have not used this" any more than it can assert its
// own spend decision; the program sets `consumed = true` in the same
// instruction that moves value, so there is no window in which a second spend
// could observe an unused authorization.

/// Byte length: 8 discriminator + 32 holder + 32 action_hash + 8 amount + 8
/// mandate_version + 8 expires_at + 1 consumed + 1 bump + 32 recipient = 130.
///
/// Was 98, without `recipient`. A 98-byte permit does not load: it names no
/// payee, and `spend_authorized` must refuse to choose one for it.
pub const AUTHORIZATION_LEN: usize = 130;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Authorization {
    /// The agent this authorizes. Bound into the PDA seeds, so an authorization
    /// cannot be presented by a different agent than the one it was issued to.
    pub holder: Pubkey,
    /// Commitment to **one exact economic action**.
    ///
    /// This is the field that does the real work. A permit that said "spend up to
    /// 100" would be reusable across any action within that amount; hashing the
    /// action itself means the permit dies with the thing it describes. A caller
    /// that wants to spend 100 must hold 100 *distinct* authorizations.
    pub action_hash: [u8; 32],
    /// The amount this specific action may move, checked against the vault at
    /// spend time.
    pub amount: u64,
    /// Which mandate version authorized this. Stored, not re-read, so evidence
    /// survives the mandate being tightened afterwards.
    pub mandate_version: u64,
    /// The mandate's own expiry, copied at issue time. A permit cannot outlive
    /// the policy that created it.
    pub expires_at: u64,
    /// Single-use flag. Written only by this program, only in the instruction
    /// that moves value.
    pub consumed: bool,
    pub bump: u8,
    /// The only account this permit can pay.
    ///
    /// `spend_authorized` needs no signature, so before this field the payee was
    /// whatever account the caller placed first — anyone who saw an unspent permit
    /// on chain could redeem it to themselves (F51). The engine names the payee
    /// when it issues the permit, because who gets paid is part of the decision.
    pub recipient: Pubkey,
}

impl Authorization {
    pub fn to_bytes(&self) -> [u8; AUTHORIZATION_LEN] {
        let mut out = [0u8; AUTHORIZATION_LEN];
        out[0..8].copy_from_slice(&authorization_discriminator());
        out[8..40].copy_from_slice(self.holder.as_ref());
        out[40..72].copy_from_slice(&self.action_hash);
        out[72..80].copy_from_slice(&self.amount.to_le_bytes());
        out[80..88].copy_from_slice(&self.mandate_version.to_le_bytes());
        out[88..96].copy_from_slice(&self.expires_at.to_le_bytes());
        out[96] = u8::from(self.consumed);
        out[97] = self.bump;
        out[98..130].copy_from_slice(self.recipient.as_ref());
        out
    }

    pub fn try_from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != AUTHORIZATION_LEN {
            return Err(err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH));
        }
        if data[0..8] != authorization_discriminator() {
            return Err(err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH));
        }
        let read_u64 = |from: usize| {
            let mut b = [0u8; 8];
            b.copy_from_slice(&data[from..from + 8]);
            u64::from_le_bytes(b)
        };
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&data[40..72]);
        Ok(Self {
            holder: Pubkey::try_from(&data[8..40])
                .map_err(|_| err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH))?,
            action_hash: hash,
            amount: read_u64(72),
            mandate_version: read_u64(80),
            expires_at: read_u64(88),
            // Strictly `!= 0` rather than `== 1`. A corrupted account holding any
            // non-zero byte must read as consumed, not as unused — the safe
            // direction to be wrong in. Treating a stray 0xFF as an unspent permit
            // would turn corruption into spendable value.
            consumed: data[96] != 0,
            bump: data[97],
            recipient: Pubkey::try_from(&data[98..130])
                .map_err(|_| err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH))?,
        })
    }

    /// May this authorization be spent, right now, for this exact action?
    ///
    /// Three independent refusals, deliberately not collapsed into one. Each
    /// answers a different question and a client needs to tell them apart:
    /// a consumed permit is a replay attempt, a mismatched hash is a confused
    /// deputy, and an expired one is stale policy. A single boolean would erase
    /// the distinction and make replay attempts indistinguishable from typos.
    pub fn spendable_at(&self, action: &[u8; 32], now: u64) -> Result<(), ProgramError> {
        if self.consumed {
            return Err(err::custom(err::AUTHORIZATION_CONSUMED));
        }
        if &self.action_hash != action {
            return Err(err::custom(err::ACTION_HASH_MISMATCH));
        }
        if now >= self.expires_at {
            return Err(err::custom(err::MANDATE_EXPIRED));
        }
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// JobEscrow: one job's capital, held apart, with a pre-committed way back.
// ─────────────────────────────────────────────────────────────────────────────
//
// The EVM escrow (`MitraJobEscrow.sol`, LP-2) exists because ERC-8183 needs a
// job's tokens to sit somewhere the provider cannot reach and the client cannot
// spend twice. Solana's vault had `reserve`/`release`, which is *earmarking*: the
// lamports never move, so a provider who went silent held nothing back and a
// client who wanted its own money back had to ask. This type is the on-chain
// form of the ERC-8183 job on this rail, and it has one property `reserve` can
// never have: the money is genuinely in another account, so it is genuinely
// unavailable to anyone but the two parties and a timeout.
//
// Two rules are structural rather than advisory, and both are enforced at the
// type level so they cannot be forgotten at a call site:
//
//   1. **The refund route is committed at lock time.** PRD §15.5 — "a
//      compensation route must be committed before execution when possible;
//      never let the recovery engine invent arbitrary compensation calldata
//      after failure". `refund_route_hash` is the hash of that route. It is set
//      once and [`JobEscrow::has_commitment`] is the only thing a refund is
//      allowed to consult, so there is no code path that could pay out against a
//      route nobody agreed to.
//
//   2. **Settlement is terminal and one-shot.** `completed` and `refunded` are
//      distinct flags rather than an enum, so a corrupted byte can never make a
//      released job readable as refundable — but they are checked *together*
//      (see [`JobEscrow::is_settled`]), so neither can be set after the other.

/// Byte length of a serialized JobEscrow.
///
/// 8 discriminator + 32 job_id + 32 client + 32 provider + 8 amount +
/// 8 timeout + 1 completed + 1 refunded + 32 refund_route_hash = 154.
pub const ESCROW_LEN: usize = 154;

/// Byte offsets, named for the same reason the Mandate's are: the arithmetic
/// happens to work out, and that coincidence is exactly what a future field
/// insertion would break silently.
mod off {
    pub const JOB_ID: usize = 8;
    pub const CLIENT: usize = 40;
    pub const PROVIDER: usize = 72;
    pub const AMOUNT: usize = 104;
    pub const TIMEOUT: usize = 112;
    pub const COMPLETED: usize = 120;
    pub const REFUNDED: usize = 121;
    pub const ROUTE: usize = 122;
}

/// One job's escrowed capital, and the terms on which it may leave.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JobEscrow {
    /// PRD §13 job identifier, hashed to 32 bytes. Recorded rather than implied
    /// so that the account is self-describing: evidence about a job should not
    /// require re-deriving it against a live node, which is the same rule the
    /// Vault's stored bump follows.
    pub job_id: [u8; 32],
    /// The vault authority whose capital this is. Also the only account whose
    /// signature releases it.
    pub client: Pubkey,
    /// The only account the released capital can be paid to. Stored, never
    /// supplied by the caller — the F51 lesson, applied to a payee that did not
    /// exist when F51 was written.
    pub provider: Pubkey,
    /// Lamports held by this escrow. Read from the account, never from an
    /// instruction argument, so a caller cannot name the sum it wants paid.
    pub amount: u64,
    /// Unix seconds after which anyone may trigger a refund. `>=` is the refund
    /// boundary, matching the EVM's `block.timestamp >= j.timeout`.
    pub timeout: u64,
    pub completed: bool,
    pub refunded: bool,
    /// PRD §15.5 — the compensation route, hash-committed at funding time. Never
    /// synthesized after the failure. All-zero means no commitment was made, and
    /// a refund against it is refused.
    pub refund_route_hash: [u8; 32],
}

impl JobEscrow {
    pub fn new(
        job_id: [u8; 32],
        client: Pubkey,
        provider: Pubkey,
        amount: u64,
        timeout: u64,
        refund_route_hash: [u8; 32],
    ) -> Self {
        Self {
            job_id,
            client,
            provider,
            amount,
            timeout,
            completed: false,
            refunded: false,
            refund_route_hash,
        }
    }

    /// True when a compensation route was committed.
    ///
    /// An all-zero hash is the absence of one, not a hash: `bytes32(0)` is what
    /// `MitraJobEscrow.sol` refuses at funding time for exactly this reason.
    pub fn has_commitment(&self) -> bool {
        self.refund_route_hash != [0u8; 32]
    }

    /// Terminal, in either direction.
    ///
    /// Both flags, deliberately: an escrow that has been paid and an escrow that
    /// has been refunded are equally dead, and checking only the flag relevant to
    /// the instruction being run would let a released job be refunded afterwards.
    pub fn is_settled(&self) -> bool {
        self.completed || self.refunded
    }

    /// The client paid, or released early to take the money back. Either way the
    /// job is over and `amount` is the sum that moves.
    pub fn mark_completed(&mut self) -> ProgramResult {
        if self.is_settled() {
            return Err(err::custom(err::ESCROW_ALREADY_SETTLED));
        }
        self.completed = true;
        Ok(())
    }

    pub fn mark_refunded(&mut self) -> ProgramResult {
        if self.is_settled() {
            return Err(err::custom(err::ESCROW_ALREADY_SETTLED));
        }
        self.refunded = true;
        Ok(())
    }

    /// Does the vault's freeze permit a refund at `now`?
    ///
    /// Not a property of this type — a refund is autonomous, and the caller may
    /// be a keeper who is not the client. Stated as a method so the two
    /// conditions are read together in one place: a refund needs the route
    /// committed, and it needs *either* the deadline passed *or* the client's own
    /// rejection.
    pub fn refundable_at(&self, now: u64, caller_is_client: bool) -> Result<(), ProgramError> {
        if !self.has_commitment() {
            return Err(err::custom(err::NO_COMMITMENT));
        }
        if !caller_is_client && now < self.timeout {
            return Err(err::custom(err::BEFORE_TIMEOUT));
        }
        Ok(())
    }

    pub fn to_bytes(&self) -> [u8; ESCROW_LEN] {
        let mut out = [0u8; ESCROW_LEN];
        out[0..8].copy_from_slice(&job_escrow_discriminator());
        out[off::JOB_ID..off::JOB_ID + 32].copy_from_slice(&self.job_id);
        out[off::CLIENT..off::CLIENT + 32].copy_from_slice(self.client.as_ref());
        out[off::PROVIDER..off::PROVIDER + 32].copy_from_slice(self.provider.as_ref());
        out[off::AMOUNT..off::AMOUNT + 8].copy_from_slice(&self.amount.to_le_bytes());
        out[off::TIMEOUT..off::TIMEOUT + 8].copy_from_slice(&self.timeout.to_le_bytes());
        out[off::COMPLETED] = u8::from(self.completed);
        out[off::REFUNDED] = u8::from(self.refunded);
        out[off::ROUTE..off::ROUTE + 32].copy_from_slice(&self.refund_route_hash);
        out
    }

    /// Load an escrow, verifying the discriminator.
    ///
    /// A zero amount is refused here rather than at each call site: it is what an
    /// *initialized but never funded* account looks like, and every instruction
    /// that reads one would otherwise have to invent its own answer. The refusal
    /// is `ESCROW_NOT_FUNDED` rather than a decode error because "you named the
    /// wrong account" and "this job was never funded" send an operator to
    /// completely different places.
    pub fn try_from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != ESCROW_LEN {
            return Err(err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH));
        }
        if data[0..8] != job_escrow_discriminator() {
            return Err(err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH));
        }
        let read_u64 = |from: usize| {
            let mut b = [0u8; 8];
            b.copy_from_slice(&data[from..from + 8]);
            u64::from_le_bytes(b)
        };
        let mut job_id = [0u8; 32];
        job_id.copy_from_slice(&data[off::JOB_ID..off::JOB_ID + 32]);
        let mut refund_route_hash = [0u8; 32];
        refund_route_hash.copy_from_slice(&data[off::ROUTE..off::ROUTE + 32]);
        let escrow = Self {
            job_id,
            client: Pubkey::try_from(&data[off::CLIENT..off::PROVIDER])
                .map_err(|_| err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH))?,
            provider: Pubkey::try_from(&data[off::PROVIDER..off::AMOUNT])
                .map_err(|_| err::custom(err::ACCOUNT_DISCRIMINATOR_MISMATCH))?,
            amount: read_u64(off::AMOUNT),
            timeout: read_u64(off::TIMEOUT),
            // `!= 0` in both directions, matching `Authorization::consumed`: any
            // stray non-zero byte in a flag must read as *set*, because the safe
            // direction to be wrong about a settlement flag is "already done".
            completed: data[off::COMPLETED] != 0,
            refunded: data[off::REFUNDED] != 0,
            refund_route_hash,
        };
        if escrow.amount == 0 {
            return Err(err::custom(err::ESCROW_NOT_FUNDED));
        }
        Ok(escrow)
    }
}
