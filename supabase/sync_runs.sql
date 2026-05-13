create table if not exists public.sync_runs (
  id uuid primary key default uuid_generate_v4(),
  connector text not null,
  action text not null,
  status text not null check (status in ('success', 'partial', 'failed')),
  started_at timestamp with time zone not null default now(),
  finished_at timestamp with time zone not null default now(),
  duration_ms integer,
  total_series integer not null default 0,
  total_observations integer not null default 0,
  failed_count integer not null default 0,
  error text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now()
);

create index if not exists sync_runs_started_at_idx
  on public.sync_runs (started_at desc);

create index if not exists sync_runs_connector_started_at_idx
  on public.sync_runs (connector, started_at desc);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.sync_runs to service_role;
grant select on public.sync_runs to anon, authenticated;

alter table public.sync_runs enable row level security;

drop policy if exists "No browser access to sync runs" on public.sync_runs;
create policy "No browser access to sync runs"
  on public.sync_runs
  for all
  using (false)
  with check (false);

select pg_notify('pgrst', 'reload schema');
