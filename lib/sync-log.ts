import type { createSupabaseAdmin } from "./supabase-server";

export type SyncRunStatus = "success" | "partial" | "failed";

export type SyncRunRecord = {
  id: string;
  connector: string;
  action: string;
  status: SyncRunStatus;
  started_at: string;
  finished_at: string;
  duration_ms: number | null;
  total_series: number;
  total_observations: number;
  failed_count: number;
  error: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
};

type SupabaseAdmin = ReturnType<typeof createSupabaseAdmin>;
const fallbackProvider = "vault_system";
const fallbackSeriesCode = "SYNC_RUNS";
const fallbackCountry = "WLD";

type RecordSyncRunInput = {
  connector: string;
  action: string;
  status: SyncRunStatus;
  startedAt: string;
  durationMs: number;
  totalSeries?: number;
  totalObservations?: number;
  failedCount?: number;
  error?: string | null;
  details?: Record<string, unknown>;
};

export function getSyncRunStatus(totalSeries: number, failedCount: number): SyncRunStatus {
  if (failedCount > 0 && totalSeries === 0) return "failed";
  if (failedCount > 0) return "partial";
  return "success";
}

function isSyncRunsUnavailable(error: { code?: string; message?: string }) {
  return error.code === "42P01" || error.code === "PGRST205" || error.message?.includes("sync_runs");
}

function buildSyncRunRecord(input: RecordSyncRunInput): SyncRunRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    connector: input.connector,
    action: input.action,
    status: input.status,
    started_at: input.startedAt,
    finished_at: now,
    duration_ms: input.durationMs,
    total_series: input.totalSeries ?? 0,
    total_observations: input.totalObservations ?? 0,
    failed_count: input.failedCount ?? 0,
    error: input.error ?? null,
    details: input.details ?? {},
    created_at: now
  };
}

function normalizeFallbackRuns(value: unknown): SyncRunRecord[] {
  if (!value || typeof value !== "object") return [];
  const runs = (value as { runs?: unknown }).runs;
  return Array.isArray(runs) ? (runs as SyncRunRecord[]) : [];
}

export async function getFallbackSyncRuns(supabase: SupabaseAdmin, limit = 30) {
  const { data, error } = await supabase
    .from("macro_series")
    .select("metadata")
    .eq("provider", fallbackProvider)
    .eq("series_code", fallbackSeriesCode)
    .eq("country_code", fallbackCountry)
    .maybeSingle();

  if (error) throw error;

  return normalizeFallbackRuns(data?.metadata)
    .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
    .slice(0, limit);
}

async function recordFallbackSyncRun(supabase: SupabaseAdmin, record: SyncRunRecord) {
  const existingRuns = await getFallbackSyncRuns(supabase, 100).catch(() => []);
  const runs = [record, ...existingRuns].slice(0, 100);

  const { error } = await supabase.from("macro_series").upsert(
    {
      provider: fallbackProvider,
      series_code: fallbackSeriesCode,
      country_code: fallbackCountry,
      name: "Sync Run Fallback Log",
      unit: "runs",
      metadata: {
        fallback: true,
        source: "macro_series.metadata",
        runs
      },
      last_synced: new Date().toISOString()
    },
    { onConflict: "provider,series_code,country_code" }
  );

  if (error) {
    console.warn(`Unable to record fallback sync run for ${record.connector}: ${error.message}`);
  }
}

export async function recordSyncRun(supabase: SupabaseAdmin, input: RecordSyncRunInput) {
  const record = buildSyncRunRecord(input);
  const { error } = await supabase.from("sync_runs").insert(record);

  if (error && isSyncRunsUnavailable(error)) {
    await recordFallbackSyncRun(supabase, record);
    return;
  }

  if (error) {
    console.warn(`Unable to record sync run for ${input.connector}: ${error.message}`);
  }
}
