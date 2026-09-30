// Check the audit log hasn't been changed since it was written.
//   npm run audit:verify [path]      (default: .aegis/audit.jsonl)

import { existsSync, readFileSync } from "node:fs";
import { verifyAudit } from "../core/audit";

const path = process.argv[2] ?? ".aegis/audit.jsonl";
if (!existsSync(path)) {
  console.log(`No audit log at ${path} yet.`);
  process.exit(0);
}
const result = verifyAudit(readFileSync(path, "utf8"));
if (result.ok) {
  console.log(`✓ ${path}: ${result.entries} entries, chain intact.`);
} else {
  console.error(`✗ ${path}: broken at line ${result.line}: ${result.problem}.`);
  process.exit(1);
}
