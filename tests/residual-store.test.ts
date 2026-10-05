/**
 * Phase 7: a reservation keeps the residual it pays, on whichever backend the
 * routes use (in-memory, or Postgres when DATABASE_URL is set).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getStore } from "@/lib/store/provider";
import { prepareStore } from "./fixtures";

beforeEach(async () => {
  await prepareStore();
});

describe("reservation residualRef persistence", () => {
  it("is written with the reservation and read back, and absent when not set", async () => {
    const { repo } = await getStore();
    const terms = {
      vaultId: "vault_sol_primary", amount: 1, runId: "run_res_store", intentId: "i", mandateId: "mandate_research_public_v7",
      mandateVersion: 1, asset: "USDC" as const, chain: "solana" as const, actionDigest: "sha256:test",
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const withRef = await repo.reserveCapital({ ...terms, reservationId: "res_with_ref", residualRef: "epoch_9#2" });
    const without = await repo.reserveCapital({ ...terms, reservationId: "res_without_ref" });
    expect(withRef.ok && without.ok, JSON.stringify([withRef, without])).toBe(true);
    expect((await repo.getReservation("res_with_ref"))?.residualRef).toBe("epoch_9#2");
    expect((await repo.getReservation("res_without_ref"))?.residualRef).toBeUndefined();

    const r = (await repo.getReservation("res_with_ref"))!;
    await repo.putReservation({ ...r, status: "COMMITTED" });
    expect((await repo.getReservation("res_with_ref"))?.residualRef).toBe("epoch_9#2");
  });
});
