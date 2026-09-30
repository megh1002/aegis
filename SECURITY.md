# Security

Aegis is a safety layer, so its own security matters. This page explains what it protects against, how, and where the limits are.

## What Aegis protects

| Threat | Protection |
|---|---|
| An agent takes a risky action without a human | Every tool call passes through the proxy and is checked against the policy before it runs. |
| An agent misdescribes its action ("this is low risk") | Rules only look at the actual tool, target, environment and parameters. The agent's own reason is shown to humans but never used to decide. |
| The console is down or unreachable | The proxy **fails closed**: nothing runs, not even actions the policy allows. |
| An agent approves its own request | Approving requires a secret printed only in the console's terminal at startup, stored in an `HttpOnly`, `SameSite=strict` cookie and compared in constant time. |
| Someone edits the history | The audit log is an append-only hash chain. `npm run audit:verify` finds the first changed or deleted line, and the console refuses to write onto a broken chain. |
| The same action runs twice by accident | Retries join the pending request; identical changing actions within 2 minutes need a human. |
| Earned trust grows too wide | Trust covers only the exact agent, tool, target and environment, with numbers capped at what humans approved. Rules marked `neverAutoTrust` can never be loosened. |
| Other devices on your network reach the console | The console listens on `127.0.0.1` only. |
| A malicious website calls the console from your browser | API requests must be addressed to `localhost` (blocks DNS rebinding), and state-changing requests from other origins are rejected. |
| Clickjacking, content injection, referrer leaks | Strict Content-Security-Policy, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff`. |

## The public website

The hosted site is **demo-only**. Both demos run entirely in the visitor's browser; the live API is switched off and returns 404. It sets no cookies and uses no analytics, trackers or third-party scripts.

## Known limits

- Anything that can read the console's terminal output can read the approval link. On a single machine where the agent runs as the same user, this reduces the risk but doesn't remove it. A team deployment should approve from a separate device.
- The audit log is tamper-*evident*, not tamper-*proof*: deleting the whole file isn't prevented. Copying the log to separate storage is the next step.
- Local agent-to-console calls are unauthenticated unless `AEGIS_API_KEY` is set.

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's **private vulnerability reporting** on this repository (Security tab → "Report a vulnerability").
