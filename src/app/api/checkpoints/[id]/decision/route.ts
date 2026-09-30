import { NextResponse } from "next/server";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

// POST /api/checkpoints/:id/decision: a human approves or rejects.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const decision = body?.decision;
  if (decision !== "approved" && decision !== "rejected") {
    return NextResponse.json({ error: "decision must be 'approved' or 'rejected'" }, { status: 400 });
  }
  const result = store.decide(id, decision);
  if (!result.ok) {
    const status = result.error === "not found" ? 404 : 409;
    return NextResponse.json({ error: result.error, checkpoint: result.checkpoint }, { status });
  }
  return NextResponse.json({ checkpoint: result.checkpoint });
}
