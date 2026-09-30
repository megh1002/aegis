// Who is allowed to approve. The console makes a random secret when it
// starts and prints a link containing it in the terminal where it runs.
// Opening that link in a browser stores the secret in a cookie, and only
// requests carrying it can approve or reject.
//
// Why: the agent Aegis supervises can often run commands on the same
// machine, including calling the console's API. Without this it could
// approve its own requests. The secret only ever appears in the console's
// terminal and the approver's browser cookie; it is never written to disk.
// (Anything that can read that terminal can still approve. See DECISIONS.md.)

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const APPROVER_COOKIE = "aegis_approver";

const g = globalThis as unknown as { __aegisApproverToken?: string };

export function approverToken(): string {
  return (g.__aegisApproverToken ??= process.env.AEGIS_APPROVER_TOKEN || randomBytes(24).toString("base64url"));
}

// Compare fixed-length hashes in constant time, so response timing can't
// leak how many characters of a guess were right.
export function isApprover(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(approverToken()).digest();
  return timingSafeEqual(a, b);
}
