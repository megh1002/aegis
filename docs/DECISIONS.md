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

## Open issue · An agent could approve its own request *(mostly fixed by 016)*
The console's approve button called an API with no login, so a coding agent that can run terminal commands could approve itself. Found in M2, fixed in M3 below, with a remaining limit.

## 016 · Approvals need a secret the agent doesn't have
**Chose:** When the console starts, it makes a random secret and prints a link containing it in its own terminal (the way Jupyter notebooks do). Opening the link stores the secret in a browser cookie. Only requests with that cookie can approve or reject. Without it, the console is view-only.
**Instead of:** No protection (M2), or a username and password (more setup, and a password could end up in a file the agent reads).
**Details:** The secret is never written to disk. It's removed from the address bar after use. The cookie is `HttpOnly` (page scripts can't read it) and `SameSite=strict` (other websites can't use it). The check compares in constant time, so response timing can't leak the secret.
**Remaining limit:** anything that can read the console's terminal output can still approve. On one machine where the agent runs as the same user, this reduces the risk; it doesn't remove it. The real fix is the team version, where approval happens on a different machine or phone.
**Trade-off:** a new link after every console restart. Set `AEGIS_APPROVER_TOKEN` to keep one.

## 017 · The audit log is append-only and tamper-evident
**Chose:** Every event is one line in `.aegis/audit.jsonl`. Each line contains the hash of the line before it (a hash chain). `npm run audit:verify` checks the chain, and the console refuses to write onto a broken one. On restart, the console rebuilds its history from the log.
**Instead of:** A plain database table, which can be edited silently.
**Why:** Relay's compliance lead needs to *prove* who approved what. Tamper-*evident* means changes are detected, not prevented: someone could still delete the file. Sending log copies somewhere else would be the next step.

## 018 · Humans can edit how much, not what or where
**Chose:** A reviewer can change parameter values (e.g. replicas 12 → 5) before approving. They can't change the target or environment, add parameters, or change a number into text. The agent is told exactly what changed, and the record keeps both versions.
**Instead of:** Approve-or-reject only, which forces a human to reject a mostly-right action and wait for the agent to try again.
**Why:** It's what real operators do. Keeping target and environment fixed means an edit can never turn "scale the API" into "scale the database." The edited version isn't re-checked against the policy: the human is explicitly approving it.

## 019 · The record includes what actually happened
**Chose:** After an approved action runs, the proxy reports the outcome (success or failure plus a short summary), and it's added to the record once.
**Why:** "Approved" isn't the same as "it worked." An audit answers both *who allowed it* and *what it did*.

## 020 · Earned trust carves narrow exceptions
**Chose:** After a human approves the same kind of action (same agent, tool, target and environment) 5 times in a row without changing it, Aegis *suggests* trusting it. A human accepts the suggestion, and that acceptance is recorded in the audit log. The grant adds an allow rule *and* an exception to each rule that was holding the action.
**Instead of:** Just adding an allow rule, which does nothing under strictest-wins (005), or loosening whole rules automatically.
**Why:** It's how Aegis keeps its promise of asking less over time, without ever changing policy on its own.

## 021 · Trust is earned slowly and lost quickly
**Chose:** Only the unbroken run of clean approvals counts. One rejection, human edit or failed run resets it. Numbers are capped at the largest value humans approved (approved 6–8 servers → trusted up to 8, not 50). Duplicates don't count. Grants can be revoked any time, and the proxy notices within 3 seconds.
**Why:** Trust should cover what humans actually saw and approved, and nothing wider.

## 022 · Some rules are hard lines
**Chose:** Rules can be marked `neverAutoTrust`. Relay's database-change and deletion rules are. Aegis never suggests loosening them, and even a forged grant can't carve into them.
**Why:** Relay's outage was a database restart. Some actions should always have a human, however many times they've been approved.

## 023 · If the console can't be reached, no trust applies
**Chose:** The proxy fetches grants from the console; on failure it uses none.
**Why:** Grants only ever loosen the policy, so "no grants" is the safe side. (Fail-closed (010) blocks the action anyway.)

## 024 · A bug found by testing the real API (lesson)
**What happened:** The console's API dropped two verdict fields (`escalatedBy`, `lockedBy`) because its schema didn't list them. Unit tests passed because they never went through the API. A live smoke test exposed it: trust for production rollbacks would silently have done nothing.
**Changed:** The request schema moved into `core/` with a regression test.
**Lesson:** Test across boundaries, not just the pieces. Schemas that quietly drop unknown fields hide this kind of bug.

## 025 · The public website is demo-only
**Chose:** When built for Vercel, the live API is switched off (returns 404) and only the two in-browser demos run. No cookies, analytics or third-party scripts.
**Instead of:** Hosting a live console anyone on the internet could send actions to.
**Why:** The public site's job is to show Aegis, not to run it. With no server state, there's nothing to attack or leak.

## 026 · The local console only talks to this computer
**Chose:** Listen on `127.0.0.1`; reject API requests not addressed to `localhost` (DNS rebinding) and state changes from other websites.
**Why:** Before this, anyone on the same Wi-Fi could open the console. Found in a security review.

## 027 · Security headers and patched dependencies
**Chose:** A strict Content-Security-Policy (everything from this site only), no framing, no referrer, HTTPS-only in production. Upgraded Next.js 16.2.9 → 16.3.8 to fix a critical advisory; `npm audit` reports 0 vulnerabilities.
**Why:** A safety product should pass a basic security review of its own. See SECURITY.md.

