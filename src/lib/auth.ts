// Agent authentication. If AEGIS_API_KEY is set (production), agent-facing
// endpoints require `Authorization: Bearer <key>`. Unset (local dev) = open.

export function agentAuthorized(req: Request): boolean {
  const required = process.env.AEGIS_API_KEY;
  if (!required) return true;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${required}`;
}
