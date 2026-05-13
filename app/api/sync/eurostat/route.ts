import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { recordSyncRun } from "@/lib/sync-log";

export const runtime = "nodejs";

const requestSchema = z.object({
  observationStart: z.string().regex(/^\d{4}(-Q[1-4]|-\d{2})?$/).default("2020-01"),
  dryRun: z.boolean().default(false)
});

const eurostatBaseUrl = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/";

type EurostatSeries = {
  dataset: string;
  seriesCode: string;
  name: string;
  country: string;
  unit: string;
  start?: string;
  params: Record<string, string>;
};
type NormalizedRow = { date: string; value: number; metadata: Record<string, unknown> };

const eurostatBundle: EurostatSeries[] = [
  {
    dataset: "prc_hicp_minr",
    seriesCode: "EUROSTAT_EA20_HICP_YOY",
    name: "Euro Area HICP Inflation",
    country: "EMU",
    unit: "percent year over year",
    params: {
      freq: "M",
      unit: "RCH_A",
      coicop18: "TOTAL",
      geo: "EA20"
    }
  },
  {
    dataset: "prc_hicp_minr",
    seriesCode: "EUROSTAT_EU27_HICP_YOY",
    name: "EU27 HICP Inflation",
    country: "EU",
    unit: "percent year over year",
    params: {
      freq: "M",
      unit: "RCH_A",
      coicop18: "TOTAL",
      geo: "EU27_2020"
    }
  },
  {
    dataset: "une_rt_m",
    seriesCode: "EUROSTAT_EU27_UNEMPLOYMENT",
    name: "EU27 Unemployment Rate",
    country: "EU",
    unit: "percent of labor force",
    params: {
      freq: "M",
      s_adj: "SA",
      age: "TOTAL",
      unit: "PC_ACT",
      sex: "T",
      geo: "EU27_2020"
    }
  },
  {
    dataset: "namq_10_gdp",
    seriesCode: "EUROSTAT_EA20_GDP_QOQ",
    name: "Euro Area Real GDP Growth",
    country: "EMU",
    unit: "percent quarter over quarter",
    params: {
      freq: "Q",
      unit: "CLV_PCH_PRE",
      s_adj: "SCA",
      na_item: "B1GQ",
      geo: "EA20"
    }
  },
  {
    dataset: "namq_10_gdp",
    seriesCode: "EUROSTAT_EU27_GDP_QOQ",
    name: "EU27 Real GDP Growth",
    country: "EU",
    unit: "percent quarter over quarter",
    params: {
      freq: "Q",
      unit: "CLV_PCH_PRE",
      s_adj: "SCA",
      na_item: "B1GQ",
      geo: "EU27_2020"
    }
  }
] as const;

type EurostatPayload = {
  label?: string;
  updated?: string;
  value?: Record<string, unknown>;
  status?: Record<string, string>;
  id?: string[];
  size?: number[];
  dimension?: Record<
    string,
    {
      label?: string;
      category?: {
        index?: Record<string, number>;
        label?: Record<string, string>;
      };
    }
  >;
};

function numberValue(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function periodToDate(period: string) {
  const quarter = period.match(/^(\d{4})-Q([1-4])$/);
  if (quarter) {
    const month = String((Number(quarter[2]) - 1) * 3 + 1).padStart(2, "0");
    return `${quarter[1]}-${month}-01`;
  }

  if (/^\d{4}-\d{2}$/.test(period)) return `${period}-01`;
  if (/^\d{4}$/.test(period)) return `${period}-01-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) return period;
  return null;
}

function normalizeStart(start: string, fallback: string) {
  if (/^\d{4}$/.test(start)) return `${start}-01`;
  if (/^\d{4}-\d{2}$/.test(start) || /^\d{4}-Q[1-4]$/.test(start)) return start;
  return fallback;
}

function buildSourceUrl(series: EurostatSeries, observationStart: string) {
  const url = new URL(series.dataset, eurostatBaseUrl);
  url.searchParams.set("format", "JSON");
  url.searchParams.set("lang", "EN");
  for (const [key, value] of Object.entries(series.params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("sinceTimePeriod", series.start ?? observationStart);
  return url;
}

async function fetchEurostatSeries(series: EurostatSeries, observationStart: string) {
  const url = buildSourceUrl(series, observationStart);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Eurostat request failed for ${series.seriesCode}: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as EurostatPayload;
  return { payload, sourceUrl: url.toString() };
}

function extractRows(payload: EurostatPayload, source: EurostatSeries) {
  const ids = payload.id ?? [];
  const timeDimension = payload.dimension?.time?.category?.index ?? {};
  const entries = Object.entries(timeDimension)
    .map(([period, index]) => ({ period, index }))
    .sort((a, b) => a.index - b.index);
  const timePosition = ids.indexOf("time");
  const timeStride = timePosition >= 0 ? (payload.size ?? []).slice(timePosition + 1).reduce((product, size) => product * size, 1) : 1;
  const values = payload.value ?? {};

  return entries
    .map<NormalizedRow | null>(({ period, index }) => {
      const flatIndex = String(index * timeStride);
      const value = numberValue(values[flatIndex]);
      const date = periodToDate(period);
      if (!date || value === null) return null;

      return {
        date,
        value,
        metadata: {
          source: "Eurostat",
          dataset: source.dataset,
          period,
          status: payload.status?.[flatIndex] ?? null,
          updated: payload.updated ?? null
        }
      };
    })
    .filter((row): row is NormalizedRow => row !== null);
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const supabase = createSupabaseAdmin();

  try {
    const body = request.headers.get("content-length") === "0" ? {} : await request.json().catch(() => ({}));
    const input = requestSchema.parse(body);
    const observationStart = normalizeStart(input.observationStart, "2020-01");
    const fetched = await Promise.all(eurostatBundle.map(async (series) => ({ series, ...(await fetchEurostatSeries(series, observationStart)) })));
    const normalized = fetched.map(({ series, payload, sourceUrl }) => ({
      series,
      payload,
      sourceUrl,
      rows: extractRows(payload, series)
    }));

    if (input.dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        totalSeries: normalized.length,
        totalObservations: normalized.reduce((sum, item) => sum + item.rows.length, 0),
        synced: normalized.map((item) => ({
          seriesCode: item.series.seriesCode,
          observations: item.rows.length,
          latest: item.rows.at(-1) ?? null
        })),
        timestamp: new Date().toISOString()
      });
    }

    const synced = [];

    for (const item of normalized) {
      const { data: series, error: seriesError } = await supabase
        .from("macro_series")
        .upsert(
          {
            provider: "eurostat",
            series_code: item.series.seriesCode,
            name: item.series.name,
            country_code: item.series.country,
            unit: item.series.unit,
            metadata: {
              source: "Eurostat dissemination API",
              dataset: item.series.dataset,
              label: item.payload.label ?? null,
              params: item.series.params,
              sourceUrl: item.sourceUrl
            },
            last_synced: new Date().toISOString()
          },
          { onConflict: "provider,series_code,country_code" }
        )
        .select("id, series_code")
        .single();

      if (seriesError) throw seriesError;

      if (item.rows.length > 0) {
        const { error: obsError } = await supabase.from("macro_observations").upsert(
          item.rows.map((row) => ({
            series_id: series.id,
            date: row.date,
            value: row.value,
            metadata: row.metadata
          })),
          { onConflict: "series_id,date" }
        );

        if (obsError) throw obsError;
      }

      synced.push({
        seriesCode: series.series_code,
        observations: item.rows.length
      });
    }

    const totalObservations = synced.reduce((sum, item) => sum + item.observations, 0);

    await recordSyncRun(supabase, {
      connector: "eurostat",
      action: "eu_macro_bundle",
      status: "success",
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries: synced.length,
      totalObservations,
      details: {
        observationStart,
        synced
      }
    });

    return NextResponse.json({
      ok: true,
      totalSeries: synced.length,
      totalObservations,
      synced,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    await recordSyncRun(supabase, {
      connector: "eurostat",
      action: "eu_macro_bundle",
      status: "failed",
      startedAt,
      durationMs: Date.now() - startedMs,
      failedCount: 1,
      error: error instanceof Error ? error.message : "Unknown Eurostat sync error"
    });

    return jsonError(error);
  }
}
