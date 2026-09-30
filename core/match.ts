// Small, predictable matching helpers. Deliberately no `eval`: the policy
// file is config, and config must never be able to run arbitrary code.

import type { Pattern } from "./types";

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

// Does `value` match the pattern (or any pattern in the list)?
// A missing value never matches: unknowns fall through to the default.
export function matchesPattern(pattern: Pattern, value: string | undefined): boolean {
  if (value === undefined) return false;
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((p) => wildcardToRegex(p).test(value));
}

const CONDITION = /^\s*params\.([A-Za-z_][\w.]*)\s*(<=|>=|==|!=|<|>)\s*(.+?)\s*$/;

export interface Condition {
  path: string[];
  op: "<" | "<=" | ">" | ">=" | "==" | "!=";
  value: number | string | boolean;
}

// Parse "params.replicas <= 5" into parts. Throws on anything else, so a
// typo in the policy file fails loudly at load time instead of silently.
export function parseCondition(text: string): Condition {
  const m = CONDITION.exec(text);
  if (!m) {
    throw new Error(
      `Can't read condition "${text}". Expected something like "params.replicas <= 5".`,
    );
  }
  const [, path, op, raw] = m;
  return { path: path.split("."), op: op as Condition["op"], value: parseLiteral(raw) };
}

function parseLiteral(raw: string): number | string | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const quoted = /^(["'])(.*)\1$/.exec(raw);
  if (quoted) return quoted[2];
  const n = Number(raw);
  if (!Number.isNaN(n)) return n;
  return raw;
}

// Evaluate a condition against params. If the param is missing or the types
// don't line up (e.g. "5" vs 5), the condition is false: when in doubt, the
// rule doesn't apply and the action falls back to asking a human.
export function checkCondition(cond: Condition, params: Record<string, unknown> | undefined) {
  let current: unknown = params;
  for (const key of cond.path) {
    if (current === null || typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[key];
  }
  if (current === undefined || typeof current !== typeof cond.value) return false;

  switch (cond.op) {
    case "==": return current === cond.value;
    case "!=": return current !== cond.value;
  }
  if (typeof current !== "number" || typeof cond.value !== "number") return false;
  switch (cond.op) {
    case "<": return current < cond.value;
    case "<=": return current <= cond.value;
    case ">": return current > cond.value;
    case ">=": return current >= cond.value;
  }
}
