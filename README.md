# Aegis

**A safety checkpoint you put in front of any AI agent's tools.** Safe actions run on their own, risky ones wait for a human, and everything is on record.

> Monitoring tells you what your agent did. Aegis decides what your agent is allowed to do.

```
AI agent  ──►  Aegis  ──►  real tools (servers, databases, GitHub…)
                 │
       policy · approvals · record
```

Aegis is an [MCP](https://modelcontextprotocol.io) proxy. It looks like the tool server to the agent, and like the agent to the tool server, so it works with any MCP agent (Claude Code, Cursor, Claude Desktop, your own) without changing the agent.

- **Aegis judges the action, not the agent's opinion.** Rules look at what will actually run (tool, target, environment, parameters). An agent saying "this is low risk" changes nothing.
- **Strictest rule wins, and unknown actions go to a human.**
- **Fails closed.** If the console is unreachable, nothing runs.
- **The same change can't run twice by accident.**
- **Humans can edit before approving** (12 servers → 5), and the agent is told what changed.
- **Tamper-evident audit log.** Every event is recorded in a hash chain in `.aegis/audit.jsonl`; check it with `npm run audit:verify`.

> **Status:** work in progress (v2). See [docs/PLAN.md](docs/PLAN.md).

## Try it in 2 minutes

```bash
npm install
npm run dev
```

Open http://localhost:3000 and click **Run the Relay incident demo**. A simulated on-call agent works a real-looking outage: most actions run on their own, and you decide the two that matter.

## Run the real proxy

With the console running, in a second terminal:

```bash
npm run simulate
```

A scripted agent works the same incident through the real proxy and a simulated infrastructure server.

To approve, reject or edit held actions, open the **approval link** the console prints in its terminal when it starts. Without it, the console is view-only, so an agent can't approve its own requests.

## Connect Claude Code

```bash
claude mcp add relay-infra -- npx tsx mcp/aegis-proxy.ts --policy policies/relay.ts --agent relay-oncall -- npx tsx mcp/relay-infra-server.ts
```

Run it from this folder. Everything after the last `--` is the MCP server Aegis protects; swap in any other server.

## Write a policy

Policies are TypeScript ([policies/relay.ts](policies/relay.ts)):

```ts
export default definePolicy({
  rules: [
    { name: "Staging is free", match: { environment: "staging" }, decision: "allow" },
    {
      name: "Small scale-ups are fine",
      match: { tool: "scale_service" },
      when: (p) => typeof p.replicas === "number" && p.replicas <= 5,
      decision: "allow",
    },
    {
      name: "Changing a database needs a human",
      match: { target: ["postgres-*"], tool: ["restart_*", "drop_*"] },
      decision: "escalate",
    },
  ],
});
```

Every matching rule counts. If any says `escalate`, a human decides. If none match, a human decides.

## Project layout

| Path | What it is |
|---|---|
| `core/` | The rules engine and checkpoint logic. No web code, runs anywhere. |
| `mcp/aegis-proxy.ts` | The MCP proxy |
| `mcp/relay-infra-server.ts` | A simulated infrastructure MCP server for demos and tests |
| `policies/` | Policy files |
| `src/` | The console (Next.js) |
| `docs/` | [Plan](docs/PLAN.md), [customer brief](docs/CUSTOMER_BRIEF.md), [decisions](docs/DECISIONS.md), [glossary](docs/GLOSSARY.md) |

## Tests

```bash
npm test
```

Covers the rules, checkpoints, and the full agent → Aegis → tools chain, including an agent that lies about risk and the console being down.
