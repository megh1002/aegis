import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { APPROVER_COOKIE, isApprover } from "@/lib/approver";
import { trust } from "@/lib/store";

export const dynamic = "force-dynamic";

// GET /api/trust: suggestions waiting for a human, and current grants.
// The proxy reads the grants to apply them.
export async function GET() {
  return NextResponse.json({ suggestions: trust.suggestions(), grants: trust.grants() });
}

// POST /api/trust: an approver accepts a suggestion.
export async function POST(req: Request) {
  if (!isApprover((await cookies()).get(APPROVER_COOKIE)?.value)) {
    return NextResponse.json({ error: "Only an approver can grant trust." }, { status: 401 });
  }
  const parsed = z.object({ key: z.string() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "key is required" }, { status: 400 });
  const grant = trust.grant(parsed.data.key);
  if (!grant) return NextResponse.json({ error: "That suggestion is no longer valid." }, { status: 409 });
  return NextResponse.json({ grant });
}
