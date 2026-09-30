import { NextResponse } from "next/server";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

// GET /api/checkpoints/:id: the proxy polls this for the human's decision.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const checkpoint = store.get(id);
  if (!checkpoint) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ checkpoint });
}
