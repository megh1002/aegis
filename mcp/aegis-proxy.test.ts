// End-to-end: a pretend agent talks to the Aegis proxy, which talks to the
// fake Relay infrastructure. Everything runs in memory, connected by
// in-process "wires" instead of separate programs.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import relay from "../policies/relay";
import { REASON_FIELD, createAegisProxy } from "./aegis-proxy";
import { ConsoleGate, MemoryGate, type HumanAnswer } from "./gate";
import type { Checkpoint } from "../core/checkpoints";
import { createRelayServer } from "./relay-infra-server";

type Human = (c: Checkpoint) => HumanAnswer;

async function setup(human: Human = () => "no answer") {
  // Wire 1: proxy <-> Relay infra
  const [upA, upB] = InMemoryTransport.createLinkedPair();
  await createRelayServer().connect(upB);
  const upstream = new Client({ name: "aegis-proxy", version: "test" });
  await upstream.connect(upA);

  // Wire 2: agent <-> proxy
  const gate = new MemoryGate(undefined, human);
  const proxy = createAegisProxy({ upstream, policy: relay, gate, agent: "relay-oncall" });
  const [agA, agB] = InMemoryTransport.createLinkedPair();
  await proxy.connect(agB);
  const agent = new Client({ name: "test-agent", version: "test" });
  await agent.connect(agA);

  const call = async (name: string, args: Record<string, unknown>) =>
    (await agent.callTool({ name, arguments: args })) as CallToolResult;
  const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  return { agent, call, textOf, store: gate.store, gate };
}

const prod = { environment: "production" };

describe("Aegis proxy", () => {
  it("shows the agent the real server's tools, plus a reason field", async () => {
    const { agent } = await setup();
    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["read_logs", "restart_service", "scale_service", "rollback_deploy"]),
    );
    expect(tools.find((t) => t.name === "read_logs")!.inputSchema.properties).toHaveProperty(REASON_FIELD);
  });

  it("passes allowed actions straight through", async () => {
    const { call, textOf, store } = await setup();
    const r = await call("read_logs", { service: "worker-queue", ...prod });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/pool leak/);
    expect(store.list()[0].decidedBy).toBe("policy");
  });

  it("blocks Relay's outage action when no human approves, and the database stays up", async () => {
    const { call, textOf } = await setup(() => "no answer");
    const r = await call("restart_service", { service: "postgres-primary", ...prod, instances: "all" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/did not run/);

    const after = await call("describe_service", { service: "postgres-primary", ...prod });
    expect(textOf(after)).not.toMatch(/down/);
  });

  it("runs an escalated action once a human approves it", async () => {
    const { call, textOf, store } = await setup(() => "approved");
    const r = await call("rollback_deploy", { service: "worker-queue", ...prod, [REASON_FIELD]: "v1.8.0 leaks connections" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/recovered/);

    const cp = store.list()[0];
    expect(cp.decidedBy).toBe("human");
    // The reason is shown to the human, and never reaches the real tool.
    expect(cp.action.reason).toBe("v1.8.0 leaks connections");
    expect(cp.action.params).not.toHaveProperty(REASON_FIELD);
  });

  it("tells the agent when a human rejects", async () => {
    const { call, textOf } = await setup(() => "rejected");
    const r = await call("scale_service", { service: "api-server", ...prod, replicas: 20 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/rejected/);
  });

  it("doesn't let the same change run twice in a row by accident", async () => {
    const { call, textOf } = await setup(() => "no answer");
    const args = { service: "worker-queue", ...prod, replicas: 4 };
    expect((await call("scale_service", args)).isError).toBeFalsy();
    const again = await call("scale_service", args);
    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(/duplicate/i);
  });
});

describe("Edit before approve, and what happened", () => {
  it("runs the human's edited version and tells the agent", async () => {
    const { call, textOf } = await setup((c) => ({ approvedWith: { ...c.action.params, replicas: 5 } }));
    const r = await call("scale_service", { service: "api-server", ...prod, replicas: 20 });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/approved this with changes \(replicas: 20 → 5\)/);
    expect(textOf(r)).toMatch(/Scaled api-server from 4 to 5 replicas/);
  });

  it("records what actually happened after the action ran", async () => {
    const { call, store } = await setup(() => "approved");
    await call("rollback_deploy", { service: "worker-queue", ...prod });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.list()[0].execution).toMatchObject({ ok: true, summary: expect.stringMatching(/recovered/) });
  });
});

describe("Earned trust through the proxy", () => {
  it("runs a trusted action on its own once a human grants trust", async () => {
    const { call, store, gate } = await setup(() => "approved");
    const args = { service: "worker-queue", ...prod };
    const trustedFor = { agent: "relay-oncall", tool: "rollback_deploy", target: "worker-queue", environment: "production" };
    gate.trustGrants = [
      { id: "g", grantedAt: 0, key: "k", pattern: trustedFor, params: {}, exceptFrom: ["Production rollbacks need a human"], approvals: 5, avgDecisionMs: 0, lastApprovedAt: 0 },
    ];
    await call("rollback_deploy", args);
    expect(store.list()[0].decidedBy).toBe("policy");
    expect(store.list()[0].verdict.matchedRules).toContain("Earned trust: rollback_deploy → worker-queue (production)");
  });
});

describe("Fail closed", () => {
  it("blocks everything, even allowed actions, when the console is unreachable", async () => {
    const gate = new ConsoleGate("http://127.0.0.1:9");
    const result = await gate.submit({
      action: { agent: "a", tool: "read_logs", target: "api-server", environment: "production" },
      verdict: { decision: "allow", matchedRules: ["Read-only tools are safe"], explanation: "Allowed." },
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/fails closed/);
  });
});
