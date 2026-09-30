// Defining and validating a policy. TypeScript catches mistakes while you
// type, but policies are also loaded at runtime (possibly from plain JS),
// so we check again: a misspelled field like "enviroment" would otherwise
// be ignored, turning "allow in staging" into "allow everywhere".

import { z } from "zod";
import type { Policy } from "./types";

const pattern = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const ruleSchema = z
  .strictObject({
    name: z.string().min(1),
    match: z
      .strictObject({
        agent: pattern.optional(),
        tool: pattern.optional(),
        target: pattern.optional(),
        environment: pattern.optional(),
      })
      .optional(),
    when: z.custom<(p: unknown) => boolean>((v) => typeof v === "function", {
      message: "`when` must be a function, e.g. (p) => p.replicas <= 5",
    }).optional(),
    decision: z.enum(["allow", "escalate"]),
  })
  .refine((r) => (r.match && Object.keys(r.match).length > 0) || r.when, {
    message: "A rule must say what it matches (match or when). A rule that matches everything is almost always a mistake.",
  });

const policySchema = z.strictObject({ rules: z.array(ruleSchema) });

// Wrap every policy file in this: you get autocomplete while writing it,
// and a clear error at startup if anything is wrong.
export function definePolicy(policy: Policy): Policy {
  const result = policySchema.safeParse(policy);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Policy is invalid:\n${problems}`);
  }
  return policy;
}
