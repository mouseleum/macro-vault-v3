import { GoogleGenAI, Type } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { assertVaultAuth } from "@/lib/auth";
import { getEnv, getOptionalEnv } from "@/lib/env";
import { jsonError, todayIsoDate } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { recordSyncRun } from "@/lib/sync-log";

export const runtime = "nodejs";

const regimeSchema = {
  type: Type.OBJECT,
  properties: {
    regime: { type: Type.STRING },
    risk_appetite: { type: Type.NUMBER },
    confidence: { type: Type.NUMBER },
    reasoning: { type: Type.STRING },
    catalysts: { type: Type.ARRAY, items: { type: Type.STRING } }
  },
  required: ["regime", "risk_appetite", "confidence", "reasoning", "catalysts"]
};

const fallbackGeminiModels = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash-lite"];
const transientGeminiCodes = new Set([429, 500, 502, 503, 504]);
const transientGeminiStatuses = new Set(["RESOURCE_EXHAUSTED", "UNAVAILABLE", "INTERNAL", "DEADLINE_EXCEEDED"]);

class TransientGeminiError extends Error {}

function getRegimeModels() {
  return Array.from(new Set([getOptionalEnv("GEMINI_MODEL"), ...fallbackGeminiModels].filter(Boolean))) as string[];
}

function getGeminiErrorSignal(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const errorRecord = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const nested = errorRecord.error && typeof errorRecord.error === "object" ? (errorRecord.error as Record<string, unknown>) : {};

  const code =
    Number(errorRecord.code ?? errorRecord.status ?? nested.code) ||
    Number(message.match(/"code"\\s*:\\s*(\\d+)/)?.[1]) ||
    undefined;
  const status =
    String(errorRecord.statusText ?? nested.status ?? message.match(/"status"\\s*:\\s*"([^"]+)"/)?.[1] ?? "") ||
    undefined;

  return { code, status, message };
}

function isTransientGeminiError(error: unknown) {
  if (error instanceof TransientGeminiError) return true;

  const signal = getGeminiErrorSignal(error);
  return Boolean(
    (signal.code && transientGeminiCodes.has(signal.code)) ||
      (signal.status && transientGeminiStatuses.has(signal.status))
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateRegimeJson(ai: GoogleGenAI, context: string) {
  const models = getRegimeModels();

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await ai.models.generateContent({
          model,
          contents: `Analyze this macro vault snapshot and return a compact market regime JSON.\n\n${
            context || "No macro observations yet."
          }`,
          config: {
            responseMimeType: "application/json",
            responseSchema: regimeSchema
          }
        });

        if (!result.text) throw new Error(`Gemini returned an empty response from ${model}.`);
        return { text: result.text, model };
      } catch (error) {
        if (!isTransientGeminiError(error)) throw error;
        if (attempt < 2) await sleep(350 * attempt);
      }
    }
  }

  throw new TransientGeminiError(
    `Gemini is temporarily unavailable after trying ${models.join(
      ", "
    )}. This is usually a short demand spike; retry in a minute or set GEMINI_MODEL=gemini-2.5-flash-lite.`
  );
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let supabase: ReturnType<typeof createSupabaseAdmin> | null = null;

  try {
    supabase = createSupabaseAdmin();
    const { data: latestSeries, error } = await supabase
      .from("macro_series")
      .select("series_code, name, macro_observations(date, value)")
      .order("last_synced", { ascending: false })
      .limit(20);

    if (error) throw error;

    const context = (latestSeries ?? [])
      .map((series: any) => {
        const observations = Array.isArray(series.macro_observations) ? series.macro_observations : [];
        const latest = observations.sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)))[0];
        return latest ? `${series.series_code} (${series.name}): ${latest.value} as of ${latest.date}` : null;
      })
      .filter(Boolean)
      .join("\n");

    const ai = new GoogleGenAI({ apiKey: getEnv("GEMINI_API_KEY") });
    const { text, model } = await generateRegimeJson(ai, context);
    const regime = JSON.parse(text);

    const { data: series, error: seriesError } = await supabase
      .from("macro_series")
      .upsert(
        {
          provider: "vault_ai",
          series_code: "VAULT_AI_REGIME",
          name: "AI Market Regime",
          country_code: "WLD",
          unit: "score",
          metadata: {
            current_regime: regime,
            model,
            last_updated: new Date().toISOString()
          },
          last_synced: new Date().toISOString()
        },
        { onConflict: "provider,series_code,country_code" }
      )
      .select("id")
      .single();

    if (seriesError) throw seriesError;

    const { error: observationError } = await supabase.from("macro_observations").upsert(
      {
        series_id: series.id,
        date: todayIsoDate(),
        value: Number(regime.risk_appetite ?? 0),
        metadata: regime
      },
      { onConflict: "series_id,date" }
    );

    if (observationError) throw observationError;

    await recordSyncRun(supabase, {
      connector: "gemini",
      action: "market_regime",
      status: "success",
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries: 1,
      totalObservations: 1,
      details: {
        model,
        regime: regime.regime,
        riskAppetite: regime.risk_appetite,
        confidence: regime.confidence
      }
    });

    return NextResponse.json({ ok: true, regime, model });
  } catch (error) {
    if (supabase) {
      await recordSyncRun(supabase, {
        connector: "gemini",
        action: "market_regime",
        status: "failed",
        startedAt,
        durationMs: Date.now() - startedMs,
        failedCount: 1,
        error: error instanceof Error ? error.message : "Unknown regime generation error"
      });
    }

    return jsonError(error, isTransientGeminiError(error) ? 503 : 500);
  }
}
