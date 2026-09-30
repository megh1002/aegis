# Customer Brief: Relay

*A simulated customer engagement. Relay is fictional; the problem is not.*

## Who they are

Relay is a 150-person software company. Their product is scheduling software that about 2,000 businesses depend on every day. A six-person **platform team** keeps it running, and one engineer is always "on call" to respond when something breaks, day or night.

## The problem

On-call is burning the team out. Most alerts have routine fixes (restart a stuck service, add servers when traffic spikes, roll back a bad release), but a human still has to wake up, log in and do it. The average incident takes **42 minutes** to resolve, and most of that time is spent getting to a laptop, not fixing anything.

So the team built an **AI on-call agent**. It reads logs and alerts, figures out what's wrong, and can take action on Relay's systems.

## What went wrong

During a trial, the agent decided a database was unhealthy and restarted it in the middle of the workday. It was the *main* production database. Relay was down for **12 minutes** and customers noticed.

Leadership's response: **the agent can suggest fixes but can't take any action.** Engineers are safe again, but they're back to waking up at 3am to click the button the agent recommended. The agent's value is mostly gone.

## What they want

> "Let the agent fix the boring stuff on its own. Anything that could take us down, a human says yes first. And I need to prove to our auditors who approved what."
> *(Priya, Head of Platform)*

## The people involved

| Person | Role in this deployment | What they care about |
|---|---|---|
| Priya, Head of Platform | Buyer, signs off | Fewer 3am pages, no more outages caused by the agent |
| On-call engineers | Daily users, they approve or reject | Approving fast, from a phone, with enough context to decide |
| Marcus, Security & Compliance | Can block the launch | A complete record of every action, for Relay's SOC 2 audit |
| The AI agent | The thing being supervised | Being allowed to act, instead of only suggesting |

## Their requirements, in their words

1. "Anything in **staging** (the test environment) can run freely. **Production** is where we need to be careful."
2. "Restarting one copy of a service is fine. Restarting a **database**, or all copies of something at once, is not."
3. "If the agent wants to add 20 servers, I might say yes to 5 instead. Let me **change it**, don't make me reject it."
4. "**Never** let the same fix run twice by accident."
5. "If Aegis itself is down, the agent must **not** just go ahead."
6. "Over time, if we keep approving the same kind of action, stop asking us."
7. "Every action, approved or automatic, must be **on record**: who, what, when, why."

## How we'll know it worked

| Measure | Today | Target |
|---|---|---|
| Time to resolve an incident | 42 min | under 20 min |
| Agent actions that run without a human | 0% (all blocked) | 70% or more |
| Risky production actions run without approval | 1 (the outage) | 0 |
| Actions with a complete audit record | none | 100% |

## Out of scope (for now)

- Connecting to Relay's real cloud. We **simulate** their systems, so the demo is safe and repeatable.
- Slack and phone notifications. Approvals happen in the Aegis console first.
