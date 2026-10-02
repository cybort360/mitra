/**
 * Per-Space asset resolution (ADR-0011 open item 2).
 *
 * ## What this replaces
 *
 * `BASE_ASSETS`, `SOLANA_ASSETS` and `TEMPO_TOKENS` were module constants inside
 * each adapter. That made **one deployer decide which assets exist and which mint
 * addresses are real** — which is a custodian deciding what capital is
 * admissible, and it contradicts the premise of the whole system.
 *
 * ## The resolution order
 *
 *   1. the Space's own `assets` map, if it declares one;
 *   2. the marketplace's rule set, when `rules.source === "external"` and the
 *      caller supplies the registry that rule set publishes;
 *   3. **refusal**. Never a built-in default.
 *
 * Step 3 is the point. A fallback to a module constant would restore exactly the
 * centralisation this removes, and it would do so invisibly — the adapter would
 * appear configured and quietly answer for a market nobody authorised.
 *
 * ## Why an unverifiable asset is refused rather than warned about
 *
 * A mint address is a claim. If the Space did not record it and the marketplace
 * rule set did not publish it, no one can check it, and an agent settling to an
 * address nobody approved is exactly the substitution attack this design exists
 * to refuse. `UNVERIFIABLE_ASSET` is the honest answer.
 */

import type { Space } from "@/lib/domain/types";
import { isExternallyGoverned } from "@/lib/kernel/space-governance";

export interface ResolvedAsset {
  symbol: string;
  address: string;
  decimals: number;
  /** Where this came from — so an operator can see WHO admitted the asset. */
  source: "space" | "external-rules" | "refused";
  /** The rule set that published it, when external. */
  ruleSetRef?: string;
}

export type AssetResult =
  | { ok: true; asset: ResolvedAsset }
  | { ok: false; reason: string };

export interface AssetResolverDeps {
  /**
   * The registry published by the marketplace named in `rules.ruleSetRef`.
   *
   * Supplied by the caller, NOT fetched by Mitra: reading it from the marketplace
   * at resolution time would let the marketplace change the terms between the
   * agreement and the settlement, which is the change-of-terms this design refuses
   * to apply silently (see `externalRulesChanged`).
   */
  externalRegistry?: Record<string, { address: string; decimals: number }>;
}

/**
 * Resolves an asset for a Space, or refuses.
 *
 * An empty `ok: false` is a real answer. Adapters call this rather than reading
 * a constant, so a Space that admits no USDC cannot settle in USDC.
 */
export function resolveAsset(
  space: Space,
  symbol: string,
  deps: AssetResolverDeps = {},
): AssetResult {
  const declared = space.assets?.[symbol];
  if (declared) {
    return {
      ok: true,
      asset: { symbol, address: declared.address, decimals: declared.decimals, source: "space" },
    };
  }

  if (isExternallyGoverned(space)) {
    // The Space did not declare it, so under a marketplace rule set the
    // marketplace's own published registry governs — but only if the CALLER
    // supplied it, so the terms in force are the ones recorded at agreement time.
    const ext = deps.externalRegistry?.[symbol];
    if (ext) {
      return {
        ok: true,
        asset: {
          symbol,
          address: ext.address,
          decimals: ext.decimals,
          source: "external-rules",
          ruleSetRef: space.rules.ruleSetRef,
        },
      };
    }
    return {
      ok: false,
      reason: `EXTERNAL_RULES_DO_NOT_PUBLISH:${space.rules.ruleSetRef ?? "unknown"}:${symbol}`,
    };
  }

  // No built-in default. A Space that has not admitted an asset cannot use it.
  return { ok: false, reason: `SPACE_HAS_NOT_ADMITTED_ASSET:${symbol}` };
}

/**
 * Whether a settlement's asset is admissible, for use as a pre-flight check.
 *
 * Separate from `resolveAsset` so a caller can ASK without the adapter being
 * committed to an address it has not verified.
 */
export function assetAdmitted(space: Space, symbol: string, deps: AssetResolverDeps = {}): boolean {
  return resolveAsset(space, symbol, deps).ok;
}
