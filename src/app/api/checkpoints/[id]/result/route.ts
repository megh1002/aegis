import { NextResponse } from "next/server";
import { z } from "zod";
import { agentAuthorized } from "@/lib/auth";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ ok: z.boolean(), summary: z.string().max(5000) });

// POST /api/checkpoints/:id/result: the proxy reports what happened when an
// approved action ran. Recorded once; later reports are ignored.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!agentAuthorized(req)) {
    return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  }
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid result" }, { status: 400 });
  const recorded = store.recordResult(id, parsed.data);
  return NextResponse.json({ recorded }, { status: recorded ? 200 : 409 });
}
