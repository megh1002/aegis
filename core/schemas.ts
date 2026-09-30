// The shape of a checkpoint request as it crosses the network (proxy ->
// console). Lives in core so it can be tested: a field missing here is
// silently dropped on the way in.

import { z } from "zod";

const text = z.string().max(500);

export const newCheckpointSchema = z.object({
  action: z.object({
    agent: text,
    tool: text,
    target: text.optional(),
    environment: text.optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().max(2000).optional(),
  }),
  verdict: z.object({
    decision: z.enum(["allow", "escalate"]),
    matchedRules: z.array(z.string()),
    explanation: z.string(),
    // Earned trust depends on these two. Without them, trust couldn't carve
    // its exception, and hard lines could be suggested.
    escalatedBy: z.array(z.string()).optional(),
    lockedBy: z.array(z.string()).optional(),
  }),
  readOnly: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(60 * 60_000).optional(),
});
