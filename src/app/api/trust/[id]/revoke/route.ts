import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { APPROVER_COOKIE, isApprover } from "@/lib/approver";
import { trust } from "@/lib/store";

export const dynamic = "force-dynamic";

// POST /api/trust/:id/revoke: take trust back. Takes effect within seconds.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApprover((await cookies()).get(APPROVER_COOKIE)?.value)) {
    return NextResponse.json({ error: "Only an approver can revoke trust." }, { status: 401 });
  }
  const { id } = await params;
  const grant = trust.revoke(id);
  if (!grant) return NextResponse.json({ error: "not found or already revoked" }, { status: 404 });
  return NextResponse.json({ grant });
}
