import { NextRequest, NextResponse } from "next/server";
import { POST as syncYahooFinance } from "@/app/api/sync/yahoo-finance/route";
import { POST as syncBinance } from "@/app/api/sync/binance/route";
import { POST as syncNoaaSpaceWeather } from "@/app/api/sync/noaa-space-weather/route";
import { POST as syncWikimediaAttention } from "@/app/api/sync/wikimedia-attention/route";
import { POST as syncCoinMetrics } from "@/app/api/sync/coinmetrics/route";
import { assertVaultAuth } from "@/lib/auth";
import { getEnv, getOptionalEnv } from "@/lib/env";

export const runtime = "nodejs";

const connectors = [
  { name: "yahoo-finance", handler: syncYahooFinance },
  { name: "binance", handler: syncBinance },
  { name: "noaa-space-weather", handler: syncNoaaSpaceWeather },
  { name: "wikimedia-attention", handler: syncWikimediaAttention },
  { name: "coinmetrics", handler: syncCoinMetrics }
] as const;

// Vercel Cron (see vercel.json) calls this with GET and
// `Authorization: Bearer ${CRON_SECRET}`. The vault key is also accepted so the
// job can be triggered manually. Fans out to the engine-source connectors;
// each records its own sync_run, so a single failure does not abort the rest.
export async function GET(request: NextRequest) {
  const cronSecret = getOptionalEnv("CRON_SECRET");
  const authHeader = request.headers.get("authorization");
  const isCronRequest = Boolean(cronSecret) && authHeader === `Bearer ${cronSecret}`;

  if (!isCronRequest) {
    const authError = assertVaultAuth(request);
    if (authError) return authError;
  }

  const vaultKey = getEnv("VAULT_API_KEY");

  const results = await Promise.all(
    connectors.map(async ({ name, handler }) => {
      const syncRequest = new NextRequest(new URL(`/api/sync/${name}`, request.url), {
        method: "POST",
        headers: { authorization: `Bearer ${vaultKey}` },
        body: JSON.stringify({})
      });

      try {
        const response = await handler(syncRequest);
        const payload = await response.json().catch(() => null);
        return { connector: name, ok: response.ok, status: response.status, sync: payload };
      } catch (error) {
        return {
          connector: name,
          ok: false,
          status: 500,
          error: error instanceof Error ? error.message : "Unknown cron sync error"
        };
      }
    })
  );

  const ok = results.every((result) => result.ok);
  return NextResponse.json({ ok, cron: "market-sync", results }, { status: ok ? 200 : 207 });
}
