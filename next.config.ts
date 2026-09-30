import type { NextConfig } from "next";

// The public website (Vercel) is demo-only: both demos run entirely in the
// visitor's browser, and the live API is switched off (see src/proxy.ts).
const demoOnly = process.env.VERCEL === "1" || process.env.AEGIS_DEMO_ONLY === "1";
const dev = process.env.NODE_ENV !== "production";

// What the page is allowed to load and connect to. Everything is served
// from this site itself; no third-party scripts, fonts, trackers or frames.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${dev ? " ws://localhost:* ws://127.0.0.1:*" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  env: { NEXT_PUBLIC_AEGIS_DEMO_ONLY: demoOnly ? "1" : "" },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          // Never send this page's address (which can briefly hold the approval secret) to other sites.
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
          ...(dev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
        ],
      },
    ];
  },
};

export default nextConfig;
