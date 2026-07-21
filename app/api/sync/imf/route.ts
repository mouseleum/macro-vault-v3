import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getSyncRunStatus, recordSyncRun } from "@/lib/sync-log";

export const runtime = "nodejs";

// Country-level external-vulnerability data for the Asymmetric Macro Engine:
// WEO consensus baselines (growth, inflation, current account) to measure
// shocks against, and monthly official FX reserves — the classic early-warning
// series for EM stress, devaluation risk, and capital flight (pairs with the
// stablecoin-supply proxy from the coinmetrics connector). Both IMF APIs are
// free and keyless. The legacy dataservices.imf.org SDMX host is dead; this
// uses the DataMapper API and the new api.imf.org SDMX 2.1 endpoint.
const weoCountries = ["USA", "CHN", "IND", "TUR", "EGY", "PAK", "ARG", "SAU"];
// Pakistan does not report IRFCL; the US is the reserve-currency issuer.
const reservesCountries = ["CHN", "IND", "TUR", "EGY", "ARG", "SAU"];

const weoIndicators = [
  { code: "NGDP_RPCH", name: "Real GDP Growth (WEO, % change)", unit: "% change" },
  { code: "PCPIPCH", name: "Inflation, Average CPI (WEO, % change)", unit: "% change" },
  { code: "BCA_NGDPD", name: "Current Account Balance (WEO, % of GDP)", unit: "% of GDP" }
];

const requestSchema = z.object({
  weoCountries: z.array(z.string().length(3)).optional(),
  reservesCountries: z.array(z.string().length(3)).optional(),
  parts: z.array(z.enum(["weo", "reserves"])).default(["weo", "reserves"]),
  observationStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2000-01-01"),
  // WEO projections run ~5 years out; store only near-term ones so
  // far-future forecasts don't masquerade as latest observations.
  forecastHorizonYears: z.number().int().min(0).max(6).default(1)
});

const DATAMAPPER_BASE = "https://www.imf.org/external/datamapper/api/v1";
const SDMX_BASE = "https://api.imf.org/external/sdmx/2.1";
const RESERVES_INDICATOR = "IRFCLDT1_IRFCL65_USD";
const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, label: string) {
  let response: Response | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    response = await fetch(url, { cache: "no-store" });

    if (response.ok) break;

    if (!retryableStatuses.has(response.status) || attempt === 3) {
      throw new Error(`IMF ${label} request failed: ${response.status}`);
    }

    await wait(attempt * 1000);
  }

  if (!response?.ok) {
    throw new Error(`IMF ${label} request failed: no response`);
  }

  return response;
}

// DataMapper ignores country/period path filters and returns every country's
// full history (plus projections), so fetch once per indicator and filter here.
async function fetchWeoIndicator(indicatorCode: string) {
  const response = await fetchWithRetry(`${DATAMAPPER_BASE}/${encodeURIComponent(indicatorCode)}`, "DataMapper");
  const payload = await response.json();
  const byCountry = payload?.values?.[indicatorCode];
  if (!byCountry || typeof byCountry !== "object") {
    throw new Error(`IMF DataMapper returned no values for ${indicatorCode}`);
  }
  return byCountry as Record<string, Record<string, number>>;
}

function weoRows(
  yearValues: Record<string, number>,
  observationStart: string,
  maxYear: number
) {
  const startYear = Number(observationStart.slice(0, 4));
  return Object.entries(yearValues)
    .map(([year, value]) => ({ year: Number(year), value: Number(value) }))
    .filter((row) => Number.isFinite(row.value) && row.year >= startYear && row.year <= maxYear)
    .map((row) => ({ date: `${row.year}-01-01`, value: row.value }));
}

type ReservesSeries = { country: string; sector: string; rows: { date: string; value: number }[] };

// The SDMX endpoint only offers XML for this dataflow; the structure-specific
// format is stable enough to parse with regexes (attributes on Series/Obs tags).
function parseReservesXml(xml: string): ReservesSeries[] {
  const series: ReservesSeries[] = [];
  const seriesPattern = /<Series ([^>]*)>([\s\S]*?)<\/Series>/g;

  for (const match of xml.matchAll(seriesPattern)) {
    const [, attrs, body] = match;
    const country = attrs.match(/COUNTRY="(\w+)"/)?.[1];
    const sector = attrs.match(/SECTOR="(\w+)"/)?.[1] ?? "";
    if (!country) continue;

    const rows = [...body.matchAll(/TIME_PERIOD="(\d{4})-M(\d{2})"[^>]*OBS_VALUE="([^"]+)"/g)]
      .map(([, year, month, value]) => ({ date: `${year}-${month}-01`, value: Number(value) }))
      .filter((row) => Number.isFinite(row.value));

    series.push({ country, sector, rows });
  }

  return series;
}

async function fetchReserves(countries: string[], observationStart: string) {
  const startPeriod = observationStart.slice(0, 7);
  const key = `${countries.join("+")}.${RESERVES_INDICATOR}..M`;
  const response = await fetchWithRetry(
    `${SDMX_BASE}/data/IRFCL/${key}?startPeriod=${startPeriod}`,
    "IRFCL"
  );
  const allSeries = parseReservesXml(await response.text());

  // Some countries publish under more than one sector; keep the monetary
  // authorities series (S1XS1311) when present, else the longest one.
  const byCountry = new Map<string, ReservesSeries>();
  for (const item of allSeries) {
    const existing = byCountry.get(item.country);
    const preferNew =
      !existing ||
      (item.sector === "S1XS1311" && existing.sector !== "S1XS1311") ||
      (existing.sector !== "S1XS1311" && item.rows.length > existing.rows.length);
    if (preferNew) byCountry.set(item.country, item);
  }

  return byCountry;
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const body = request.headers.get("content-length") === "0" ? {} : await request.json().catch(() => ({}));
    const input = requestSchema.parse(body);
    const weoList = (input.weoCountries?.length ? input.weoCountries : weoCountries).map((c) => c.toUpperCase());
    const reservesList = (input.reservesCountries?.length ? input.reservesCountries : reservesCountries).map((c) =>
      c.toUpperCase()
    );

    const supabase = createSupabaseAdmin();
    const synced: { seriesCode: string; observations: number }[] = [];
    const failed: { seriesCode: string; error: string }[] = [];

    const upsertSeries = async (
      seriesCode: string,
      name: string,
      countryCode: string,
      unit: string,
      metadata: Record<string, unknown>,
      rows: { date: string; value: number }[]
    ) => {
      const { data: series, error: seriesError } = await supabase
        .from("macro_series")
        .upsert(
          {
            provider: "imf",
            series_code: seriesCode,
            name,
            country_code: countryCode,
            unit,
            metadata: { ...metadata, observationStart: input.observationStart },
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
            metadata: { countryCode }
          })),
          { onConflict: "series_id,date" }
        );

        if (obsError) throw obsError;
      }

      synced.push({ seriesCode: series.series_code, observations: rows.length });
    };

    if (input.parts.includes("weo")) {
      const maxYear = new Date().getUTCFullYear() + input.forecastHorizonYears;

      for (const indicator of weoIndicators) {
        let byCountry: Record<string, Record<string, number>>;
        try {
          byCountry = await fetchWeoIndicator(indicator.code);
        } catch (error) {
          for (const country of weoList) {
            failed.push({
              seriesCode: `IMF_${country}_${indicator.code}`,
              error: error instanceof Error ? error.message : "Unknown IMF sync error"
            });
          }
          continue;
        }

        for (const country of weoList) {
          try {
            const yearValues = byCountry[country];
            if (!yearValues) {
              failed.push({ seriesCode: `IMF_${country}_${indicator.code}`, error: "Country missing from WEO data" });
              continue;
            }
            await upsertSeries(
              `IMF_${country}_${indicator.code}`,
              `${indicator.name} (${country})`,
              country,
              indicator.unit,
              {
                indicatorCode: indicator.code,
                source: "IMF DataMapper API (WEO)",
                forecastHorizonYears: input.forecastHorizonYears
              },
              weoRows(yearValues, input.observationStart, maxYear)
            );
          } catch (error) {
            failed.push({
              seriesCode: `IMF_${country}_${indicator.code}`,
              error: error instanceof Error ? error.message : "Unknown IMF sync error"
            });
          }
        }
      }
    }

    if (input.parts.includes("reserves")) {
      let reservesByCountry: Map<string, ReservesSeries> | null = null;
      try {
        reservesByCountry = await fetchReserves(reservesList, input.observationStart);
      } catch (error) {
        for (const country of reservesList) {
          failed.push({
            seriesCode: `IMF_${country}_RESERVES_USD`,
            error: error instanceof Error ? error.message : "Unknown IMF sync error"
          });
        }
      }

      if (reservesByCountry) {
        for (const country of reservesList) {
          try {
            const item = reservesByCountry.get(country);
            if (!item || item.rows.length === 0) {
              failed.push({ seriesCode: `IMF_${country}_RESERVES_USD`, error: "No IRFCL reserves data returned" });
              continue;
            }
            await upsertSeries(
              `IMF_${country}_RESERVES_USD`,
              `Official Reserve Assets, monthly (${country})`,
              country,
              "USD",
              {
                indicatorCode: RESERVES_INDICATOR,
                sector: item.sector,
                source: "IMF SDMX 2.1 API (IRFCL)"
              },
              item.rows
            );
          } catch (error) {
            failed.push({
              seriesCode: `IMF_${country}_RESERVES_USD`,
              error: error instanceof Error ? error.message : "Unknown IMF sync error"
            });
          }
        }
      }
    }

    const totalSeries = synced.length;
    const totalObservations = synced.reduce((sum, item) => sum + item.observations, 0);
    await recordSyncRun(supabase, {
      connector: "imf",
      action: "country_macro",
      status: getSyncRunStatus(totalSeries, failed.length),
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries,
      totalObservations,
      failedCount: failed.length,
      details: {
        parts: input.parts,
        observationStart: input.observationStart,
        weoCountries: weoList,
        reservesCountries: reservesList,
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
