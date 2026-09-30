import { NextResponse } from "next/server";
import { getMetrics } from "@/lib/store";

export const dynamic = "force-dynamic";

// GET /api/metrics — trust metrics for the console header.
export async function GET() {
  return NextResponse.json({ metrics: await getMetrics() });
}
