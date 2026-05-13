create extension if not exists "pgcrypto";

create table if not exists public.macro_series (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  series_code text not null,
  name text not null,
  country_code text not null default 'WLD',
  unit text,
  metadata jsonb,
  last_synced timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, series_code, country_code)
);

create table if not exists public.macro_observations (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references public.macro_series(id) on delete cascade,
  date date not null,
  value double precision not null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  unique (series_id, date)
);

create index if not exists macro_observations_series_date_idx
  on public.macro_observations (series_id, date desc);

alter table public.macro_series enable row level security;
alter table public.macro_observations enable row level security;

-- MVP stance: all browser access goes through Next.js API routes.
-- The service role key bypasses RLS on the server. No public RLS policies are created yet.
