"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";

type Risk = "low" | "medium" | "high";
type Status = "pending" | "approved" | "rejected";

interface Checkpoint {
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

interface Metrics {
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

/* ---------- helpers ---------- */

const pct = (n: number) => `${Math.round(n * 100)}%`;

function computeMetrics(all: Checkpoint[]): Metrics {
  const total = all.length;
  const autoApproved = all.filter((c) => c.decidedBy === "auto-policy").length;
  const escalated = total - autoApproved;
  const rejected = all.filter((c) => c.status === "rejected").length;
  const pending = all.filter((c) => c.status === "pending").length;
  const humanDecided = all.filter((c) => c.decidedBy && c.decidedBy !== "auto-policy");
  const vetoRate = humanDecided.length
    ? humanDecided.filter((c) => c.status === "rejected").length / humanDecided.length
    : 0;
  const times = humanDecided.filter((c) => c.decidedAt).map((c) => c.decidedAt! - c.createdAt);
  const avgTimeToDecideMs = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;

  const ordered = [...all].sort((a, b) => a.createdAt - b.createdAt);
  const trend: { label: string; interventionRate: number }[] = [];
  const buckets = 6;
  if (total) {
    const size = Math.ceil(total / buckets);
    for (let i = 0; i < ordered.length; i += size) {
      const slice = ordered.slice(i, i + size);
      const esc = slice.filter((c) => c.decidedBy !== "auto-policy").length;
      trend.push({ label: `${i + 1}`, interventionRate: esc / slice.length });
    }
  }
  return {
    total,
    autoApproved,
    escalated,
    approved: all.filter((c) => c.status === "approved").length,
    rejected,
    pending,
    interventionRate: total ? escalated / total : 0,
    autoApproveRate: total ? autoApproved / total : 0,
    vetoRate,
    avgTimeToDecideMs,
    trend,
  };
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
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(from + (target - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else prev.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

const riskGlow: Record<Risk, string> = {
  low: "shadow-[0_0_0_1px_rgba(16,185,129,0.35),0_0_28px_-6px_rgba(16,185,129,0.5)]",
  medium: "shadow-[0_0_0_1px_rgba(245,158,11,0.4),0_0_28px_-6px_rgba(245,158,11,0.55)]",
  high: "shadow-[0_0_0_1px_rgba(244,63,94,0.45),0_0_32px_-4px_rgba(244,63,94,0.6)]",
};
const riskBadge: Record<Risk, string> = {
  low: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
  medium: "bg-amber-400/10 text-amber-300 border-amber-400/30",
  high: "bg-rose-400/10 text-rose-300 border-rose-400/30",
};
const statusBadge: Record<Status, string> = {
  pending: "bg-amber-400/10 text-amber-300 border-amber-400/30",
  approved: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
  rejected: "bg-rose-400/10 text-rose-300 border-rose-400/30",
};

/* ---------- demo simulation ---------- */

const DEMO_SCRIPT: {
  delay: number;
  action: string;
  reasoning: string;
  risk: Risk;
  escalate: boolean;
  policyReason: string;
}[] = [
  { delay: 400, action: "Tag ticket #1201 as 'billing'", reasoning: "Keyword match on invoice.", risk: "low", escalate: false, policyReason: "Low-risk — within auto-approve policy." },
  { delay: 1000, action: "Send order-status update to customer", reasoning: "Read-only information.", risk: "low", escalate: false, policyReason: "Low-risk — within auto-approve policy." },
  { delay: 1700, action: "Update customer's shipping address", reasoning: "Customer-confirmed change.", risk: "medium", escalate: false, policyReason: "Medium risk, nothing sensitive detected." },
  { delay: 2400, action: "Issue a $500 refund to customer #4821", reasoning: "Item never arrived; tracking inconclusive.", risk: "high", escalate: true, policyReason: "High-risk actions always need a human." },
  { delay: 3100, action: "Delete 1,204 stale user records from production", reasoning: "Cleanup job flagged them inactive >2y.", risk: "high", escalate: true, policyReason: "High-risk actions always need a human." },
  { delay: 3800, action: "Close resolved ticket #1188", reasoning: "Customer confirmed resolution.", risk: "low", escalate: false, policyReason: "Low-risk — within auto-approve policy." },
];

function mkCheckpoint(item: (typeof DEMO_SCRIPT)[number]): Checkpoint {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    agent: "support-bot (demo)",
    action: item.action,
    reasoning: item.reasoning,
    risk: item.risk,
    status: item.escalate ? "pending" : "approved",
    policyReason: item.policyReason,
    createdAt: now,
    decidedAt: item.escalate ? undefined : now,
    decidedBy: item.escalate ? undefined : "auto-policy",
  };
}

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
    <svg viewBox="0 0 24 24" fill="none" className={className}>
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
    <div className="relative grid h-[150px] w-[150px] place-items-center">
      <svg viewBox="0 0 130 130" className="h-[150px] w-[150px] -rotate-90">
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
        <span className="text-3xl font-semibold text-white tabular-nums">{Math.round(animated * 100)}%</span>
        <span className="text-[11px] uppercase tracking-wider text-neutral-400">autonomous</span>
      </div>
    </div>
  );
}

function Stat({ label, value, hint, accent }: { label: string; value: string; hint: string; accent: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="glass glass-hover rounded-2xl p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">{label}</div>
      <div className={`mt-1.5 text-3xl font-semibold tabular-nums ${accent}`}>{value}</div>
      <div className="mt-1 text-xs text-neutral-500">{hint}</div>
    </motion.div>
  );
}

function TrendChart({ trend }: { trend: Metrics["trend"] }) {
  if (trend.length < 2) {
    return <div className="text-xs text-neutral-500">Run more actions to reveal the trend.</div>;
  }
  return (
    <div className="flex h-28 items-end gap-2">
      {trend.map((t, i) => (
        <div key={i} className="group flex h-full flex-1 flex-col justify-end gap-1.5">
          <motion.div initial={{ height: 0 }} animate={{ height: `${Math.max(4, t.interventionRate * 100)}%` }} transition={{ duration: 0.7, delay: i * 0.05, ease: "easeOut" }} className="w-full rounded-t-md bg-gradient-to-t from-rose-500/50 to-rose-400 shadow-[0_0_18px_-4px_rgba(244,63,94,0.7)]" />
          <span className="h-3 text-center text-[10px] tabular-nums text-neutral-500 opacity-0 transition group-hover:opacity-100">{pct(t.interventionRate)}</span>
        </div>
      ))}
    </div>
  );
}

function HowItWorks() {
  const steps = [
    { n: "1", t: "Agent acts", d: "Your AI agent is about to do something — send, delete, pay, deploy." },
    { n: "2", t: "Aegis checks policy", d: "Safe, routine actions run instantly. Only risky ones are held." },
    { n: "3", t: "You decide", d: "A held action waits here for a human to approve or reject." },
  ];
  return (
    <div className="mb-10 grid gap-3 sm:grid-cols-3">
      {steps.map((s) => (
        <div key={s.n} className="glass rounded-2xl p-4">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-full border border-white/15 bg-white/5 text-xs font-semibold text-neutral-200">{s.n}</span>
            <span className="text-sm font-medium text-white">{s.t}</span>
          </div>
          <p className="text-xs leading-relaxed text-neutral-400">{s.d}</p>
        </div>
      ))}
    </div>
  );
}

/* ---------- page ---------- */

export default function Console() {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [demo, setDemo] = useState(false);
  const [demoCheckpoints, setDemoCheckpoints] = useState<Checkpoint[]>([]);
  const demoTimers = useRef<number[]>([]);

  const load = useCallback(async () => {
    const [c, m] = await Promise.all([
      fetch("/api/checkpoints", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/metrics", { cache: "no-store" }).then((r) => r.json()),
    ]);
    setCheckpoints(c.checkpoints);
    setMetrics(m.metrics);
  }, []);

  useEffect(() => {
    if (demo) return; // pause live polling while the demo drives the view
    load();
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [load, demo]);

  useEffect(() => () => demoTimers.current.forEach(clearTimeout), []);

  function runDemo() {
    demoTimers.current.forEach(clearTimeout);
    demoTimers.current = [];
    setDemoCheckpoints([]);
    setDemo(true);
    DEMO_SCRIPT.forEach((item) => {
      const id = window.setTimeout(() => {
        setDemoCheckpoints((prev) => [mkCheckpoint(item), ...prev]);
      }, item.delay);
      demoTimers.current.push(id);
    });
  }

  function exitDemo() {
    demoTimers.current.forEach(clearTimeout);
    demoTimers.current = [];
    setDemo(false);
    setDemoCheckpoints([]);
  }

  async function decide(id: string, decision: "approved" | "rejected") {
    if (demo) {
      setDemoCheckpoints((prev) =>
        prev.map((c) =>
          c.id === id ? { ...c, status: decision, decidedAt: Date.now(), decidedBy: "you" } : c,
        ),
      );
      return;
    }
    setBusy(id);
    await fetch(`/api/checkpoints/${id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    await load();
    setBusy(null);
  }

  const active = demo ? demoCheckpoints : checkpoints;
  const activeMetrics = demo ? computeMetrics(demoCheckpoints) : metrics;
  const pending = active.filter((c) => c.status === "pending");
  const history = active.filter((c) => c.status !== "pending");

  return (
    <>
      <Background />
      <main className="mx-auto w-full max-w-5xl px-6 py-12">
        {/* Header */}
        <motion.header initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }} className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Shield className="h-9 w-9" />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                <span className="grad-text">Aegis</span>
              </h1>
              <p className="text-xs text-neutral-400">Mission Control for AI Agents</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            {demo ? (
              <>
                <span className="rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-2.5 py-1 text-[11px] font-medium text-fuchsia-300">DEMO MODE</span>
                <button onClick={exitDemo} className="rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-xs font-medium text-neutral-200 hover:bg-white/10">Exit demo</button>
              </>
            ) : (
              <>
                <div className="glass flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs">
                  <span className="pulse-dot h-2 w-2 rounded-full bg-emerald-400" />
                  <span className="text-neutral-300">Monitoring · <span className="tabular-nums">{metrics?.total ?? 0}</span></span>
                </div>
                <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }} onClick={runDemo} className="rounded-full bg-gradient-to-r from-indigo-500 via-sky-500 to-fuchsia-500 px-4 py-1.5 text-xs font-semibold text-white shadow-lg shadow-indigo-500/25">▶ Run live demo</motion.button>
              </>
            )}
          </div>
        </motion.header>

        {/* Hero */}
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15, duration: 0.6 }} className="mb-8 max-w-2xl text-sm leading-relaxed text-neutral-400">
          Aegis lets AI agents run autonomously — but pauses them before risky actions so a human can
          approve or reject. The goal is to keep intervention{" "}
          <span className="font-medium text-neutral-200">low and falling</span>. Full autonomy, without capsizing.
        </motion.p>

        <HowItWorks />

        {/* Demo banner */}
        <AnimatePresence>
          {demo && (
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mb-6 rounded-2xl border border-fuchsia-400/25 bg-fuchsia-400/[0.06] px-4 py-3 text-sm text-fuchsia-100">
              A simulated agent is working. Watch safe actions auto-approve — then{" "}
              <span className="font-semibold">approve or reject</span> the risky ones below and see the metrics move.
            </motion.div>
          )}
        </AnimatePresence>

        {/* Metrics */}
        {activeMetrics && (
          <section className="mb-12 grid grid-cols-1 gap-4 lg:grid-cols-[auto_1fr]">
            <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.6 }} className="glass flex items-center gap-5 rounded-2xl p-5">
              <TrustRing rate={activeMetrics.autoApproveRate} />
              <div className="pr-2">
                <div className="text-sm font-medium text-white">Ran without a human</div>
                <div className="mt-1 text-xs text-neutral-400">{activeMetrics.autoApproved} of {activeMetrics.total} actions auto-approved by policy.</div>
                <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] text-emerald-300">intervention {pct(activeMetrics.interventionRate)}</div>
              </div>
            </motion.div>

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat label="Escalated" value={String(activeMetrics.escalated)} hint="pulled in a human" accent="text-amber-300" />
              <Stat label="Human veto rate" value={pct(activeMetrics.vetoRate)} hint={`${activeMetrics.rejected} rejected`} accent="text-rose-300" />
              <Stat label="Avg decision" value={activeMetrics.avgTimeToDecideMs ? `${(activeMetrics.avgTimeToDecideMs / 1000).toFixed(1)}s` : "—"} hint="time to decide" accent="text-sky-300" />
              <div className="glass col-span-2 rounded-2xl p-4 sm:col-span-3">
                <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Intervention over time · lower = agent earning trust</div>
                <TrendChart trend={activeMetrics.trend} />
              </div>
            </div>
          </section>
        )}

        {/* Pending */}
        <section className="mb-12">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-medium text-neutral-300">
            Awaiting your decision
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-300 tabular-nums">{pending.length}</span>
          </h2>

          {pending.length === 0 ? (
            <div className="glass rounded-2xl border-dashed p-10 text-center text-sm text-neutral-500">
              {demo ? (
                "Simulated agent is starting… risky actions will appear here in a moment."
              ) : (
                <>
                  All clear — agents are running on their own.{" "}
                  <button onClick={runDemo} className="font-medium text-sky-300 underline-offset-2 hover:underline">Run the live demo</button>{" "}
                  to see the loop in action.
                </>
              )}
            </div>
          ) : (
            <ul className="space-y-3">
              <AnimatePresence mode="popLayout">
                {pending.map((c) => (
                  <motion.li key={c.id} layout initial={{ opacity: 0, y: 20, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.96, x: 40 }} transition={{ type: "spring", stiffness: 380, damping: 30 }} className={`glass rounded-2xl p-5 ${riskGlow[c.risk]}`}>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-mono text-xs text-neutral-400">{c.agent}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${riskBadge[c.risk]}`}>{c.risk} risk</span>
                    </div>
                    <p className="text-[15px] font-medium text-white">{c.action}</p>
                    <p className="mt-1 text-sm text-neutral-400">{c.reasoning}</p>
                    <p className="mt-2.5 flex items-center gap-1.5 text-xs text-neutral-500"><span className="text-neutral-600">⚑</span> {c.policyReason}</p>
                    <div className="mt-4 flex gap-2.5">
                      <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} disabled={busy === c.id} onClick={() => decide(c.id, "approved")} className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-emerald-500/20 disabled:opacity-50">Approve</motion.button>
                      <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} disabled={busy === c.id} onClick={() => decide(c.id, "rejected")} className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-neutral-200 hover:bg-white/10 disabled:opacity-50">Reject</motion.button>
                    </div>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </section>

        {/* History */}
        <section>
          <h2 className="mb-4 text-sm font-medium text-neutral-300">History</h2>
          {history.length === 0 ? (
            <p className="text-sm text-neutral-500">Nothing decided yet.</p>
          ) : (
            <ul className="space-y-2">
              {history.map((c, i) => (
                <motion.li key={c.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i * 0.03, 0.3) }} className="glass flex items-center justify-between rounded-xl px-4 py-2.5 text-sm">
                  <div className="min-w-0 truncate">
                    <span className="text-neutral-200">{c.action}</span>
                    <span className="ml-2 font-mono text-xs text-neutral-500">{c.agent} · {c.decidedBy}</span>
                  </div>
                  <span className={`ml-3 shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusBadge[c.status]}`}>{c.status}</span>
                </motion.li>
              ))}
            </ul>
          )}
        </section>

        <footer className="mt-16 border-t border-white/5 pt-6 text-center text-xs text-neutral-600">
          Aegis · human oversight for autonomous agents
        </footer>
      </main>
    </>
  );
}
