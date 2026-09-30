// Checkpoint store. Backed by Supabase when SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY are set; otherwise falls back to an in-memory map
// (globalThis singleton so it survives Next.js dev hot-reloads).

import { evaluatePolicy } from "./policy";
import { getDb } from "./db";

export type Risk = "low" | "medium" | "high";
export type Status = "pending" | "approved" | "rejected";

export interface Checkpoint {
  id: string;
  agent: string;
  action: string;
  reasoning: string;
  risk: Risk;
  status: Status;
  policyReason: string;
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
}

/* ---------- in-memory fallback ---------- */

interface MemStore {
  checkpoints: Map<string, Checkpoint>;
}
const globalForStore = globalThis as unknown as { __aegisStore?: MemStore };
const mem: MemStore = globalForStore.__aegisStore ?? { checkpoints: new Map() };
if (!globalForStore.__aegisStore) globalForStore.__aegisStore = mem;

/* ---------- row mapping ---------- */

interface Row {
  id: string;
  agent: string;
  action: string;
  reasoning: string;
  risk: Risk;
  status: Status;
  policy_reason: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

function fromRow(r: Row): Checkpoint {
  return {
    id: r.id,
    agent: r.agent,
    action: r.action,
    reasoning: r.reasoning,
    risk: r.risk,
    status: r.status,
    policyReason: r.policy_reason,
    createdAt: new Date(r.created_at).getTime(),
    decidedAt: r.decided_at ? new Date(r.decided_at).getTime() : undefined,
    decidedBy: r.decided_by ?? undefined,
  };
}

/* ---------- store API ---------- */

export async function createCheckpoint(input: {
  agent: string;
  action: string;
  reasoning: string;
  risk: Risk;
}): Promise<Checkpoint> {
  const policy = evaluatePolicy(input);
  const status: Status = policy.outcome === "auto-approve" ? "approved" : "pending";
  const now = Date.now();
  const base = {
    agent: input.agent,
    action: input.action,
    reasoning: input.reasoning,
    risk: input.risk,
    status,
    decidedBy: status === "approved" ? "auto-policy" : undefined,
  };

  const db = getDb();
  if (db) {
    const { data, error } = await db
      .from("checkpoints")
      .insert({
        agent: base.agent,
        action: base.action,
        reasoning: base.reasoning,
        risk: base.risk,
        status: base.status,
        policy_reason: policy.reason,
        decided_at: status === "approved" ? new Date(now).toISOString() : null,
        decided_by: base.decidedBy ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(`db insert failed: ${error.message}`);
    return fromRow(data as Row);
  }

  const checkpoint: Checkpoint = {
    id: crypto.randomUUID(),
    ...base,
    policyReason: policy.reason,
    createdAt: now,
    decidedAt: status === "approved" ? now : undefined,
  };
  mem.checkpoints.set(checkpoint.id, checkpoint);
  return checkpoint;
}

export async function getCheckpoint(id: string): Promise<Checkpoint | undefined> {
  const db = getDb();
  if (db) {
    const { data } = await db.from("checkpoints").select().eq("id", id).maybeSingle();
    return data ? fromRow(data as Row) : undefined;
  }
  return mem.checkpoints.get(id);
}

export async function listCheckpoints(): Promise<Checkpoint[]> {
  const db = getDb();
  if (db) {
    const { data, error } = await db
      .from("checkpoints")
      .select()
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(`db list failed: ${error.message}`);
    return (data as Row[]).map(fromRow);
  }
  return [...mem.checkpoints.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export async function decideCheckpoint(
  id: string,
  decision: "approved" | "rejected",
  decidedBy = "human",
): Promise<Checkpoint | undefined> {
  const db = getDb();
  if (db) {
    const { data } = await db
      .from("checkpoints")
      .update({ status: decision, decided_at: new Date().toISOString(), decided_by: decidedBy })
      .eq("id", id)
      .eq("status", "pending") // only pending checkpoints can be decided
      .select()
      .maybeSingle();
    return data ? fromRow(data as Row) : await getCheckpoint(id);
  }

  const checkpoint = mem.checkpoints.get(id);
  if (!checkpoint || checkpoint.status !== "pending") return checkpoint;
  checkpoint.status = decision;
  checkpoint.decidedAt = Date.now();
  checkpoint.decidedBy = decidedBy;
  return checkpoint;
}

/* ---------- metrics ---------- */

export interface Metrics {
  total: number;
  autoApproved: number;
  escalated: number;
  approved: number;
  rejected: number;
  pending: number;
  interventionRate: number;
  autoApproveRate: number;
  vetoRate: number;
  avgTimeToDecideMs: number;
  trend: { label: string; interventionRate: number }[];
}

export async function getMetrics(): Promise<Metrics> {
  const all = await listCheckpoints();
  const total = all.length;
  const autoApproved = all.filter((c) => c.decidedBy === "auto-policy").length;
  const escalated = total - autoApproved;
  const approved = all.filter((c) => c.status === "approved").length;
  const rejected = all.filter((c) => c.status === "rejected").length;
  const pending = all.filter((c) => c.status === "pending").length;

  const humanDecided = all.filter((c) => c.decidedBy === "human");
  const vetoRate = humanDecided.length
    ? humanDecided.filter((c) => c.status === "rejected").length / humanDecided.length
    : 0;
  const times = humanDecided
    .filter((c) => c.decidedAt)
    .map((c) => c.decidedAt! - c.createdAt);
  const avgTimeToDecideMs = times.length
    ? times.reduce((a, b) => a + b, 0) / times.length
    : 0;

  const ordered = [...all].reverse();
  const trend: { label: string; interventionRate: number }[] = [];
  const buckets = 6;
  if (total) {
    const size = Math.ceil(total / buckets);
    for (let i = 0; i < ordered.length; i += size) {
      const slice = ordered.slice(i, i + size);
      const esc = slice.filter((c) => c.decidedBy !== "auto-policy").length;
      trend.push({
        label: `${i + 1}–${i + slice.length}`,
        interventionRate: esc / slice.length,
      });
    }
  }

  return {
    total,
    autoApproved,
    escalated,
    approved,
    rejected,
    pending,
    interventionRate: total ? escalated / total : 0,
    autoApproveRate: total ? autoApproved / total : 0,
    vetoRate,
    avgTimeToDecideMs,
    trend,
  };
}
