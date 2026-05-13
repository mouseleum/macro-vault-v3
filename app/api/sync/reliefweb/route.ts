import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { getOptionalEnv } from "@/lib/env";
import { createMacroEvents, listMacroEvents } from "@/lib/intelligence-store";
import { recordSyncRun } from "@/lib/sync-log";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import type { MacroEvent, SourceTier } from "@/types/vault";

export const runtime = "nodejs";

const reliefThemes = [
  {
    name: "Conflict & Displacement",
    category: "reliefweb_conflict_displacement",
    query: "conflict displacement refugees insecurity violence",
    impactScore: 65
  },
  {
    name: "Food & Humanitarian Stress",
    category: "reliefweb_food_humanitarian_stress",
    query: "food insecurity famine humanitarian malnutrition acute food insecurity",
    impactScore: 60
  },
  {
    name: "Climate & Disaster Shock",
    category: "reliefweb_disaster_shock",
    query: "earthquake flood drought cyclone wildfire storm",
    impactScore: 55
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
  limit: z.coerce.number().int().min(1).max(50).default(15),
  dryRun: z.boolean().default(false)
});

type ReliefWebItem = {
  id?: string;
  href?: string;
  fields?: Record<string, unknown>;
};

type ReliefTheme = (typeof reliefThemes)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function firstRecord(value: unknown) {
  if (Array.isArray(value)) return value.find(isRecord) ?? null;
  return isRecord(value) ? value : null;
}

function normalizeDate(value: unknown) {
  const direct = stringValue(value);
  if (direct && /^\d{4}-\d{2}-\d{2}/.test(direct)) return direct.slice(0, 10);

  if (isRecord(value)) {
    const created = stringValue(value.created);
    if (created && /^\d{4}-\d{2}-\d{2}/.test(created)) return created.slice(0, 10);
  }

  return new Date().toISOString().slice(0, 10);
}

function normalizeCountryCode(fields: Record<string, unknown>) {
  const primary = firstRecord(fields.primary_country);
  const country = primary ?? firstRecord(fields.country);
  const iso3 = stringValue(country?.iso3 ?? country?.iso);
  const name = stringValue(country?.name);

  if (iso3) return iso3.toUpperCase().slice(0, 3);
  if (!name) return "WLD";

  const common: Record<string, string> = {
    "united states": "US",
    usa: "US",
    china: "CN",
    japan: "JP",
    germany: "DE",
    france: "FR",
    italy: "IT",
    "united kingdom": "GB",
    ukraine: "UA",
    russia: "RU",
    israel: "IL",
    palestine: "PSE",
    "occupied palestinian territory": "PSE",
    sudan: "SDN",
    ethiopia: "ETH",
    somalia: "SOM",
    "south sudan": "SSD",
    yemen: "YEM"
  };

  return common[name.toLowerCase()] ?? name.slice(0, 3).toUpperCase();
}

function namesFrom(value: unknown) {
  if (!Array.isArray(value)) {
    const record = firstRecord(value);
    return record ? [stringValue(record.name)].filter((item): item is string => Boolean(item)) : [];
  }

  return value
    .map((item) => (isRecord(item) ? stringValue(item.name) : null))
    .filter((item): item is string => Boolean(item));
}

async function fetchReliefReports(theme: ReliefTheme, appName: string, limit: number) {
  const url = new URL("https://api.reliefweb.int/v2/reports");
  url.searchParams.set("appname", appName);

  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "MacroVault/1.0"
    },
    body: JSON.stringify({
      limit,
      preset: "latest",
      profile: "list",
      query: {
        value: theme.query,
        operator: "OR"
      },
      fields: {
        include: [
          "title",
          "url",
          "date.created",
          "country.name",
          "country.iso3",
          "primary_country.name",
          "primary_country.iso3",
          "disaster.name",
          "source.name",
          "format.name",
          "theme.name"
        ]
      },
      sort: ["date:desc"]
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(payload?.error)
      ? stringValue(payload.error.message)
      : stringValue(payload?.error) ?? stringValue(payload?.info);
    throw new Error(`ReliefWeb request failed for ${theme.name}: HTTP ${response.status}${message ? ` - ${message}` : ""}`);
  }

  return Array.isArray(payload?.data) ? (payload.data as ReliefWebItem[]) : [];
}

function itemToMacroEvent(item: ReliefWebItem, theme: ReliefTheme): Omit<MacroEvent, "id" | "created_at"> | null {
  const fields = isRecord(item.fields) ? item.fields : {};
  const title = stringValue(fields.title);
  const sourceUrl = stringValue(fields.url) ?? stringValue(item.href);
  if (!title || !sourceUrl) return null;

  const sourceNames = namesFrom(fields.source);
  const disasterNames = namesFrom(fields.disaster);
  const formatNames = namesFrom(fields.format);
  const themeNames = namesFrom(fields.theme);
  const countryCode = normalizeCountryCode(fields);

  return {
    event_date: normalizeDate(fields.date),
    title,
    narrative: [
      title,
      sourceNames.length ? `source ${sourceNames.slice(0, 2).join(", ")}` : null,
      disasterNames.length ? `disaster ${disasterNames.slice(0, 2).join(", ")}` : null,
      themeNames.length ? `themes ${themeNames.slice(0, 3).join(", ")}` : null
    ]
      .filter(Boolean)
      .join(" / "),
    category: theme.category,
    country_code: countryCode,
    region: countryCode,
    impact_score: theme.impactScore,
    confidence: 0.62,
    source_url: sourceUrl,
    source_title: sourceNames[0] ?? "ReliefWeb",
    source_tier: "public_web" as SourceTier,
    metadata: {
      source: "reliefweb",
      provider: "reliefweb",
      reliefwebId: item.id,
      query: theme.query,
      theme: theme.name,
      disasterNames,
      sourceNames,
      formatNames,
      themeNames,
      item
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
    const appName = getOptionalEnv("RELIEFWEB_APP_NAME");
    if (!appName) {
      return NextResponse.json(
        {
          error: "Missing optional server variable: RELIEFWEB_APP_NAME",
          details: "ReliefWeb requires an approved appname. Request one in the ReliefWeb API documentation."
        },
        { status: 400 }
      );
    }

    const body = request.headers.get("content-length") === "0" ? {} : await request.json().catch(() => ({}));
    const input = querySchema.parse(body);
    const themes = input.themes?.length ? input.themes : reliefThemes;
    const existingEvents = await listMacroEvents(supabase, { limit: 500 });
    const existingUrls = new Set(existingEvents.map((event) => event.source_url).filter(Boolean));
    const normalizedEvents: Array<Omit<MacroEvent, "id" | "created_at">> = [];
    const failed = [];

    for (const theme of themes) {
      try {
        const themeWithDefaults = {
          ...theme,
          category: theme.category ?? "reliefweb_humanitarian_stress",
          impactScore: theme.impactScore ?? 55
        };
        const reports = await fetchReliefReports(themeWithDefaults, appName, input.limit);
        const events = reports
          .map((item) => itemToMacroEvent(item, themeWithDefaults))
          .filter((event): event is Omit<MacroEvent, "id" | "created_at"> => Boolean(event))
          .filter((event) => !existingUrls.has(event.source_url));

        for (const event of events) {
          if (event.source_url) existingUrls.add(event.source_url);
          normalizedEvents.push(event);
        }
      } catch (error) {
        failed.push({
          theme: theme.name,
          error: error instanceof Error ? error.message : "Unknown ReliefWeb sync error"
        });
      }
    }

    if (input.dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        totalEvents: normalizedEvents.length,
        failed,
        events: normalizedEvents.slice(0, 10),
        timestamp: new Date().toISOString()
      });
    }

    const storedEvents = await createMacroEvents(supabase, normalizedEvents.slice(0, input.limit * themes.length));

    await recordSyncRun(supabase, {
      connector: "reliefweb",
      action: "humanitarian_stress_scan",
      status: failed.length && storedEvents.length ? "partial" : failed.length ? "failed" : "success",
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries: 0,
      totalObservations: storedEvents.length,
      failedCount: failed.length,
      details: {
        limit: input.limit,
        themes: themes.map((theme) => theme.name),
        storedEvents: storedEvents.length,
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
      connector: "reliefweb",
      action: "humanitarian_stress_scan",
      status: "failed",
      startedAt,
      durationMs: Date.now() - startedMs,
      failedCount: 1,
      error: error instanceof Error ? error.message : "Unknown ReliefWeb sync error"
    });

    return jsonError(error);
  }
}
