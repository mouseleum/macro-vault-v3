import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError, todayIsoDate } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getSyncRunStatus, recordSyncRun } from "@/lib/sync-log";

export const runtime = "nodejs";

// Public-attention proxy: daily Wikipedia pageviews for geopolitical flashpoints.
// A spike in attention that the market has not repriced is an asymmetry signal.
const articleBundle = [
  "Strait_of_Hormuz",
  "Taiwan_Strait",
  "South_China_Sea",
  "Russian_invasion_of_Ukraine",
  "Israel–Hamas_war",
  "Red_Sea_crisis"
];

const requestSchema = z.object({
  articles: z.array(z.string().min(1)).optional(),
  observationStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2023-01-01")
});

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);

function compactDate(isoDate: string) {
  return isoDate.replace(/-/g, "");
}

function seriesCodeForArticle(article: string) {
  const slug = article
    .normalize("NFKD")
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 80);
  return `WIKI_${slug}`;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PageviewItem = {
  timestamp?: string;
  views?: number;
};

async function fetchPageviews(article: string, observationStart: string) {
  const start = compactDate(observationStart);
  const end = compactDate(todayIsoDate());
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${encodeURIComponent(article)}/daily/${start}/${end}`;

  let response: Response | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    response = await fetch(url, {
      cache: "no-store",
      // Wikimedia's API policy requires a descriptive User-Agent.
      headers: { "User-Agent": "MacroVault/1.0 (https://macro-vault-v3.vercel.app)" }
    });

    if (response.ok) break;
    // 404 = article has no pageview data; treat as empty, not an error.
    if (response.status === 404) return [];

    if (!retryableStatuses.has(response.status) || attempt === 3) {
      throw new Error(`Wikimedia request failed for ${article}: ${response.status}`);
    }

    await wait(attempt * 500);
  }

  if (!response?.ok) {
    throw new Error(`Wikimedia request failed for ${article}: no response`);
  }

  const payload = await response.json();
  const items: PageviewItem[] = Array.isArray(payload?.items) ? payload.items : [];

  const rows = items
    .map((item) => {
      if (!item.timestamp || !Number.isFinite(Number(item.views))) return null;
      // timestamp is YYYYMMDD00.
      const ymd = item.timestamp.slice(0, 8);
      const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
      return { date, value: Number(item.views) };
    })
    .filter((row): row is { date: string; value: number } => row !== null);

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
    const articles = input.articles?.length ? input.articles : articleBundle;

    const supabase = createSupabaseAdmin();
    const synced = [];
    const failed = [];

    for (const article of articles) {
      try {
        const rows = await fetchPageviews(article, input.observationStart);

        const { data: series, error: seriesError } = await supabase
          .from("macro_series")
          .upsert(
            {
              provider: "wikimedia",
              series_code: seriesCodeForArticle(article),
              name: `Wikipedia daily pageviews: ${article.replace(/_/g, " ")}`,
              country_code: "WLD",
              unit: "views/day",
              metadata: {
                article,
                source: "Wikimedia REST pageviews API",
                project: "en.wikipedia",
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
              metadata: { article }
            })),
            { onConflict: "series_id,date" }
          );

          if (obsError) throw obsError;
        }

        synced.push({ seriesCode: series.series_code, observations: rows.length });
      } catch (error) {
        failed.push({
          article,
          error: error instanceof Error ? error.message : "Unknown Wikimedia sync error"
        });
      }
    }

    const totalSeries = synced.length;
    const totalObservations = synced.reduce((sum, item) => sum + item.observations, 0);
    await recordSyncRun(supabase, {
      connector: "wikimedia",
      action: "attention_pageviews_daily",
      status: getSyncRunStatus(totalSeries, failed.length),
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries,
      totalObservations,
      failedCount: failed.length,
      details: {
        observationStart: input.observationStart,
        requestedArticles: articles,
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
