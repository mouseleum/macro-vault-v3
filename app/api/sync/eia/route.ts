import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { getOptionalEnv } from "@/lib/env";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getSyncRunStatus, recordSyncRun } from "@/lib/sync-log";

export const runtime = "nodejs";

const eiaBundle = [
  { id: "PET.RWTC.D", name: "WTI Crude Oil Spot Price", unit: "dollars per barrel", country: "US" },
  { id: "PET.RBRTE.D", name: "Brent Crude Oil Spot Price", unit: "dollars per barrel", country: "WLD" },
  { id: "NG.RNGWHHD.D", name: "Henry Hub Natural Gas Spot Price", unit: "dollars per MMBtu", country: "US" },
  { id: "PET.WCESTUS1.W", name: "US Commercial Crude Oil Stocks ex-SPR", unit: "thousand barrels", country: "US" },
  { id: "PET.WGTSTUS1.W", name: "US Total Motor Gasoline Stocks", unit: "thousand barrels", country: "US" },
  { id: "PET.WDISTUS1.W", name: "US Distillate Fuel Oil Stocks", unit: "thousand barrels", country: "US" },
  { id: "PET.WCRFPUS2.W", name: "US Crude Oil Field Production", unit: "thousand barrels per day", country: "US" },
  { id: "PET.WPULEUS3.W", name: "US Refinery Utilization Rate", unit: "percent", country: "US" }
];

const requestSchema = z.object({
  seriesIds: z.array(z.string().min(1)).optional(),
  observationStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2020-01-01"),
  limit: z.coerce.number().int().min(1).max(10000).default(5000)
});

type EiaSeries = (typeof eiaBundle)[number];
type EiaDataRow = {
  period?: unknown;
  value?: unknown;
};

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);

function normalizeSeriesCode(eiaSeriesId: string) {
  return `EIA_${eiaSeriesId.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()}`;
}

function normalizePeriod(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{4}-\d{2}$/.test(trimmed)) return `${trimmed}-01`;
  if (/^\d{8}$/.test(trimmed)) return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
  if (/^\d{6}$/.test(trimmed)) return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-01`;
  if (/^\d{4}$/.test(trimmed)) return `${trimmed}-01-01`;

  return null;
}

function normalizeValue(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getEiaSeries(inputIds: string[] | undefined) {
  if (!inputIds?.length) return eiaBundle;

  const wanted = new Set(inputIds.map((id) => id.toUpperCase()));
  return eiaBundle.filter((series) => wanted.has(series.id.toUpperCase()));
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEiaPayload(payload: unknown) {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const response = record.response && typeof record.response === "object" ? (record.response as Record<string, unknown>) : {};
  const v2Rows = Array.isArray(response.data) ? (response.data as EiaDataRow[]) : null;

  if (v2Rows) {
    return v2Rows
      .map((row) => ({
        date: normalizePeriod(row.period),
        value: normalizeValue(row.value)
      }))
      .filter((row): row is { date: string; value: number } => Boolean(row.date) && row.value !== null);
  }

  const series = Array.isArray(record.series) ? record.series[0] : null;
  const seriesRecord = series && typeof series === "object" ? (series as Record<string, unknown>) : {};
  const legacyRows = Array.isArray(seriesRecord.data) ? seriesRecord.data : [];

  return legacyRows
    .map((row) => (Array.isArray(row) ? { date: normalizePeriod(row[0]), value: normalizeValue(row[1]) } : null))
    .filter((row): row is { date: string; value: number } => Boolean(row?.date) && row?.value !== null);
}

async function fetchWithRetries(url: URL) {
  let response: Response | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    response = await fetch(url, { cache: "no-store" });
    if (response.ok) return response;

    if (!retryableStatuses.has(response.status) || attempt === 3) {
      return response;
    }

    await wait(attempt * 500);
  }

  return response;
}

async function fetchEiaObservations(series: EiaSeries, apiKey: string, observationStart: string, limit: number) {
  const v2Url = new URL(`https://api.eia.gov/v2/seriesid/${series.id}`);
  v2Url.searchParams.set("api_key", apiKey);
  v2Url.searchParams.set("start", observationStart);
  v2Url.searchParams.set("sort[0][column]", "period");
  v2Url.searchParams.set("sort[0][direction]", "asc");
  v2Url.searchParams.set("length", String(limit));

  const v2Response = await fetchWithRetries(v2Url);
  if (v2Response?.ok) {
    const payload = await v2Response.json();
    return parseEiaPayload(payload)
      .filter((row) => row.date >= observationStart)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-limit);
  }

  const legacyUrl = new URL("https://api.eia.gov/series/");
  legacyUrl.searchParams.set("api_key", apiKey);
  legacyUrl.searchParams.set("series_id", series.id);

  const legacyResponse = await fetchWithRetries(legacyUrl);
  if (!legacyResponse?.ok) {
    throw new Error(`EIA request failed for ${series.id}: HTTP ${legacyResponse?.status ?? "no response"}`);
  }

  const payload = await legacyResponse.json();
  return parseEiaPayload(payload)
    .filter((row) => row.date >= observationStart)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-limit);
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const apiKey = getOptionalEnv("EIA_API_KEY");
    if (!apiKey) {
      return NextResponse.json({ error: "Missing optional server variable: EIA_API_KEY" }, { status: 400 });
    }

    const body = request.headers.get("content-length") === "0" ? {} : await request.json().catch(() => ({}));
    const input = requestSchema.parse(body);
    const requestedSeries = getEiaSeries(input.seriesIds);

    if (!requestedSeries.length) {
      return NextResponse.json({ error: "No supported EIA series requested." }, { status: 400 });
    }

    const supabase = createSupabaseAdmin();
    const synced = [];
    const failed = [];

    for (const item of requestedSeries) {
      try {
        const rows = await fetchEiaObservations(item, apiKey, input.observationStart, input.limit);
        const seriesCode = normalizeSeriesCode(item.id);

        const { data: series, error: seriesError } = await supabase
          .from("macro_series")
          .upsert(
            {
              provider: "eia",
              series_code: seriesCode,
              name: item.name,
              country_code: item.country,
              unit: item.unit,
              metadata: {
                eiaSeriesId: item.id,
                source: "U.S. Energy Information Administration",
                observationStart: input.observationStart,
                sourceUrl: `https://api.eia.gov/v2/seriesid/${item.id}`
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
              metadata: { eiaSeriesId: item.id }
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
          eiaSeriesId: item.id,
          error: error instanceof Error ? error.message : "Unknown EIA sync error"
        });
      }
    }

    const totalSeries = synced.length;
    const totalObservations = synced.reduce((sum, item) => sum + item.observations, 0);
    await recordSyncRun(supabase, {
      connector: "eia",
      action: "physical_energy_bundle",
      status: getSyncRunStatus(totalSeries, failed.length),
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries,
      totalObservations,
      failedCount: failed.length,
      details: {
        observationStart: input.observationStart,
        limit: input.limit,
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
