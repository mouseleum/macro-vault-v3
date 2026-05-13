import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getSyncRunStatus, recordSyncRun } from "@/lib/sync-log";

export const runtime = "nodejs";

const tffUrl = "https://www.cftc.gov/dea/newcot/FinFutWk.txt";
const disaggregatedUrl = "https://www.cftc.gov/dea/newcot/f_disagg.txt";

const financialTargets = [
  { match: "EURO FX", label: "Euro FX", country: "EMU" },
  { match: "JAPANESE YEN", label: "Japanese Yen", country: "JP" },
  { match: "BRITISH POUND", label: "British Pound", country: "GB" },
  { match: "SWISS FRANC", label: "Swiss Franc", country: "CH" },
  { match: "CANADIAN DOLLAR", label: "Canadian Dollar", country: "CA" },
  { match: "AUSTRALIAN DOLLAR", label: "Australian Dollar", country: "AU" },
  { match: "U.S. DOLLAR INDEX", label: "US Dollar Index", country: "US" },
  { match: "S&P 500", label: "S&P 500", country: "US" },
  { match: "NASDAQ", label: "Nasdaq", country: "US" },
  { match: "U.S. TREASURY NOTES - 10 YEAR", label: "US 10Y Treasury Note", country: "US" }
];

const commodityTargets = [
  { match: "CRUDE OIL", label: "Crude Oil", country: "US" },
  { match: "NATURAL GAS", label: "Natural Gas", country: "US" },
  { match: "GOLD", label: "Gold", country: "WLD" },
  { match: "SILVER", label: "Silver", country: "WLD" },
  { match: "COPPER", label: "Copper", country: "WLD" },
  { match: "CORN", label: "Corn", country: "US" },
  { match: "SOYBEANS", label: "Soybeans", country: "US" },
  { match: "WHEAT", label: "Wheat", country: "US" }
];

const requestSchema = z.object({
  dryRun: z.boolean().default(false)
});

type ParsedCotRow = {
  report: "tff" | "disaggregated";
  target: string;
  marketName: string;
  reportDate: string;
  contractCode: string;
  marketCode: string;
  commodityCode: string;
  contractUnits: string | null;
  countryCode: string;
  metrics: Array<{
    key: string;
    label: string;
    value: number;
    unit: string;
    components?: Record<string, number>;
  }>;
};

function parseCsvLine(line: string) {
  const fields: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"" && quoted && next === "\"") {
      current += "\"";
      index += 1;
      continue;
    }

    if (char === "\"") {
      quoted = !quoted;
      continue;
    }

    if (char === "," && !quoted) {
      fields.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  fields.push(current.trim());
  return fields;
}

function parseNumber(value: string | undefined) {
  if (!value || value === ".") return null;
  const number = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : null;
}

function slug(value: string) {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72);
}

function findTarget(marketName: string, targets: typeof financialTargets) {
  const normalized = marketName.toUpperCase();
  return targets.find((target) => normalized.includes(target.match)) ?? null;
}

function net(long: number | null, short: number | null) {
  return long !== null && short !== null ? long - short : null;
}

function pushMetric(
  metrics: ParsedCotRow["metrics"],
  key: string,
  label: string,
  value: number | null,
  unit: string,
  components?: Record<string, number | null>
) {
  if (value === null) return;

  metrics.push({
    key,
    label,
    value,
    unit,
    components: components
      ? Object.fromEntries(Object.entries(components).filter((entry): entry is [string, number] => entry[1] !== null))
      : undefined
  });
}

function parseTffRow(fields: string[]): ParsedCotRow | null {
  const marketName = fields[0];
  const target = findTarget(marketName, financialTargets);
  if (!target) return null;

  const dealerLong = parseNumber(fields[8]);
  const dealerShort = parseNumber(fields[9]);
  const assetLong = parseNumber(fields[11]);
  const assetShort = parseNumber(fields[12]);
  const leveragedLong = parseNumber(fields[14]);
  const leveragedShort = parseNumber(fields[15]);
  const openInterest = parseNumber(fields[7]);
  const metrics: ParsedCotRow["metrics"] = [];

  pushMetric(metrics, "leveraged_funds_net", "Leveraged Funds Net Position", net(leveragedLong, leveragedShort), "contracts", {
    long: leveragedLong,
    short: leveragedShort
  });
  pushMetric(metrics, "asset_manager_net", "Asset Manager Net Position", net(assetLong, assetShort), "contracts", {
    long: assetLong,
    short: assetShort
  });
  pushMetric(metrics, "dealer_net", "Dealer Net Position", net(dealerLong, dealerShort), "contracts", {
    long: dealerLong,
    short: dealerShort
  });
  pushMetric(metrics, "open_interest", "Open Interest", openInterest, "contracts");

  return {
    report: "tff",
    target: target.label,
    marketName,
    reportDate: fields[2],
    contractCode: fields[3],
    marketCode: fields[4],
    commodityCode: fields[6],
    contractUnits: fields[81] || null,
    countryCode: target.country,
    metrics
  };
}

function parseDisaggregatedRow(fields: string[]): ParsedCotRow | null {
  const marketName = fields[0];
  const target = findTarget(marketName, commodityTargets);
  if (!target) return null;

  const producerLong = parseNumber(fields[8]);
  const producerShort = parseNumber(fields[9]);
  const swapLong = parseNumber(fields[10]);
  const swapShort = parseNumber(fields[11]);
  const managedLong = parseNumber(fields[13]);
  const managedShort = parseNumber(fields[14]);
  const openInterest = parseNumber(fields[7]);
  const metrics: ParsedCotRow["metrics"] = [];

  pushMetric(metrics, "managed_money_net", "Managed Money Net Position", net(managedLong, managedShort), "contracts", {
    long: managedLong,
    short: managedShort
  });
  pushMetric(metrics, "producer_merchant_net", "Producer Merchant Net Position", net(producerLong, producerShort), "contracts", {
    long: producerLong,
    short: producerShort
  });
  pushMetric(metrics, "swap_dealer_net", "Swap Dealer Net Position", net(swapLong, swapShort), "contracts", {
    long: swapLong,
    short: swapShort
  });
  pushMetric(metrics, "open_interest", "Open Interest", openInterest, "contracts");

  return {
    report: "disaggregated",
    target: target.label,
    marketName,
    reportDate: fields[2],
    contractCode: fields[3],
    marketCode: fields[4],
    commodityCode: fields[6],
    contractUnits: fields[125] || null,
    countryCode: target.country,
    metrics
  };
}

async function fetchCotRows(url: string, parser: (fields: string[]) => ParsedCotRow | null) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`CFTC request failed: HTTP ${response.status}`);
  }

  const text = await response.text();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parser(parseCsvLine(line)))
    .filter((row): row is ParsedCotRow => Boolean(row));
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
    const [financialRows, commodityRows] = await Promise.all([fetchCotRows(tffUrl, parseTffRow), fetchCotRows(disaggregatedUrl, parseDisaggregatedRow)]);
    const rows = [...financialRows, ...commodityRows];

    if (input.dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        totalMarkets: rows.length,
        totalSeries: rows.reduce((sum, row) => sum + row.metrics.length, 0),
        markets: rows.map((row) => ({
          report: row.report,
          target: row.target,
          marketName: row.marketName,
          reportDate: row.reportDate,
          metrics: row.metrics.map((metric) => metric.key)
        })),
        timestamp: new Date().toISOString()
      });
    }

    const synced = [];
    const failed = [];

    for (const row of rows) {
      for (const metric of row.metrics) {
        try {
          const seriesCode = `CFTC_${slug(row.report)}_${slug(row.contractCode || row.target)}_${slug(metric.key)}`;
          const { data: series, error: seriesError } = await supabase
            .from("macro_series")
            .upsert(
              {
                provider: "cftc_cot",
                series_code: seriesCode,
                name: `${row.marketName} CFTC ${metric.label}`,
                country_code: row.countryCode,
                unit: metric.unit,
                metadata: {
                  source: "CFTC Commitments of Traders",
                  report: row.report,
                  marketName: row.marketName,
                  contractCode: row.contractCode,
                  marketCode: row.marketCode,
                  commodityCode: row.commodityCode,
                  contractUnits: row.contractUnits,
                  metric: metric.key,
                  sourceUrl: row.report === "tff" ? tffUrl : disaggregatedUrl
                },
                last_synced: new Date().toISOString()
              },
              { onConflict: "provider,series_code,country_code" }
            )
            .select("id, series_code")
            .single();

          if (seriesError) throw seriesError;

          const { error: obsError } = await supabase.from("macro_observations").upsert(
            {
              series_id: series.id,
              date: row.reportDate,
              value: metric.value,
              metadata: {
                source: "CFTC Commitments of Traders",
                report: row.report,
                marketName: row.marketName,
                contractUnits: row.contractUnits,
                metric: metric.key,
                components: metric.components ?? {}
              }
            },
            { onConflict: "series_id,date" }
          );

          if (obsError) throw obsError;

          synced.push({ seriesCode: series.series_code, observations: 1 });
        } catch (error) {
          failed.push({
            market: row.marketName,
            metric: metric.key,
            error: error instanceof Error ? error.message : "Unknown CFTC sync error"
          });
        }
      }
    }

    const totalSeries = synced.length;
    const totalObservations = synced.reduce((sum, item) => sum + item.observations, 0);
    await recordSyncRun(supabase, {
      connector: "cftc_cot",
      action: "positioning_bundle",
      status: getSyncRunStatus(totalSeries, failed.length),
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries,
      totalObservations,
      failedCount: failed.length,
      details: {
        markets: rows.map((row) => row.marketName),
        synced,
        failed
      }
    });

    return NextResponse.json({
      ok: true,
      totalMarkets: rows.length,
      totalSeries,
      totalObservations,
      synced,
      failed,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    await recordSyncRun(supabase, {
      connector: "cftc_cot",
      action: "positioning_bundle",
      status: "failed",
      startedAt,
      durationMs: Date.now() - startedMs,
      failedCount: 1,
      error: error instanceof Error ? error.message : "Unknown CFTC sync error"
    });

    return jsonError(error);
  }
}
