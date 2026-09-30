# Aegis — Mission Control for AI Agents

Human-in-the-loop oversight for autonomous AI agents. Agents run on their own, but
**pause and raise their hand before risky actions**. A human approves or rejects from a
live console. Low-risk actions are auto-approved by policy; everything is logged.

> The trust-and-control layer that lets teams actually deploy agents that take real actions.

## The pieces

- **SDK** (`src/lib/aegis-sdk.ts`) — drop `requireApproval()` into any agent. It pauses the
  agent until a human decides (or auto-policy resolves it).
- **API** (`src/app/api/checkpoints/…`) — create a checkpoint, read its status, decide on it.
- **Console** (`src/app/page.tsx`) — live queue of pending approvals + trust metrics + history.
- **Store** (`src/lib/store.ts`) — Supabase when configured, in-memory fallback for local dev.

## Connect your agent

Aegis is agent-agnostic — anything that can make an HTTP call can use it.

**Option A — SDK (TypeScript):** copy `src/lib/aegis-sdk.ts` into your agent project:

```ts
import { requireApproval } from "./aegis-sdk";

const { approved } = await requireApproval({
  agent: "refund-bot",
  action: "Issue a $500 refund to customer #4821",
  reasoning: "Customer claims item never arrived.",
  risk: "high",
});
if (approved) await issueRefund();
```

Set `AEGIS_URL` (your console URL) and `AEGIS_API_KEY` in the agent's environment.

**Option B — raw HTTP (any language / framework):**

```bash
# 1. Agent raises its hand before a risky action
curl -X POST $AEGIS_URL/api/checkpoints \
  -H "Authorization: Bearer $AEGIS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent":"my-bot","action":"...","reasoning":"...","risk":"high"}'

# 2. Poll until a human decides (status: pending → approved | rejected)
curl $AEGIS_URL/api/checkpoints/<id>
```

Works from LangChain/LangGraph tool wrappers, CrewAI callbacks, Claude tool-use loops —
wrap your risky tools so they call Aegis before executing.

## Environment

| Var | Where | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | console (Vercel) | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | console (Vercel) | server-side DB access |
| `AEGIS_API_KEY` | console + agents | shared secret agents use to create checkpoints |
| `AEGIS_URL` | agents | base URL of the deployed console |

Run `supabase/schema.sql` once in the Supabase SQL editor to create the table.

## Run it

```bash
npm run dev                   # start the console at http://localhost:3000
node scripts/demo-agent.mjs   # in another terminal — a demo "refund bot"
```

The demo bot auto-approves a low-risk email, then **waits** on a $500 refund until you
click Approve/Reject in the console.

## The thesis

Not "keep a human in the loop" (friction). It's "let teams safely take humans *out*
of the loop, one proven-safe action at a time." The policy engine auto-approves as much
as it safely can and escalates only the risky few; the metrics prove human load is low
and falling. **Full autonomy, without capsizing.**

## Roadmap

- [x] Walking skeleton: checkpoint → live console → human decision
- [x] Policy engine: auto-approve vs. escalate (risk + sensitive-action rules)
- [x] Trust metrics: auto-approve rate, intervention rate, veto rate, time-to-decide
- [x] Polished command-deck UI (animated background, trust ring, motion, glass)
- [x] Deployed to Vercel · Supabase-backed store with local in-memory fallback
- [ ] Supabase realtime (replace console polling)
- [ ] Console auth (right now anyone with the URL can approve)
- [ ] Configurable policies per agent + a trust curve that escalates less over time
- [ ] Rewind / replay an agent's decision history
- [ ] Wire it into a real agent (dogfood on Research Crew / Claro)
