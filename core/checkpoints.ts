// Checkpoints: the record of every action an agent tried, what the policy
// said, and what a human decided. Pure logic with no web or file code, so
// the console, the proxy's tests and the demo all share one implementation.

import type { Action, Verdict } from "./types";

export type Status = "pending" | "approved" | "rejected" | "expired";
export type DecidedBy = "policy" | "human" | "timeout";

export interface Checkpoint {
  id: string;
  action: Action;
  verdict: Verdict;
  status: Status;
  decidedBy?: DecidedBy;
  createdAt: number;
  decidedAt?: number;
  // A human can't approve after this: the agent has stopped waiting.
  expiresAt?: number;
  // Same agent + tool + target + environment + params.
  fingerprint: string;
  // Set when this looks like a repeat of an action that just ran.
  duplicateOf?: string;
}

export interface NewCheckpoint {
  action: Action;
  verdict: Verdict;
  // From the tool's own description: does it only read, never change?
  // Read-only repeats (checking logs twice) are normal, not duplicates.
  readOnly?: boolean;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 5 * 60_000;
// An identical changing action within this window is probably an accident
// (a retry, or the agent losing track), so a human confirms it.
export const DUPLICATE_WINDOW_MS = 2 * 60_000;
const MAX_KEPT = 1000;

// Key order must not matter: {a:1,b:2} and {b:2,a:1} are the same action.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function fingerprintOf(a: Action): string {
  // `reason` is left out on purpose: rewording the reason doesn't make it a different action.
  return stableStringify({
    agent: a.agent,
    tool: a.tool,
    target: a.target,
    environment: a.environment,
    params: a.params ?? {},
  });
}

const secondsAgo = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s ago`;

export class CheckpointStore {
  private items = new Map<string, Checkpoint>();

  constructor(private now: () => number = Date.now) {}

  // Returns the checkpoint and whether it joined one already waiting.
  create(input: NewCheckpoint): { checkpoint: Checkpoint; joined: boolean } {
    const now = this.now();
    const fingerprint = fingerprintOf(input.action);

    // Idempotency, part 1: the same request while one is already waiting
    // (e.g. the agent retried) joins it instead of creating a second one.
    const waiting = this.list().find((c) => c.fingerprint === fingerprint && c.status === "pending");
    if (waiting) return { checkpoint: waiting, joined: true };

    let verdict = input.verdict;
    let duplicateOf: string | undefined;

    // Idempotency, part 2: an identical changing action that just ran is
    // escalated even if the policy allows it, so a fix can't run twice by accident.
    if (!input.readOnly) {
      const recent = this.list().find(
        (c) =>
          c.fingerprint === fingerprint &&
          c.status === "approved" &&
          c.decidedAt !== undefined &&
          now - c.decidedAt < DUPLICATE_WINDOW_MS,
      );
      if (recent) {
        duplicateOf = recent.id;
        verdict = {
          ...verdict,
          decision: "escalate",
          explanation: `Possible duplicate: the same action ran ${secondsAgo(now - recent.decidedAt!)}. ${verdict.explanation}`,
        };
      }
    }

    const allowed = verdict.decision === "allow";
    const checkpoint: Checkpoint = {
      id: crypto.randomUUID(),
      action: input.action,
      verdict,
      status: allowed ? "approved" : "pending",
      decidedBy: allowed ? "policy" : undefined,
      createdAt: now,
      decidedAt: allowed ? now : undefined,
      expiresAt: allowed ? undefined : now + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      fingerprint,
      duplicateOf,
    };
    this.items.set(checkpoint.id, checkpoint);
    this.trim();
    return { checkpoint, joined: false };
  }

  get(id: string): Checkpoint | undefined {
    const c = this.items.get(id);
    if (c) this.expireIfDue(c);
    return c;
  }

  // Newest first.
  list(): Checkpoint[] {
    const all = [...this.items.values()];
    all.forEach((c) => this.expireIfDue(c));
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  decide(
    id: string,
    decision: "approved" | "rejected",
  ): { ok: true; checkpoint: Checkpoint } | { ok: false; error: string; checkpoint?: Checkpoint } {
    const c = this.get(id);
    if (!c) return { ok: false, error: "not found" };
    if (c.status !== "pending") {
      return { ok: false, error: `already ${c.status}`, checkpoint: c };
    }
    c.status = decision;
    c.decidedBy = "human";
    c.decidedAt = this.now();
    return { ok: true, checkpoint: c };
  }

  private expireIfDue(c: Checkpoint) {
    if (c.status === "pending" && c.expiresAt !== undefined && this.now() >= c.expiresAt) {
      c.status = "expired";
      c.decidedBy = "timeout";
      c.decidedAt = c.expiresAt;
    }
  }

  private trim() {
    if (this.items.size <= MAX_KEPT) return;
    const oldest = [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const c of oldest.slice(0, this.items.size - MAX_KEPT)) this.items.delete(c.id);
  }
}

/* ---------- metrics ---------- */

export interface Metrics {
  total: number;
  autoApproved: number;
  escalated: number;
  approved: number;
  rejected: number;
  expired: number;
  pending: number;
  autoApproveRate: number;
  interventionRate: number;
  // Of the actions a human decided, how many they rejected.
  vetoRate: number;
  avgTimeToDecideMs: number;
  trend: { label: string; interventionRate: number }[];
}

export function computeMetrics(all: Checkpoint[]): Metrics {
  const total = all.length;
  const autoApproved = all.filter((c) => c.decidedBy === "policy").length;
  const human = all.filter((c) => c.decidedBy === "human");
  const times = human.map((c) => c.decidedAt! - c.createdAt);

  const ordered = [...all].sort((a, b) => a.createdAt - b.createdAt);
  const trend: Metrics["trend"] = [];
  if (total) {
    const size = Math.ceil(total / 6);
    for (let i = 0; i < ordered.length; i += size) {
      const slice = ordered.slice(i, i + size);
      trend.push({
        label: `${i + 1}–${i + slice.length}`,
        interventionRate: slice.filter((c) => c.decidedBy !== "policy").length / slice.length,
      });
    }
  }

  return {
    total,
    autoApproved,
    escalated: total - autoApproved,
    approved: all.filter((c) => c.status === "approved").length,
    rejected: all.filter((c) => c.status === "rejected").length,
    expired: all.filter((c) => c.status === "expired").length,
    pending: all.filter((c) => c.status === "pending").length,
    autoApproveRate: total ? autoApproved / total : 0,
    interventionRate: total ? (total - autoApproved) / total : 0,
    vetoRate: human.length ? human.filter((c) => c.status === "rejected").length / human.length : 0,
    avgTimeToDecideMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
    trend,
  };
}
