-- Aegis schema. Run this once in the Supabase SQL editor (or `supabase db push`).

create table if not exists checkpoints (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  action text not null,
  reasoning text not null default '',
  risk text not null check (risk in ('low', 'medium', 'high')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  policy_reason text not null default '',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text
);

create index if not exists checkpoints_created_at_idx on checkpoints (created_at desc);
create index if not exists checkpoints_status_idx on checkpoints (status);

-- The app talks to Supabase with the service-role key from the server only,
-- so lock the table down for anon/authenticated clients.
alter table checkpoints enable row level security;
