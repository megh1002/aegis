// Policy engine — the smart part of the product.
// Decides whether an agent action can run automatically or must escalate to a
// human. The whole thesis: escalate as LITTLE as possible, only the risky few.

import type { Risk } from "./store";

export interface PolicyInput {
  agent: string;
  action: string;
  reasoning: string;
  risk: Risk;
}

export interface PolicyDecision {
  outcome: "auto-approve" | "escalate";
  reason: string;
}

// Actions that move money, touch production, or destroy data — never auto-run
// at medium risk, even if the agent thinks it's fine.
const SENSITIVE =
  /(refund|payment|\bpay\b|wire|transfer|charge|invoice|\$|delete|\bdrop\b|prod(uction)?|deploy|password|api[_ -]?key)/i;

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  if (input.risk === "high") {
    return { outcome: "escalate", reason: "High-risk actions always need a human." };
  }
  if (input.risk === "low") {
    return { outcome: "auto-approve", reason: "Low-risk — within auto-approve policy." };
  }
  // medium risk: auto-approve unless it touches something sensitive
  if (SENSITIVE.test(input.action)) {
    return {
      outcome: "escalate",
      reason: "Medium risk touching a sensitive action (money / data / prod).",
    };
  }
  return { outcome: "auto-approve", reason: "Medium risk, nothing sensitive detected." };
}
