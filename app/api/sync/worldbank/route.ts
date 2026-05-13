import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getSyncRunStatus, recordSyncRun } from "@/lib/sync-log";

export const runtime = "nodejs";

const requestSchema = z.object({
  countryCode: z.string().min(2).max(3).default("US"),
  countryCodes: z.array(z.string().min(2).max(3)).optional(),
  indicatorCode: z.string().min(2).default("NY.GDP.MKTP.CD"),
  name: z.string().min(1).default("GDP current US$"),
  indicators: z
    .array(
      z.object({
        indicatorCode: z.string().min(2),
        name: z.string().min(1),
        unit: z.string().nullable().optional()
      })
    )
    .optional()
});

type WorldBankObservation = {
  date: string;
  value: number | null;
};

async function fetchWorldBankRows(countryCode: string, indicatorCode: string) {
  const url = `https://api.worldbank.org/v2/country/${encodeURIComponent(countryCode)}/indicator/${encodeURIComponent(
    indicatorCode
  )}?format=json&per_page=100`;
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`World Bank request failed for ${countryCode}/${indicatorCode}: ${response.status}`);
  }

  const payload = await response.json();
  const observations = Array.isArray(payload?.[1]) ? (payload[1] as WorldBankObservation[]) : [];

  return {
    url,
    rows: observations
      .filter((item) => item.value !== null && item.date)
      .map((item) => ({
        date: `${item.date}-01-01`,
        value: Number(item.value)
      }))
  };
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const body = request.headers.get("content-length") === "0" ? {} : await request.json().catch(() => ({}));
    const input = requestSchema.parse(body);
    const countries = Array.from(new Set((input.countryCodes?.length ? input.countryCodes : [input.countryCode]).map((code) => code.toUpperCase())));
    const indicators = input.indicators?.length
      ? input.indicators.map((indicator) => ({
          indicatorCode: indicator.indicatorCode.toUpperCase(),
          name: indicator.name,
          unit: indicator.unit ?? null
        }))
      : [{ indicatorCode: input.indicatorCode.toUpperCase(), name: input.name, unit: null }];
    const supabase = createSupabaseAdmin();
    const synced = [];
    const failed = [];

    for (const countryCode of countries) {
      for (const indicator of indicators) {
        try {
          const seriesCode = `WB_${countryCode}_${indicator.indicatorCode}`.replace(/[^A-Z0-9]+/g, "_");
          const { url, rows } = await fetchWorldBankRows(countryCode, indicator.indicatorCode);

          const { data: series, error: seriesError } = await supabase
            .from("macro_series")
            .upsert(
              {
                provider: "world_bank",
                series_code: seriesCode,
                name: `${indicator.name} (${countryCode})`,
                country_code: countryCode,
                unit: indicator.unit,
                metadata: {
                  indicatorCode: indicator.indicatorCode,
                  source: "World Bank API",
                  sourceUrl: url
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
                metadata: { indicatorCode: indicator.indicatorCode }
              })),
              { onConflict: "series_id,date" }
            );

            if (obsError) throw obsError;
          }

          synced.push({
            seriesCode: series.series_code,
            observations: rows.length
          });
        } catch (error) {
          failed.push({
            countryCode,
            indicatorCode: indicator.indicatorCode,
            error: error instanceof Error ? error.message : "Unknown World Bank sync error"
          });
        }
      }
    }

    const totalSeries = synced.length;
    const totalObservations = synced.reduce((sum, item) => sum + item.observations, 0);
    await recordSyncRun(supabase, {
      connector: "world_bank",
      action: "macro_bundle",
      status: getSyncRunStatus(totalSeries, failed.length),
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries,
      totalObservations,
      failedCount: failed.length,
      details: {
        countries,
        indicators: indicators.map((indicator) => indicator.indicatorCode),
        synced,
        failed
      }
    });

    return NextResponse.json({
      ok: true,
      seriesCode: synced[0]?.seriesCode ?? null,
      observations: synced[0]?.observations ?? 0,
      synced,
      failed,
      totalSeries,
      totalObservations,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return jsonError(error);
  }
}
