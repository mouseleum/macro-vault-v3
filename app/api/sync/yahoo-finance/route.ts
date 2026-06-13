import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getSyncRunStatus, recordSyncRun } from "@/lib/sync-log";

export const runtime = "nodejs";

// Daily closing prices for the indices/commodities the Asymmetric Macro Engine
// reasons over (energy shock -> European indices, oil, gold, dollar, volatility).
const tickerBundle = [
  { ticker: "DX-Y.NYB", name: "US Dollar Index (DXY)", unit: "index" },
  { ticker: "^GSPC", name: "S&P 500 Index", unit: "index" },
  { ticker: "^GDAXI", name: "DAX 40 Index", unit: "index" },
  { ticker: "^STOXX50E", name: "EURO STOXX 50 Index", unit: "index" },
  { ticker: "CL=F", name: "WTI Crude Oil Front-Month Future", unit: "USD/bbl" },
  { ticker: "BZ=F", name: "Brent Crude Oil Front-Month Future", unit: "USD/bbl" },
  { ticker: "GC=F", name: "Gold Front-Month Future", unit: "USD/oz" }
];

const requestSchema = z.object({
  tickers: z.array(z.string().min(1)).optional(),
  observationStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2020-01-01")
});

type TickerSpec = (typeof tickerBundle)[number];

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);

function getTickers(inputTickers: string[] | undefined): TickerSpec[] {
  if (!inputTickers?.length) return tickerBundle;
  const wanted = new Set(inputTickers.map((ticker) => ticker.toUpperCase()));
  const matched = tickerBundle.filter((spec) => wanted.has(spec.ticker.toUpperCase()));
  const extras = inputTickers
    .filter((ticker) => !tickerBundle.some((spec) => spec.ticker.toUpperCase() === ticker.toUpperCase()))
    .map((ticker) => ({ ticker, name: `${ticker} (Yahoo Finance)`, unit: "price" }));
  return [...matched, ...extras];
}

function seriesCodeForTicker(ticker: string) {
  const slug = ticker.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `YF_${slug}`;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchDailyCloses(spec: TickerSpec, observationStart: string) {
  const period1 = Math.floor(new Date(`${observationStart}T00:00:00.000Z`).getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(spec.ticker)}`);
  url.searchParams.set("interval", "1d");
  url.searchParams.set("period1", String(period1));
  url.searchParams.set("period2", String(period2));

  let response: Response | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    response = await fetch(url, {
      cache: "no-store",
      // Yahoo throttles requests without a browser-like User-Agent.
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MacroVault/1.0)" }
    });

    if (response.ok) break;

    if (!retryableStatuses.has(response.status) || attempt === 3) {
      throw new Error(`Yahoo Finance request failed for ${spec.ticker}: ${response.status}`);
    }

    await wait(attempt * 500);
  }

  if (!response?.ok) {
    throw new Error(`Yahoo Finance request failed for ${spec.ticker}: no response`);
  }

  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  const timestamps: number[] = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const closes: Array<number | null> = result?.indicators?.quote?.[0]?.close ?? [];
  const currency = typeof result?.meta?.currency === "string" ? result.meta.currency : undefined;

  const rows = timestamps
    .map((ts, index) => ({
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      value: closes[index]
    }))
    .filter((row): row is { date: string; value: number } => typeof row.value === "number" && Number.isFinite(row.value));

  // Collapse to one row per date (last wins) in case of duplicate intraday stamps.
  const deduped = Array.from(new Map(rows.map((row) => [row.date, row])).values());
  return { rows: deduped, currency };
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const body = request.headers.get("content-length") === "0" ? {} : await request.json().catch(() => ({}));
    const input = requestSchema.parse(body);
    const requestedTickers = getTickers(input.tickers);

    if (!requestedTickers.length) {
      return NextResponse.json({ error: "No tickers requested." }, { status: 400 });
    }

    const supabase = createSupabaseAdmin();
    const synced = [];
    const failed = [];

    for (const spec of requestedTickers) {
      try {
        const { rows, currency } = await fetchDailyCloses(spec, input.observationStart);

        const { data: series, error: seriesError } = await supabase
          .from("macro_series")
          .upsert(
            {
              provider: "yahoo_finance",
              series_code: seriesCodeForTicker(spec.ticker),
              name: spec.name,
              country_code: "WLD",
              unit: currency ? `${spec.unit} (${currency})` : spec.unit,
              metadata: {
                ticker: spec.ticker,
                source: "Yahoo Finance chart API",
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
              metadata: { ticker: spec.ticker }
            })),
            { onConflict: "series_id,date" }
          );

          if (obsError) throw obsError;
        }

        synced.push({ seriesCode: series.series_code, observations: rows.length });
      } catch (error) {
        failed.push({
          ticker: spec.ticker,
          error: error instanceof Error ? error.message : "Unknown Yahoo Finance sync error"
        });
      }
    }

    const totalSeries = synced.length;
    const totalObservations = synced.reduce((sum, item) => sum + item.observations, 0);
    await recordSyncRun(supabase, {
      connector: "yahoo_finance",
      action: "market_data_daily",
      status: getSyncRunStatus(totalSeries, failed.length),
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries,
      totalObservations,
      failedCount: failed.length,
      details: {
        observationStart: input.observationStart,
        requestedTickers: requestedTickers.map((spec) => spec.ticker),
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
