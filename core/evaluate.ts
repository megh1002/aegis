// The heart of Aegis: given an action and a policy, decide allow or escalate.
//
// Two rules decided by Meghna (see docs/DECISIONS.md):
//   1. Strictest wins. If any matching rule says escalate, it escalates,
//      no matter what order the rules are in.
//   2. No matching rule means escalate. Unknown actions go to a human.
// Plus one safety net: if a rule's `when` check crashes, a human decides.

import { matchesPattern } from "./match";
import type { Action, Policy, Rule, Verdict } from "./types";

type RuleResult = "match" | "no-match" | "error";

function checkRule(rule: Rule, action: Action): RuleResult {
  const m = rule.match ?? {};
  if (m.agent && !matchesPattern(m.agent, action.agent)) return "no-match";
  if (m.tool && !matchesPattern(m.tool, action.tool)) return "no-match";
  if (m.target && !matchesPattern(m.target, action.target)) return "no-match";
  if (m.environment && !matchesPattern(m.environment, action.environment)) return "no-match";
  if (rule.when) {
    try {
      if (rule.when(action.params ?? {}) !== true) return "no-match";
    } catch {
      return "error";
    }
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
    };
  }

  if (matched.length === 0) {
    return {
      decision: "escalate",
      matchedRules: [],
      explanation: "No rule covers this action, so a human decides.",
    };
  }

  const escalating = matched.filter((r) => r.decision === "escalate");
  if (escalating.length > 0) {
    return {
      decision: "escalate",
      matchedRules: matched.map((r) => r.name),
      explanation: `Needs a human: ${quote(escalating)}.`,
    };
  }

  return {
    decision: "allow",
    matchedRules: matched.map((r) => r.name),
    explanation: `Allowed by ${quote(matched)}.`,
  };
}
