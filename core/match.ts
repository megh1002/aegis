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
