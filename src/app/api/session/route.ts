import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { APPROVER_COOKIE, isApprover } from "@/lib/approver";

export const dynamic = "force-dynamic";

// GET /api/session: can this browser approve?
export async function GET() {
  const token = (await cookies()).get(APPROVER_COOKIE)?.value;
  return NextResponse.json({ approver: isApprover(token) });
}

// POST /api/session: exchange the link's secret for an approver cookie.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token : undefined;
  if (!isApprover(token)) {
    return NextResponse.json({ approver: false, error: "That approval link isn't valid for this console." }, { status: 401 });
  }
  (await cookies()).set(APPROVER_COOKIE, token!, {
    httpOnly: true, // page scripts can't read it
    sameSite: "strict", // other sites can't send it
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return NextResponse.json({ approver: true });
}
