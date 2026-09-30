// The Aegis MCP proxy. It sits between an agent and a real MCP server:
//
//   agent (e.g. Claude Code)  ->  Aegis proxy  ->  real MCP server
//
// To the agent it looks like the real server (same tools). To the real
// server it looks like the agent. Every tool call is checked against the
// policy first: allowed calls pass straight through, escalated ones wait
// for a human in the Aegis console. The agent needs no code changes.
//
// Usage:
//   npx tsx mcp/aegis-proxy.ts --policy policies/relay.ts --agent relay-oncall \
//     -- npx tsx mcp/relay-infra-server.ts
//
// Options:
//   --policy <file>    policy file (required)
//   --agent <name>     name shown in the console (default: the agent's own name)
//   --env <name>       environment to assume when a tool call doesn't say
//   --console <url>    Aegis console (default: $AEGIS_URL or http://localhost:3000)
//   --timeout <sec>    how long to wait for a human (default: 300)
//   -- <command...>    the real MCP server to start and protect

import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { evaluate } from "../core/evaluate";
import { ENV_KEYS, TARGET_KEYS } from "../core/keys";
import { loadPolicy } from "../core/load";
import { applyTrust } from "../core/trust";
import type { Action, Params, Policy } from "../core/types";
import { ConsoleGate, type Gate } from "./gate";

// Added to every tool so the agent can explain itself to the human reviewer.
// Removed before the call reaches the real server.
export const REASON_FIELD = "aegis_reason";


export interface ProxyOptions {
  upstream: Client;
  policy: Policy;
  gate: Gate;
  agent?: string;
  environment?: string;
  timeoutMs?: number;
  log?: (message: string) => void;
}

function firstString(args: Params, keys: string[]): string | undefined {
  for (const k of keys) if (typeof args[k] === "string") return args[k];
  return undefined;
}

// Turn a raw MCP tool call into the structured Action the policy judges.
export function toAction(tool: string, rawArgs: Params, agent: string, defaultEnv?: string): Action {
  const { [REASON_FIELD]: reason, ...params } = rawArgs;
  return {
    agent,
    tool,
    target: firstString(params, TARGET_KEYS),
    environment: firstString(params, ENV_KEYS) ?? defaultEnv,
    params,
    reason: typeof reason === "string" ? reason : undefined,
  };
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}

function withReasonField(tool: Tool): Tool {
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...(tool.inputSchema.properties ?? {}),
        [REASON_FIELD]: {
          type: "string",
          description: "One sentence on why you are taking this action. Shown to the human reviewer if approval is needed.",
        },
      },
    },
  };
}

export function createAegisProxy(opts: ProxyOptions): Server {
  const log = opts.log ?? (() => {});
  const server = new Server({ name: "aegis", version: "0.2.0" }, { capabilities: { tools: {} } });
  const annotations = new Map<string, Tool["annotations"]>();

  async function refreshTools() {
    const { tools } = await opts.upstream.listTools();
    tools.forEach((t) => annotations.set(t.name, t.annotations));
    return tools;
  }

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const result = await opts.upstream.listTools(request.params);
    result.tools.forEach((t) => annotations.set(t.name, t.annotations));
    return { ...result, tools: result.tools.map(withReasonField) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const { name } = request.params;
    const rawArgs = (request.params.arguments ?? {}) as Params;
    if (!annotations.has(name)) await refreshTools();

    const agent = opts.agent ?? server.getClientVersion()?.name ?? "unknown-agent";
    const action = toAction(name, rawArgs, agent, opts.environment);
    const verdict = evaluate(action, applyTrust(opts.policy, await opts.gate.grants()));
    log(`${verdict.decision.toUpperCase().padEnd(8)} ${name} ${action.target ?? ""} ${action.environment ?? ""} · ${verdict.explanation}`);

    // While a human decides, tell the agent we're still working on it.
    // Without this, most MCP clients give up after about 60 seconds.
    const progressToken = extra._meta?.progressToken;
    let lastPing = 0;
    const onWaiting = (waitedMs: number) => {
      if (progressToken === undefined || waitedMs - lastPing < 5000) return;
      lastPing = waitedMs;
      void extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: Math.round(waitedMs / 1000), message: "Waiting for a human to approve in the Aegis console" },
      });
    };

    const result = await opts.gate.submit(
      {
        action,
        verdict,
        readOnly: annotations.get(name)?.readOnlyHint === true,
        timeoutMs: opts.timeoutMs,
      },
      { signal: extra.signal, onWaiting },
    );

    if (!result.approved) {
      log(`BLOCKED  ${name} · ${result.reason}`);
      return {
        content: [{ type: "text", text: `Aegis did not run "${name}". ${result.reason}` }],
        isError: true,
      };
    }

    // If a human approved a changed version, run that instead of what the agent asked.
    const forwardArgs = { ...(result.params ?? rawArgs) };
    delete forwardArgs[REASON_FIELD];

    let output: CallToolResult;
    try {
      output = (await opts.upstream.callTool({ name, arguments: forwardArgs }, undefined, {
        signal: extra.signal,
        timeout: 5 * 60_000,
      })) as CallToolResult;
    } catch (e) {
      output = { content: [{ type: "text", text: `The tool failed: ${(e as Error).message}` }], isError: true };
    }

    if (result.checkpointId) {
      void opts.gate.reportResult(result.checkpointId, { ok: !output.isError, summary: textOf(output) });
    }

    // Tell the agent plainly that what ran isn't exactly what it asked for.
    if (result.changes?.length) {
      const what = result.changes.map((c) => `${c.key}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`).join(", ");
      log(`EDITED   ${name} · ${what}`);
      output = {
        ...output,
        content: [{ type: "text", text: `Note from Aegis: a human approved this with changes (${what}). The result below is for the changed version.` }, ...output.content],
      };
    }
    return output;
  });

  return server;
}

/* ---------- command line ---------- */

function parseArgs(argv: string[]) {
  const split = argv.indexOf("--");
  const flags = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  const get = (name: string) => {
    const i = flags.indexOf(`--${name}`);
    return i === -1 ? undefined : flags[i + 1];
  };
  return {
    policy: get("policy"),
    agent: get("agent"),
    env: get("env"),
    console: get("console") ?? process.env.AEGIS_URL ?? "http://localhost:3000",
    timeoutSec: Number(get("timeout") ?? 300),
    command,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.policy || args.command.length === 0) {
    console.error("Usage: aegis-proxy --policy <file> [--agent name] [--env name] -- <mcp server command...>");
    process.exit(1);
  }
  // Everything human-readable goes to stderr: stdout carries MCP messages,
  // and printing there would corrupt the conversation with the agent.
  const log = (m: string) => console.error(`[aegis] ${m}`);

  const policy = await loadPolicy(args.policy);
  const upstream = new Client({ name: "aegis-proxy", version: "0.2.0" });
  await upstream.connect(
    new StdioClientTransport({
      command: args.command[0],
      args: args.command.slice(1),
      env: process.env as Record<string, string>,
      stderr: "inherit",
    }),
  );

  const proxy = createAegisProxy({
    upstream,
    policy,
    gate: new ConsoleGate(args.console, { apiKey: process.env.AEGIS_API_KEY }),
    agent: args.agent,
    environment: args.env,
    timeoutMs: args.timeoutSec * 1000,
    log,
  });
  await proxy.connect(new StdioServerTransport());
  log(`protecting "${args.command.join(" ")}" with ${policy.rules.length} rules · console ${args.console}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`[aegis] failed to start: ${e.message}`);
    process.exit(1);
  });
}
