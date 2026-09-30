import { describe, expect, it } from "vitest";
import relay from "../policies/relay";
import { CheckpointStore } from "./checkpoints";
import { evaluate } from "./evaluate";
import { applyTrust, suggestTrust, type TrustGrant } from "./trust";
import type { Action } from "./types";

const rollback: Action = {
  agent: "relay-oncall",
  tool: "rollback_deploy",
  target: "worker-queue",
  environment: "production",
  params: { service: "worker-queue", environment: "production" },
};
const scale = (replicas: number): Action => ({
  agent: "relay-oncall",
  tool: "scale_service",
  target: "api-server",
  environment: "production",
  params: { service: "api-server", environment: "production", replicas },
});
const dbRestart: Action = {
  agent: "relay-oncall",
  tool: "restart_service",
  target: "postgres-primary",
  environment: "production",
  params: { service: "postgres-primary", environment: "production", instances: 1 },
};

// A store with a controllable clock: each incident happens 10 minutes after
// the last (so repeats aren't flagged as duplicates), and a human answers
// within seconds (so nothing expires).
function world() {
  let t = 1_000_000;
  const store = new CheckpointStore(() => (t += 1000));
  const act = (a: Action, answer: "approved" | "rejected" | { edit: Record<string, unknown> } = "approved") => {
    t += 10 * 60_000;
    const { checkpoint } = store.create({ action: a, verdict: evaluate(a, relay) });
    if (checkpoint.status !== "pending") return checkpoint;
    if (typeof answer === "string") store.decide(checkpoint.id, answer);
    else store.decide(checkpoint.id, "approved", { ...a.params, ...answer.edit });
    store.recordResult(checkpoint.id, { ok: true, summary: "done" });
    return store.get(checkpoint.id)!;
  };
  return { store, act };
}

const grant = (s: ReturnType<typeof suggestTrust>[number]): TrustGrant => ({ ...s, id: "g1", grantedAt: 0 });

describe("Earned trust: suggestions", () => {
  it("suggests trusting an action after 5 clean approvals", () => {
    const { store, act } = world();
    for (let i = 0; i < 5; i++) act(rollback);
    const [s] = suggestTrust(store.list(), []);
    expect(s.pattern).toMatchObject({ tool: "rollback_deploy", target: "worker-queue", environment: "production" });
    expect(s.approvals).toBe(5);
    expect(s.exceptFrom).toEqual(["Production rollbacks need a human"]);
  });

  it("doesn't suggest after only 4", () => {
    const { store, act } = world();
    for (let i = 0; i < 4; i++) act(rollback);
    expect(suggestTrust(store.list(), [])).toEqual([]);
  });

  it("resets after a rejection: trust is lost quickly", () => {
    const { store, act } = world();
    for (let i = 0; i < 5; i++) act(rollback);
    act(rollback, "rejected");
    for (let i = 0; i < 4; i++) act(rollback);
    expect(suggestTrust(store.list(), [])).toEqual([]);
  });

  it("resets after a human edit", () => {
    const { store, act } = world();
    for (let i = 0; i < 5; i++) act(scale(8));
    act(scale(8), { edit: { replicas: 6 } });
    expect(suggestTrust(store.list(), [])).toEqual([]);
  });

  it("caps numbers at the largest value humans approved", () => {
    const { store, act } = world();
    [6, 8, 7, 6, 8].forEach((n) => act(scale(n)));
    const [s] = suggestTrust(store.list(), []);
    expect(s.params).toEqual({ replicas: { max: 8 } });
  });

  it("never suggests loosening a hard line, however many approvals", () => {
    const { store, act } = world();
    for (let i = 0; i < 20; i++) act(dbRestart);
    expect(suggestTrust(store.list(), [])).toEqual([]);
  });

  it("doesn't repeat a suggestion that's already granted", () => {
    const { store, act } = world();
    for (let i = 0; i < 5; i++) act(rollback);
    const [s] = suggestTrust(store.list(), []);
    expect(suggestTrust(store.list(), [grant(s)])).toEqual([]);
  });
});

describe("Earned trust: applying a grant", () => {
  function trustedPolicy(actions: Action[]) {
    const { store, act } = world();
    actions.forEach((a) => act(a));
    const [s] = suggestTrust(store.list(), []);
    return { policy: applyTrust(relay, [grant(s)]), suggestion: s };
  }

  it("lets the trusted action run on its own, despite the rule that held it", () => {
    const { policy } = trustedPolicy(Array(5).fill(rollback));
    const v = evaluate(rollback, policy);
    expect(v.decision).toBe("allow");
    expect(v.matchedRules).toContain("Earned trust: rollback_deploy → worker-queue (production)");
  });

  it("stays narrow: a different target, environment or agent still needs a human", () => {
    const { policy } = trustedPolicy(Array(5).fill(rollback));
    expect(evaluate({ ...rollback, target: "api-server" }, policy).decision).toBe("escalate");
    expect(evaluate({ ...rollback, agent: "some-other-agent" }, policy).decision).toBe("escalate");
  });

  it("stays within the approved numbers", () => {
    const { policy } = trustedPolicy([6, 8, 7, 6, 8].map(scale));
    expect(evaluate(scale(8), policy).decision).toBe("allow");
    expect(evaluate(scale(9), policy).decision).toBe("escalate");
  });

  it("stops applying once revoked", () => {
    const { suggestion } = trustedPolicy(Array(5).fill(rollback));
    const revoked = { ...grant(suggestion), revokedAt: 1 };
    expect(evaluate(rollback, applyTrust(relay, [revoked])).decision).toBe("escalate");
  });

  it("never carves into a hard line, even if a grant names it", () => {
    const forged: TrustGrant = {
      id: "x",
      grantedAt: 0,
      key: "k",
      pattern: { agent: "relay-oncall", tool: "restart_service", target: "postgres-primary", environment: "production" },
      params: {},
      exceptFrom: ["Changing a database needs a human"],
      approvals: 99,
      avgDecisionMs: 0,
      lastApprovedAt: 0,
    };
    expect(evaluate(dbRestart, applyTrust(relay, [forged])).decision).toBe("escalate");
  });

  it("leaves the original policy untouched", () => {
    trustedPolicy(Array(5).fill(rollback));
    expect(evaluate(rollback, relay).decision).toBe("escalate");
  });
});
