import { describe, expect, it } from "vitest";
import { CheckpointStore, DUPLICATE_WINDOW_MS, computeMetrics } from "./checkpoints";
import type { Action, Verdict } from "./types";

const allow: Verdict = { decision: "allow", matchedRules: ["Small scale-ups are fine"], explanation: "Allowed." };
const escalate: Verdict = { decision: "escalate", matchedRules: ["Changing a database needs a human"], explanation: "Needs a human." };

const scale: Action = {
  agent: "relay-oncall",
  tool: "scale_service",
  target: "worker-queue",
  environment: "production",
  params: { service: "worker-queue", environment: "production", replicas: 4 },
};

// A clock we control, so tests don't have to actually wait.
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("Checkpoints", () => {
  it("auto-approves what the policy allows", () => {
    const store = new CheckpointStore();
    const { checkpoint } = store.create({ action: scale, verdict: allow });
    expect(checkpoint.status).toBe("approved");
    expect(checkpoint.decidedBy).toBe("policy");
  });

  it("holds escalated actions until a human decides", () => {
    const store = new CheckpointStore();
    const { checkpoint } = store.create({ action: scale, verdict: escalate });
    expect(checkpoint.status).toBe("pending");
    const result = store.decide(checkpoint.id, "rejected");
    expect(result.ok).toBe(true);
    expect(store.get(checkpoint.id)?.status).toBe("rejected");
    expect(store.get(checkpoint.id)?.decidedBy).toBe("human");
  });

  it("can't be decided twice", () => {
    const store = new CheckpointStore();
    const { checkpoint } = store.create({ action: scale, verdict: escalate });
    store.decide(checkpoint.id, "approved");
    const second = store.decide(checkpoint.id, "rejected");
    expect(second.ok).toBe(false);
    expect(store.get(checkpoint.id)?.status).toBe("approved");
  });

  it("expires when the agent stops waiting, and can't be approved after", () => {
    const c = clock();
    const store = new CheckpointStore(c.now);
    const { checkpoint } = store.create({ action: scale, verdict: escalate, timeoutMs: 30_000 });
    c.advance(30_001);
    expect(store.get(checkpoint.id)?.status).toBe("expired");
    expect(store.decide(checkpoint.id, "approved").ok).toBe(false);
  });
});

describe("Idempotency: the same fix never runs twice by accident", () => {
  it("joins a retry to the request already waiting", () => {
    const store = new CheckpointStore();
    const first = store.create({ action: scale, verdict: escalate });
    const retry = store.create({ action: scale, verdict: escalate });
    expect(retry.joined).toBe(true);
    expect(retry.checkpoint.id).toBe(first.checkpoint.id);
    expect(store.list()).toHaveLength(1);
  });

  it("treats params in a different order as the same action", () => {
    const store = new CheckpointStore();
    const first = store.create({ action: scale, verdict: escalate });
    const reordered: Action = {
      ...scale,
      params: { replicas: 4, environment: "production", service: "worker-queue" },
      reason: "Different wording, same action",
    };
    expect(store.create({ action: reordered, verdict: escalate }).checkpoint.id).toBe(first.checkpoint.id);
  });

  it("escalates an identical allowed action that just ran", () => {
    const c = clock();
    const store = new CheckpointStore(c.now);
    store.create({ action: scale, verdict: allow });
    c.advance(10_000);
    const again = store.create({ action: scale, verdict: allow });
    expect(again.checkpoint.status).toBe("pending");
    expect(again.checkpoint.verdict.explanation).toMatch(/duplicate.*10s ago/i);
    expect(again.checkpoint.duplicateOf).toBeDefined();
  });

  it("allows it again once the window has passed", () => {
    const c = clock();
    const store = new CheckpointStore(c.now);
    store.create({ action: scale, verdict: allow });
    c.advance(DUPLICATE_WINDOW_MS + 1);
    expect(store.create({ action: scale, verdict: allow }).checkpoint.status).toBe("approved");
  });

  it("doesn't treat repeated reads as duplicates", () => {
    const store = new CheckpointStore();
    const read: Action = { agent: "a", tool: "read_logs", target: "api-server", environment: "production" };
    store.create({ action: read, verdict: allow, readOnly: true });
    expect(store.create({ action: read, verdict: allow, readOnly: true }).checkpoint.status).toBe("approved");
  });
});

describe("Metrics", () => {
  it("counts who decided what", () => {
    const store = new CheckpointStore();
    store.create({ action: { ...scale, target: "a" }, verdict: allow });
    store.create({ action: { ...scale, target: "b" }, verdict: allow });
    store.create({ action: { ...scale, target: "c" }, verdict: allow });
    const held = store.create({ action: { ...scale, target: "d" }, verdict: escalate });
    store.decide(held.checkpoint.id, "rejected");

    const m = computeMetrics(store.list());
    expect(m.total).toBe(4);
    expect(m.autoApproveRate).toBe(0.75);
    expect(m.interventionRate).toBe(0.25);
    expect(m.vetoRate).toBe(1);
  });
});
