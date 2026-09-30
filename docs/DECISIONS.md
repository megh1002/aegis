# Aegis v2 — Decision Log

One entry per decision: what we chose, what we didn't, and why.

---

## 001 · Aegis is a general product; Relay is the first customer
**Chose:** Build Aegis for any agent, and use Relay (simulated) as the design partner.
**Instead of:** Building "for anyone" with no customer (v1), or building only for Relay.
**Why:** Designing without a real customer led to vague decisions in v1. Relay forces concrete ones, and only its policy file is customer-specific.

## 002 · Runs on the user's machine and connects through MCP
**Chose:** Local-first, sitting between any agent and its MCP tools.
**Instead of:** A hosted website that agents call.
**Why:** People can use it today with the agents they already have, starting with me on Claude Code. A shared team console comes later.

## 003 · Aegis judges the action, not the agent's opinion
**Chose:** Agents send structured actions (tool, target, environment, params). Aegis decides the risk from those facts.
**Instead of:** Trusting the agent's own risk label (v1).
**Why:** A risk label can be wrong or made up. The action data is what actually runs, so the agent can't misdescribe it without changing the action. `reason` is shown to humans only.

## 004 · Two outcomes: allow or escalate
**Chose:** No "deny." Anything not clearly safe goes to a human.
**Instead of:** A third outcome that blocks actions outright.
**Why:** A human always gets the final say. Trade-off: a person might approve something that should never happen. Revisit if real usage shows it's needed.

## 005 · Strictest rule wins
**Chose:** If any matching rule says escalate, the action escalates, whatever the rule order.
**Instead of:** First matching rule wins (like a firewall).
**Why:** Rule order can never silently open a hole. Consequence: "Staging is free" doesn't cover deleting data or restarting databases in staging, because those rules are stricter.

## 006 · No matching rule means escalate
**Chose:** Unknown actions go to a human.
**Instead of:** Allowing them (how Relay's outage happened) or blocking them (the agent gets stuck).
**Why:** Safe by default, and the approvals on unknown actions later tell Aegis which new rules to suggest (M4).

## 007 · Policies are YAML files, validated strictly *(replaced by 008)*
**Chose:** YAML, rejected on any unknown field, bad condition or catch-all rule.
**Instead of:** TypeScript code.
**Why:** Non-engineers like Relay's Head of Platform can read and review it. Strict validation matters because a typo like "enviroment" would otherwise be ignored and turn "allow in staging" into "allow everywhere." Conditions are parsed, never run as code, so the file can't execute anything.

## 008 · Policies are TypeScript, not YAML
**Chose:** A typed list of rules in a `.ts` file, wrapped in `definePolicy()`. Conditions are small functions, e.g. `(p) => p.replicas <= 5`.
**Instead of:** YAML (007), or one big `decide()` function.
**Why:** The editor autocompletes rules and flags typos while typing. Conditions are real code instead of a mini-language Aegis has to parse. A rule list (not one function) keeps rule names, strictest-wins and rule-by-rule tests.
**Trade-offs, and how we handle them:**
- Non-programmers can't easily edit rules. Accepted: the people writing policies for agents are usually engineers.
- A condition can crash. Handled: if any rule's check throws, the action escalates to a human.
- JavaScript treats `"5" <= 5` and `null <= 5` as true. Handled: rules check the type first, and a test guards it.
- Runtime validation stays, because policies may also be written in plain JavaScript without type checking.

## 009 · Aegis plugs in as an MCP proxy
**Chose:** Aegis pretends to be the MCP server to the agent, and the agent to the real server. Every tool call passes through it.
**Instead of:** An SDK the agent calls (v1), reading logs afterwards, or a plugin for one agent.
**Why:** It's the one place every action must pass through, so it can't be skipped, and nobody changes their agent.

## 010 · Fail closed, even for allowed actions
**Chose:** If the console can't be reached, *every* action is blocked, including ones the policy allows.
**Instead of:** Letting allowed actions run without the console.
**Why:** Relay's requirements say "if Aegis is down, don't go ahead" and "every action on record." An allowed action with no record breaks the second. Trade-off: the console going down stops the agent completely.

## 011 · The same change can't run twice by accident
**Chose:** A retry while a request is waiting joins that request. An identical *changing* action within 2 minutes of the last one goes to a human, even if the policy allows it.
**Instead of:** Trusting the agent not to repeat itself.
**Why:** "Never let the same fix run twice." Read-only tools (marked by the server with `readOnlyHint`) are exempt, since checking logs twice is normal.

## 012 · The agent can explain itself, but it never decides anything
**Chose:** Aegis adds an optional `aegis_reason` field to every tool. The reviewer sees it; the policy ignores it; it's removed before the call reaches the real tool.
**Why:** Reviewers decide faster with context. Keeping it out of the decision preserves decision 003.

## 013 · While a human decides, keep the agent's connection alive
**Chose:** The proxy sends a progress update every 5 seconds while waiting. Default wait: 5 minutes, then the action expires and can no longer be approved.
**Why:** MCP requests give up after 60 seconds by default. Expiry stops a human approving something the agent has already given up on.

## 014 · Supabase removed for now
**Chose:** The console keeps checkpoints in memory. The Supabase code is in the v1 commit.
**Why:** Local-first (002) doesn't need a hosted database yet. Trade-off: restarting the console clears history. A permanent audit log is M3.

## 015 · Broad "escalate" rules catch reads too (lesson)
**What happened:** The rule "Databases always need a human" matched *any* action on `postgres-*`. With strictest-wins, even reading database metrics was held. The in-browser demo caught it.
**Changed to:** "Changing a database needs a human", matching only tools that change something.
**Lesson:** Strictest-wins makes escalate rules powerful, so they have to be precise. A test now guards it.

## Open issue · An agent could approve its own request
The console's approve button calls an API with no login. A coding agent that can run terminal commands could, in principle, call that API and approve itself. Fix planned for M3: approvals need a secret the agent can't read (or a login). Found while building M2; not yet fixed.

