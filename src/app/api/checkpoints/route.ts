import { NextResponse } from "next/server";
import { computeMetrics } from "../../../../core/checkpoints";
import { newCheckpointSchema } from "../../../../core/schemas";
import { agentAuthorized } from "@/lib/auth";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

// GET /api/checkpoints: everything the console shows, newest first.
export async function GET() {
  const checkpoints = store.list();
  return NextResponse.json({ checkpoints, metrics: computeMetrics(checkpoints) });
}

// POST /api/checkpoints: the proxy records an action and the policy's verdict.
// Allowed actions come back approved; escalated ones come back pending.
export async function POST(req: Request) {
  if (!agentAuthorized(req)) {
    return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  }
  const parsed = newCheckpointSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid checkpoint", issues: parsed.error.issues }, { status: 400 });
  }
  const { checkpoint, joined } = store.create(parsed.data);
  return NextResponse.json({ checkpoint, joined }, { status: joined ? 200 : 201 });
}
