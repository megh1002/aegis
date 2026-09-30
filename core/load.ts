// Loading a policy file from disk. Kept apart from policy.ts so the rules
// engine itself has no Node-only imports and can also run in the browser
// (the console's demo mode uses it).

import { pathToFileURL } from "node:url";
import { definePolicy } from "./policy";
import type { Policy } from "./types";

// Load a policy file by path (its default export).
export async function loadPolicy(path: string): Promise<Policy> {
  const mod = await import(pathToFileURL(path).href);
  return definePolicy(mod.default);
}
