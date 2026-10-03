import { NextResponse } from "next/server";
import { getStore } from "@/lib/store/provider";
import { isRecovered, isTerminal } from "@/lib/kernel/recovery";

/**
 * List sagas, optionally filtered by runId, or fetch a single saga by sagaId.
 *
 * Layer B: HTTP read surface for PRD §15 TALOS recovery sagas (F49 Step 3).
 *
 * Sagas are durable state machines populated by commercial failure transitions
 * (e.g. `applyAgreementOpWithSaga` on deliverable rejection), stored in the
 * repository.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sagaId = url.searchParams.get("sagaId") ?? undefined;
  const runId = url.searchParams.get("runId") ?? undefined;
  const { repo, backend } = await getStore();

  if (sagaId) {
    const saga = await repo.getSaga(sagaId);
    if (!saga) {
      return NextResponse.json(
        { error: "SAGA_NOT_FOUND", sagaId, backend },
        { status: 404 },
      );
    }
    return NextResponse.json({
      data: {
        ...saga,
        isRecovered: isRecovered(saga),
        isTerminal: isTerminal("saga", saga.status),
      },
      backend,
      evidenceLevel: "LOCAL_PASS",
    });
  }

  const sagas = await repo.listSagas(runId);
  return NextResponse.json({
    data: sagas.map((s) => ({
      ...s,
      isRecovered: isRecovered(s),
      isTerminal: isTerminal("saga", s.status),
    })),
    count: sagas.length,
    runId: runId ?? null,
    backend,
    evidenceLevel: "LOCAL_PASS",
  });
}
