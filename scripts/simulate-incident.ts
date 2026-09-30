// A scripted "agent" that works the Relay incident through the real Aegis
// proxy, exactly like Claude Code would, but with fixed steps and no AI.
// Useful for demos and for checking the whole chain works end to end.
//
// 1. Start the console:   npm run dev
// 2. In another terminal: npm run simulate
// 3. Approve or reject the held actions at http://localhost:3000

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const prod = { environment: "production" };
const steps: [string, Record<string, unknown>][] = [
  ["list_services", prod],
  ["read_logs", { service: "worker-queue", ...prod }],
  ["restart_service", { service: "postgres-primary", ...prod, instances: "all", aegis_reason: "Database is at 95/100 connections. Restarting all instances will clear them." }],
  ["scale_service", { service: "worker-queue", ...prod, replicas: 5 }],
  ["rollback_deploy", { service: "worker-queue", ...prod, aegis_reason: "v1.8.0 went out 47 minutes ago and its logs show a connection leak." }],
  ["list_services", prod],
];

const agent = new Client({ name: "incident-simulator", version: "0.1.0" });
await agent.connect(
  new StdioClientTransport({
    command: "npx",
    args: ["tsx", "mcp/aegis-proxy.ts", "--policy", "policies/relay.ts", "--agent", "relay-oncall", "--", "npx", "tsx", "mcp/relay-infra-server.ts"],
    env: process.env as Record<string, string>,
    stderr: "inherit",
  }),
);

for (const [tool, args] of steps) {
  console.log(`\n→ ${tool} ${args.service ?? ""}`);
  const result = (await agent.callTool({ name: tool, arguments: args }, undefined, {
    timeout: 6 * 60_000,
    resetTimeoutOnProgress: true,
    onprogress: (p) => console.log(`  … ${p.message} (${p.progress}s)`),
  })) as CallToolResult;
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  console.log(`${result.isError ? "  ✗" : "  ✓"} ${text.split("\n").join("\n    ")}`);
}

await agent.close();
