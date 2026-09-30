// Supabase server-side client. Aegis uses the service-role key from API routes
// only — never expose it to the browser. When the env vars are missing (local
// dev without setup), the store falls back to in-memory automatically.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null | undefined;

export function getDb(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  client = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return client;
}
