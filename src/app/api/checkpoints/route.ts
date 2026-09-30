import { NextResponse } from "next/server";
import { createCheckpoint, listCheckpoints, type Risk } from "@/lib/store";
import { agentAuthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/checkpoints — list all checkpoints (newest first), for the console.
export async function GET() {
  return NextResponse.json({ checkpoints: await listCheckpoints() });
}

// POST /api/checkpoints — an agent raises its hand before a risky action.
export async function POST(req: Request) {
  if (!agentAuthorized(req)) {
    return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body.action !== "string") {
    return NextResponse.json({ error: "action is required" }, { status: 400 });
  }
  const risk: Risk = ["low", "medium", "high"].includes(body.risk) ? body.risk : "medium";

  const checkpoint = await createCheckpoint({
    agent: typeof body.agent === "string" ? body.agent : "unknown-agent",
    action: body.action,
    reasoning:
      typeof body.reasoning === "string" ? body.reasoning : "(no reasoning given)",
    risk,
  });

  return NextResponse.json({ checkpoint }, { status: 201 });
}
