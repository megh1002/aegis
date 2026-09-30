import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { APPROVER_COOKIE, isApprover } from "@/lib/approver";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  // Optional edited params: approve a changed version of the action.
  params: z.record(z.string(), z.unknown()).optional(),
});

// POST /api/checkpoints/:id/decision: a human approves or rejects.
// Only a browser holding the approver cookie may call this.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApprover((await cookies()).get(APPROVER_COOKIE)?.value)) {
    return NextResponse.json(
      { error: "Only an approver can decide. Open the approval link printed where the console is running." },
      { status: 401 },
    );
  }
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "decision must be 'approved' or 'rejected'" }, { status: 400 });
  }
  const result = store.decide(id, parsed.data.decision, parsed.data.params);
  if (!result.ok) {
    const status = result.error === "not found" ? 404 : result.error.startsWith("already") ? 409 : 400;
    return NextResponse.json({ error: result.error, checkpoint: result.checkpoint }, { status });
  }
  return NextResponse.json({ checkpoint: result.checkpoint });
}
