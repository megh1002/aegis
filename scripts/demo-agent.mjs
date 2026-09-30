// Demo agent — a "support bot" doing a batch of work.
// Most actions auto-approve via policy; only the sensitive/high-risk ones pause
// for a human in the console. This shows a LOW intervention rate — the point.
//
// Run the app first (npm run dev), then:  node scripts/demo-agent.mjs

const BASE_URL = process.env.AEGIS_URL ?? "http://localhost:3000";
const API_KEY = process.env.AEGIS_API_KEY;
const HEADERS = {
  "Content-Type": "application/json",
  ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
};

async function requireApproval({ agent, action, reasoning, risk }) {
  const res = await fetch(`${BASE_URL}/api/checkpoints`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ agent, action, reasoning, risk }),
  });
  if (!res.ok) throw new Error(`Aegis: create failed (${res.status})`);
  const { checkpoint } = await res.json();

  if (checkpoint.status === "approved") {
    console.log(`  ✅ auto-approved — ${action}`);
    return { approved: true };
  }

  console.log(`  ⏸  escalated, waiting for a human — ${action}`);
  let status = checkpoint.status;
  while (status === "pending") {
    await new Promise((r) => setTimeout(r, 1500));
    const s = await fetch(`${BASE_URL}/api/checkpoints/${checkpoint.id}`);
    status = (await s.json()).checkpoint.status;
  }
  console.log(status === "approved" ? `  ✅ approved — ${action}` : `  🛑 rejected — ${action}`);
  return { approved: status === "approved" };
}

const WORK = [
  { action: "Tag ticket #1201 as 'billing'", reasoning: "Keyword match.", risk: "low" },
  { action: "Send order-status update to customer", reasoning: "Read-only info.", risk: "low" },
  { action: "Draft a reply for agent review", reasoning: "No side effects.", risk: "low" },
  { action: "Update customer's shipping address", reasoning: "Customer-confirmed.", risk: "medium" },
  { action: "Close resolved ticket #1188", reasoning: "Customer said thanks.", risk: "low" },
  { action: "Issue a $500 refund to customer #4821", reasoning: "Item never arrived; tracking inconclusive.", risk: "high" },
];

async function main() {
  console.log("🤖 Support bot processing a batch of work...\n");
  for (const w of WORK) {
    await requireApproval({ agent: "support-bot", ...w });
  }
  console.log("\n🤖 Done. Check the console — most actions ran on their own.");
}

main().catch((e) => {
  console.error("Demo failed:", e.message);
  process.exit(1);
});
