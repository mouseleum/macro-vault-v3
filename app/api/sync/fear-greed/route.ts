import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { recordSyncRun } from "@/lib/sync-log";

export const runtime = "nodejs";

const requestSchema = z.object({
  limit: z.number().int().min(0).max(5000).default(0)
});

type FearGreedObservation = {
  value: string;
  value_classification: string;
  timestamp: string;
  time_until_update?: string;
};

function unixDateToIso(value: string) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const supabase = createSupabaseAdmin();
    const body = request.headers.get("content-length") === "0" ? {} : await request.json().catch(() => ({}));
    const input = requestSchema.parse(body);

    const url = new URL("https://api.alternative.me/fng/");
    url.searchParams.set("limit", String(input.limit));
    url.searchParams.set("format", "json");

    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      await recordSyncRun(supabase, {
        connector: "alternative_me",
        action: "fear_greed",
        status: "failed",
        startedAt,
        durationMs: Date.now() - startedMs,
        failedCount: 1,
        error: `Alternative.me request failed: ${response.status}`,
        details: { limit: input.limit }
      });
      return NextResponse.json({ error: "Alternative.me request failed", status: response.status }, { status: 502 });
    }

    const payload = await response.json();
    const observations = Array.isArray(payload?.data) ? (payload.data as FearGreedObservation[]) : [];

    const rows = Array.from(
      new Map(
        observations
          .map((item) => {
            const date = unixDateToIso(item.timestamp);
            const value = Number(item.value);
            if (!date || !Number.isFinite(value)) return null;

            return [
              date,
              {
                date,
                value,
                classification: item.value_classification,
                timeUntilUpdate: item.time_until_update ? Number(item.time_until_update) : null
              }
            ] as const;
          })
          .filter((item): item is readonly [string, { date: string; value: number; classification: string; timeUntilUpdate: number | null }] =>
            Boolean(item)
          )
      ).values()
    );

    const { data: series, error: seriesError } = await supabase
      .from("macro_series")
      .upsert(
        {
          provider: "alternative_me",
          series_code: "ALT_FNG",
          name: "Crypto Fear and Greed Index",
          country_code: "WLD",
          unit: "0-100 sentiment score",
          metadata: {
            source: "Alternative.me Fear and Greed Index API",
            sourceUrl: url.toString(),
            attribution: "Data from Alternative.me"
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
          metadata: {
            classification: row.classification,
            timeUntilUpdate: row.timeUntilUpdate,
            attribution: "Data from Alternative.me"
          }
        })),
        { onConflict: "series_id,date" }
      );

      if (obsError) throw obsError;
    }

    await recordSyncRun(supabase, {
      connector: "alternative_me",
      action: "fear_greed",
      status: "success",
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries: 1,
      totalObservations: rows.length,
      details: {
        limit: input.limit,
        seriesCode: series.series_code,
        observations: rows.length
      }
    });

    return NextResponse.json({
      ok: true,
      seriesCode: series.series_code,
      observations: rows.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return jsonError(error);
  }
}
