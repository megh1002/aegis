import { NextResponse } from "next/server";
import { z } from "zod";
import { computeMetrics } from "../../../../core/checkpoints";
import { agentAuthorized } from "@/lib/auth";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

const pattern = z.string().max(500);
const bodySchema = z.object({
  action: z.object({
    agent: pattern,
    tool: pattern,
    target: pattern.optional(),
    environment: pattern.optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().max(2000).optional(),
  }),
  verdict: z.object({
    decision: z.enum(["allow", "escalate"]),
    matchedRules: z.array(z.string()),
    explanation: z.string(),
  }),
  readOnly: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(60 * 60_000).optional(),
});

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
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid checkpoint", issues: parsed.error.issues }, { status: 400 });
  }
  const { checkpoint, joined } = store.create(parsed.data);
  return NextResponse.json({ checkpoint, joined }, { status: joined ? 200 : 201 });
}
