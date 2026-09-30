import { describe, expect, it } from "vitest";
import relay from "../policies/relay";
import { evaluate } from "./evaluate";
import { newCheckpointSchema } from "./schemas";
import type { Action } from "./types";

describe("What survives the trip from proxy to console", () => {
  it("keeps every verdict field the engine produces", () => {
    // Regression: escalatedBy and lockedBy were silently dropped by the API,
    // which broke earned trust in the live console.
    const action: Action = {
      agent: "a",
      tool: "restart_service",
      target: "postgres-primary",
      environment: "production",
      params: { service: "postgres-primary", environment: "production", instances: "all" },
    };
    const verdict = evaluate(action, relay);
    const parsed = newCheckpointSchema.parse({ action, verdict });
    expect(parsed.verdict).toEqual(verdict);
    expect(parsed.verdict.lockedBy).toEqual(["Changing a database needs a human"]);
  });
});
