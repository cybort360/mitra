import { beforeEach, describe, expect, it } from "vitest";
import {
  MACHINES, TRANSITIONS, canTransition, isTerminal, nextStates, transition,
} from "@/lib/kernel/machines";
import { POST as createReservation } from "@/app/api/v1/reservations/route";
import { POST as execute } from "@/app/api/v1/reservations/execute/route";
import { __resetLedgerForTests, getLedger } from "@/lib/store/ledger";
import { getStore, __resetStoreForTests } from "@/lib/store/provider";
import { NOW, goodProposal, json, prepareStore, req } from "./fixtures";

const hold = async () => {
  const created = await createReservation(req({ ...goodProposal, ttlMinutes: 60 }));
  return (await json(created)).data;
};

beforeEach(async () => { await prepareStore(); });

/** The documented happy path for each machine, from STATE_MACHINES.md. */
const HAPPY_PATHS: Record<string, string[]> = {
  agent: ["UNREGISTERED", "DISCOVERED", "CLAIMED", "CONTROL_VERIFIED", "REGISTERED", "AUTHORITY_PENDING", "FUNDED", "ACTIVE"],
  reservation: ["REQUESTED", "RESERVED", "COMMITTED", "SETTLING", "SETTLED"],
  agreement: ["OPEN", "FUNDED", "EXECUTING", "SUBMITTED", "ACCEPTED"],
  obligation: ["PROPOSED", "ACCEPTED", "ACCRUING", "DUE", "CLEARED", "SETTLING", "SETTLED"],
  saga: ["DECLARED", "EXECUTING", "RECOVERY_PENDING", "RECOVERING", "RECOVERED"],
  clearingEpoch: ["OPEN", "FROZEN", "CALCULATING", "CHALLENGE", "FINALIZED", "SETTLING", "SETTLED"],
  mandate: ["DRAFT", "ACTIVE"],
};

describe("state machines", () => {
  it("covers every machine documented in STATE_MACHINES.md plus mandate", () => {
    // The doc lists seven machines. Mandate is in the domain types and the API
    // surface, so it is enforced too rather than left unguarded.
    expect(MACHINES.sort()).toEqual(
      ["agent", "agreement", "clearingEpoch", "mandate", "obligation", "reservation", "saga"].sort(),
    );
  });

  it("walks every documented happy path", () => {
    for (const [machine, path] of Object.entries(HAPPY_PATHS)) {
      for (let i = 0; i < path.length - 1; i += 1) {
        expect(canTransition(machine, path[i], path[i + 1]), `${machine}: ${path[i]} -> ${path[i + 1]}`).toEqual({ ok: true });
      }
    }
  });

  it("rejects skipping a step in every machine", () => {
    const skips: [string, string, string][] = [
      ["reservation", "REQUESTED", "COMMITTED"],
      ["reservation", "RESERVED", "SETTLED"],
      ["agreement", "OPEN", "SUBMITTED"],
      ["obligation", "PROPOSED", "SETTLED"],
      ["clearingEpoch", "OPEN", "FINALIZED"],
      ["agent", "UNREGISTERED", "ACTIVE"],
      ["saga", "DECLARED", "RECOVERED"],
    ];
    for (const [machine, from, to] of skips) {
      const verdict = canTransition(machine, from, to);
      expect(verdict.ok, `${machine} ${from}->${to}`).toBe(false);
      expect(verdict.ok === false && verdict.reason).toMatch(/ILLEGAL_TRANSITION/);
    }
  });

  it("rejects moving backwards", () => {
    expect(canTransition("reservation", "COMMITTED", "RESERVED").ok).toBe(false);
    expect(canTransition("obligation", "SETTLED", "DUE").ok).toBe(false);
    expect(canTransition("clearingEpoch", "FINALIZED", "CALCULATING").ok).toBe(false);
  });

  it("rejects a self-transition so a settled record cannot be re-committed", () => {
    const verdict = canTransition("reservation", "SETTLED", "SETTLED");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/NO_OP_TRANSITION/);
  });
});

describe("terminal states", () => {
  it("treats documented terminal states as terminal", () => {
    for (const [machine, terminal] of [
      ["reservation", "SETTLED"], ["reservation", "RELEASED"], ["reservation", "EXPIRED"],
      ["obligation", "SETTLED"], ["obligation", "DEFAULTED"],
      ["saga", "RECOVERED"], ["saga", "CONTAINED"], ["saga", "ABORTED"],
      ["agent", "REVOKED"], ["clearingEpoch", "SETTLED"], ["agreement", "REFUNDED"],
    ] as const) {
      expect(isTerminal(machine, terminal), `${machine}.${terminal}`).toBe(true);
      expect(canTransition(machine, terminal, "ACTIVE").ok, `${machine}.${terminal} -> ACTIVE`).toBe(false);
    }
  });

  it("rejects any transition out of a terminal state", () => {
    const verdict = canTransition("reservation", "SETTLED", "COMMITTED");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/TERMINAL_STATE/);
  });

  it("keeps the three saga outcomes distinct", () => {
    // The doc is explicit that RECOVERED, CONTAINED and ABORTED are not
    // interchangeable. Collapsing them would erase the difference between
    // "recovered the value" and "stopped the loss".
    const outcomes = ["RECOVERED", "CONTAINED", "ABORTED"] as const;
    for (const outcome of outcomes) {
      expect(isTerminal("saga", outcome)).toBe(true);
      for (const other of outcomes) {
        expect(canTransition("saga", outcome, other).ok, `${outcome} -> ${other}`).toBe(false);
      }
    }
    // All three are reachable, so none is a dead label.
    for (const outcome of outcomes) {
      expect(canTransition("saga", "EXECUTING", outcome).ok, `EXECUTING -> ${outcome}`).toBe(true);
    }
  });

  it("rejects an unknown machine and an unknown state", () => {
    const unknownMachine = canTransition("nope", "A", "B");
    expect(unknownMachine.ok).toBe(false);
    expect(unknownMachine.ok === false && unknownMachine.reason).toMatch(/UNKNOWN_MACHINE/);
    expect(canTransition("reservation", "NOT_A_STATE", "SETTLED").ok).toBe(false);
    expect(canTransition("reservation", "REQUESTED", "NOT_A_STATE").ok).toBe(false);
  });
});

describe("transition()", () => {
  it("returns the entity with the new status", () => {
    const r = transition("reservation", { status: "RESERVED", amount: 5 }, "COMMITTED");
    expect(r.status).toBe("COMMITTED");
    expect(r.amount).toBe(5);
  });

  it("throws rather than silently returning on an illegal transition", () => {
    // Throwing is deliberate: a caller that ignored a returned verdict could
    // still write the new state. This cannot be ignored by accident.
    expect(() => transition("reservation", { status: "REQUESTED" }, "SETTLED")).toThrow(/ILLEGAL_TRANSITION/);
    expect(() => transition("reservation", { status: "SETTLED" }, "COMMITTED")).toThrow(/TERMINAL_STATE/);
  });

  it("does not mutate the input", () => {
    const original = { status: "RESERVED", amount: 5 };
    transition("reservation", original, "COMMITTED");
    expect(original.status).toBe("RESERVED");
  });

  it("exposes the permitted next states for UI affordances", () => {
    expect(nextStates("reservation", "RESERVED").sort()).toEqual(["CANCELED", "COMMITTED", "EXPIRED", "RELEASED"].sort());
    expect(nextStates("reservation", "SETTLED")).toEqual([]);
  });
});

describe("state machine enforcement through the API", () => {
  it("commits a reservation on a legal transition", async () => {
    const r = await hold();
    const res = await execute(req({
      reservationId: r.reservationId, amount: r.amount, asset: r.asset,
      chain: r.chain, actionDigest: r.actionDigest, now: NOW,
    }));
    expect((await json(res)).data.status).toBe("COMMITTED");
  });

  it("refuses to move a settled reservation backwards", async () => {
    // The point of Phase 2: the machine is enforced, not merely documented.
    const r = await hold();
    await execute(req({
      reservationId: r.reservationId, amount: r.amount, asset: r.asset,
      chain: r.chain, actionDigest: r.actionDigest, now: NOW,
    }));
    // Asserted through the store the routes actually used. With DATABASE_URL
    // set that is Postgres, so reaching into the in-memory ledger would be
    // asserting against a record nothing wrote.
    const { repo } = await getStore();
    await expect(repo.setReservationStatus(r.reservationId, "RESERVED")).rejects.toThrow(/TERMINAL_STATE|ILLEGAL_TRANSITION/);
    expect((await repo.getReservation(r.reservationId))?.status).toBe("COMMITTED");
  });

  it("refuses to skip COMMITTED entirely", async () => {
    const r = await hold();
    const { repo } = await getStore();
    await expect(repo.setReservationStatus(r.reservationId, "SETTLED")).rejects.toThrow(/ILLEGAL_TRANSITION/);
    expect((await repo.getReservation(r.reservationId))?.status).toBe("RESERVED");
  });

  it("refuses a re-commit of an already committed reservation", async () => {
    const r = await hold();
    const { repo } = await getStore();
    await repo.setReservationStatus(r.reservationId, "COMMITTED");
    await expect(repo.setReservationStatus(r.reservationId, "COMMITTED")).rejects.toThrow(/NO_OP_TRANSITION/);
  });

  it("allows the legal release branch from RESERVED", async () => {
    const r = await hold();
    const { repo } = await getStore();
    const released = await repo.setReservationStatus(r.reservationId, "RELEASED");
    expect(released?.status).toBe("RELEASED");
    expect(isTerminal("reservation", "RELEASED")).toBe(true);
  });

  it("bumps the version on a legal transition", async () => {
    const r = await hold();
    const { repo } = await getStore();
    expect((await repo.setReservationStatus(r.reservationId, "COMMITTED"))?.version).toBe(r.version + 1);
  });
});

describe("table integrity", () => {
  it("lists no transition to a state the machine does not define", () => {
    for (const [machine, table] of Object.entries(TRANSITIONS)) {
      const defined = new Set(Object.keys(table));
      for (const [from, targets] of Object.entries(table)) {
        for (const to of targets) {
          expect(defined.has(to), `${machine}: ${from} -> ${to} targets an undefined state`).toBe(true);
        }
      }
    }
  });

  it("gives every machine at least one terminal state", () => {
    for (const machine of MACHINES) {
      const table = TRANSITIONS[machine];
      expect(Object.values(table).some((next) => next.length === 0), `${machine} has no terminal state`).toBe(true);
    }
  });
});
