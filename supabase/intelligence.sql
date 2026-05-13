create table if not exists public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_url text,
  source_type text not null default 'manual_paste',
  source_tier text not null default 'user_supplied'
    check (source_tier in ('user_supplied', 'public_web', 'licensed', 'internal', 'unknown')),
  content_text text not null,
  summary text,
  tags text[] not null default '{}',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.intelligence_candidates (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'promoted')),
  signal_type text not null default 'numeric_observation'
    check (signal_type in ('numeric_observation', 'event', 'document_note')),
  title text not null,
  provider text,
  series_code text,
  country_code text,
  date date,
  value numeric,
  unit text,
  narrative text,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  source_document_id uuid references public.knowledge_documents(id) on delete set null,
  source_url text,
  source_title text,
  source_tier text not null default 'unknown'
    check (source_tier in ('user_supplied', 'public_web', 'licensed', 'internal', 'unknown')),
  extraction_method text not null default 'manual',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists public.macro_events (
  id uuid primary key default gen_random_uuid(),
  event_date date not null,
  title text not null,
  narrative text not null,
  category text,
  country_code text,
  region text,
  impact_score numeric check (impact_score is null or (impact_score >= -100 and impact_score <= 100)),
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  source_url text,
  source_title text,
  source_tier text not null default 'unknown'
    check (source_tier in ('user_supplied', 'public_web', 'licensed', 'internal', 'unknown')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists knowledge_documents_created_idx
  on public.knowledge_documents (created_at desc);

create index if not exists knowledge_documents_tags_idx
  on public.knowledge_documents using gin (tags);

create index if not exists intelligence_candidates_status_created_idx
  on public.intelligence_candidates (status, created_at desc);

create index if not exists intelligence_candidates_series_date_idx
  on public.intelligence_candidates (provider, series_code, country_code, date desc);

create index if not exists macro_events_date_idx
  on public.macro_events (event_date desc);

alter table public.knowledge_documents enable row level security;
alter table public.intelligence_candidates enable row level security;
alter table public.macro_events enable row level security;

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete, references, trigger, truncate
  on public.knowledge_documents to service_role;
grant select, insert, update, delete, references, trigger, truncate
  on public.intelligence_candidates to service_role;
grant select, insert, update, delete, references, trigger, truncate
  on public.macro_events to service_role;

-- Keep anon/authenticated table privileges narrow. RLS remains enabled and no
-- public policies are created, so browser clients cannot read or mutate rows.
grant select on public.knowledge_documents to anon, authenticated;
grant select on public.intelligence_candidates to anon, authenticated;
grant select on public.macro_events to anon, authenticated;

notify pgrst, 'reload schema';

-- MVP stance: Next.js server routes use the Supabase service role for writes.
