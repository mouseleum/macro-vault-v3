import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { getOptionalEnv } from "@/lib/env";
import { createMacroEvent, createMacroEvents, listMacroEvents, updateMacroEvent } from "@/lib/intelligence-store";
import { recordSyncRun } from "@/lib/sync-log";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import type { MacroEvent, SourceTier } from "@/types/vault";

export const runtime = "nodejs";

const syncSchema = z.object({
  provider: z.enum(["fmp"]).default("fmp"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  country: z.string().trim().min(2).max(3).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60)
});

type FmpCalendarRecord = Record<string, unknown>;

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function stringValue(record: FmpCalendarRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function normalizeCountry(value: string | null) {
  if (!value) return "WLD";
  if (value.length <= 3) return value.toUpperCase();
  const common: Record<string, string> = {
    "united states": "US",
    usa: "US",
    china: "CN",
    japan: "JP",
    germany: "DE",
    "euro area": "EMU",
    eurozone: "EMU",
    "united kingdom": "GB",
    uk: "GB"
  };
  return common[value.toLowerCase()] ?? value.slice(0, 3).toUpperCase();
}

function normalizeImpact(record: FmpCalendarRecord) {
  const raw = stringValue(record, ["impact", "importance", "volatility", "priority"]);
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (normalized.includes("high") || normalized === "3") return 75;
  if (normalized.includes("medium") || normalized === "2") return 45;
  if (normalized.includes("low") || normalized === "1") return 20;
  return null;
}

function normalizeFmpCalendarRecord(record: FmpCalendarRecord): Omit<MacroEvent, "id" | "created_at"> | null {
  const title = stringValue(record, ["event", "name", "title", "indicator"]);
  const dateRaw = stringValue(record, ["date", "dateUtc", "datetime", "time"]);
  if (!title || !dateRaw) return null;

  const eventDate = dateRaw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return null;

  const country = normalizeCountry(stringValue(record, ["country", "countryCode", "country_code"]));
  const actual = stringValue(record, ["actual", "actualValue"]);
  const forecast = stringValue(record, ["estimate", "forecast", "consensus"]);
  const previous = stringValue(record, ["previous", "prior"]);
  const currency = stringValue(record, ["currency", "currencyCode"]);
  const impactScore = normalizeImpact(record);

  return {
    event_date: eventDate,
    title,
    narrative: [
      title,
      actual ? `actual ${actual}` : null,
      forecast ? `forecast ${forecast}` : null,
      previous ? `previous ${previous}` : null
    ]
      .filter(Boolean)
      .join(" / "),
    category: "economic_calendar",
    country_code: country,
    region: country,
    impact_score: impactScore,
    confidence: 0.85,
    source_url: "https://site.financialmodelingprep.com/developer/docs/stable/economics-calendar",
    source_title: "Financial Modeling Prep Economic Calendar",
    source_tier: "public_web" as SourceTier,
    metadata: {
      source: "economic_calendar",
      provider: "fmp",
      provider_record: record,
      actual,
      forecast,
      previous,
      currency,
      impact_score: impactScore
    }
  };
}

function eventKey(event: Pick<MacroEvent, "event_date" | "title" | "country_code" | "category">) {
  return [event.event_date, event.country_code ?? "WLD", event.category ?? "macro_event", event.title.toLowerCase()].join("|");
}

function eventMetadata(event: Pick<MacroEvent, "metadata">) {
  return event.metadata && typeof event.metadata === "object" ? (event.metadata as Record<string, unknown>) : {};
}

const releaseFields = ["actual", "forecast", "previous"] as const;

function hasNewReleaseValues(incoming: Record<string, unknown>, existing: Record<string, unknown>) {
  return releaseFields.some((field) => incoming[field] != null && incoming[field] !== existing[field]);
}

async function fetchFmpCalendar(input: z.infer<typeof syncSchema>) {
  const apiKey = getOptionalEnv("FMP_API_KEY") ?? "demo";
  const url = new URL("https://financialmodelingprep.com/stable/economic-calendar");
  url.searchParams.set("apikey", apiKey);
  if (input.from) url.searchParams.set("from", input.from);
  if (input.to) url.searchParams.set("to", input.to);

  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`FMP economic calendar request failed: HTTP ${response.status}`);
  }

  if (!Array.isArray(data)) {
    throw new Error("FMP economic calendar returned an unexpected payload.");
  }

  return data as FmpCalendarRecord[];
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const supabase = createSupabaseAdmin();

  try {
    const parsed = syncSchema.parse(await request.json().catch(() => ({})));
    const from = parsed.from ?? isoDate(addDays(new Date(), -7));
    const to = parsed.to ?? isoDate(addDays(new Date(), 30));
    const input = { ...parsed, from, to };
    const records = await fetchFmpCalendar(input);
    const country = input.country?.toUpperCase();
    const normalizedEvents = records
      .map(normalizeFmpCalendarRecord)
      .filter((event): event is Omit<MacroEvent, "id" | "created_at"> => Boolean(event))
      .filter((event) => !country || event.country_code === country)
      .slice(0, input.limit);
    // Scope the dedup query to the sync window; the key includes event_date, so
    // only events inside [from, to] can collide. A "latest N rows" scan misses
    // older events once the table grows.
    const existingEvents = await listMacroEvents(supabase, {
      limit: 2000,
      category: "economic_calendar",
      country,
      from,
      to
    });
    const existingByKey = new Map(existingEvents.map((event) => [eventKey(event), event] as const));

    const newEvents: typeof normalizedEvents = [];
    const releaseUpdates: Array<{ id: string; patch: Partial<MacroEvent> }> = [];

    for (const event of normalizedEvents) {
      const existing = existingByKey.get(eventKey(event));
      if (!existing) {
        newEvents.push(event);
        continue;
      }

      const incomingMetadata = eventMetadata(event);
      const existingMetadata = eventMetadata(existing);
      if (!hasNewReleaseValues(incomingMetadata, existingMetadata)) continue;

      releaseUpdates.push({
        id: existing.id,
        patch: {
          narrative: event.narrative,
          impact_score: event.impact_score ?? existing.impact_score,
          metadata: {
            // Keep keys the sync doesn't own (e.g. prep_notes) and never
            // overwrite a stored release value with null.
            ...existingMetadata,
            ...Object.fromEntries(Object.entries(incomingMetadata).filter(([, value]) => value != null))
          }
        }
      });
    }

    let storedEvents: MacroEvent[] = [];
    let conflictSkipped = 0;
    try {
      storedEvents = await createMacroEvents(supabase, newEvents);
    } catch (batchError) {
      if ((batchError as { code?: string } | null)?.code !== "23505") throw batchError;
      // The batch hit the unique index on calendar events (in-app dedup raced a
      // concurrent sync or read stale rows). The index is the authoritative
      // dedup, so retry row by row and treat violations as already stored.
      for (const event of newEvents) {
        try {
          storedEvents.push(await createMacroEvent(supabase, event));
        } catch (error) {
          if ((error as { code?: string } | null)?.code === "23505") {
            conflictSkipped += 1;
            continue;
          }
          throw error;
        }
      }
    }

    const updatedEvents: MacroEvent[] = [];
    for (const update of releaseUpdates) {
      updatedEvents.push(await updateMacroEvent(supabase, update.id, update.patch));
    }

    await recordSyncRun(supabase, {
      connector: "economic_calendar",
      action: "fmp_calendar",
      status: "success",
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries: 0,
      totalObservations: storedEvents.length + updatedEvents.length,
      details: {
        provider: "fmp",
        from,
        to,
        usedDemoKey: !getOptionalEnv("FMP_API_KEY"),
        totalFetched: records.length,
        updatedEvents: updatedEvents.length,
        duplicatesSkipped: normalizedEvents.length - newEvents.length - releaseUpdates.length + conflictSkipped
      }
    });

    return NextResponse.json({
      ok: true,
      provider: "fmp",
      fallback: !getOptionalEnv("FMP_API_KEY"),
      totalEvents: records.length,
      storedEvents: storedEvents.length,
      updatedEvents: updatedEvents.length,
      failedCount: records.length - normalizedEvents.length,
      from,
      to,
      events: [...storedEvents, ...updatedEvents]
    });
  } catch (error) {
    await recordSyncRun(supabase, {
      connector: "economic_calendar",
      action: "fmp_calendar",
      status: "failed",
      startedAt,
      durationMs: Date.now() - startedMs,
      failedCount: 1,
      error: error instanceof Error ? error.message : "Unknown economic calendar sync error"
    });

    return jsonError(error);
  }
}
