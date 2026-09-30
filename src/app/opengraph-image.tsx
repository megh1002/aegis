// The preview image shown when the site's link is shared (LinkedIn, Slack,
// iMessage). Generated at build time from the same design as the page.

import { ImageResponse } from "next/og";

export const alt = "Aegis: a safety checkpoint for AI agents. Safe actions run on their own, risky ones wait for you.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const rows = [
  { text: "Read the logs of the API server", badge: "runs now", held: false },
  { text: "Run 4 copies of the job queue", badge: "runs now", held: false },
  { text: "Restart the main database", badge: "waits for you", held: true },
];

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          background: "radial-gradient(900px 500px at 15% -10%, rgba(99,102,241,0.28), transparent 60%), #06070c",
          color: "#e5e7eb",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <svg width="64" height="64" viewBox="0 0 32 32">
            <defs>
              <linearGradient id="t" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#6366f1" />
                <stop offset="100%" stopColor="#0ea5e9" />
              </linearGradient>
            </defs>
            <rect width="32" height="32" rx="9" fill="url(#t)" />
            <path d="M9 24.5 16 7.5l7 17" fill="none" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="16" cy="19" r="2.3" fill="white" />
          </svg>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 40, fontWeight: 700, color: "white", letterSpacing: -1 }}>Aegis</div>
            <div style={{ fontSize: 22, color: "#9ca3af" }}>A safety checkpoint for AI agents</div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 48 }}>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 58, fontWeight: 700, lineHeight: 1.12, letterSpacing: -2, maxWidth: 560 }}>
            <div style={{ color: "white" }}>Let AI agents act.</div>
            <div style={{ color: "#a5b4fc" }}>Stay in charge of what matters.</div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 16,
              width: 470,
              padding: 26,
              borderRadius: 22,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.03)",
            }}
          >
            {rows.map((r) => (
              <div key={r.text} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                <div style={{ fontSize: 21, color: "#e5e7eb" }}>{r.text}</div>
                <div
                  style={{
                    display: "flex",
                    flexShrink: 0,
                    fontSize: 17,
                    padding: "5px 12px",
                    borderRadius: 999,
                    color: r.held ? "#fde68a" : "#6ee7b7",
                    background: r.held ? "rgba(251,191,36,0.16)" : "rgba(52,211,153,0.12)",
                  }}
                >
                  {r.badge}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ fontSize: 22, color: "#6b7280" }}>Try the one-minute demo · loop-chi-plum.vercel.app</div>
      </div>
    ),
    size,
  );
}
