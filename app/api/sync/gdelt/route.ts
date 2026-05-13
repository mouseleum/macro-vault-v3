import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createMacroEvents, listMacroEvents } from "@/lib/intelligence-store";
import { recordSyncRun } from "@/lib/sync-log";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import type { MacroEvent, SourceTier } from "@/types/vault";

export const runtime = "nodejs";

const gdeltThemes = [
  {
    name: "Supply Chain Stress",
    category: "gdelt_supply_stress",
    query: "\"shipping disruption\" OR \"port congestion\" OR \"supply chain disruption\" OR \"Red Sea disruption\"",
    impactScore: 55
  },
  {
    name: "Credit & Liquidity Stress",
    category: "gdelt_credit_stress",
    query: "\"credit stress\" OR \"funding stress\" OR \"bank liquidity\" OR \"liquidity crunch\"",
    impactScore: 60
  },
  {
    name: "Geopolitical Escalation",
    category: "gdelt_geopolitical_stress",
    query: "\"geopolitical risk\" OR sanctions OR \"conflict escalation\" OR \"military escalation\"",
    impactScore: 65
  }
];

const querySchema = z.object({
  themes: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        category: z.string().trim().min(1).optional(),
        query: z.string().trim().min(3),
        impactScore: z.coerce.number().min(0).max(100).optional()
      })
    )
    .optional(),
  timespan: z.string().trim().regex(/^\d+[hdmw]$/i).default("3d"),
  maxRecords: z.coerce.number().int().min(1).max(100).default(25)
});

type GdeltArticle = Record<string, unknown>;

function stringValue(record: GdeltArticle, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function normalizeSeenDate(value: string | null) {
  if (!value) return new Date().toISOString().slice(0, 10);
  if (/^\d{14}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function normalizeCountry(value: string | null) {
  if (!value) return "WLD";
  if (/^[A-Za-z]{2,3}$/.test(value)) return value.toUpperCase();

  const common: Record<string, string> = {
    "united states": "US",
    usa: "US",
    china: "CN",
    japan: "JP",
    germany: "DE",
    france: "FR",
    italy: "IT",
    "united kingdom": "GB",
    britain: "GB",
    russia: "RU",
    ukraine: "UA",
    israel: "IL",
    india: "IN"
  };

  return common[value.toLowerCase()] ?? value.slice(0, 3).toUpperCase();
}

function summarizeArticle(article: GdeltArticle, themeName: string) {
  const title = stringValue(article, ["title"]) ?? themeName;
  const domain = stringValue(article, ["domain", "sourceCollectionIdentifier", "sourceCommonName"]);
  const language = stringValue(article, ["language"]);
  return [title, domain ? `source ${domain}` : null, language ? `language ${language}` : null].filter(Boolean).join(" / ");
}

async function fetchGdeltArticles(theme: (typeof gdeltThemes)[number], timespan: string, maxRecords: number) {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", theme.query);
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("sort", "HybridRel");
  url.searchParams.set("timespan", timespan);
  url.searchParams.set("maxrecords", String(maxRecords));

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`GDELT request failed for ${theme.name}: HTTP ${response.status}`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.articles) ? (payload.articles as GdeltArticle[]) : [];
}

function articleToMacroEvent(article: GdeltArticle, theme: (typeof gdeltThemes)[number]): Omit<MacroEvent, "id" | "created_at"> | null {
  const title = stringValue(article, ["title"]);
  const sourceUrl = stringValue(article, ["url"]);
  if (!title || !sourceUrl) return null;

  const sourceCountry = normalizeCountry(stringValue(article, ["sourceCountry", "sourcecountry", "country"]));
  const sourceDomain = stringValue(article, ["domain", "sourceCommonName"]);
  const seenDate = stringValue(article, ["seendate", "seenDate", "date"]);

  return {
    event_date: normalizeSeenDate(seenDate),
    title,
    narrative: summarizeArticle(article, theme.name),
    category: theme.category,
    country_code: sourceCountry,
    region: sourceCountry,
    impact_score: theme.impactScore,
    confidence: 0.55,
    source_url: sourceUrl,
    source_title: sourceDomain ?? "GDELT",
    source_tier: "public_web" as SourceTier,
    metadata: {
      source: "gdelt_doc",
      provider: "gdelt",
      query: theme.query,
      theme: theme.name,
      article
    }
  };
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const supabase = createSupabaseAdmin();

  try {
    const body = request.headers.get("content-length") === "0" ? {} : await request.json().catch(() => ({}));
    const input = querySchema.parse(body);
    const themes = input.themes?.length ? input.themes : gdeltThemes;
    const existingEvents = await listMacroEvents(supabase, { limit: 500 });
    const existingUrls = new Set(existingEvents.map((event) => event.source_url).filter(Boolean));

    const normalizedEvents: Array<Omit<MacroEvent, "id" | "created_at">> = [];
    const failed = [];

    for (const theme of themes) {
      try {
        const themeWithDefaults = {
          ...theme,
          category: theme.category ?? "gdelt_news",
          impactScore: theme.impactScore ?? 50
        };
        const articles = await fetchGdeltArticles(themeWithDefaults, input.timespan, input.maxRecords);
        const events = articles
          .map((article) => articleToMacroEvent(article, themeWithDefaults))
          .filter((event): event is Omit<MacroEvent, "id" | "created_at"> => Boolean(event))
          .filter((event) => !existingUrls.has(event.source_url));

        for (const event of events) {
          if (event.source_url) existingUrls.add(event.source_url);
          normalizedEvents.push(event);
        }
      } catch (error) {
        failed.push({
          theme: theme.name,
          error: error instanceof Error ? error.message : "Unknown GDELT sync error"
        });
      }
    }

    const storedEvents = await createMacroEvents(supabase, normalizedEvents.slice(0, input.maxRecords * themes.length));

    await recordSyncRun(supabase, {
      connector: "gdelt",
      action: "global_news_stress_scan",
      status: failed.length && storedEvents.length ? "partial" : failed.length ? "failed" : "success",
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries: 0,
      totalObservations: storedEvents.length,
      failedCount: failed.length,
      details: {
        timespan: input.timespan,
        maxRecords: input.maxRecords,
        themes: themes.map((theme) => theme.name),
        storedEvents: storedEvents.length,
        duplicatesSkipped: normalizedEvents.length - storedEvents.length,
        failed
      }
    });

    return NextResponse.json({
      ok: true,
      totalEvents: normalizedEvents.length,
      storedEvents: storedEvents.length,
      failed,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    await recordSyncRun(supabase, {
      connector: "gdelt",
      action: "global_news_stress_scan",
      status: "failed",
      startedAt,
      durationMs: Date.now() - startedMs,
      failedCount: 1,
      error: error instanceof Error ? error.message : "Unknown GDELT sync error"
    });

    return jsonError(error);
  }
}
