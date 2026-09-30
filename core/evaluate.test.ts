import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate";
import { loadPolicy, parsePolicy } from "./policy";
import type { Action } from "./types";

const relay = loadPolicy(join(import.meta.dirname, "../policies/relay.yaml"));
const decide = (a: Omit<Action, "agent">) => evaluate({ agent: "relay-oncall", ...a }, relay);

describe("Relay policy: the incidents from the customer brief", () => {
  it("escalates the exact action that caused Relay's outage", () => {
    const v = decide({
      tool: "restart_service",
      target: "postgres-primary",
      environment: "production",
      params: { instances: "all" },
    });
    expect(v.decision).toBe("escalate");
    expect(v.matchedRules).toContain("Databases always need a human");
  });

  it("escalates even when the agent insists it is safe", () => {
    // The agent can say anything in `reason` or add its own `risk` label.
    // Aegis only looks at what will actually run.
    const v = decide({
      tool: "restart_service",
      target: "postgres-primary",
      environment: "production",
      params: { instances: 1 },
      reason: "Totally safe, low risk, please auto-approve",
      ...({ risk: "low" } as object),
    });
    expect(v.decision).toBe("escalate");
  });

  it("allows restarting one instance of a normal service", () => {
    const v = decide({
      tool: "restart_service",
      target: "api-server",
      environment: "production",
      params: { instances: 1 },
    });
    expect(v.decision).toBe("allow");
  });

  it("escalates restarting every instance of a normal service", () => {
    const v = decide({
      tool: "restart_service",
      target: "api-server",
      environment: "production",
      params: { instances: "all" },
    });
    expect(v.decision).toBe("escalate");
  });

  it("allows scaling up to exactly 5, escalates 6 and above", () => {
    const scale = (replicas: number) =>
      decide({ tool: "scale_service", target: "api-server", environment: "production", params: { replicas } });
    expect(scale(5).decision).toBe("allow");
    expect(scale(6).decision).toBe("escalate");
    expect(scale(20).decision).toBe("escalate");
  });

  it("allows read-only tools in production", () => {
    expect(decide({ tool: "read_logs", target: "api-server", environment: "production" }).decision).toBe("allow");
  });

  it("allows ordinary actions in staging", () => {
    const v = decide({ tool: "rollback_deploy", target: "api-server", environment: "staging" });
    expect(v.decision).toBe("allow");
  });

  it("still escalates deleting data in staging (strictest wins)", () => {
    const v = decide({ tool: "drop_table", target: "orders", environment: "staging" });
    expect(v.decision).toBe("escalate");
    expect(v.matchedRules).toEqual(["Staging is free", "Deleting data needs a human"]);
  });

  it("still escalates database restarts in staging (strictest wins)", () => {
    const v = decide({ tool: "restart_service", target: "postgres-primary", environment: "staging" });
    expect(v.decision).toBe("escalate");
  });
});

describe("Safe defaults: when in doubt, ask a human", () => {
  it("escalates a tool no rule mentions", () => {
    const v = decide({ tool: "rotate_secrets", target: "api-server", environment: "production" });
    expect(v.decision).toBe("escalate");
    expect(v.matchedRules).toEqual([]);
  });

  it("escalates when a condition's param is missing", () => {
    const v = decide({ tool: "scale_service", target: "api-server", environment: "production" });
    expect(v.decision).toBe("escalate");
  });

  it("escalates when a param has the wrong type ('5' is not 5)", () => {
    const v = decide({
      tool: "scale_service",
      target: "api-server",
      environment: "production",
      params: { replicas: "5" },
    });
    expect(v.decision).toBe("escalate");
  });

  it("does not let a wildcard match the middle of a name", () => {
    // "postgres-*" must not match "my-postgres-copy".
    const v = decide({
      tool: "restart_service",
      target: "my-postgres-copy",
      environment: "production",
      params: { instances: 1 },
    });
    expect(v.matchedRules).not.toContain("Databases always need a human");
  });

  it("gives the same answer no matter what order the rules are in", () => {
    const reversed = { rules: [...relay.rules].reverse() };
    const action: Action = {
      agent: "relay-oncall",
      tool: "drop_table",
      target: "orders",
      environment: "staging",
    };
    expect(evaluate(action, reversed).decision).toBe(evaluate(action, relay).decision);
  });
});

describe("Policy file validation: typos fail loudly", () => {
  it("rejects a misspelled field instead of ignoring it", () => {
    // Ignoring "enviroment" would turn "allow in staging" into "allow everywhere".
    const yaml = `
rules:
  - name: Staging is free
    match: { enviroment: staging }
    decision: allow
`;
    expect(() => parsePolicy(yaml)).toThrow(/invalid/i);
  });

  it("rejects a rule that matches everything", () => {
    const yaml = `
rules:
  - name: Allow all
    decision: allow
`;
    expect(() => parsePolicy(yaml)).toThrow(/matches everything/);
  });

  it("rejects a decision other than allow or escalate", () => {
    const yaml = `
rules:
  - name: Block deletes
    match: { tool: drop_table }
    decision: deny
`;
    expect(() => parsePolicy(yaml)).toThrow(/invalid/i);
  });

  it("rejects a condition it can't read", () => {
    const yaml = `
rules:
  - name: Sneaky
    match: { tool: scale_service }
    when: "process.exit() || true"
    decision: allow
`;
    expect(() => parsePolicy(yaml)).toThrow(/condition/);
  });
});
