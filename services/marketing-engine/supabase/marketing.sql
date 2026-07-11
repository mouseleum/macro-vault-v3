-- Marketing engine schema. Run in the Supabase SQL Editor of the project the
-- engine points at (can be the vault's Supabase project or a separate one).

create table if not exists public.marketing_drafts (
  id uuid primary key default gen_random_uuid(),
  project text not null,
  highlight_id text not null,
  content_hash text not null unique,
  type text not null default 'stat'
    check (type in ('alert', 'stat', 'surprise', 'event', 'milestone')),
  headline text not null,
  narrative text not null,
  severity text not null default 'medium'
    check (severity in ('low', 'medium', 'high', 'extreme')),
  metrics jsonb not null default '[]',
  sparkline jsonb,
  media jsonb,
  link text,
  tags text[] not null default '{}',
  copy jsonb not null default '{}',
  score numeric not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'published')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists marketing_drafts_status_idx on public.marketing_drafts (status, created_at desc);
create index if not exists marketing_drafts_project_idx on public.marketing_drafts (project, created_at desc);

create table if not exists public.marketing_posts (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.marketing_drafts(id) on delete cascade,
  channel text not null
    check (channel in ('zapier', 'bluesky', 'x', 'linkedin')),
  external_id text,
  url text,
  status text not null default 'posted'
    check (status in ('posted', 'failed', 'skipped', 'dry_run')),
  error text,
  posted_at timestamptz not null default now()
);

create index if not exists marketing_posts_draft_idx on public.marketing_posts (draft_id, posted_at desc);

-- Safe to re-run on deployments created before the media column existed.
alter table public.marketing_drafts add column if not exists media jsonb;

-- The engine talks to Supabase with the service-role key only; keep RLS on so
-- anon/authenticated roles have no access.
alter table public.marketing_drafts enable row level security;
alter table public.marketing_posts enable row level security;
