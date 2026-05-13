import type { SupabaseClient } from "@supabase/supabase-js";
import type { MacroSeries, Observation } from "@/types/vault";

const seriesSelect = "id, provider, series_code, name, country_code, unit, metadata, last_synced";
const observationSelect = "id, series_id, date, value, metadata, created_at";

export type SeriesLocator = {
  code: string;
  provider?: string | null;
  country?: string | null;
};

export type SeriesFilters = {
  provider?: string | null;
  country?: string | null;
  q?: string | null;
  limit?: number;
};

export type ObservationFilters = {
  limit: number;
  start?: string | null;
  end?: string | null;
  order?: "asc" | "desc";
};

export function clampLimit(value: string | null, fallback = 50, max = 500) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), max) : fallback;
}

export async function listSeries(supabase: SupabaseClient, filters: SeriesFilters) {
  let query = supabase.from("macro_series").select(seriesSelect);

  if (filters.provider) query = query.eq("provider", filters.provider);
  if (filters.country) query = query.eq("country_code", filters.country.toUpperCase());

  const { data, error } = await query
    .order("provider", { ascending: true })
    .order("series_code", { ascending: true });

  if (error) throw error;

  const search = filters.q?.trim().toLowerCase();
  const series = (data ?? []) as MacroSeries[];
  const filtered = search
    ? series.filter((item) =>
        [item.series_code, item.name, item.provider, item.country_code]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(search))
      )
    : series;

  return filtered.slice(0, filters.limit ?? 500);
}

export async function findSeries(supabase: SupabaseClient, locator: SeriesLocator) {
  let query = supabase.from("macro_series").select(seriesSelect).eq("series_code", locator.code);

  if (locator.provider) query = query.eq("provider", locator.provider);
  if (locator.country) query = query.eq("country_code", locator.country.toUpperCase());

  const { data, error } = await query.order("last_synced", { ascending: false }).limit(1);

  if (error) throw error;
  return ((data ?? [])[0] ?? null) as MacroSeries | null;
}

export async function listObservations(supabase: SupabaseClient, seriesId: string, filters: number | ObservationFilters) {
  const options = typeof filters === "number" ? { limit: filters, order: "desc" as const } : filters;
  let query = supabase
    .from("macro_observations")
    .select(observationSelect)
    .eq("series_id", seriesId);

  if (options.start) query = query.gte("date", options.start);
  if (options.end) query = query.lte("date", options.end);

  const { data, error } = await query.order("date", { ascending: options.order === "asc" }).limit(options.limit);

  if (error) throw error;
  return (data ?? []) as Observation[];
}

export async function getLatestObservation(supabase: SupabaseClient, seriesId: string) {
  const observations = await listObservations(supabase, seriesId, 1);
  return observations[0] ?? null;
}

export async function getLatestRegime(supabase: SupabaseClient) {
  const series = await findSeries(supabase, {
    code: "VAULT_AI_REGIME",
    provider: "vault_ai",
    country: "WLD"
  });

  if (!series) return { series: null, observation: null, regime: null };

  const observation = await getLatestObservation(supabase, series.id);
  const metadata = (observation?.metadata ?? series.metadata ?? {}) as Record<string, unknown>;
  const regime =
    "current_regime" in metadata && metadata.current_regime && typeof metadata.current_regime === "object"
      ? metadata.current_regime
      : metadata;

  return { series, observation, regime };
}
