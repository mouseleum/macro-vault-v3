import { NextRequest, NextResponse } from "next/server";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { recordSyncRun } from "@/lib/sync-log";

export const runtime = "nodejs";

// Planetary K-index (geomagnetic storm level). Spikes (Kp >= 5) flag grid/GPS
// disruption risk that markets rarely price. The 1-minute feed is a rolling
// window; this connector runs daily and upserts the daily maximum.
const SOURCE_URL = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";

type KpRecord = {
  time_tag?: string;
  kp_index?: number | string;
};

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const supabase = createSupabaseAdmin();

  try {
    const response = await fetch(SOURCE_URL, { cache: "no-store" });
    if (!response.ok) {
      await recordSyncRun(supabase, {
        connector: "noaa_swpc",
        action: "planetary_k_index",
        status: "failed",
        startedAt,
        durationMs: Date.now() - startedMs,
        failedCount: 1,
        error: `NOAA SWPC request failed: ${response.status}`
      });
      return NextResponse.json({ error: "NOAA SWPC request failed", status: response.status }, { status: 502 });
    }

    const payload = (await response.json()) as KpRecord[];
    const records = Array.isArray(payload) ? payload : [];

    // Reduce 1-minute samples to the daily maximum Kp.
    const dailyMax = new Map<string, number>();
    for (const record of records) {
      if (!record.time_tag) continue;
      const value = Number(record.kp_index);
      if (!Number.isFinite(value)) continue;
      const date = record.time_tag.slice(0, 10);
      const current = dailyMax.get(date);
      if (current === undefined || value > current) dailyMax.set(date, value);
    }

    const rows = Array.from(dailyMax.entries()).map(([date, value]) => ({ date, value }));

    const { data: series, error: seriesError } = await supabase
      .from("macro_series")
      .upsert(
        {
          provider: "noaa_swpc",
          series_code: "NOAA_PLANETARY_KP",
          name: "Planetary K-index (daily maximum)",
          country_code: "WLD",
          unit: "Kp (0-9)",
          metadata: {
            source: "NOAA Space Weather Prediction Center",
            sourceUrl: SOURCE_URL,
            aggregation: "daily_max"
          },
          last_synced: new Date().toISOString()
        },
        { onConflict: "provider,series_code,country_code" }
      )
      .select("id, series_code")
      .single();

    if (seriesError) throw seriesError;

    if (rows.length > 0) {
      const { error: obsError } = await supabase.from("macro_observations").upsert(
        rows.map((row) => ({
          series_id: series.id,
          date: row.date,
          value: row.value,
          metadata: { source: "NOAA SWPC", aggregation: "daily_max" }
        })),
        { onConflict: "series_id,date" }
      );

      if (obsError) throw obsError;
    }

    await recordSyncRun(supabase, {
      connector: "noaa_swpc",
      action: "planetary_k_index",
      status: "success",
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries: 1,
      totalObservations: rows.length,
      details: { days: rows.length }
    });

    return NextResponse.json({
      ok: true,
      seriesCode: series.series_code,
      totalSeries: 1,
      totalObservations: rows.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    await recordSyncRun(supabase, {
      connector: "noaa_swpc",
      action: "planetary_k_index",
      status: "failed",
      startedAt,
      durationMs: Date.now() - startedMs,
      failedCount: 1,
      error: error instanceof Error ? error.message : "Unknown NOAA SWPC sync error"
    }).catch(() => {});
    return jsonError(error);
  }
}
