-- Macro Vault v3 compatibility check for an existing Supabase database.
-- Safe to run: these queries only read metadata.
--
-- Run each query block separately in Supabase SQL Editor and send the result tables.

-- 1) Do the two expected tables and columns exist?
select
  table_name,
  ordinal_position,
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('macro_series', 'macro_observations')
order by table_name, ordinal_position;

-- 2) Do the required unique / foreign-key constraints exist?
select
  tc.table_name,
  tc.constraint_type,
  tc.constraint_name,
  string_agg(kcu.column_name, ', ' order by kcu.ordinal_position) as columns
from information_schema.table_constraints tc
left join information_schema.key_column_usage kcu
  on kcu.constraint_schema = tc.constraint_schema
 and kcu.constraint_name = tc.constraint_name
 and kcu.table_schema = tc.table_schema
 and kcu.table_name = tc.table_name
where tc.table_schema = 'public'
  and tc.table_name in ('macro_series', 'macro_observations')
group by tc.table_name, tc.constraint_type, tc.constraint_name
order by tc.table_name, tc.constraint_type, tc.constraint_name;

-- 3) Is row level security enabled on these tables?
select
  n.nspname as schema_name,
  c.relname as table_name,
  c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('macro_series', 'macro_observations')
  and c.relkind = 'r'
order by c.relname;
