// Earned trust: the feature that makes Aegis ask less over time.
//
// When humans keep approving the same kind of action, unchanged, Aegis
// suggests trusting it. A human accepts the suggestion (that acceptance is
// itself a recorded decision), and from then on that exact kind of action
// runs on its own.
//
// Designed to be narrow and easy to lose:
// - A "kind of action" is the same agent, tool, target and environment.
// - Parameters are capped at what humans actually approved: if they approved
//   scaling to 6 and 8, trust covers up to 8, not 50.
// - One rejection, edit or failed run resets the streak.
// - Rules marked `neverAutoTrust` (e.g. database changes) are never suggested.
// - A grant can be revoked at any time.
//
// With strictest-wins, adding an allow rule can't override an escalate rule,
// so a grant does two things: it adds an allow rule for the pattern, and it
// carves the same pattern out of each rule that was holding it.

import type { Checkpoint } from "./checkpoints";
import { IDENTITY_KEYS } from "./keys";
import type { Action, Params, Policy, Rule } from "./types";

export const DEFAULT_MIN_APPROVALS = 5;

export interface TrustPattern {
  agent: string;
  tool: string;
  target?: string;
  environment?: string;
}

// Limits on parameters, from what humans approved.
export type ParamLimit = { max: number } | { oneOf: unknown[] };

export interface TrustSuggestion {
  key: string;
  pattern: TrustPattern;
  params: Record<string, ParamLimit>;
  // The rules this would carve an exception from (empty: nothing covered it).
  exceptFrom: string[];
  approvals: number;
  avgDecisionMs: number;
  lastApprovedAt: number;
}

export interface TrustGrant extends TrustSuggestion {
  id: string;
  grantedAt: number;
  revokedAt?: number;
}

export function patternKey(p: TrustPattern): string {
  return JSON.stringify([p.agent, p.tool, p.target ?? null, p.environment ?? null]);
}

function patternOf(a: Action): TrustPattern {
  return { agent: a.agent, tool: a.tool, target: a.target, environment: a.environment };
}

export function describePattern(p: TrustPattern): string {
  return `${p.tool}${p.target ? ` → ${p.target}` : ""}${p.environment ? ` (${p.environment})` : ""}`;
}

export function describeLimits(params: Record<string, ParamLimit>): string {
  return Object.entries(params)
    .map(([k, l]) => ("max" in l ? `${k} ≤ ${l.max}` : `${k}: ${l.oneOf.map((v) => JSON.stringify(v)).join(" or ")}`))
    .join(", ");
}

// A clean approval: a human said yes, didn't change anything, and it worked.
function isClean(c: Checkpoint) {
  return c.status === "approved" && !c.edit && c.execution?.ok !== false;
}

function limitsFrom(approved: Checkpoint[]): Record<string, ParamLimit> {
  const limits: Record<string, ParamLimit> = {};
  const keys = new Set(approved.flatMap((c) => Object.keys(c.action.params ?? {})));
  for (const key of keys) {
    if (IDENTITY_KEYS.has(key)) continue; // already pinned by the pattern
    const values = approved.map((c) => c.action.params?.[key]);
    if (values.every((v) => typeof v === "number")) {
      limits[key] = { max: Math.max(...(values as number[])) };
    } else {
      const seen: unknown[] = [];
      for (const v of values) if (!seen.some((s) => JSON.stringify(s) === JSON.stringify(v))) seen.push(v);
      limits[key] = { oneOf: seen };
    }
  }
  return limits;
}

export function suggestTrust(
  checkpoints: Checkpoint[],
  grants: TrustGrant[],
  { minApprovals = DEFAULT_MIN_APPROVALS } = {},
): TrustSuggestion[] {
  const active = new Set(grants.filter((g) => !g.revokedAt).map((g) => g.key));

  // Only decisions a human made about actions the policy held.
  const byPattern = new Map<string, Checkpoint[]>();
  for (const c of checkpoints) {
    if (c.decidedBy !== "human" || c.duplicateOf) continue;
    const key = patternKey(patternOf(c.action));
    byPattern.set(key, [...(byPattern.get(key) ?? []), c]);
  }

  const suggestions: TrustSuggestion[] = [];
  for (const [key, list] of byPattern) {
    if (active.has(key)) continue;
    const newestFirst = [...list].sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
    if (newestFirst.some((c) => (c.verdict.lockedBy ?? []).length > 0)) continue;

    // Trust is earned slowly and lost quickly: count only the unbroken
    // run of clean approvals since the last rejection, edit or failure.
    const streak: Checkpoint[] = [];
    for (const c of newestFirst) {
      if (!isClean(c)) break;
      streak.push(c);
    }
    if (streak.length < minApprovals) continue;

    const latest = streak[0];
    suggestions.push({
      key,
      pattern: patternOf(latest.action),
      params: limitsFrom(streak),
      exceptFrom: [...new Set(streak.flatMap((c) => c.verdict.escalatedBy ?? []))],
      approvals: streak.length,
      avgDecisionMs: streak.reduce((sum, c) => sum + ((c.decidedAt ?? 0) - c.createdAt), 0) / streak.length,
      lastApprovedAt: latest.decidedAt ?? latest.createdAt,
    });
  }
  return suggestions.sort((a, b) => b.approvals - a.approvals);
}

function withinLimits(limits: Record<string, ParamLimit>) {
  return (p: Params) =>
    Object.entries(limits).every(([k, l]) =>
      "max" in l
        ? typeof p[k] === "number" && p[k] <= l.max
        : l.oneOf.some((v) => JSON.stringify(v) === JSON.stringify(p[k])),
    );
}

// The policy plus every active grant. The original policy is untouched.
export function applyTrust(policy: Policy, grants: TrustGrant[]): Policy {
  const active = grants.filter((g) => !g.revokedAt);
  if (active.length === 0) return policy;

  const rules: Rule[] = policy.rules.map((r) => ({ ...r, except: [...(r.except ?? [])] }));
  for (const g of active) {
    const match = {
      agent: g.pattern.agent,
      tool: g.pattern.tool,
      ...(g.pattern.target ? { target: g.pattern.target } : {}),
      ...(g.pattern.environment ? { environment: g.pattern.environment } : {}),
    };
    const when = withinLimits(g.params);
    for (const rule of rules) {
      // Hard lines are never carved into, even if a grant names them.
      if (g.exceptFrom.includes(rule.name) && !rule.neverAutoTrust) rule.except!.push({ match, when });
    }
    rules.push({ name: `Earned trust: ${describePattern(g.pattern)}`, match, when, decision: "allow" });
  }
  return { rules };
}
