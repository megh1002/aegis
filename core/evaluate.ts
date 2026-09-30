// The heart of Aegis: given an action and a policy, decide allow or escalate.
//
// Two rules decided by Meghna (see docs/DECISIONS.md):
//   1. Strictest wins. If any matching rule says escalate, it escalates,
//      no matter what order the rules are in.
//   2. No matching rule means escalate. Unknown actions go to a human.

import { checkCondition, matchesPattern, parseCondition } from "./match";
import type { Action, Policy, Rule, Verdict } from "./types";

function ruleMatches(rule: Rule, action: Action): boolean {
  const m = rule.match ?? {};
  if (m.agent && !matchesPattern(m.agent, action.agent)) return false;
  if (m.tool && !matchesPattern(m.tool, action.tool)) return false;
  if (m.target && !matchesPattern(m.target, action.target)) return false;
  if (m.environment && !matchesPattern(m.environment, action.environment)) return false;
  if (rule.when && !checkCondition(parseCondition(rule.when), action.params)) return false;
  return true;
}

export function evaluate(action: Action, policy: Policy): Verdict {
  const matched = policy.rules.filter((r) => ruleMatches(r, action));

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
      explanation: `Needs a human: ${escalating.map((r) => `"${r.name}"`).join(", ")}.`,
    };
  }

  return {
    decision: "allow",
    matchedRules: matched.map((r) => r.name),
    explanation: `Allowed by ${matched.map((r) => `"${r.name}"`).join(", ")}.`,
  };
}
