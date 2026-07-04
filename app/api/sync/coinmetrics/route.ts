import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getSyncRunStatus, recordSyncRun } from "@/lib/sync-log";

export const runtime = "nodejs";

// On-chain structure the Asymmetric Macro Engine reasons over: stablecoin
// supply as a capital-flight / offshore-dollar-demand proxy, hash rate for
// energy- and jurisdiction-driven miner stress, MVRV for valuation asymmetry,
// and usage metrics for price/adoption divergence. Coin Metrics community API
// (free tier, no key) — fee/miner-revenue/exchange-flow metrics are pro-only.
const metricBundle = [
  { asset: "btc", metric: "CapMVRVCur", seriesCode: "CM_BTC_MVRV", name: "Bitcoin MVRV Ratio (market cap / realized cap)", unit: "ratio" },
  { asset: "btc", metric: "HashRate", seriesCode: "CM_BTC_HASH_RATE", name: "Bitcoin Mean Hash Rate", unit: "TH/s" },
  { asset: "btc", metric: "AdrActCnt", seriesCode: "CM_BTC_ACTIVE_ADDRESSES", name: "Bitcoin Active Addresses", unit: "addresses" },
  { asset: "btc", metric: "TxCnt", seriesCode: "CM_BTC_TX_COUNT", name: "Bitcoin Transaction Count", unit: "transactions" },
  { asset: "usdt", metric: "SplyCur", seriesCode: "CM_USDT_SUPPLY", name: "Tether (USDT) Circulating Supply", unit: "USDT" },
  { asset: "usdc", metric: "SplyCur", seriesCode: "CM_USDC_SUPPLY", name: "USD Coin (USDC) Circulating Supply", unit: "USDC" }
];

const requestSchema = z.object({
  seriesCodes: z.array(z.string().min(1)).optional(),
  observationStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2020-01-01")
});

type MetricSpec = (typeof metricBundle)[number];

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
const COINMETRICS_BASE = "https://community-api.coinmetrics.io/v4";

function getSpecs(inputCodes: string[] | undefined): MetricSpec[] {
  if (!inputCodes?.length) return metricBundle;
  const wanted = new Set(inputCodes.map((code) => code.toUpperCase()));
  return metricBundle.filter((spec) => wanted.has(spec.seriesCode));
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type AssetMetricsRow = { asset: string; time: string } & Record<string, string>;

async function fetchJsonWithRetry(url: string) {
  let response: Response | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    response = await fetch(url, { cache: "no-store" });

    if (response.ok) break;

    if (!retryableStatuses.has(response.status) || attempt === 3) {
      throw new Error(`Coin Metrics request failed: ${response.status}`);
    }

    // Community tier rate limit is per-IP and tight; back off generously.
    await wait(attempt * 1000);
  }

  if (!response?.ok) {
    throw new Error("Coin Metrics request failed: no response");
  }

  return response.json() as Promise<{ data?: AssetMetricsRow[]; next_page_url?: string }>;
}

// One request per asset covers all of that asset's metrics; paginate via
// next_page_url (full history since 2020 currently fits in a single page).
async function fetchAssetMetrics(asset: string, metrics: string[], observationStart: string) {
  const url = new URL(`${COINMETRICS_BASE}/timeseries/asset-metrics`);
  url.searchParams.set("assets", asset);
  url.searchParams.set("metrics", metrics.join(","));
  url.searchParams.set("frequency", "1d");
  url.searchParams.set("start_time", observationStart);
  url.searchParams.set("page_size", "10000");
  url.searchParams.set("paging_from", "start");

  const rows: AssetMetricsRow[] = [];
  let nextUrl: string | undefined = url.toString();

  while (nextUrl) {
    const payload = await fetchJsonWithRetry(nextUrl);
    rows.push(...(payload.data ?? []));
    nextUrl = payload.next_page_url;
  }

  return rows;
}

function rowsForMetric(rows: AssetMetricsRow[], metric: string) {
  const parsed = rows
    .map((row) => ({
      date: row.time.slice(0, 10),
      value: Number(row[metric])
    }))
    .filter((row) => Number.isFinite(row.value));

  // Collapse to one row per date (last wins) in case of duplicate stamps.
  return Array.from(new Map(parsed.map((row) => [row.date, row])).values());
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const body = request.headers.get("content-length") === "0" ? {} : await request.json().catch(() => ({}));
    const input = requestSchema.parse(body);
    const specs = getSpecs(input.seriesCodes);

    if (!specs.length) {
      return NextResponse.json({ error: "No known series codes requested." }, { status: 400 });
    }

    const supabase = createSupabaseAdmin();
    const synced = [];
    const failed = [];

    const assets = [...new Set(specs.map((spec) => spec.asset))];

    for (const asset of assets) {
      const assetSpecs = specs.filter((spec) => spec.asset === asset);

      let assetRows: AssetMetricsRow[];
      try {
        assetRows = await fetchAssetMetrics(
          asset,
          assetSpecs.map((spec) => spec.metric),
          input.observationStart
        );
      } catch (error) {
        for (const spec of assetSpecs) {
          failed.push({
            seriesCode: spec.seriesCode,
            error: error instanceof Error ? error.message : "Unknown Coin Metrics sync error"
          });
        }
        continue;
      }

      for (const spec of assetSpecs) {
        try {
          const rows = rowsForMetric(assetRows, spec.metric);

          const { data: series, error: seriesError } = await supabase
            .from("macro_series")
            .upsert(
              {
                provider: "coinmetrics",
                series_code: spec.seriesCode,
                name: spec.name,
                country_code: "WLD",
                unit: spec.unit,
                metadata: {
                  asset: spec.asset,
                  metric: spec.metric,
                  source: "Coin Metrics community API",
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
                metadata: { asset: spec.asset, metric: spec.metric }
              })),
              { onConflict: "series_id,date" }
            );

            if (obsError) throw obsError;
          }

          synced.push({ seriesCode: series.series_code, observations: rows.length });
        } catch (error) {
          failed.push({
            seriesCode: spec.seriesCode,
            error: error instanceof Error ? error.message : "Unknown Coin Metrics sync error"
          });
        }
      }
    }

    const totalSeries = synced.length;
    const totalObservations = synced.reduce((sum, item) => sum + item.observations, 0);
    await recordSyncRun(supabase, {
      connector: "coinmetrics",
      action: "onchain_daily",
      status: getSyncRunStatus(totalSeries, failed.length),
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries,
      totalObservations,
      failedCount: failed.length,
      details: {
        observationStart: input.observationStart,
        requestedSeries: specs.map((spec) => spec.seriesCode),
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
