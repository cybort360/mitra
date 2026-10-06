//! The Anchor program for the confidential mandate policy circuit.
//!
//! ## This replaces the unmodified Arcium template (F44)
//!
//! `arcium build` compiled the encrypted instruction and exited green while this
//! file was still wired to the template's `add_together`. Every macro, context and
//! account below was renamed to `evaluate_mandate` as part of the rewrite, because
//! a rename that misses one macro position fails at compile time with an opaque
//! "Confidential instruction was not found" — but a *partial* rename that still
//! type-checks would silently keep evaluating the wrong circuit.
//!
//! ## What is secret and what is not
//!
//! The mandate's limits are the thing worth hiding (PRD §11.12). All six policy
//! fields are queued as `encrypted_u64`, so no node sees the threshold an agent
//! holds. The *identifiers* — the caller's x25519 key and the callback nonce — are
//! plaintext, exactly as §11.12 describes: enough to establish that a decision
//! occurred under a valid policy, without publishing the policy.
//!
//! ## What this program does NOT do
//!
//! It emits ciphertexts. It does not decrypt them, and it does not enforce
//! anything on its own — per PRD §11, "the enclave MUST NOT be the only
//! enforcement layer". The decision is consumed off-chain, verified, and only then
//! bound to an execution by `validateExecutionBinding`, which re-derives
//! independently of the MPC result.

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

const COMP_DEF_OFFSET_EVALUATE_MANDATE: u32 = comp_def_offset("evaluate_mandate");

declare_id!("7ZAm4faeREU54yDKWBKqfvRjSucgxBT5zaMWyJvYcU29");

#[arcium_program]
pub mod probe {
    use super::*;

    /// Registers the computation definition for `evaluate_mandate`.
    pub fn init_evaluate_mandate_comp_def(
        ctx: Context<InitEvaluateMandateCompDef>,
    ) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    /// Queues a confidential policy evaluation.
    ///
    /// Six encrypted `u64` inputs, matching `MandatePolicyInput` field for field.
    /// The ORDER here is load-bearing: it must match the circuit's struct layout,
    /// and nothing in the type system checks that. The comment on each argument
    /// names the circuit field it feeds.
    pub fn evaluate_mandate(
        ctx: Context<EvaluateMandate>,
        computation_offset: u64,
        // circuit field `amount` — the action's value
        ciphertext_amount: [u8; 32],
        // circuit field `max_transaction` — the mandate's per-action ceiling
        ciphertext_max_transaction: [u8; 32],
        // circuit field `budget` — the mandate's total ceiling
        ciphertext_budget: [u8; 32],
        // circuit field `available` — capital actually available to the vault
        ciphertext_available: [u8; 32],
        // circuit field `mandate_live` — 1 if active and unexpired, else 0
        ciphertext_mandate_live: [u8; 32],
        // circuit field `chain_allowed` — 1 if chain is on the mandate's list, else 0
        ciphertext_chain_allowed: [u8; 32],
        // caller x25519 key, used to encrypt the decision back to it
        pubkey: [u8; 32],
        // callback nonce, plaintext
        nonce: u128,
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let args = ArgBuilder::new()
            .x25519_pubkey(pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ciphertext_amount)
            .encrypted_u64(ciphertext_max_transaction)
            .encrypted_u64(ciphertext_budget)
            .encrypted_u64(ciphertext_available)
            .encrypted_u64(ciphertext_mandate_live)
            .encrypted_u64(ciphertext_chain_allowed)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![EvaluateMandateCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1, // num ciphertext inputs
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "evaluate_mandate")]
    pub fn evaluate_mandate_callback(
        ctx: Context<EvaluateMandateCallback>,
        output: SignedComputationOutputs<EvaluateMandateOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(EvaluateMandateOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        emit!(MandateDecisionEvent {
            allowed: o.ciphertexts[0],
            reason: o.ciphertexts[1],
            nonce: o.nonce.to_le_bytes(),
        });
        Ok(())
    }
}

#[queue_computation_accounts("evaluate_mandate", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct EvaluateMandate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_EVALUATE_MANDATE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("evaluate_mandate")]
#[derive(Accounts)]
pub struct EvaluateMandateCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_EVALUATE_MANDATE))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: address is validated by the Arcium program; verify_output reads slot data from it.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[init_computation_definition_accounts("evaluate_mandate", payer)]
#[derive(Accounts)]
pub struct InitEvaluateMandateCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    /// Can't check it here as it's not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

/// The confidential decision. Both fields are ciphertexts.
#[event]
pub struct MandateDecisionEvent {
    pub allowed: [u8; 32],
    pub reason: [u8; 32],
    pub nonce: [u8; 16],
}

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
}
