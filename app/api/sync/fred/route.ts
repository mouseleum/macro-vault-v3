import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { getOptionalEnv } from "@/lib/env";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getSyncRunStatus, recordSyncRun } from "@/lib/sync-log";

export const runtime = "nodejs";

const fredBundle = [
  { id: "CPIAUCSL", name: "Consumer Price Index for All Urban Consumers", unit: "index 1982-1984=100" },
  { id: "CPILFESL", name: "Core Consumer Price Index", unit: "index 1982-1984=100" },
  { id: "PCEPI", name: "Personal Consumption Expenditures Price Index", unit: "index 2017=100" },
  { id: "UNRATE", name: "US Unemployment Rate", unit: "percent" },
  { id: "PAYEMS", name: "All Employees Total Nonfarm Payrolls", unit: "thousands of persons" },
  { id: "FEDFUNDS", name: "Effective Federal Funds Rate", unit: "percent" },
  { id: "DGS2", name: "2-Year Treasury Constant Maturity Rate", unit: "percent" },
  { id: "DGS10", name: "10-Year Treasury Constant Maturity Rate", unit: "percent" },
  { id: "T10Y2Y", name: "10-Year Minus 2-Year Treasury Spread", unit: "percent" },
  { id: "WALCL", name: "Federal Reserve Total Assets", unit: "millions of dollars" },
  { id: "RRPONTTLD", name: "Overnight Reverse Repurchase Agreements Total Securities Sold", unit: "billions of dollars" },
  { id: "WRESBAL", name: "Reserve Balances with Federal Reserve Banks", unit: "billions of dollars" },
  { id: "M2SL", name: "M2 Money Stock", unit: "billions of dollars" },
  { id: "BAMLH0A0HYM2", name: "US High Yield Option-Adjusted Spread", unit: "percent" },
  { id: "VIXCLS", name: "CBOE Volatility Index", unit: "index" }
];

const requestSchema = z.object({
  seriesIds: z.array(z.string().min(1)).optional(),
  observationStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2015-01-01")
});

type FredObservation = {
  date: string;
  value: string;
};

type FredSeries = (typeof fredBundle)[number];

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);

function normalizeFredValue(value: string) {
  if (value === ".") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getFredSeries(inputIds: string[] | undefined) {
  if (!inputIds?.length) return fredBundle;

  const wanted = new Set(inputIds.map((id) => id.toUpperCase()));
  return fredBundle.filter((series) => wanted.has(series.id));
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFredObservations(series: FredSeries, apiKey: string, observationStart: string) {
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("series_id", series.id);
  url.searchParams.set("observation_start", observationStart);
  url.searchParams.set("sort_order", "asc");

  let response: Response | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    response = await fetch(url, { cache: "no-store" });

    if (response.ok) break;

    if (!retryableStatuses.has(response.status) || attempt === 3) {
      throw new Error(`FRED request failed for ${series.id}: ${response.status}`);
    }

    await wait(attempt * 500);
  }

  if (!response?.ok) {
    throw new Error(`FRED request failed for ${series.id}: no response`);
  }

  const payload = await response.json();
  const observations = Array.isArray(payload?.observations) ? (payload.observations as FredObservation[]) : [];

  return observations
    .map((item) => ({
      date: item.date,
      value: normalizeFredValue(item.value)
    }))
    .filter((item): item is { date: string; value: number } => item.value !== null);
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const apiKey = getOptionalEnv("FRED_API_KEY");
    if (!apiKey) {
      return NextResponse.json({ error: "Missing optional server variable: FRED_API_KEY" }, { status: 400 });
    }

    const body = request.headers.get("content-length") === "0" ? {} : await request.json().catch(() => ({}));
    const input = requestSchema.parse(body);
    const requestedSeries = getFredSeries(input.seriesIds);

    if (!requestedSeries.length) {
      return NextResponse.json({ error: "No supported FRED series requested." }, { status: 400 });
    }

    const supabase = createSupabaseAdmin();
    const synced = [];
    const failed = [];

    for (const item of requestedSeries) {
      try {
        const rows = await fetchFredObservations(item, apiKey, input.observationStart);

        const { data: series, error: seriesError } = await supabase
          .from("macro_series")
          .upsert(
            {
              provider: "fred",
              series_code: `FRED_${item.id}`,
              name: item.name,
              country_code: "US",
              unit: item.unit,
              metadata: {
                fredSeriesId: item.id,
                source: "Federal Reserve Economic Data",
                observationStart: input.observationStart
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
              metadata: { fredSeriesId: item.id }
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
          fredSeriesId: item.id,
          error: error instanceof Error ? error.message : "Unknown FRED sync error"
        });
      }
    }

    const totalSeries = synced.length;
    const totalObservations = synced.reduce((sum, item) => sum + item.observations, 0);
    await recordSyncRun(supabase, {
      connector: "fred",
      action: "us_macro_liquidity_bundle",
      status: getSyncRunStatus(totalSeries, failed.length),
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries,
      totalObservations,
      failedCount: failed.length,
      details: {
        observationStart: input.observationStart,
        requestedSeries: requestedSeries.map((series) => series.id),
        synced,
        failed
      }
    });

    return NextResponse.json({
      ok: true,
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
