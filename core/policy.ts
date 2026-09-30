// Loading and validating a policy file. Validation is strict on purpose:
// a misspelled field like "enviroment" would otherwise be ignored, turning
// "allow in staging" into "allow everywhere".

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { parseCondition } from "./match";
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
    when: z.string().optional(),
    decision: z.enum(["allow", "escalate"]),
  })
  .refine((r) => (r.match && Object.keys(r.match).length > 0) || r.when, {
    message: "A rule must say what it matches (match or when). A rule that matches everything is almost always a mistake.",
  })
  .refine(
    (r) => {
      if (!r.when) return true;
      try {
        parseCondition(r.when);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid "when" condition. Expected something like "params.replicas <= 5".' },
  );

const policySchema = z.strictObject({ rules: z.array(ruleSchema) });

export function parsePolicy(yamlText: string): Policy {
  const result = policySchema.safeParse(parse(yamlText));
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Policy file is invalid:\n${problems}`);
  }
  return result.data;
}

export function loadPolicy(path: string): Policy {
  return parsePolicy(readFileSync(path, "utf8"));
}
