import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError, todayIsoDate } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { recordSyncRun } from "@/lib/sync-log";

export const runtime = "nodejs";

const requestSchema = z.object({
  base: z.string().length(3).default("EUR"),
  quotes: z.array(z.string().length(3)).default(["USD", "GBP", "JPY", "CHF", "SEK"]),
  observationStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2020-01-01")
});

type FrankfurterRate = {
  date: string;
  base: string;
  quote: string;
  rate: number;
};

function normalizeCurrency(value: string) {
  return value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
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
    const base = normalizeCurrency(input.base);
    const quotes = Array.from(new Set(input.quotes.map(normalizeCurrency).filter((quote) => quote && quote !== base)));

    if (!quotes.length) {
      await recordSyncRun(supabase, {
        connector: "frankfurter_ecb",
        action: "fx_rates",
        status: "failed",
        startedAt,
        durationMs: Date.now() - startedMs,
        failedCount: 1,
        error: "At least one quote currency is required.",
        details: { base, quotes }
      });
      return NextResponse.json({ error: "At least one quote currency is required." }, { status: 400 });
    }

    const url = new URL("https://api.frankfurter.dev/v2/rates");
    url.searchParams.set("from", input.observationStart);
    url.searchParams.set("to", todayIsoDate());
    url.searchParams.set("base", base);
    url.searchParams.set("quotes", quotes.join(","));
    url.searchParams.set("providers", "ECB");

    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      await recordSyncRun(supabase, {
        connector: "frankfurter_ecb",
        action: "fx_rates",
        status: "failed",
        startedAt,
        durationMs: Date.now() - startedMs,
        failedCount: 1,
        error: `Frankfurter FX request failed: ${response.status}`,
        details: { base, quotes, observationStart: input.observationStart }
      });
      return NextResponse.json({ error: "Frankfurter FX request failed", status: response.status }, { status: 502 });
    }

    const payload = await response.json();
    const rates = Array.isArray(payload) ? (payload as FrankfurterRate[]) : [];
    const grouped = new Map<string, Array<{ date: string; value: number }>>();

    for (const item of rates) {
      if (!item.date || !item.quote || !Number.isFinite(Number(item.rate))) continue;
      const quote = normalizeCurrency(item.quote);
      const rows = grouped.get(quote) ?? [];
      rows.push({ date: item.date, value: Number(item.rate) });
      grouped.set(quote, rows);
    }

    const synced = [];

    for (const quote of quotes) {
      const rows = Array.from(new Map((grouped.get(quote) ?? []).map((row) => [row.date, row])).values());
      const seriesCode = `FX_${base}_${quote}`;

      const { data: series, error: seriesError } = await supabase
        .from("macro_series")
        .upsert(
          {
            provider: "frankfurter_ecb",
            series_code: seriesCode,
            name: `${base}/${quote} ECB reference exchange rate`,
            country_code: "WLD",
            unit: `${quote} per ${base}`,
            metadata: {
              source: "Frankfurter v2 API",
              provider: "ECB",
              base,
              quote,
              observationStart: input.observationStart,
              sourceUrl: url.toString().replace(/quotes=[^&]+/, `quotes=${quote}`)
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
            metadata: { base, quote, source: "Frankfurter ECB" }
          })),
          { onConflict: "series_id,date" }
        );

        if (obsError) throw obsError;
      }

      synced.push({
        seriesCode: series.series_code,
        observations: rows.length
      });
    }

    const totalSeries = synced.length;
    const totalObservations = synced.reduce((sum, item) => sum + item.observations, 0);
    await recordSyncRun(supabase, {
      connector: "frankfurter_ecb",
      action: "fx_rates",
      status: "success",
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries,
      totalObservations,
      details: {
        base,
        quotes,
        observationStart: input.observationStart,
        synced
      }
    });

    return NextResponse.json({
      ok: true,
      synced,
      totalSeries,
      totalObservations,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return jsonError(error);
  }
}
