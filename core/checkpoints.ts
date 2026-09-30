// Checkpoints: the record of every action an agent tried, what the policy
// said, and what a human decided. Pure logic with no web or file code, so
// the console, the proxy's tests and the demo all share one implementation.

import { IDENTITY_KEYS } from "./keys";
import type { Action, Params, Verdict } from "./types";

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
  // A human approved a changed version (e.g. 20 servers became 5).
  // `action.params` stays as the agent asked; `edit.params` is what ran.
  edit?: { params: Params; changes: Change[] };
  // What happened when the approved action actually ran.
  execution?: { ok: boolean; summary: string; at: number };
}

export interface Change {
  key: string;
  from: unknown;
  to: unknown;
}

export type CheckpointEvent = "created" | "decided" | "expired" | "executed";

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

// Check a human's edit: same keys, same types, and never the target or
// environment. Editing changes *how much*, not *what* or *where*.
export function validateEdit(original: Params, edited: Params): { ok: true; changes: Change[] } | { ok: false; error: string } {
  const changes: Change[] = [];
  for (const key of Object.keys(edited)) {
    if (!(key in original)) return { ok: false, error: `"${key}" isn't a parameter of this action` };
  }
  for (const [key, from] of Object.entries(original)) {
    const to = key in edited ? edited[key] : from;
    if (JSON.stringify(to) === JSON.stringify(from)) continue;
    if (IDENTITY_KEYS.has(key)) return { ok: false, error: `"${key}" can't be edited: approve or reject the action as asked` };
    if (typeof to !== typeof from || (to === null) !== (from === null)) {
      return { ok: false, error: `"${key}" must stay a ${from === null ? "null" : typeof from}` };
    }
    changes.push({ key, from, to });
  }
  return { ok: true, changes };
}

type Listener = (event: CheckpointEvent, checkpoint: Checkpoint) => void;

export class CheckpointStore {
  private items = new Map<string, Checkpoint>();
  private listeners: Listener[] = [];

  constructor(private now: () => number = Date.now) {}

  // Called on every change, e.g. to write the audit log.
  onEvent(listener: Listener) {
    this.listeners.push(listener);
  }

  private emit(event: CheckpointEvent, c: Checkpoint) {
    for (const l of this.listeners) l(event, structuredClone(c));
  }

  // Load checkpoints saved earlier (e.g. replayed from the audit log).
  restore(checkpoints: Checkpoint[]) {
    for (const c of checkpoints) this.items.set(c.id, structuredClone(c));
  }

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
    this.emit("created", checkpoint);
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
    edited?: Params,
  ): { ok: true; checkpoint: Checkpoint } | { ok: false; error: string; checkpoint?: Checkpoint } {
    const c = this.get(id);
    if (!c) return { ok: false, error: "not found" };
    if (c.status !== "pending") {
      return { ok: false, error: `already ${c.status}`, checkpoint: c };
    }
    if (edited && decision === "approved") {
      const original = c.action.params ?? {};
      const check = validateEdit(original, edited);
      if (!check.ok) return { ok: false, error: check.error, checkpoint: c };
      if (check.changes.length > 0) c.edit = { params: { ...original, ...edited }, changes: check.changes };
    }
    c.status = decision;
    c.decidedBy = "human";
    c.decidedAt = this.now();
    this.emit("decided", c);
    return { ok: true, checkpoint: c };
  }

  // The proxy reports back once an approved action has actually run.
  recordResult(id: string, result: { ok: boolean; summary: string }): boolean {
    const c = this.get(id);
    if (!c || c.status !== "approved" || c.execution) return false;
    c.execution = { ok: result.ok, summary: result.summary.slice(0, 500), at: this.now() };
    this.emit("executed", c);
    return true;
  }

  private expireIfDue(c: Checkpoint) {
    if (c.status === "pending" && c.expiresAt !== undefined && this.now() >= c.expiresAt) {
      c.status = "expired";
      c.decidedBy = "timeout";
      c.decidedAt = c.expiresAt;
      this.emit("expired", c);
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
