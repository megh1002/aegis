import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate";
import relay from "../policies/relay";
import { definePolicy, loadPolicy } from "./policy";
import type { Action, Policy } from "./types";

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

describe("Policy validation: mistakes fail loudly", () => {
  // The "ts-expect-error" lines prove TypeScript catches these while you type.
  // The runtime checks catch them anyway, e.g. in a plain JavaScript policy.

  it("rejects a misspelled field instead of ignoring it", () => {
    // Ignoring "enviroment" would turn "allow in staging" into "allow everywhere".
    expect(() =>
      definePolicy({
        // @ts-expect-error misspelled on purpose
        rules: [{ name: "Staging is free", match: { enviroment: "staging" }, decision: "allow" }],
      }),
    ).toThrow(/invalid/i);
  });

  it("rejects a rule that matches everything", () => {
    expect(() => definePolicy({ rules: [{ name: "Allow all", decision: "allow" }] })).toThrow(
      /matches everything/,
    );
  });

  it("rejects a decision other than allow or escalate", () => {
    expect(() =>
      definePolicy({
        // @ts-expect-error "deny" is not an outcome (decision 004)
        rules: [{ name: "Block deletes", match: { tool: "drop_table" }, decision: "deny" }],
      }),
    ).toThrow(/invalid/i);
  });

  it("rejects a `when` that isn't a function", () => {
    expect(() =>
      definePolicy({
        // @ts-expect-error a string condition was the old YAML style
        rules: [{ name: "Old style", match: { tool: "scale_service" }, when: "params.replicas <= 5", decision: "allow" }],
      }),
    ).toThrow(/function/);
  });

  it("loads a policy file from a path", async () => {
    const loaded = await loadPolicy(join(import.meta.dirname, "../policies/relay.ts"));
    expect(loaded.rules.length).toBe(relay.rules.length);
  });
});

describe("Code-specific risks", () => {
  it("does not let JavaScript treat '5' or null as the number 5", () => {
    const scale = (replicas: unknown) =>
      decide({ tool: "scale_service", target: "api-server", environment: "production", params: { replicas } });
    expect(scale("5").decision).toBe("escalate");
    expect(scale(null).decision).toBe("escalate");
  });

  it("escalates when a rule's check crashes, even if another rule allows", () => {
    const fragile: Policy = definePolicy({
      rules: [
        { name: "Reads are fine", match: { tool: "read_logs" }, decision: "allow" },
        {
          name: "Buggy rule",
          match: { tool: "read_logs" },
          when: (p) => p.options.verbose === true, // crashes: p.options is undefined
          decision: "allow",
        },
      ],
    });
    const v = evaluate({ agent: "a", tool: "read_logs" }, fragile);
    expect(v.decision).toBe("escalate");
    expect(v.explanation).toMatch(/crashed/);
  });
});
