-- Run in Supabase: SQL Editor -> New query -> paste -> Run.

create table if not exists public.usage_snapshots (
  id            bigint generated always as identity primary key,
  device        text        not null,
  captured_at   timestamptz not null default now(),
  block_start   timestamptz,
  block_end     timestamptz,
  total_tokens  bigint      not null default 0,
  cost_usd      numeric     not null default 0,
  is_active     boolean     not null default false,
  raw           jsonb
);

create index if not exists usage_snapshots_captured_at_idx
  on public.usage_snapshots (captured_at desc);

-- RLS is enabled with NO policies: the anon key has no access to the table.
-- The agent writes with the service_role key, which bypasses RLS.
alter table public.usage_snapshots enable row level security;

-- The only thing the anon key (the widget) can do: read the latest snapshot.
create or replace function public.latest_usage()
returns table (
  device        text,
  captured_at   timestamptz,
  block_start   timestamptz,
  block_end     timestamptz,
  total_tokens  bigint,
  cost_usd      numeric,
  is_active     boolean
)
language sql
security definer
set search_path = public
as $$
  select device, captured_at, block_start, block_end, total_tokens, cost_usd, is_active
  from public.usage_snapshots
  order by captured_at desc
  limit 1;
$$;

revoke all on function public.latest_usage() from public;
grant execute on function public.latest_usage() to anon, authenticated;

-- Optional: clean up old rows (the agent writes every ~2 min, about 720 rows per day).
-- delete from public.usage_snapshots where captured_at < now() - interval '14 days';
