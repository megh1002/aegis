"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckpointStore, computeMetrics, type Checkpoint, type Metrics } from "../../core/checkpoints";
import { evaluate } from "../../core/evaluate";
import { applyTrust, describeLimits, describePattern, suggestTrust, type TrustGrant, type TrustSuggestion } from "../../core/trust";
import type { Action } from "../../core/types";
import relayPolicy from "../../policies/relay";

/* ---------- helpers ---------- */

const pct = (n: number) => `${Math.round(n * 100)}%`;
const clockTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function timeLeft(ms: number) {
  if (ms <= 0) return "expiring";
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`;
}

function useNow(everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function useCountUp(target: number, duration = 900) {
  const [val, setVal] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    const from = prev.current;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      setVal(from + (target - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
      else prev.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

// Params worth showing as chips: skip the ones already shown as target/environment.
const HIDDEN_PARAMS = new Set(["service", "target", "resource", "name", "environment", "env"]);
function paramChips(a: Action) {
  return Object.entries(a.params ?? {}).filter(([k]) => !HIDDEN_PARAMS.has(k));
}

const envBadge = (env?: string) =>
  env === "production"
    ? "border-rose-400/30 bg-rose-400/10 text-rose-300"
    : env === "staging"
      ? "border-sky-400/30 bg-sky-400/10 text-sky-300"
      : "border-white/15 bg-white/5 text-neutral-300";

function outcome(c: Checkpoint): { label: string; cls: string } {
  if (c.status === "pending") return { label: "waiting", cls: "border-amber-400/30 bg-amber-400/10 text-amber-300" };
  if (c.decidedBy === "policy") return { label: "auto-allowed", cls: "border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-300/90" };
  if (c.status === "approved") return { label: "approved by human", cls: "border-emerald-400/40 bg-emerald-400/15 text-emerald-200" };
  if (c.status === "rejected") return { label: "rejected", cls: "border-rose-400/30 bg-rose-400/10 text-rose-300" };
  return { label: "expired", cls: "border-white/15 bg-white/5 text-neutral-400" };
}

/* ---------- demo: the Relay incident, run through the real rules engine ---------- */

interface DemoStep {
  say: string;
  tool: string;
  target: string;
  params: Record<string, unknown>;
  reason?: string;
  hint?: string;
  ifApproved?: string;
  ifRejected?: string;
  // What the simulated tool returns, given the params that actually ran.
  result: (p: Record<string, unknown>) => string;
}

const prod = { environment: "production" };
const DEMO: DemoStep[] = [
  { say: "Alert fired: API latency is 4.2s. Checking which services are unhealthy.", tool: "list_services", target: "", params: prod, result: () => "3 services degraded: api-server, worker-queue, postgres-primary." },
  { say: "Reading api-server logs.", tool: "read_logs", target: "api-server", params: { service: "api-server", ...prod }, result: () => "ERROR timeout waiting for job result from worker-queue (30s)" },
  { say: "The API is timing out on worker-queue. Reading its logs.", tool: "read_logs", target: "worker-queue", params: { service: "worker-queue", ...prod }, result: () => "deployed v1.8.0 (47 min ago) · ERROR connection not released after job" },
  { say: "The database looks overloaded. Checking its metrics (reading is always allowed).", tool: "get_metrics", target: "postgres-primary", params: { service: "postgres-primary", ...prod }, result: () => "connections 95/100, cpu 88%" },
  {
    say: "The agent wants to restart the main database. This is the exact action behind Relay's outage.",
    tool: "restart_service",
    target: "postgres-primary",
    params: { service: "postgres-primary", ...prod, instances: "all" },
    reason: "Database is at 95/100 connections. Restarting all instances will clear them.",
    hint: "Try rejecting this one.",
    ifApproved: "Approved: postgres-primary is restarting. In real life, Relay would now be down for about 12 minutes.",
    ifRejected: "Blocked. Aegis told the agent a human said no, so it looks for another fix.",
    result: () => "postgres-primary is restarting. Unavailable for about 12 minutes.",
  },
  { say: "Restarting a single worker-queue instance to free connections.", tool: "restart_service", target: "worker-queue", params: { service: "worker-queue", ...prod, instances: 1 }, result: () => "Restarted 1 instance of worker-queue. Errors are returning." },
  {
    say: "The agent wants to add workers to drain the backlog, going from 3 to 12.",
    tool: "scale_service",
    target: "worker-queue",
    params: { service: "worker-queue", ...prod, replicas: 12 },
    reason: "Queue depth is 18,400. More workers will drain it faster.",
    hint: "12 is a lot. Try Edit: change replicas to 5, then approve.",
    ifApproved: "Approved. The agent was told exactly what ran.",
    ifRejected: "Rejected. The agent keeps investigating.",
    result: (p) => `Scaled worker-queue from 3 to ${p.replicas} replicas.`,
  },
  {
    say: "The agent found the real cause and wants to roll back worker-queue.",
    tool: "rollback_deploy",
    target: "worker-queue",
    params: { service: "worker-queue", ...prod },
    reason: "v1.8.0 went out 47 minutes ago and its logs show a connection leak. Rolling back to v1.7.4.",
    hint: "This is the right fix. Approve it.",
    ifApproved: "Rolled back. The queue is draining and the API has recovered.",
    ifRejected: "Rejected. The incident continues, and the on-call engineer takes over.",
    result: () => "Rolled back worker-queue v1.8.0 → v1.7.4. Queue draining, API recovered.",
  },
  { say: "Confirming the queue is draining.", tool: "read_logs", target: "worker-queue", params: { service: "worker-queue", ...prod }, result: () => "queue draining: 18,400 → 2,100 jobs" },
];

const READ_ONLY = new Set(["list_services", "read_logs", "get_metrics", "describe_service"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Only called from event handlers, never during render.
const currentTime = () => Date.now();

// "A week at Relay": the same routine fixes come up day after day. The
// demo uses 3 clean approvals before suggesting trust; the real default is 5.
const WEEK_MIN_APPROVALS = 3;
const DAY_MS = 24 * 60 * 60_000;
interface WeekAction {
  tool: string;
  target: string;
  params: Record<string, unknown>;
  reason?: string;
  // How the simulated on-call engineer answers if Aegis holds it.
  human: "approved" | "rejected";
}
const ROUTINE: WeekAction[] = [
  { tool: "read_logs", target: "worker-queue", params: { service: "worker-queue", ...prod }, human: "approved" },
  { tool: "rollback_deploy", target: "worker-queue", params: { service: "worker-queue", ...prod }, reason: "Nightly release broke the queue again.", human: "approved" },
  { tool: "scale_service", target: "api-server", params: { service: "api-server", ...prod, replicas: 8 }, reason: "Morning traffic peak.", human: "approved" },
];
const DB_RESTART: WeekAction = {
  tool: "restart_service",
  target: "postgres-primary",
  params: { service: "postgres-primary", ...prod, instances: "all" },
  reason: "Database connections are high.",
  human: "rejected",
};
const WEEK: WeekAction[][] = Array.from({ length: 7 }, (_, day) => (day === 4 ? [...ROUTINE, DB_RESTART] : ROUTINE));

/* ---------- visual pieces ---------- */

function Background() {
  return (
    <>
      <div className="aegis-bg">
        <div className="aegis-blob one" />
        <div className="aegis-blob two" />
        <div className="aegis-blob three" />
      </div>
      <div className="aegis-grid" />
    </>
  );
}

function Shield({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <defs>
        <linearGradient id="sg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#a5b4fc" />
          <stop offset="50%" stopColor="#67e8f9" />
          <stop offset="100%" stopColor="#d8b4fe" />
        </linearGradient>
      </defs>
      <path d="M12 2 4 5v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V5l-8-3Z" stroke="url(#sg)" strokeWidth="1.5" strokeLinejoin="round" fill="rgba(129,140,248,0.12)" />
      <path d="m8.5 12 2.3 2.3L16 9.6" stroke="url(#sg)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrustRing({ rate }: { rate: number }) {
  const animated = useCountUp(rate);
  const R = 52;
  const C = 2 * Math.PI * R;
  return (
    <div className="relative grid h-[140px] w-[140px] shrink-0 place-items-center">
      <svg viewBox="0 0 130 130" className="h-[140px] w-[140px] -rotate-90">
        <defs>
          <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#818cf8" />
            <stop offset="50%" stopColor="#22d3ee" />
            <stop offset="100%" stopColor="#c084fc" />
          </linearGradient>
        </defs>
        <circle cx="65" cy="65" r={R} stroke="rgba(255,255,255,0.08)" strokeWidth="10" fill="none" />
        <circle cx="65" cy="65" r={R} stroke="url(#ring)" strokeWidth="10" fill="none" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - rate)} style={{ transition: "stroke-dashoffset 1s cubic-bezier(0.22,1,0.36,1)" }} />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-3xl font-semibold tabular-nums text-white">{Math.round(animated * 100)}%</span>
        <span className="text-[11px] uppercase tracking-wider text-neutral-400">autonomous</span>
      </div>
    </div>
  );
}

function Stat({ label, value, hint, accent }: { label: string; value: string; hint: string; accent: string }) {
  return (
    <div className="glass rounded-2xl p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">{label}</div>
      <div className={`mt-1.5 text-2xl font-semibold tabular-nums ${accent}`}>{value}</div>
      <div className="mt-1 text-xs text-neutral-500">{hint}</div>
    </div>
  );
}

function TrendChart({ trend }: { trend: Metrics["trend"] }) {
  if (trend.length < 2) return <div className="text-xs text-neutral-500">The trend appears once more actions have run.</div>;
  return (
    <div className="flex h-20 items-end gap-2">
      {trend.map((t, i) => (
        <div key={i} className="group flex h-full flex-1 flex-col justify-end gap-1" title={`actions ${t.label}: ${pct(t.interventionRate)} needed a human`}>
          <motion.div initial={{ height: 0 }} animate={{ height: `${Math.max(4, t.interventionRate * 100)}%` }} transition={{ duration: 0.6, delay: i * 0.04 }} className="w-full rounded-t-md bg-gradient-to-t from-rose-500/40 to-rose-400/90" />
        </div>
      ))}
    </div>
  );
}

function FlowDiagram() {
  const box = "glass rounded-xl px-4 py-3 text-center";
  const arrow = "hidden text-neutral-600 sm:block";
  return (
    <div className="mb-10 grid items-center gap-3 sm:grid-cols-[1fr_auto_1.3fr_auto_1fr]">
      <div className={box}>
        <div className="text-sm font-medium text-white">AI agent</div>
        <div className="mt-0.5 text-xs text-neutral-500">Claude Code, Cursor, your own</div>
      </div>
      <span className={arrow}>→</span>
      <div className={`${box} border border-indigo-400/30 shadow-[0_0_30px_-8px_rgba(99,102,241,0.6)]`}>
        <div className="flex items-center justify-center gap-1.5 text-sm font-medium text-white">
          <Shield className="h-4 w-4" /> Aegis checks every action
        </div>
        <div className="mt-1.5 flex flex-wrap justify-center gap-1.5 text-[11px]">
          <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-emerald-300">safe → runs now</span>
          <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-amber-300">risky → you decide</span>
        </div>
      </div>
      <span className={arrow}>→</span>
      <div className={box}>
        <div className="text-sm font-medium text-white">Real tools</div>
        <div className="mt-0.5 text-xs text-neutral-500">servers, databases, GitHub</div>
      </div>
    </div>
  );
}

// Turn what the human typed back into the same type as the original value.
function coerce(original: unknown, typed: string): unknown {
  if (typeof original === "number") return typed.trim() === "" ? NaN : Number(typed);
  if (typeof original === "boolean") return typed === "true";
  return typed;
}

function PendingCard({
  c,
  now,
  busy,
  canDecide,
  onDecide,
}: {
  c: Checkpoint;
  now: number;
  busy: boolean;
  canDecide: boolean;
  onDecide: (d: "approved" | "rejected", params?: Record<string, unknown>) => void;
}) {
  const a = c.action;
  const chips = paramChips(a);
  const left = c.expiresAt ? c.expiresAt - now : undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const edited = Object.fromEntries(
    chips.map(([k, v]) => [k, k in draft ? coerce(v, draft[k]) : v]),
  );
  const invalid = Object.values(edited).some((v) => typeof v === "number" && Number.isNaN(v));
  const changed = chips.some(([k, v]) => JSON.stringify(edited[k]) !== JSON.stringify(v));

  return (
    <motion.li layout initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.96, x: 40 }} transition={{ type: "spring", stiffness: 380, damping: 30 }} className="glass rounded-2xl p-5 shadow-[0_0_0_1px_rgba(245,158,11,0.35),0_0_30px_-8px_rgba(245,158,11,0.45)]">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        {a.environment && <span className={`rounded-full border px-2 py-0.5 font-medium ${envBadge(a.environment)}`}>{a.environment}</span>}
        <span className="font-mono text-neutral-400">{a.agent}</span>
        {left !== undefined && <span className={`ml-auto tabular-nums ${left < 60_000 ? "text-rose-300" : "text-neutral-500"}`}>{timeLeft(left)}</span>}
      </div>

      <p className="font-mono text-[15px] text-white">
        {a.tool}
        {a.target && (
          <>
            <span className="mx-2 text-neutral-500">→</span>
            <span className="text-amber-200">{a.target}</span>
          </>
        )}
      </p>
      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {chips.map(([k, v]) =>
            editing && (typeof v === "number" || typeof v === "string" || typeof v === "boolean") ? (
              <label key={k} className="flex items-center gap-1.5 rounded-md border border-sky-400/40 bg-sky-400/10 px-2 py-0.5 font-mono text-xs text-sky-100">
                {k}:
                <input
                  aria-label={`New value for ${k}`}
                  inputMode={typeof v === "number" ? "numeric" : undefined}
                  value={k in draft ? draft[k] : String(v)}
                  onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                  className="w-16 bg-transparent text-white outline-none"
                />
              </label>
            ) : (
              <span key={k} className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-xs text-neutral-300">
                {k}: <span className="text-white">{typeof v === "string" ? v : JSON.stringify(v)}</span>
              </span>
            ),
          )}
        </div>
      )}

      {c.duplicateOf && (
        <p className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2 text-xs text-amber-200">
          Possible duplicate: this exact action already ran moments ago.
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">The agent says</div>
          <p className="mt-1 text-sm text-neutral-300">{a.reason ? `“${a.reason}”` : <span className="text-neutral-500">No reason given.</span>}</p>
          <p className="mt-1 text-[11px] text-neutral-600">The agent&apos;s own words. Not used to decide.</p>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">Why Aegis held it</div>
          <p className="mt-1 text-sm text-neutral-300">{c.verdict.explanation}</p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          disabled={busy || !canDecide || (editing && invalid)}
          onClick={() => onDecide("approved", editing && changed ? { ...(a.params ?? {}), ...edited } : undefined)}
          className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-5 py-2 text-sm font-medium text-white shadow-lg shadow-emerald-500/20 disabled:opacity-40"
        >
          {editing && changed ? "Approve with changes" : "Approve"}
        </motion.button>
        <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} disabled={busy || !canDecide} onClick={() => onDecide("rejected")} className="rounded-xl border border-white/15 bg-white/5 px-5 py-2 text-sm font-medium text-neutral-200 hover:bg-white/10 disabled:opacity-40">
          Reject
        </motion.button>
        {chips.length > 0 && (
          <button
            disabled={!canDecide}
            onClick={() => {
              setEditing((e) => !e);
              setDraft({});
            }}
            className="px-2 py-2 text-sm text-sky-300 underline-offset-2 hover:underline disabled:opacity-40"
          >
            {editing ? "Cancel edit" : "Edit"}
          </button>
        )}
        {editing && invalid && <span className="text-xs text-rose-300">Numbers only.</span>}
      </div>
    </motion.li>
  );
}

function ActivityRow({ c }: { c: Checkpoint }) {
  const o = outcome(c);
  const a = c.action;
  return (
    <motion.li initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className="glass grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1 rounded-xl px-4 py-2.5 text-sm sm:grid-cols-[72px_1fr_auto]">
      <span className="pt-0.5 font-mono text-xs tabular-nums text-neutral-500">{clockTime(c.createdAt)}</span>
      <div className="min-w-0">
        <div className="truncate font-mono text-[13px] text-neutral-200">
          {a.tool}
          {a.target && <span className="text-neutral-400"> → {a.target}</span>}
          {a.environment && <span className="ml-2 text-xs text-neutral-500">{a.environment}</span>}
        </div>
        <div className="truncate text-xs text-neutral-500">
          {c.decidedBy === "policy" ? `Rule: ${c.verdict.matchedRules.join(", ")}` : c.verdict.explanation}
        </div>
        {c.edit && (
          <div className="mt-0.5 text-xs text-sky-300">
            Human changed {c.edit.changes.map((ch) => `${ch.key} ${JSON.stringify(ch.from)} → ${JSON.stringify(ch.to)}`).join(", ")}
          </div>
        )}
        {c.execution && (
          <div className={`mt-0.5 truncate text-xs ${c.execution.ok ? "text-neutral-400" : "text-rose-300"}`} title={c.execution.summary}>
            {c.execution.ok ? "Ran: " : "Failed: "}
            {c.execution.summary.split("\n")[0]}
          </div>
        )}
      </div>
      <span className={`col-start-2 w-fit rounded-full border px-2 py-0.5 text-[11px] font-medium sm:col-start-auto ${o.cls}`}>{o.label}</span>
    </motion.li>
  );
}

function TrustPanel({
  suggestions,
  grants,
  canDecide,
  minApprovals,
  onGrant,
  onRevoke,
  onSimulate,
}: {
  suggestions: TrustSuggestion[];
  grants: TrustGrant[];
  canDecide: boolean;
  minApprovals: number;
  onGrant: (key: string) => void;
  onRevoke: (id: string) => void;
  onSimulate?: () => void;
}) {
  const active = grants.filter((g) => !g.revokedAt);
  return (
    <section className="mb-10">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-neutral-300">Earned trust</h2>
        {onSimulate && (
          <button onClick={onSimulate} className="text-xs font-medium text-sky-300 underline-offset-2 hover:underline">
            ▶ Simulate a week at Relay
          </button>
        )}
      </div>

      {suggestions.length === 0 && active.length === 0 && (
        <p className="glass rounded-2xl p-5 text-sm text-neutral-500">
          Nothing yet. When humans approve the same action {minApprovals} times in a row without changing it, Aegis suggests letting it run on its own.
          Rules marked as hard lines, like database changes, are never suggested.
        </p>
      )}

      <ul className="space-y-3">
        <AnimatePresence mode="popLayout">
          {suggestions.map((sg) => (
            <motion.li key={sg.key} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 40 }} className="glass rounded-2xl p-5 shadow-[0_0_0_1px_rgba(56,189,248,0.35),0_0_30px_-8px_rgba(56,189,248,0.45)]">
              <p className="text-sm text-neutral-300">
                Humans approved <span className="font-mono text-white">{describePattern(sg.pattern)}</span> {sg.approvals} times in a row, unchanged
                {sg.avgDecisionMs > 0 && <>, taking {(sg.avgDecisionMs / 1000).toFixed(0)}s each on average</>}.
              </p>
              <p className="mt-2 text-sm text-neutral-400">
                Trust it: let exactly this run without asking
                {Object.keys(sg.params).length > 0 && <>, only for <span className="font-mono text-neutral-200">{describeLimits(sg.params)}</span></>}.
                {sg.exceptFrom.length > 0 && <> Makes a narrow exception to {sg.exceptFrom.map((r) => `“${r}”`).join(", ")}.</>}
              </p>
              <div className="mt-4 flex gap-2.5">
                <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} disabled={!canDecide} onClick={() => onGrant(sg.key)} className="rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 px-5 py-2 text-sm font-medium text-white shadow-lg shadow-sky-500/20 disabled:opacity-40">
                  Trust this
                </motion.button>
                <span className="self-center text-xs text-neutral-500">You can take it back any time.</span>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>

      {active.length > 0 && (
        <ul className="mt-3 space-y-2">
          {active.map((g) => (
            <li key={g.id} className="glass flex flex-wrap items-center justify-between gap-2 rounded-xl px-4 py-2.5 text-sm">
              <div className="min-w-0">
                <span className="mr-2 rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-[11px] font-medium text-sky-300">trusted</span>
                <span className="font-mono text-[13px] text-neutral-200">{describePattern(g.pattern)}</span>
                {Object.keys(g.params).length > 0 && <span className="ml-2 font-mono text-xs text-neutral-500">{describeLimits(g.params)}</span>}
                <span className="ml-2 text-xs text-neutral-500">after {g.approvals} approvals</span>
              </div>
              <button disabled={!canDecide} onClick={() => onRevoke(g.id)} className="text-xs text-rose-300 underline-offset-2 hover:underline disabled:opacity-40">
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConnectAgent() {
  return (
    <details className="glass group rounded-2xl p-5">
      <summary className="cursor-pointer list-none text-sm font-medium text-neutral-200">
        <span className="mr-2 inline-block transition group-open:rotate-90">›</span>
        Connect your own agent
      </summary>
      <div className="mt-4 space-y-3 text-sm text-neutral-400">
        <p>Aegis sits in front of any MCP server. Point your agent at Aegis instead of the server, and every tool call is checked first. For Claude Code:</p>
        <pre className="overflow-x-auto rounded-xl border border-white/10 bg-black/40 p-4 font-mono text-xs leading-relaxed text-neutral-300">{`claude mcp add relay-infra -- \\
  npx tsx mcp/aegis-proxy.ts --policy policies/relay.ts --agent relay-oncall -- \\
  npx tsx mcp/relay-infra-server.ts`}</pre>
        <p>Keep this console running. If it goes down, Aegis blocks every action until it&apos;s back (it fails closed).</p>
      </div>
    </details>
  );
}

/* ---------- page ---------- */

export default function Console() {
  const now = useNow();
  const [live, setLive] = useState<{ checkpoints: Checkpoint[]; metrics: Metrics } | null>(null);
  const [liveTrust, setLiveTrust] = useState<{ suggestions: TrustSuggestion[]; grants: TrustGrant[] }>({ suggestions: [], grants: [] });
  const [reachable, setReachable] = useState(true);
  // Can this browser approve? Needs the link printed by the console at startup.
  const [approver, setApprover] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Demo mode runs entirely in the browser, with its own store.
  const [demo, setDemo] = useState(false);
  const demoStore = useRef<CheckpointStore | null>(null);
  const demoRun = useRef(0);
  const [demoCheckpoints, setDemoCheckpoints] = useState<Checkpoint[]>([]);
  const [narration, setNarration] = useState<{ text: string; hint?: string } | null>(null);
  const [demoDone, setDemoDone] = useState(false);
  const [demoKind, setDemoKind] = useState<"incident" | "week">("incident");
  const [demoGrants, setDemoGrants] = useState<TrustGrant[]>([]);
  const demoGrantsRef = useRef<TrustGrant[]>([]);
  // Resolves when the visitor clicks "Continue the week".
  const continueWeek = useRef<(() => void) | null>(null);
  const [weekPaused, setWeekPaused] = useState(false);

  const load = useCallback(async () => {
    try {
      const [res, trustRes] = await Promise.all([
        fetch("/api/checkpoints", { cache: "no-store" }),
        fetch("/api/trust", { cache: "no-store" }),
      ]);
      if (!res.ok) throw new Error(String(res.status));
      setLive(await res.json());
      if (trustRes.ok) setLiveTrust(await trustRes.json());
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = new URLSearchParams(window.location.search).get("token");
      if (token) {
        // Swap the link's secret for a cookie, then remove it from the address bar.
        const res = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }).catch(() => null);
        window.history.replaceState(null, "", window.location.pathname);
        if (res && !res.ok) setError((await res.json()).error);
      }
      const res = await fetch("/api/session", { cache: "no-store" }).catch(() => null);
      const session = res?.ok ? await res.json() : { approver: false };
      if (!cancelled) setApprover(session.approver);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (demo) return;
    const first = setTimeout(load, 0);
    const t = setInterval(load, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load, demo]);

  async function runDemo() {
    const run = ++demoRun.current;
    const store = new CheckpointStore();
    demoStore.current = store;
    setDemo(true);
    setDemoKind("incident");
    setDemoDone(false);
    // Copy each checkpoint so React sees a change and re-renders.
    const refresh = () => setDemoCheckpoints(store.list().map((c) => ({ ...c })));
    refresh();
    const alive = () => demoRun.current === run;

    for (const step of DEMO) {
      if (!alive()) return;
      setNarration({ text: step.say });
      await sleep(1100);
      if (!alive()) return;

      const action: Action = {
        agent: "relay-oncall",
        tool: step.tool,
        target: step.target || undefined,
        environment: "production",
        params: step.params,
        reason: step.reason,
      };
      const { checkpoint } = store.create({ action, verdict: evaluate(action, relayPolicy), readOnly: READ_ONLY.has(step.tool) });
      refresh();

      if (checkpoint.status === "pending") {
        setNarration({ text: `${step.say} Aegis is holding it for you.`, hint: step.hint });
        while (alive() && store.get(checkpoint.id)?.status === "pending") await sleep(200);
        if (!alive()) return;
        const approved = store.get(checkpoint.id)?.status === "approved";
        setNarration({ text: (approved ? step.ifApproved : step.ifRejected) ?? "" });
      }
      const final = store.get(checkpoint.id)!;
      if (final.status === "approved") store.recordResult(final.id, { ok: true, summary: step.result(final.edit?.params ?? step.params) });
      refresh();
      if (checkpoint.status === "pending") await sleep(2200);
    }
    if (!alive()) return;
    const m = computeMetrics(store.list());
    setDemoDone(true);
    setNarration({ text: `Incident handled. ${m.autoApproved} of ${m.total} actions ran on their own, and a human made the ${m.escalated} calls that mattered.` });
  }

  async function runWeek() {
    const run = ++demoRun.current;
    const alive = () => demoRun.current === run;
    // A simulated clock: days pass in seconds.
    let simNow = currentTime();
    const store = new CheckpointStore(() => simNow);
    demoStore.current = store;
    demoGrantsRef.current = [];
    setDemoGrants([]);
    setDemo(true);
    setDemoKind("week");
    setDemoDone(false);
    setWeekPaused(false);
    const refresh = () => setDemoCheckpoints(store.list().map((c) => ({ ...c })));
    refresh();

    for (let day = 0; day < WEEK.length; day++) {
      if (!alive()) return;
      simNow += DAY_MS;
      setNarration({ text: `Day ${day + 1}. ${day === 4 ? "Another bad night, and the agent wants to restart the database." : "The routine fixes come up again."}` });
      for (const step of WEEK[day]) {
        await sleep(650);
        if (!alive()) return;
        simNow += 60_000;
        const action: Action = { agent: "relay-oncall", tool: step.tool, target: step.target, environment: "production", params: step.params, reason: step.reason };
        const verdict = evaluate(action, applyTrust(relayPolicy, demoGrantsRef.current));
        const { checkpoint } = store.create({ action, verdict, readOnly: READ_ONLY.has(step.tool) });
        refresh();
        if (checkpoint.status === "pending") {
          await sleep(700);
          if (!alive()) return;
          simNow += 8000; // the on-call engineer takes a few seconds
          store.decide(checkpoint.id, step.human);
        }
        if (store.get(checkpoint.id)?.status === "approved") store.recordResult(checkpoint.id, { ok: true, summary: "done" });
        refresh();
      }

      const open = suggestTrust(store.list(), demoGrantsRef.current, { minApprovals: WEEK_MIN_APPROVALS });
      if (day >= 2 && open.length > 0 && demoGrantsRef.current.length === 0) {
        setNarration({
          text: `End of day ${day + 1}. The on-call engineer approved the same fixes ${WEEK_MIN_APPROVALS} days running, without changing them. Aegis noticed.`,
          hint: "Click “Trust this” on the suggestions below, then continue the week.",
        });
        setWeekPaused(true);
        await new Promise<void>((resolve) => (continueWeek.current = resolve));
        setWeekPaused(false);
      }
    }
    if (!alive()) return;
    setDemoDone(true);
    const trusted = demoGrantsRef.current.filter((g) => !g.revokedAt).length;
    setNarration({
      text: trusted
        ? "Week done. After you granted trust, the routine fixes ran on their own and only the database restart needed a human. That's the goal: fewer interruptions, only where it matters."
        : "Week done. Without granting trust, the on-call engineer was interrupted for the same fixes every day.",
    });
  }

  function exitDemo() {
    demoRun.current++;
    demoStore.current = null;
    continueWeek.current?.();
    setDemoCheckpoints([]);
    setDemoGrants([]);
    demoGrantsRef.current = [];
    setDemo(false);
    setNarration(null);
  }

  async function grantTrust(key: string) {
    setError(null);
    if (demo) {
      const sg = suggestTrust(demoStore.current?.list() ?? [], demoGrantsRef.current, { minApprovals: WEEK_MIN_APPROVALS }).find((x) => x.key === key);
      if (!sg) return;
      demoGrantsRef.current = [...demoGrantsRef.current, { ...sg, id: crypto.randomUUID(), grantedAt: currentTime() }];
      setDemoGrants(demoGrantsRef.current);
      return;
    }
    const res = await fetch("/api/trust", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? "Couldn't grant trust.");
    await load();
  }

  async function revokeTrust(id: string) {
    setError(null);
    if (demo) {
      demoGrantsRef.current = demoGrantsRef.current.map((g) => (g.id === id ? { ...g, revokedAt: currentTime() } : g));
      setDemoGrants(demoGrantsRef.current);
      return;
    }
    const res = await fetch(`/api/trust/${id}/revoke`, { method: "POST" });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? "Couldn't revoke trust.");
    await load();
  }

  async function decide(id: string, decision: "approved" | "rejected", params?: Record<string, unknown>) {
    setError(null);
    if (demo) {
      const store = demoStore.current;
      if (!store) return;
      const result = store.decide(id, decision, params);
      if (!result.ok) setError(result.error);
      setDemoCheckpoints(store.list().map((c) => ({ ...c })));
      return;
    }
    setBusy(id);
    const res = await fetch(`/api/checkpoints/${id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, params }),
    });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? `Couldn't record the decision (${res.status}).`);
    await load();
    setBusy(null);
  }

  const canDecide = demo || approver === true;

  const checkpoints = demo ? demoCheckpoints : (live?.checkpoints ?? []);
  const metrics = demo ? computeMetrics(checkpoints) : live?.metrics;
  const pending = checkpoints.filter((c) => c.status === "pending");
  const trustView = demo
    ? { suggestions: suggestTrust(demoCheckpoints, demoGrants, { minApprovals: WEEK_MIN_APPROVALS }), grants: demoGrants }
    : liveTrust;
  const activity = checkpoints.filter((c) => c.status !== "pending");

  return (
    <>
      <Background />
      <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-12">
        {/* Header */}
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Shield className="h-9 w-9" />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight"><span className="grad-text">Aegis</span></h1>
              <p className="text-xs text-neutral-400">A safety checkpoint for AI agents</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            {demo ? (
              <>
                <span className="rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-2.5 py-1 text-[11px] font-medium text-fuchsia-300">DEMO · simulated</span>
                <button onClick={exitDemo} className="rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-xs font-medium text-neutral-200 hover:bg-white/10">Exit demo</button>
              </>
            ) : (
              <>
                <div className="glass flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs">
                  <span className={`h-2 w-2 rounded-full ${reachable ? "pulse-dot bg-emerald-400" : "bg-rose-400"}`} />
                  <span className="text-neutral-300">{reachable ? "Live" : "Console offline"}</span>
                </div>
                <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }} onClick={runDemo} className="rounded-full bg-gradient-to-r from-indigo-500 via-sky-500 to-fuchsia-500 px-4 py-1.5 text-xs font-semibold text-white shadow-lg shadow-indigo-500/25">
                  ▶ Run the Relay incident demo
                </motion.button>
              </>
            )}
          </div>
        </header>

        {/* Hero */}
        <section className="mb-8 max-w-2xl">
          <h2 className="text-xl font-semibold leading-snug text-white sm:text-2xl">
            Monitoring tells you what your agent did.
            <br />
            <span className="grad-text">Aegis decides what it&apos;s allowed to do.</span>
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-neutral-400">
            Aegis sits between an AI agent and its tools. Safe actions run instantly. Risky ones wait here for a human. The goal is to keep human involvement low, and only where it matters.
          </p>
        </section>

        <FlowDiagram />

        {/* Demo narration */}
        <AnimatePresence mode="wait">
          {demo && narration && (
            <motion.div key={narration.text} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mb-6 rounded-2xl border border-fuchsia-400/25 bg-fuchsia-400/[0.06] px-4 py-3 text-sm text-fuchsia-50">
              <span className="mr-2 font-mono text-xs text-fuchsia-300">relay-oncall</span>
              {narration.text}
              {narration.hint && <span className="ml-2 font-medium text-amber-200">{narration.hint}</span>}
              {weekPaused && (
                <button onClick={() => continueWeek.current?.()} className="ml-3 rounded-full border border-fuchsia-300/40 bg-fuchsia-400/15 px-3 py-1 text-xs font-medium text-fuchsia-100 hover:bg-fuchsia-400/25">
                  Continue the week →
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {!demo && reachable && approver === false && (
          <div className="mb-6 rounded-2xl border border-sky-400/25 bg-sky-400/[0.06] px-4 py-3 text-sm text-sky-100">
            <span className="font-medium">View only.</span> To approve or reject, open the approval link printed in the terminal where the console is running. This stops an agent from approving its own requests.
          </div>
        )}
        {error && (
          <div role="alert" className="mb-6 rounded-2xl border border-rose-400/30 bg-rose-400/[0.08] px-4 py-3 text-sm text-rose-100">
            {error}
          </div>
        )}

        {/* Pending */}
        <section className="mb-10">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-medium text-neutral-300">
            Waiting for you
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-xs tabular-nums text-amber-300">{pending.length}</span>
          </h2>
          {pending.length === 0 ? (
            <div className="glass rounded-2xl p-8 text-center text-sm text-neutral-500">
              {demo ? (
                demoDone ? (
                  <>
                    Demo finished.{" "}
                    <button onClick={demoKind === "week" ? runWeek : runDemo} className="font-medium text-sky-300 underline-offset-2 hover:underline">Run it again</button>
                  </>
                ) : (
                  "The agent is working. Anything risky will appear here."
                )
              ) : !reachable ? (
                "Can't reach the console server. Connected agents are blocked until it's back."
              ) : (
                <>
                  Nothing needs a human right now.{" "}
                  <button onClick={runDemo} className="font-medium text-sky-300 underline-offset-2 hover:underline">Run the demo</button> to see a real incident.
                </>
              )}
            </div>
          ) : (
            <ul className="space-y-3">
              <AnimatePresence mode="popLayout">
                {pending.map((c) => (
                  <PendingCard key={c.id} c={c} now={demo && demoKind === "week" ? (c.expiresAt ?? now) - 5 * 60_000 : now} busy={busy === c.id} canDecide={canDecide} onDecide={(d, p) => decide(c.id, d, p)} />
                ))}
              </AnimatePresence>
            </ul>
          )}
        </section>

        {(demoKind === "week" || !demo) && (
          <TrustPanel
            suggestions={trustView.suggestions}
            grants={trustView.grants}
            canDecide={canDecide}
            minApprovals={demo ? WEEK_MIN_APPROVALS : 5}
            onGrant={grantTrust}
            onRevoke={revokeTrust}
            onSimulate={demo ? undefined : runWeek}
          />
        )}

        {/* Metrics */}
        {metrics && metrics.total > 0 && (
          <section className="mb-10 grid grid-cols-1 gap-4 lg:grid-cols-[auto_1fr]">
            <div className="glass flex items-center gap-5 rounded-2xl p-5">
              <TrustRing rate={metrics.autoApproveRate} />
              <div>
                <div className="text-sm font-medium text-white">Ran without a human</div>
                <div className="mt-1 text-xs text-neutral-400">{metrics.autoApproved} of {metrics.total} actions allowed by policy.</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat label="Needed a human" value={String(metrics.escalated)} hint={`${pct(metrics.interventionRate)} of actions`} accent="text-amber-300" />
              <Stat label="Human said no" value={pct(metrics.vetoRate)} hint={`${metrics.rejected} rejected`} accent="text-rose-300" />
              <Stat label="Time to decide" value={metrics.avgTimeToDecideMs ? `${(metrics.avgTimeToDecideMs / 1000).toFixed(1)}s` : "—"} hint="average" accent="text-sky-300" />
              <div className="glass col-span-2 rounded-2xl p-4 sm:col-span-3">
                <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Share of actions needing a human, over time</div>
                <TrendChart trend={metrics.trend} />
              </div>
            </div>
          </section>
        )}

        {/* Activity */}
        <section className="mb-10">
          <h2 className="mb-4 text-sm font-medium text-neutral-300">Every action, on record</h2>
          {activity.length === 0 ? (
            <p className="text-sm text-neutral-500">No actions yet.</p>
          ) : (
            <ul className="space-y-2">
              {activity.map((c) => (
                <ActivityRow key={c.id} c={c} />
              ))}
            </ul>
          )}
        </section>

        <ConnectAgent />

        <footer className="mt-14 border-t border-white/5 pt-6 text-center text-xs text-neutral-600">
          Aegis · autonomy where it&apos;s safe, people where it matters
        </footer>
      </main>
    </>
  );
}
