# Aegis

A safety checkpoint for AI agents. Safe actions run on their own, risky ones wait for a person, and everything is on record.

**Try it: [aegis-checkpoint.vercel.app](https://aegis-checkpoint.vercel.app)**

## Why this exists

AI agents are starting to do real things: restart servers, change data, merge code. Most of the time that's fine. Occasionally it isn't. In July 2025, an AI coding agent on Replit deleted a company's production database during a code freeze, after being told not to make changes.

The usual answer is to make the agent ask permission. But an agent that asks about everything is exhausting, and people start clicking "yes" without reading. An agent that asks about nothing is how databases get deleted.

Aegis sits in between. You write down which actions are safe and which need a person. Aegis checks every action against those rules before it runs, and over time it learns which approvals are routine and stops asking about them.

## Try it

Open [aegis-checkpoint.vercel.app](https://aegis-checkpoint.vercel.app) and click **Try the demo**. An AI agent works through a simulated outage at a made-up company called Relay. It investigates on its own, then asks to restart the main database, which is exactly what caused Relay's last outage. You decide.

There's a second demo, **See how trust builds over a week**, that fast-forwards seven days of routine incidents.

Both take about a minute and run in your browser. Nothing is sent anywhere.

## How it works

```
AI agent  ──►  Aegis  ──►  the real systems (servers, databases, GitHub)
                 │
        rules · approvals · record
```

Agents connect to their tools using [MCP](https://modelcontextprotocol.io), a standard that Claude Code, Cursor and most agent frameworks support. Aegis sits in the middle of that connection. The agent thinks it's talking to its tools, so it needs no changes.

When the agent tries to do something, this happens:

1. Aegis reads the action as facts: which tool, on which system, in which environment, with which settings.
2. It checks those facts against your rules. It ignores what the agent *says* about the action. An agent claiming "this is low risk" changes nothing.
3. Safe actions run straight away.
4. Anything else waits in the Aegis console for a person to approve, reject or edit. ("Add 12 servers" can become "add 5.")
5. Every step is written to an audit log that shows if anyone tampers with it.

If Aegis itself goes down, nothing runs. It fails closed.

## Rules

Rules live in a TypeScript file. Here are three of Relay's ([full file](policies/relay.ts)):

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
      neverAutoTrust: true,
    },
  ],
});
```

Two things decide the outcome. If any matching rule says a person should decide, a person decides, whatever order the rules are in. And if no rule matches at all, a person decides. Unknown actions are never waved through.

## Earning trust

After people approve the same action five times in a row without changing it, Aegis suggests letting it run on its own. Someone has to accept that suggestion, and the acceptance is recorded too.

Trust is kept narrow on purpose. It only covers that exact action, and only up to the numbers people actually approved: approving 6 to 8 servers doesn't mean 50 is fine. One rejection resets it. Rules marked `neverAutoTrust`, like database changes, can never be trusted away.

## Running it yourself

The website only runs the demos. To connect a real agent, run Aegis on your own computer:

```bash
git clone https://github.com/megh1002/aegis.git
cd aegis
npm install
npm run dev
```

The console opens at http://localhost:3000. The repo includes a [`.mcp.json`](.mcp.json) that puts Aegis in front of Relay's simulated systems. Open this folder in Claude Code, keep `npm run dev` running, and ask it to investigate the production incident. Only those tools go through Aegis. Claude Code's normal file editing and commands aren't affected.

When the console starts, it prints a private approval link in the terminal. Only a browser that opened that link can approve actions, so an agent running on the same machine can't approve its own requests.

To try it without an AI, `npm run simulate` runs a scripted agent through the same path.

## What's in here

| Folder | What it is |
|---|---|
| `core/` | The rules engine, approvals, earned trust and audit log. Plain TypeScript with no web code. |
| `mcp/` | The Aegis proxy, and a simulated version of Relay's systems for demos and tests |
| `policies/` | Rule files |
| `src/` | The console (Next.js) |
| `docs/` | The [Relay case](docs/CUSTOMER_BRIEF.md) and a [log of design decisions](docs/DECISIONS.md) and why they were made |

`npm test` runs 67 tests, including an agent that lies about how risky its action is, the console being unreachable, and someone editing the audit log.

## Security

Aegis is a safety tool, so it gets its own threat model: [SECURITY.md](SECURITY.md). The short version: the console only listens on your own machine, approvals need a secret the agent doesn't have, and the public demo site has no live system behind it at all.

## What it doesn't do yet

- Approvals happen in a browser on the same computer. A real team would want them on a phone, or in Slack.
- History lives in a local file. It shows tampering, but it doesn't stop someone deleting the whole file.
- Relay is a made-up company. The rules and incidents are realistic, but nobody runs Aegis in production today.

## Why I built it

I wanted to understand what it actually takes to let an AI agent loose on real systems, and to build the thing I'd want in place before doing it. Most of the interesting problems turned out to be about trust, not AI: who's allowed to decide, what happens when something breaks, and how you prove what happened afterwards.

Built with Next.js, TypeScript, the MCP TypeScript SDK and Vitest.

## License

MIT
