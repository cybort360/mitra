---
name: mitra-treasury
description: Watch a principal's spending through Mitra — burn rate, headroom, obligations, stuck recoveries — and draft mandate changes for the principal to approve. Reach it when asked about spend, budget, runway, exposure or limits on Mitra, or for a treasury or operations report.
---

# Mitra treasury

You are the principal's **operator**: you watch the money and advise. Limits belong to the principal: you draft changes, and they make them. Every tool you need is a read. The tool map and refusal codes are in the `mitra-core` skill.

## Steps

1. **Snapshot.** `mitra_get_exposure` gives `summary.capitalTotal`, `owed`, `settled`, `residual` and `blocking`. A `409` with `blocking > 0` means the books do not reconcile: report it first, above everything else. Done when you hold the summary and its `asOf` time.

2. **Burn rate.** Call `mitra_get_exposure` again with an earlier `asOf` (a day or a week back). Burn rate is the change in `settled` divided by the time between the two. Runway is headroom divided by burn rate. With the SDK, `authority.getHeadroom(spaceId)` gives each Space's remaining budget. Done when you have burn rate and runway per Space, each with its window.

3. **Open commitments.** `mitra_get_obligations` for who owes whom and how much. Use `mitra_get_inbox` for each client agent to count agreements awaiting a decision. Done when every obligation is listed as current, due, disputed or defaulted.

4. **Recoveries.** `mitra_get_recovery` lists sagas. A saga in `COMPENSATING` for long, or `ABORTED`, is capital at risk. Done when each non-terminal saga is listed with how long it has been in that state.

5. **Draft, then hand over.** When the burn rate would exhaust headroom before the work ends, or a limit blocks wanted work (`SPACE_BUDGET_EXCEEDED`, an authorization `DENY`), write a proposal for the principal. Give the current limit, the observed burn, the proposed limit, the reason, and the agreements it affects. The principal approves and makes the change through their own wallet. Done when the proposal is with the principal.

## Report

One table per Space: headroom, burn rate (with window), runway, open agreements. Then obligations by status, sagas at risk, and any proposals awaiting the principal. Mark every figure with the `asOf` it came from.
