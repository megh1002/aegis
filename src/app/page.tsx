"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckpointStore, computeMetrics, type Checkpoint, type Metrics } from "../../core/checkpoints";
import { evaluate } from "../../core/evaluate";
import { applyTrust, suggestTrust, type TrustGrant, type TrustSuggestion } from "../../core/trust";
import { plainAction, plainEnv, plainLimits, plainParam, plainPattern, technical } from "@/lib/plain";
import type { Action } from "../../core/types";
import relayPolicy from "../../policies/relay";

/* ---------- helpers ---------- */

const pct = (n: number) => `${Math.round(n * 100)}%`;
// Set when built for the public website: demos only, no live console.
const DEMO_ONLY = process.env.NEXT_PUBLIC_AEGIS_DEMO_ONLY === "1";
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
  { say: "It's 2am at Relay and their app has slowed to a crawl. The AI agent starts investigating by checking which systems are unhealthy.", tool: "list_services", target: "", params: prod, result: () => "Three systems are struggling: the API server, the job queue and the main database." },
  { say: "It reads the API server's logs.", tool: "read_logs", target: "api-server", params: { service: "api-server", ...prod }, result: () => "The API server keeps waiting on the job queue." },
  { say: "The API server is stuck waiting on the job queue, so the agent reads the job queue's logs next.", tool: "read_logs", target: "worker-queue", params: { service: "worker-queue", ...prod }, result: () => "An update went out 47 minutes ago, and errors started right after." },
  { say: "The main database looks overloaded, so the agent checks how it's doing. Just looking is always allowed.", tool: "get_metrics", target: "postgres-primary", params: { service: "postgres-primary", ...prod }, result: () => "The database is close to its connection limit." },
  {
    say: "Now the agent wants to restart the entire main database. That's exactly what took Relay down last time.",
    tool: "restart_service",
    target: "postgres-primary",
    params: { service: "postgres-primary", ...prod, instances: "all" },
    reason: "The database is close to its connection limit. Restarting it will clear that.",
    hint: "Try rejecting this one.",
    ifApproved: "You approved it. The main database is restarting, so in real life Relay's app would now be down for about 12 minutes.",
    ifRejected: "You said no. Aegis tells the agent, and it looks for a safer fix.",
    result: () => "The main database is restarting. The app is down for about 12 minutes.",
  },
  { say: "It restarts one copy of the job queue to free things up. That's small and safe, so it runs on its own.", tool: "restart_service", target: "worker-queue", params: { service: "worker-queue", ...prod, instances: 1 }, result: () => "Restarted one copy of the job queue. It helped briefly, but the errors are coming back." },
  {
    say: "The agent wants to run 12 copies of the job queue instead of 3, to clear the backlog faster.",
    tool: "scale_service",
    target: "worker-queue",
    params: { service: "worker-queue", ...prod, replicas: 12 },
    reason: "18,400 jobs are waiting. More copies will get through them faster.",
    hint: "12 is a lot. Try Edit, change it to 5, then approve.",
    ifApproved: "Approved. The agent is told exactly what ran, including any change you made.",
    ifRejected: "You said no. The agent keeps investigating.",
    result: (p) => `Now running ${p.replicas} copies of the job queue.`,
  },
  {
    say: "The agent found the real cause: the update from 47 minutes ago. It wants to undo it.",
    tool: "rollback_deploy",
    target: "worker-queue",
    params: { service: "worker-queue", ...prod },
    reason: "The job queue's latest update broke it. Going back to the previous version should fix it.",
    hint: "This is the right fix. Approve it.",
    ifApproved: "Undone. The backlog is clearing and the app is fast again.",
    ifRejected: "You said no. The outage continues, and a human engineer takes over.",
    result: () => "Undid the latest update. The backlog is clearing and the app is fast again.",
  },
  { say: "Last, the agent checks that things are really getting better.", tool: "read_logs", target: "worker-queue", params: { service: "worker-queue", ...prod }, result: () => "The backlog dropped from 18,400 jobs to 2,100." },
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
  return <div className="aegis-bg" />;
}

// The Aegis mark: a geometric "A" whose crossbar is a single dot, the
// checkpoint every action passes. Same drawing as src/app/icon.svg.
function Logo({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <defs>
        <linearGradient id="aegis-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#0ea5e9" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#aegis-tile)" />
      <path d="M9 24.5 16 7.5l7 17" fill="none" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="19" r="2.3" fill="white" />
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

// A still example for the hero. Each badge comes from the real rules
// engine and Relay's real policy, so what it shows is accurate.
const EXAMPLE: Action[] = [
  { agent: "relay-oncall", tool: "read_logs", target: "api-server", environment: "production" },
  { agent: "relay-oncall", tool: "scale_service", target: "worker-queue", environment: "production", params: { replicas: 4 } },
  { agent: "relay-oncall", tool: "restart_service", target: "postgres-primary", environment: "production", params: { instances: "all" } },
];

function Example() {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
      <div className="mb-3 text-xs text-neutral-500">Example: an on-call agent during an outage</div>
      <ul className="space-y-2">
        {EXAMPLE.map((action) => {
          const held = evaluate(action, relayPolicy).decision === "escalate";
          return (
            <li key={action.tool + action.target} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0">
                <span className="block truncate text-neutral-200">{plainAction(action)}</span>
                <span className="block truncate font-mono text-[11px] text-neutral-600">{technical(action)}</span>
              </span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${held ? "bg-amber-400/15 text-amber-200" : "bg-emerald-400/10 text-emerald-300"}`}>
                {held ? "waits for you" : "runs now"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    ["The agent acts", "It tries to do something: restart a server, add capacity, change data."],
    ["Aegis checks your rules", "Safe actions go straight through."],
    ["You decide the risky few", "Approve, edit or reject. Trust grows as you approve."],
  ];
  return (
    <ol className="mb-16 grid gap-6 border-t border-white/[0.06] pt-8 sm:grid-cols-3">
      {steps.map(([t, d], i) => (
        <li key={t}>
          <div className="text-xs text-neutral-500">{i + 1}</div>
          <div className="mt-1 text-sm font-medium text-neutral-100">{t}</div>
          <p className="mt-1 text-sm leading-relaxed text-neutral-500">{d}</p>
        </li>
      ))}
    </ol>
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
    <motion.li layout initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.96, x: 40 }} transition={{ type: "spring", stiffness: 380, damping: 30 }} className="glass rounded-2xl border border-amber-400/25 p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        {a.environment && <span className={`rounded-full border px-2 py-0.5 font-medium ${envBadge(a.environment)}`}>{plainEnv(a.environment)}</span>}
        <span className="font-mono text-neutral-400">{a.agent}</span>
        {left !== undefined && <span className={`ml-auto tabular-nums ${left < 60_000 ? "text-rose-300" : "text-neutral-500"}`}>{timeLeft(left)}</span>}
      </div>

      <p className="text-[17px] font-medium text-white">{plainAction(a)}</p>
      <p className="mt-0.5 font-mono text-xs text-neutral-500">{technical(a)}</p>
      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {chips.map(([k, v]) =>
            editing && (typeof v === "number" || typeof v === "string" || typeof v === "boolean") ? (
              <label key={k} className="flex items-center gap-1.5 rounded-md border border-sky-400/40 bg-sky-400/10 px-2 py-0.5 font-mono text-xs text-sky-100">
                {plainParam(k)}:
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
                {plainParam(k)}: <span className="text-white">{typeof v === "string" ? v : JSON.stringify(v)}</span>
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
        <div className="truncate text-[13.5px] text-neutral-200">{plainAction(a)}</div>
        <div className="truncate font-mono text-[11px] text-neutral-600">{technical(a)}</div>
        <div className="truncate text-xs text-neutral-500">
          {c.decidedBy === "policy" ? `Why it ran: ${c.verdict.matchedRules.join(", ")}` : c.verdict.explanation}
        </div>
        {c.edit && (
          <div className="mt-0.5 text-xs text-sky-300">
            A person changed {c.edit.changes.map((ch) => `${plainParam(ch.key)} from ${JSON.stringify(ch.from)} to ${JSON.stringify(ch.to)}`).join(", ")}
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

const GITHUB_URL = "https://github.com/megh1002/aegis";

// Shown when a demo ends: what the visitor just did, in plain words.
function DemoSummary({ kind, checkpoints, grants, onRunIncident, onRunWeek }: {
  kind: "incident" | "week";
  checkpoints: Checkpoint[];
  grants: TrustGrant[];
  onRunIncident: () => void;
  onRunWeek: () => void;
}) {
  const auto = checkpoints.filter((c) => c.decidedBy === "policy").length;
  const human = checkpoints.filter((c) => c.decidedBy === "human").sort((a, b) => a.createdAt - b.createdAt);
  const verb = (c: Checkpoint) => (c.status === "rejected" ? "you said no" : c.edit ? "you approved it with a change" : "you approved it");
  const trusted = grants.filter((g) => !g.revokedAt).length;

  return (
    <div className="glass rounded-2xl border border-emerald-400/20 p-6">
      <h4 className="text-[15px] font-medium text-white">What just happened</h4>
      {kind === "incident" ? (
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-neutral-300">
          <li>The agent handled <span className="text-white">{auto} of {checkpoints.length}</span> steps on its own: reading logs, checking systems, small safe fixes.</li>
          <li>
            It needed you for <span className="text-white">{human.length}</span> decision{human.length === 1 ? "" : "s"}:
            <ul className="mt-1.5 space-y-1 pl-4 text-neutral-400">
              {human.map((c) => (
                <li key={c.id}>“{plainAction(c.action)}”: {verb(c)}.</li>
              ))}
            </ul>
          </li>
          <li>Everything, including your decisions, is on record below.</li>
        </ul>
      ) : (
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-neutral-300">
          <li>For the first days, the same routine fixes needed a person every time.</li>
          <li>{trusted ? `You trusted ${trusted} of them, so from then on they ran on their own.` : "You didn't grant trust, so they kept needing a person every day."}</li>
          <li>The database restart still came to a person, because some rules never loosen.</li>
        </ul>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-4 text-sm">
        {kind === "incident" ? (
          <button onClick={onRunWeek} className="rounded-full bg-white px-4 py-2 font-medium text-neutral-900 hover:bg-neutral-200">
            Next: see how trust builds over a week
          </button>
        ) : (
          <button onClick={onRunIncident} className="rounded-full bg-white px-4 py-2 font-medium text-neutral-900 hover:bg-neutral-200">
            Try the outage demo
          </button>
        )}
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="text-neutral-300 underline-offset-4 hover:text-white hover:underline">
          How it&apos;s built (GitHub) →
        </a>
      </div>
    </div>
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
            <motion.li key={sg.key} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 40 }} className="glass rounded-2xl border border-sky-400/25 p-5">
              <p className="text-sm text-neutral-300">
                You approved <span className="font-medium text-white">“{plainPattern(sg.pattern)}”</span> {sg.approvals} times in a row, without changing it
                {sg.avgDecisionMs > 0 && <>, taking {(sg.avgDecisionMs / 1000).toFixed(0)}s each on average</>}.
              </p>
              <p className="mt-2 text-sm text-neutral-400">
                Trust it: let exactly this run without asking
                {Object.keys(sg.params).length > 0 && <>, only for <span className="text-neutral-200">{plainLimits(sg.params)}</span></>}.
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
                <span className="text-[13.5px] text-neutral-200">{plainPattern(g.pattern)}</span>
                {Object.keys(g.params).length > 0 && <span className="ml-2 text-xs text-neutral-500">{plainLimits(g.params)}</span>}
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
  const [progress, setProgress] = useState<{ step: number; total: number }>({ step: 0, total: 0 });

  // Once a demo starts and the console exists on the page, bring it into view.
  useEffect(() => {
    if (demo) document.getElementById("console")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [demo]);

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
    if (DEMO_ONLY) return;
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
    if (demo || DEMO_ONLY) return;
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
    setProgress({ step: 0, total: DEMO.length });
    // Copy each checkpoint so React sees a change and re-renders.
    const refresh = () => setDemoCheckpoints(store.list().map((c) => ({ ...c })));
    refresh();
    const alive = () => demoRun.current === run;

    for (const [i, step] of DEMO.entries()) {
      if (!alive()) return;
      setProgress({ step: i + 1, total: DEMO.length });
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
    setNarration({ text: `Incident handled. The agent did ${m.autoApproved} of ${m.total} steps on its own, and you made the ${m.escalated} calls that mattered. Here's a recap.` });
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
    setProgress({ step: 0, total: WEEK.length });
    const refresh = () => setDemoCheckpoints(store.list().map((c) => ({ ...c })));
    refresh();

    for (let day = 0; day < WEEK.length; day++) {
      if (!alive()) return;
      simNow += DAY_MS;
      setProgress({ step: day + 1, total: WEEK.length });
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
        ? "Week done. After you granted trust, the routine fixes ran on their own, and only the database restart needed a person. Here's a recap."
        : "Week done. Without trust, the on-call engineer was interrupted for the same fixes every day. Here's a recap.",
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
  const showConsoleSection =
    demo || checkpoints.length > 0 || trustView.suggestions.length > 0 || trustView.grants.length > 0 || (!DEMO_ONLY && (!reachable || approver === false));

  return (
    <>
      <Background />
      <main className={`mx-auto w-full max-w-5xl px-4 pt-8 sm:px-6 ${demo ? "pb-56" : "pb-16"}`}>
        {/* Header */}
        <header className="mb-12 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Logo className="h-9 w-9 rounded-[10px] shadow-lg shadow-indigo-500/25" />
            <div className="leading-tight">
              <div className="text-[19px] font-semibold tracking-[-0.02em] text-white">Aegis</div>
              <p className="text-[11px] tracking-wide text-neutral-500">Safety checkpoint for AI agents</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            {demo ? (
              <>
                <span className="rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-2.5 py-1 text-[11px] font-medium text-fuchsia-300">Demo · simulated</span>
                <button onClick={exitDemo} className="rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-xs font-medium text-neutral-200 hover:bg-white/10">Exit demo</button>
              </>
            ) : DEMO_ONLY ? null : (
              <div className="glass flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs">
                <span className={`h-2 w-2 rounded-full ${reachable ? "pulse-dot bg-emerald-400" : "bg-rose-400"}`} />
                <span className="text-neutral-300">{reachable ? (approver ? "Live · you can approve" : "Live · view only") : "Console offline"}</span>
              </div>
            )}
          </div>
        </header>

        {/* Hero */}
        <section className="mb-14 grid items-center gap-10 lg:grid-cols-[1.2fr_1fr]">
          <div>
            <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-white sm:text-5xl">
              Let AI agents act.
              <br />
              <span className="grad-text">Stay in charge of what matters.</span>
            </h1>
            <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-neutral-400">
              Aegis sits between an AI agent and the systems it touches. Safe actions run on their own. Risky ones wait for you.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-4">
              <button onClick={runDemo} className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-neutral-900 transition hover:bg-neutral-200">
                Try the demo
              </button>
              <button onClick={runWeek} className="text-sm text-neutral-300 underline-offset-4 hover:text-white hover:underline">
                See how trust builds over a week →
              </button>
            </div>
            <p className="mt-4 text-xs text-neutral-600">About a minute. Runs in your browser; nothing is stored.</p>
          </div>
          <Example />
        </section>

        <HowItWorks />

        {/* The console: only shown once there's something in it */}
        {showConsoleSection && (
        <section id="console" className="scroll-mt-6">
          <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-xs font-medium uppercase tracking-[0.18em] text-neutral-500">Your approvals</h2>
            <span className="text-xs text-neutral-500">
              {demo ? "Simulated incident. Your clicks are the human decisions." : DEMO_ONLY ? "Start a demo above to see it work." : "Connected to agents on this computer."}
            </span>
          </div>

          {!demo && !DEMO_ONLY && reachable && approver === false && (
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
          <div className="mb-10">
            <h3 className="mb-4 flex items-center gap-2 text-sm font-medium text-neutral-300">
              Waiting for you
              <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-xs tabular-nums text-amber-300">{pending.length}</span>
            </h3>
            {demo && demoDone ? (
              <DemoSummary kind={demoKind} checkpoints={checkpoints} grants={trustView.grants} onRunIncident={runDemo} onRunWeek={runWeek} />
            ) : pending.length === 0 ? (
              <div className="glass rounded-2xl p-8 text-center text-sm text-neutral-500">
                {demo ? (
                  weekPaused ? (
                    "The week is paused. Look at the suggestions below."
                  ) : (
                    "The agent is working. Anything risky will appear here."
                  )
                ) : DEMO_ONLY ? (
                  <>Nothing yet. <button onClick={runDemo} className="font-medium text-sky-300 underline-offset-2 hover:underline">Watch an agent handle an outage</button>.</>
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
          </div>

          {((demo && demoKind === "week") || (!demo && (trustView.suggestions.length > 0 || trustView.grants.length > 0))) && (
            <TrustPanel
              suggestions={trustView.suggestions}
              grants={trustView.grants}
              canDecide={canDecide}
              minApprovals={demo ? WEEK_MIN_APPROVALS : 5}
              onGrant={grantTrust}
              onRevoke={revokeTrust}
            />
          )}

          {/* Metrics */}
          {metrics && metrics.total > 0 && (
            <div className="mb-10 grid grid-cols-1 gap-4 lg:grid-cols-[auto_1fr]">
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
            </div>
          )}

          {/* Activity */}
          <div className="mb-16">
            <h3 className="mb-4 text-sm font-medium text-neutral-300">Every action, on record</h3>
            {activity.length === 0 ? (
              <p className="text-sm text-neutral-500">No actions yet.</p>
            ) : (
              <ul className="space-y-2">
                {activity.map((c) => (
                  <ActivityRow key={c.id} c={c} />
                ))}
              </ul>
            )}
          </div>
        </section>
        )}

        <footer className="border-t border-white/5 pt-6 text-center text-xs leading-relaxed text-neutral-600">
          Built by Meghna Sarda ·{" "}
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="text-neutral-400 underline-offset-4 hover:text-white hover:underline">Code on GitHub</a>
          {" "}· No cookies, analytics or tracking.
        </footer>
      </main>

      {/* Demo guide */}
      <AnimatePresence>
        {demo && narration && !demoDone && (
          <motion.div initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }} className="fixed inset-x-0 bottom-0 z-50 px-3 pb-3 sm:px-4 sm:pb-4">
            <div role="status" className="mx-auto max-w-3xl rounded-2xl border border-fuchsia-400/30 bg-[#0e0b1a]/95 p-4 shadow-2xl shadow-fuchsia-900/30 backdrop-blur">
              <div className="mb-2 flex items-center justify-between gap-3 text-[11px]">
                <span className="font-mono text-fuchsia-300">
                  relay-oncall · {demoKind === "week" ? `day ${progress.step} of ${progress.total}` : `step ${progress.step} of ${progress.total}`}
                </span>
                <button onClick={exitDemo} className="text-neutral-400 hover:text-white">Exit demo</button>
              </div>
              <div className="mb-3 h-1 overflow-hidden rounded-full bg-white/10">
                <motion.div className="h-full rounded-full bg-gradient-to-r from-indigo-400 via-sky-400 to-fuchsia-400" animate={{ width: `${progress.total ? (progress.step / progress.total) * 100 : 0}%` }} transition={{ duration: 0.5 }} />
              </div>
              <AnimatePresence mode="wait">
                <motion.p key={narration.text} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-sm leading-relaxed text-fuchsia-50">
                  {narration.text}
                  {narration.hint && <span className="ml-1.5 font-medium text-amber-200">{narration.hint}</span>}
                </motion.p>
              </AnimatePresence>
              {weekPaused && (
                <button onClick={() => continueWeek.current?.()} className="mt-3 rounded-full border border-fuchsia-300/40 bg-fuchsia-400/15 px-3.5 py-1.5 text-xs font-medium text-fuchsia-100 hover:bg-fuchsia-400/25">
                  Continue the week →
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
