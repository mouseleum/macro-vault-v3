-- Macro Vault v3 additive migration for an existing Supabase database.
--
-- Do not run this until after reviewing diagnostics.
-- This is intentionally additive: it avoids dropping or renaming existing data.

alter table public.macro_series
  add column if not exists unit text,
  add column if not exists created_at timestamptz not null default now();

alter table public.macro_observations
  add column if not exists metadata jsonb default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

-- Needed for upsert(..., { onConflict: "provider,series_code,country_code" }).
create unique index if not exists macro_series_provider_series_code_country_code_key
  on public.macro_series (provider, series_code, country_code);

-- Needed for upsert(..., { onConflict: "series_id,date" }).
create unique index if not exists macro_observations_series_id_date_key
  on public.macro_observations (series_id, date);

-- Ensure observation rows point to series rows.
do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'macro_observations'
      and constraint_type = 'FOREIGN KEY'
      and constraint_name = 'macro_observations_series_id_fkey'
  ) then
    alter table public.macro_observations
      add constraint macro_observations_series_id_fkey
      foreign key (series_id)
      references public.macro_series(id)
      on delete cascade;
  end if;
end $$;
