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

## 007 · Policies are YAML files, validated strictly
**Chose:** YAML, rejected on any unknown field, bad condition or catch-all rule.
**Instead of:** TypeScript code.
**Why:** Non-engineers like Relay's Head of Platform can read and review it. Strict validation matters because a typo like "enviroment" would otherwise be ignored and turn "allow in staging" into "allow everywhere." Conditions are parsed, never run as code, so the file can't execute anything.

