import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getSyncRunStatus, recordSyncRun } from "@/lib/sync-log";

export const runtime = "nodejs";

// Safe-haven flow proxies. PAXG (tokenised gold) tracks gold; BTC is the
// risk-sentiment crypto proxy. Daily closes + volume via Binance public klines.
const symbolBundle = [
  { symbol: "PAXGUSDT", name: "PAX Gold / USDT (gold proxy)", unit: "USDT" },
  { symbol: "BTCUSDT", name: "Bitcoin / USDT", unit: "USDT" }
];

const requestSchema = z.object({
  symbols: z.array(z.string().min(1)).optional(),
  observationStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2020-01-01")
});

type SymbolSpec = (typeof symbolBundle)[number];

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
// Public market-data mirror; avoids the geo-blocking (HTTP 451) that the main
// api.binance.com endpoint returns from some hosting regions.
const BINANCE_BASE = "https://data-api.binance.vision";

function getSymbols(inputSymbols: string[] | undefined): SymbolSpec[] {
  if (!inputSymbols?.length) return symbolBundle;
  const wanted = new Set(inputSymbols.map((symbol) => symbol.toUpperCase()));
  const matched = symbolBundle.filter((spec) => wanted.has(spec.symbol));
  const extras = inputSymbols
    .map((symbol) => symbol.toUpperCase())
    .filter((symbol) => !symbolBundle.some((spec) => spec.symbol === symbol))
    .map((symbol) => ({ symbol, name: `${symbol} (Binance)`, unit: "quote" }));
  return [...matched, ...extras];
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Kline = [number, string, string, string, string, string, ...unknown[]];

async function fetchDailyKlines(spec: SymbolSpec, observationStart: string) {
  const startTime = new Date(`${observationStart}T00:00:00.000Z`).getTime();
  const url = new URL(`${BINANCE_BASE}/api/v3/klines`);
  url.searchParams.set("symbol", spec.symbol);
  url.searchParams.set("interval", "1d");
  url.searchParams.set("startTime", String(startTime));
  url.searchParams.set("limit", "1000");

  let response: Response | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    response = await fetch(url, { cache: "no-store" });

    if (response.ok) break;

    if (!retryableStatuses.has(response.status) || attempt === 3) {
      throw new Error(`Binance request failed for ${spec.symbol}: ${response.status}`);
    }

    await wait(attempt * 500);
  }

  if (!response?.ok) {
    throw new Error(`Binance request failed for ${spec.symbol}: no response`);
  }

  const payload = (await response.json()) as Kline[];
  const klines = Array.isArray(payload) ? payload : [];

  const rows = klines
    .map((kline) => {
      const openTime = Number(kline[0]);
      const close = Number(kline[4]);
      const volume = Number(kline[5]);
      return {
        date: new Date(openTime).toISOString().slice(0, 10),
        value: close,
        volume: Number.isFinite(volume) ? volume : null
      };
    })
    .filter((row): row is { date: string; value: number; volume: number | null } => Number.isFinite(row.value));

  return Array.from(new Map(rows.map((row) => [row.date, row])).values());
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const body = request.headers.get("content-length") === "0" ? {} : await request.json().catch(() => ({}));
    const input = requestSchema.parse(body);
    const requestedSymbols = getSymbols(input.symbols);

    if (!requestedSymbols.length) {
      return NextResponse.json({ error: "No symbols requested." }, { status: 400 });
    }

    const supabase = createSupabaseAdmin();
    const synced = [];
    const failed = [];

    for (const spec of requestedSymbols) {
      try {
        const rows = await fetchDailyKlines(spec, input.observationStart);

        const { data: series, error: seriesError } = await supabase
          .from("macro_series")
          .upsert(
            {
              provider: "binance",
              series_code: `BINANCE_${spec.symbol}`,
              name: spec.name,
              country_code: "WLD",
              unit: spec.unit,
              metadata: {
                symbol: spec.symbol,
                source: "Binance public klines (data-api.binance.vision)",
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
              metadata: { symbol: spec.symbol, volume: row.volume }
            })),
            { onConflict: "series_id,date" }
          );

          if (obsError) throw obsError;
        }

        synced.push({ seriesCode: series.series_code, observations: rows.length });
      } catch (error) {
        failed.push({
          symbol: spec.symbol,
          error: error instanceof Error ? error.message : "Unknown Binance sync error"
        });
      }
    }

    const totalSeries = synced.length;
    const totalObservations = synced.reduce((sum, item) => sum + item.observations, 0);
    await recordSyncRun(supabase, {
      connector: "binance",
      action: "safe_haven_flows_daily",
      status: getSyncRunStatus(totalSeries, failed.length),
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries,
      totalObservations,
      failedCount: failed.length,
      details: {
        observationStart: input.observationStart,
        requestedSymbols: requestedSymbols.map((spec) => spec.symbol),
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
