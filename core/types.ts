// The shapes Aegis works with. Nothing here depends on the website, so the
// same engine can run inside the console, a script, or the MCP connector.

// Loosely typed on purpose: every agent sends different params, so rules
// check the types they rely on (see policies/relay.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Params = Record<string, any>;

// What an agent wants to do, described as facts rather than opinions.
// Everything except `reason` is exactly what will run, so the agent can't
// misdescribe it without changing the action itself.
export interface Action {
  agent: string;
  tool: string;
  target?: string;
  environment?: string;
  params?: Params;
  // Shown to the human reviewer. Never used to decide anything.
  reason?: string;
}

// Two outcomes on purpose: a human always gets the final say on anything
// that isn't clearly safe. See docs/DECISIONS.md.
export type Decision = "allow" | "escalate";

// A match value is one pattern or a list of patterns (any of them).
// Patterns support `*` as a wildcard, e.g. "postgres-*".
export type Pattern = string | string[];

export interface Match {
  agent?: Pattern;
  tool?: Pattern;
  target?: Pattern;
  environment?: Pattern;
}

export interface Rule {
  name: string;
  match?: Match;
  // Optional check on the action's params, e.g. (p) => p.replicas <= 5.
  when?: (params: Params) => boolean;
  decision: Decision;
  // Cases this rule does NOT cover. Earned trust adds these (see trust.ts).
  except?: { match?: Match; when?: (params: Params) => boolean }[];
  // A hard line: Aegis will never suggest loosening this rule.
  neverAutoTrust?: boolean;
}

export interface Policy {
  rules: Rule[];
}

export interface Verdict {
  decision: Decision;
  // Names of every rule that matched, so the human can see why.
  matchedRules: string[];
  explanation: string;
  // The rules that sent it to a human (empty when no rule covered it).
  escalatedBy?: string[];
  // Any of those that are hard lines, so earned trust never applies.
  lockedBy?: string[];
}
