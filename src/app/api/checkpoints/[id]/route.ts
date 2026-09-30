import { NextResponse } from "next/server";
import { getCheckpoint } from "@/lib/store";

export const dynamic = "force-dynamic";

// GET /api/checkpoints/:id — the SDK polls this to learn the human's decision.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const checkpoint = await getCheckpoint(id);
  if (!checkpoint) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ checkpoint });
}
