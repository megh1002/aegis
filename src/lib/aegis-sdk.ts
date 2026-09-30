// Aegis SDK — drop this into any agent.
// Before a risky action, call requireApproval(). It pauses the agent until a
// human approves or rejects from the Aegis console (or auto-policy resolves it).
//
//   import { requireApproval } from "./aegis-sdk";
//
//   const { approved } = await requireApproval({
//     agent: "refund-bot",
//     action: "Issue a $500 refund to customer #4821",
//     reasoning: "Customer claims item never arrived.",
//     risk: "high",
//   });
//   if (approved) await issueRefund();
//
// Config via env: AEGIS_URL (console base URL), AEGIS_API_KEY (agent key).

export type Risk = "low" | "medium" | "high";

export interface ApprovalRequest {
  agent: string;
  action: string;
  reasoning: string;
  risk: Risk;
}

export interface ApprovalResult {
  approved: boolean;
  status: "approved" | "rejected";
  checkpointId: string;
}

const BASE_URL = process.env.AEGIS_URL ?? "http://localhost:3000";
const API_KEY = process.env.AEGIS_API_KEY;

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
  };
}

async function fetchStatus(id: string): Promise<"pending" | "approved" | "rejected"> {
  const res = await fetch(`${BASE_URL}/api/checkpoints/${id}`, { headers: headers() });
  const data = await res.json();
  return data.checkpoint.status;
}

/**
 * Raise a checkpoint and block until it is decided.
 * @param pollMs how often to poll for the human's decision
 * @param timeoutMs give up (treat as rejected) after this long
 */
export async function requireApproval(
  request: ApprovalRequest,
  { pollMs = 1500, timeoutMs = 5 * 60_000 }: { pollMs?: number; timeoutMs?: number } = {},
): Promise<ApprovalResult> {
  const res = await fetch(`${BASE_URL}/api/checkpoints`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error(`Aegis: failed to create checkpoint (${res.status})`);

  const { checkpoint } = await res.json();
  const id: string = checkpoint.id;
  let status: "pending" | "approved" | "rejected" = checkpoint.status;

  const deadline = Date.now() + timeoutMs;
  while (status === "pending") {
    if (Date.now() > deadline) status = "rejected"; // fail safe: no answer = no action
    else {
      await new Promise((r) => setTimeout(r, pollMs));
      status = await fetchStatus(id);
    }
  }

  return { approved: status === "approved", status, checkpointId: id };
}
