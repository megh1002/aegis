// Plain-English descriptions of actions, for people who don't read tool
// names. The console shows these first and the exact technical action
// underneath, so both kinds of reader get what they need.
//
// The names below are Relay's (the demo customer). Anything unknown falls
// back to a readable version of the raw name.

import type { ParamLimit, TrustPattern } from "../../core/trust";
import type { Action, Params } from "../../core/types";

const SYSTEMS: Record<string, string> = {
  "api-server": "the API server",
  "worker-queue": "the job queue",
  "web-frontend": "the website",
  "postgres-primary": "the main database",
  "postgres-replica": "the backup database",
  "redis-cache": "the cache",
};

const PARAMS: Record<string, string> = {
  replicas: "copies",
  instances: "instances",
};

const humanize = (name: string) => name.replace(/[_-]+/g, " ").trim();
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const plainSystem = (target?: string) => (target ? (SYSTEMS[target] ?? humanize(target)) : "");

export function plainEnv(env?: string) {
  if (env === "production") return "live system";
  if (env === "staging") return "test system";
  return env ?? "";
}

export const plainParam = (key: string) => PARAMS[key] ?? humanize(key);

export function plainAction(a: Pick<Action, "tool" | "target"> & { params?: Params }): string {
  const system = plainSystem(a.target);
  const p = a.params ?? {};
  switch (a.tool) {
    case "list_services":
      return "Check which systems are unhealthy";
    case "read_logs":
      return `Read the logs of ${system}`;
    case "get_metrics":
      return `Check how ${system} is doing`;
    case "describe_service":
      return `Look up ${system}`;
    case "restart_service":
      return p.instances === "all" ? `Restart all of ${system}` : `Restart one copy of ${system}`;
    case "scale_service":
      return typeof p.replicas === "number" ? `Run ${p.replicas} copies of ${system}` : `Change how many copies of ${system} run`;
    case "rollback_deploy":
      return `Undo the latest update to ${system}`;
    case "drop_table":
      return `Permanently delete the "${a.target}" table`;
    default:
      return capitalize(`${humanize(a.tool)}${system ? ` on ${system}` : ""}`);
  }
}

// "Undo the latest update to the job queue, on the live system"
export function plainPattern(p: TrustPattern): string {
  const env = plainEnv(p.environment);
  return `${plainAction({ tool: p.tool, target: p.target })}${env ? ` (${env})` : ""}`;
}

// "up to 8 copies"
export function plainLimits(params: Record<string, ParamLimit>): string {
  return Object.entries(params)
    .map(([k, l]) => ("max" in l ? `up to ${l.max} ${plainParam(k)}` : `${plainParam(k)}: ${l.oneOf.map((v) => JSON.stringify(v)).join(" or ")}`))
    .join(", ");
}

// The exact technical action, shown in small print under the plain version.
export function technical(a: Pick<Action, "tool" | "target" | "environment">): string {
  return `${a.tool}${a.target ? ` → ${a.target}` : ""}${a.environment ? ` · ${a.environment}` : ""}`;
}
