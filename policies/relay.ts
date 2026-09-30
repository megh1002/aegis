// Relay's policy for their AI on-call agent.
// See docs/CUSTOMER_BRIEF.md for where each rule comes from.
//
// How this file works:
//   - Every rule that matches an action is considered.
//   - If ANY matching rule says escalate, a human decides (strictest wins).
//   - If NO rule matches, a human decides.

import { definePolicy } from "../core/policy";

export default definePolicy({
  rules: [
    // "Anything in staging can run freely."
    {
      name: "Staging is free",
      match: { environment: "staging" },
      decision: "allow",
    },

    // Reading logs and metrics changes nothing.
    {
      name: "Read-only tools are safe",
      match: { tool: ["read_logs", "get_metrics", "list_services", "describe_service"] },
      decision: "allow",
    },

    // "Restarting one copy of a service is fine."
    {
      name: "Restarting a single instance is fine",
      match: { tool: "restart_service" },
      when: (p) => p.instances === 1,
      decision: "allow",
    },

    // "Restarting a database ... is not."
    {
      name: "Databases always need a human",
      match: { target: ["postgres-*", "redis-*"] },
      decision: "escalate",
    },

    // "If the agent wants to add 20 servers, I might say yes to 5."
    // The typeof check matters: in JavaScript, "5" <= 5 and null <= 5 are both true.
    {
      name: "Small scale-ups are fine",
      match: { tool: "scale_service" },
      when: (p) => typeof p.replicas === "number" && p.replicas <= 5,
      decision: "allow",
    },

    // Rolling back a bad release in production affects every customer.
    {
      name: "Production rollbacks need a human",
      match: { tool: "rollback_deploy", environment: "production" },
      decision: "escalate",
    },

    // Deleting anything is never automatic, in any environment.
    {
      name: "Deleting data needs a human",
      match: { tool: ["delete_*", "drop_*"] },
      decision: "escalate",
    },
  ],
});
