import { NextRequest, NextResponse } from "next/server";
import { assertVaultAuth } from "@/lib/auth";
import { getEnv, getEnvStatus, getOptionalEnv } from "@/lib/env";
import { createSupabaseAdmin } from "@/lib/supabase-server";

export const runtime = "nodejs";

type ConnectorStatus = {
  ok: boolean;
  status: "ok" | "warning" | "error" | "missing";
  latencyMs: number | null;
  detail: string;
};

function missingConnector(detail: string): ConnectorStatus {
  return { ok: false, status: "missing", latencyMs: null, detail };
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.name === "AbortError" ? "Timed out" : error.message;
  return "Unknown connector error";
}

async function probeFetch(url: string, timeoutMs = 5000, options: { warnOnFailure?: boolean } = {}): Promise<ConnectorStatus> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal
    });
    const latencyMs = Date.now() - started;
    const rateLimited = response.status === 429;

    return {
      ok: response.ok,
      status: response.ok ? "ok" : rateLimited || options.warnOnFailure ? "warning" : "error",
      latencyMs,
      detail: rateLimited ? "HTTP 429 rate limited" : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      status: options.warnOnFailure ? "warning" : "error",
      latencyMs: Date.now() - started,
      detail: formatError(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeSupabase(timeoutMs = 5000): Promise<ConnectorStatus> {
  const started = Date.now();
  const supabase = createSupabaseAdmin();

  try {
    const result = await Promise.race([
      supabase.from("macro_series").select("id", { count: "exact", head: true }).limit(1),
      new Promise<{ error: Error }>((resolve) => {
        setTimeout(() => resolve({ error: new Error("Timed out") }), timeoutMs);
      })
    ]);
    const latencyMs = Date.now() - started;

    if (result.error) {
      return { ok: false, status: "error", latencyMs, detail: result.error.message };
    }

    return { ok: true, status: "ok", latencyMs, detail: "Service role query OK" };
  } catch (error) {
    return { ok: false, status: "error", latencyMs: Date.now() - started, detail: formatError(error) };
  }
}

async function probeConnectors() {
  const fredKey = getOptionalEnv("FRED_API_KEY");
  const eiaKey = getOptionalEnv("EIA_API_KEY");
  const reliefWebAppName = getOptionalEnv("RELIEFWEB_APP_NAME");
  const geminiKey = getOptionalEnv("GEMINI_API_KEY");
  const fmpKey = getOptionalEnv("FMP_API_KEY");
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const [supabase, worldBank, eurostat, frankfurter, alternativeMe, gdelt, reliefweb, usgs, treasury, cftc, fred, eia, fmp, gemini] = await Promise.all([
    probeSupabase(),
    probeFetch("https://api.worldbank.org/v2/country/US/indicator/NY.GDP.MKTP.CD?format=json&per_page=1"),
    probeFetch("https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/namq_10_gdp?format=JSON&lang=EN&freq=Q&s_adj=SCA&unit=CLV_PCH_PRE&na_item=B1GQ&geo=EU27_2020&sinceTimePeriod=2026-Q1"),
    probeFetch("https://api.frankfurter.dev/v2/rates?from=2024-01-01&to=2024-01-02&base=EUR&quotes=USD&providers=ECB"),
    probeFetch("https://api.alternative.me/fng/?limit=1&format=json"),
    probeFetch("https://api.gdeltproject.org/api/v2/doc/doc?query=macro&mode=ArtList&format=json&maxrecords=1&timespan=1d", 5000, {
      warnOnFailure: true
    }),
    reliefWebAppName
      ? probeFetch(`https://api.reliefweb.int/v2/reports?appname=${encodeURIComponent(reliefWebAppName)}&limit=1&preset=latest`, 5000, {
          warnOnFailure: true
        })
      : Promise.resolve(missingConnector("RELIEFWEB_APP_NAME is not configured.")),
    probeFetch("https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=1&minmagnitude=5"),
    probeFetch("https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?page[size]=1"),
    probeFetch("https://www.cftc.gov/dea/newcot/FinFutWk.txt"),
    fredKey
      ? probeFetch(
          `https://api.stlouisfed.org/fred/series?series_id=UNRATE&file_type=json&api_key=${encodeURIComponent(fredKey)}`
        )
      : Promise.resolve(missingConnector("FRED_API_KEY is not configured.")),
    eiaKey
      ? probeFetch(`https://api.eia.gov/v2/seriesid/PET.RWTC.D?length=1&api_key=${encodeURIComponent(eiaKey)}`)
      : Promise.resolve(missingConnector("EIA_API_KEY is not configured.")),
    fmpKey
      ? probeFetch(
          `https://financialmodelingprep.com/stable/economic-calendar?from=${today}&to=${tomorrow}&apikey=${encodeURIComponent(fmpKey)}`
        )
      : Promise.resolve(missingConnector("FMP_API_KEY is not configured.")),
    geminiKey
      ? probeFetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(geminiKey)}`)
      : Promise.resolve(missingConnector("GEMINI_API_KEY is not configured."))
  ]);

  return {
    supabase,
    worldBank,
    eurostat,
    frankfurter,
    alternativeMe,
    gdelt,
    reliefweb,
    usgs,
    treasury,
    cftc,
    fred,
    eia,
    fmp,
    gemini
  };
}

export async function GET(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  const env = getEnvStatus();
  const optional = {
    FRED_API_KEY: Boolean(getOptionalEnv("FRED_API_KEY")),
    EIA_API_KEY: Boolean(getOptionalEnv("EIA_API_KEY")),
    RELIEFWEB_APP_NAME: Boolean(getOptionalEnv("RELIEFWEB_APP_NAME")),
    FMP_API_KEY: Boolean(getOptionalEnv("FMP_API_KEY")),
    GEMINI_MODEL: Boolean(getOptionalEnv("GEMINI_MODEL")),
    GEMINI_INTELLIGENCE_MODEL: Boolean(getOptionalEnv("GEMINI_INTELLIGENCE_MODEL")),
    APIFY_TOKEN: Boolean(getOptionalEnv("APIFY_TOKEN"))
  };
  const connectors = await probeConnectors();
  const requiredEnvOk = Object.values(env).every(Boolean);
  const connectorOk = Object.values(connectors).every(
    (connector) => connector.ok || connector.status === "missing" || connector.status === "warning"
  );

  getEnv("VAULT_API_KEY");

  return NextResponse.json({
    ok: requiredEnvOk && connectorOk,
    env,
    optional,
    connectors,
    timestamp: new Date().toISOString()
  });
}
