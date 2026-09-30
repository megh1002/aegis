import { NextResponse } from "next/server";
import { decideCheckpoint, getCheckpoint } from "@/lib/store";

export const dynamic = "force-dynamic";

// POST /api/checkpoints/:id/decision — the human approves or rejects.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const decision = body?.decision;
  if (decision !== "approved" && decision !== "rejected") {
    return NextResponse.json(
      { error: "decision must be 'approved' or 'rejected'" },
      { status: 400 },
    );
  }

  if (!(await getCheckpoint(id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const checkpoint = await decideCheckpoint(id, decision);
  return NextResponse.json({ checkpoint });
}
