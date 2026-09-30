// Runs before every API request.
//
// 1. On the public website (demo-only), the API is switched off entirely:
//    no live data exists there, and nothing can be sent to it.
// 2. Locally, the API only answers requests addressed to this computer.
//    This blocks "DNS rebinding", where a malicious website tricks your
//    browser into calling a server running on your own machine.
// 3. Anything that changes state must come from this site's own pages or
//    from a non-browser client like the Aegis proxy, never another website.

import { NextResponse, type NextRequest } from "next/server";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function proxy(req: NextRequest) {
  if (process.env.NEXT_PUBLIC_AEGIS_DEMO_ONLY === "1") {
    return NextResponse.json({ error: "This public site is demo-only. Run Aegis locally to use the live console." }, { status: 404 });
  }

  const host = req.headers.get("host")?.replace(/:\d+$/, "") ?? "";
  if (!LOCAL_HOSTS.has(host)) {
    return NextResponse.json({ error: "Aegis only accepts requests to localhost." }, { status: 403 });
  }

  const origin = req.headers.get("origin");
  if (req.method !== "GET" && origin && new URL(origin).host !== req.headers.get("host")) {
    return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
