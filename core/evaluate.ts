// The heart of Aegis: given an action and a policy, decide allow or escalate.
//
// Two rules decided by Meghna (see docs/DECISIONS.md):
//   1. Strictest wins. If any matching rule says escalate, it escalates,
//      no matter what order the rules are in.
//   2. No matching rule means escalate. Unknown actions go to a human.
// Plus one safety net: if a rule's `when` check crashes, a human decides.

import { matchesPattern } from "./match";
import type { Action, Match, Policy, Rule, Verdict } from "./types";

type RuleResult = "match" | "no-match" | "error";

// Does this match + when pair cover the action?
function covers(m: Match, when: Rule["when"], action: Action): RuleResult {
  if (m.agent && !matchesPattern(m.agent, action.agent)) return "no-match";
  if (m.tool && !matchesPattern(m.tool, action.tool)) return "no-match";
  if (m.target && !matchesPattern(m.target, action.target)) return "no-match";
  if (m.environment && !matchesPattern(m.environment, action.environment)) return "no-match";
  if (when) {
    try {
      if (when(action.params ?? {}) !== true) return "no-match";
    } catch {
      return "error";
    }
  }
  return "match";
}

function checkRule(rule: Rule, action: Action): RuleResult {
  const result = covers(rule.match ?? {}, rule.when, action);
  if (result !== "match") return result;
  for (const ex of rule.except ?? []) {
    const r = covers(ex.match ?? {}, ex.when, action);
    // A crashing exception is treated as "not excepted": the rule still applies.
    if (r === "match") return "no-match";
  }
  return "match";
}

const quote = (rules: Rule[]) => rules.map((r) => `"${r.name}"`).join(", ");

export function evaluate(action: Action, policy: Policy): Verdict {
  const results = policy.rules.map((rule) => ({ rule, result: checkRule(rule, action) }));
  const matched = results.filter((r) => r.result === "match").map((r) => r.rule);
  const broken = results.filter((r) => r.result === "error").map((r) => r.rule);

  if (broken.length > 0) {
    return {
      decision: "escalate",
      matchedRules: matched.map((r) => r.name),
      explanation: `A rule crashed while checking this action (${quote(broken)}), so a human decides.`,
      // A broken rule is a problem to fix, not something to learn to trust.
      lockedBy: broken.map((r) => r.name),
    };
  }

  if (matched.length === 0) {
    return {
      decision: "escalate",
      matchedRules: [],
      explanation: "No rule covers this action, so a human decides.",
      escalatedBy: [],
      lockedBy: [],
    };
  }

  const escalating = matched.filter((r) => r.decision === "escalate");
  if (escalating.length > 0) {
    return {
      decision: "escalate",
      matchedRules: matched.map((r) => r.name),
      explanation: `Needs a human: ${quote(escalating)}.`,
      escalatedBy: escalating.map((r) => r.name),
      lockedBy: escalating.filter((r) => r.neverAutoTrust).map((r) => r.name),
    };
  }

  return {
    decision: "allow",
    matchedRules: matched.map((r) => r.name),
    explanation: `Allowed by ${quote(matched)}.`,
  };
}
