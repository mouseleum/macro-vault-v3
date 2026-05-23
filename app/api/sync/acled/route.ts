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

const acledTokenUrl = "https://acleddata.com/oauth/token";
const acledReadUrl = "https://acleddata.com/api/acled/read";
const sourceTier: SourceTier = "licensed";

const defaultCountries = ["Ukraine", "Russia", "Israel", "Palestine", "Iran", "Yemen", "Sudan"];
const defaultEventTypes = [
  "Battles",
  "Explosions/Remote violence",
  "Violence against civilians",
  "Riots",
  "Protests"
];
const acledFields = [
  "event_id_cnty",
  "event_date",
  "country",
  "iso",
  "region",
  "admin1",
  "admin2",
  "admin3",
  "location",
  "latitude",
  "longitude",
  "geo_precision",
  "event_type",
  "sub_event_type",
  "actor1",
  "assoc_actor_1",
  "actor2",
  "assoc_actor_2",
  "inter1",
  "inter2",
  "interaction",
  "civilian_targeting",
  "notes",
  "fatalities",
  "source",
  "source_scale",
  "tags",
  "timestamp"
];

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  countries: z.array(z.string().trim().min(2)).max(40).optional(),
  eventTypes: z.array(z.string().trim().min(3)).max(20).optional(),
  minFatalities: z.coerce.number().int().min(0).max(10000).default(0),
  dryRun: z.boolean().default(false)
});

type AcledCategory =
  | "acled_battle"
  | "acled_explosion_remote_violence"
  | "acled_violence_civilians"
  | "acled_riot"
  | "acled_protest"
  | "acled_strategic_development"
  | "acled_conflict_event";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function cleanText(value: string | null, maxLength = 360) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1).trim()}...` : normalized;
}

function dateRange(days: number) {
  const end = new Date();
  const start = addDays(end, -days);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10)
  };
}

function countryCode(country: string | null) {
  if (!country) return "WLD";
  const map: Record<string, string> = {
    afghanistan: "AFG",
    armenia: "ARM",
    azerbaijan: "AZE",
    china: "CHN",
    ethiopia: "ETH",
    georgia: "GEO",
    india: "IND",
    iran: "IRN",
    iraq: "IRQ",
    israel: "ISR",
    lebanon: "LBN",
    libya: "LBY",
    mali: "MLI",
    myanmar: "MMR",
    niger: "NER",
    nigeria: "NGA",
    pakistan: "PAK",
    palestine: "PSE",
    russia: "RUS",
    somalia: "SOM",
    sudan: "SDN",
    syria: "SYR",
    taiwan: "TWN",
    turkey: "TUR",
    ukraine: "UKR",
    "united states": "US",
    venezuela: "VEN",
    yemen: "YEM"
  };

  return map[country.toLowerCase()] ?? country.slice(0, 3).toUpperCase();
}

function eventCategory(eventType: string | null): AcledCategory {
  const normalized = eventType?.toLowerCase() ?? "";
  if (normalized.includes("battle")) return "acled_battle";
  if (normalized.includes("explosion") || normalized.includes("remote")) return "acled_explosion_remote_violence";
  if (normalized.includes("violence against civilians")) return "acled_violence_civilians";
  if (normalized.includes("riot")) return "acled_riot";
  if (normalized.includes("protest")) return "acled_protest";
  if (normalized.includes("strategic")) return "acled_strategic_development";
  return "acled_conflict_event";
}

function impactScore(category: AcledCategory, fatalities: number | null, civilianTargeting: string | null) {
  const baseScores: Record<AcledCategory, number> = {
    acled_battle: 70,
    acled_explosion_remote_violence: 72,
    acled_violence_civilians: 75,
    acled_riot: 50,
    acled_protest: 35,
    acled_strategic_development: 42,
    acled_conflict_event: 45
  };
  const fatalityBoost =
    fatalities === null || fatalities <= 0
      ? 0
      : fatalities >= 100
        ? 35
        : fatalities >= 20
          ? 25
          : fatalities >= 5
            ? 15
            : 8;
  const civilianBoost = civilianTargeting?.toLowerCase() === "civilian targeting" ? 10 : 0;
  return Math.min(100, baseScores[category] + fatalityBoost + civilianBoost);
}

async function getAcledToken(email: string, password: string) {
  const body = new URLSearchParams({
    username: email,
    password,
    grant_type: "password",
    client_id: "acled",
    scope: "authenticated"
  });
  const response = await fetch(acledTokenUrl, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload = await response.json().catch(() => null);
  const token = isRecord(payload) ? stringValue(payload.access_token) : null;

  if (!response.ok || !token) {
    const message = isRecord(payload) ? stringValue(payload.error_description) ?? stringValue(payload.message) : null;
    throw new Error(`ACLED OAuth failed: HTTP ${response.status}${message ? ` - ${message}` : ""}`);
  }

  return token;
}

async function fetchAcledRows(token: string, input: z.infer<typeof querySchema>) {
  const range = dateRange(input.days);
  const url = new URL(acledReadUrl);
  url.searchParams.set("event_date", `${range.start}|${range.end}`);
  url.searchParams.set("event_date_where", "BETWEEN");
  url.searchParams.set("limit", String(input.limit));
  url.searchParams.set("fields", acledFields.join("|"));
  url.searchParams.set("with_total", "true");
  url.searchParams.set("inter_num", "0");

  const countries = input.countries?.length ? input.countries : defaultCountries;
  if (countries.length) url.searchParams.set("country", countries.join("|"));

  const eventTypes = input.eventTypes?.length ? input.eventTypes : defaultEventTypes;
  if (eventTypes.length) url.searchParams.set("event_type", eventTypes.join("|"));

  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = isRecord(payload) ? stringValue(payload.message) ?? stringValue(payload.error) : null;
    throw new Error(
      `ACLED request failed: HTTP ${response.status}${message ? ` - ${message}` : ""}. Check myACLED API access and accepted terms.`
    );
  }

  const rows: Record<string, unknown>[] = Array.isArray(payload?.data) ? payload.data.filter(isRecord) : [];
  const totalCount = isRecord(payload) ? numberValue(payload.total_count) : null;
  return { rows, totalCount, range, countries, eventTypes };
}

function rowToEvent(row: Record<string, unknown>): Omit<MacroEvent, "id" | "created_at"> | null {
  const eventId = stringValue(row.event_id_cnty);
  const eventDate = stringValue(row.event_date);
  const country = stringValue(row.country);
  const eventType = stringValue(row.event_type);
  const subEventType = stringValue(row.sub_event_type);
  const location = stringValue(row.location);
  const admin1 = stringValue(row.admin1);
  const actor1 = stringValue(row.actor1);
  const actor2 = stringValue(row.actor2);
  const fatalities = numberValue(row.fatalities);
  const category = eventCategory(eventType);
  const notes = cleanText(stringValue(row.notes));
  const latitude = numberValue(row.latitude);
  const longitude = numberValue(row.longitude);
  const titleLocation = [location, admin1].filter(Boolean).join(", ") || country || "Unknown location";

  if (!eventId || !eventDate || !eventType) return null;

  return {
    event_date: eventDate.slice(0, 10),
    title: `${country ?? "ACLED"}: ${subEventType ?? eventType} in ${titleLocation}`,
    narrative: [
      subEventType ? `${eventType} - ${subEventType}` : eventType,
      titleLocation,
      actor1 ? `actor ${actor1}${actor2 ? ` / ${actor2}` : ""}` : null,
      fatalities !== null ? `fatalities ${fatalities}` : null,
      notes
    ]
      .filter(Boolean)
      .join(" / "),
    category,
    country_code: countryCode(country),
    region: admin1 ?? stringValue(row.region) ?? countryCode(country),
    impact_score: impactScore(category, fatalities, stringValue(row.civilian_targeting)),
    confidence: 0.88,
    source_url: "https://acleddata.com/",
    source_title: "ACLED",
    source_tier: sourceTier,
    metadata: {
      source: "acled",
      provider: "acled",
      eventId,
      acledIso: numberValue(row.iso),
      eventType,
      subEventType,
      country,
      admin1,
      admin2: stringValue(row.admin2),
      admin3: stringValue(row.admin3),
      location,
      latitude,
      longitude,
      geoPrecision: numberValue(row.geo_precision),
      actor1,
      assocActor1: stringValue(row.assoc_actor_1),
      actor2,
      assocActor2: stringValue(row.assoc_actor_2),
      inter1: stringValue(row.inter1),
      inter2: stringValue(row.inter2),
      interaction: stringValue(row.interaction),
      civilianTargeting: stringValue(row.civilian_targeting),
      fatalities,
      sourceName: stringValue(row.source),
      sourceScale: stringValue(row.source_scale),
      tags: stringValue(row.tags),
      timestamp: numberValue(row.timestamp),
      raw: row
    }
  };
}

async function existingAcledIds(supabase: ReturnType<typeof createSupabaseAdmin>) {
  const categories: AcledCategory[] = [
    "acled_battle",
    "acled_explosion_remote_violence",
    "acled_violence_civilians",
    "acled_riot",
    "acled_protest",
    "acled_strategic_development",
    "acled_conflict_event"
  ];
  const existing = await Promise.all(categories.map((category) => listMacroEvents(supabase, { limit: 500, category })));
  return new Set(
    existing
      .flat()
      .map((event) => (isRecord(event.metadata) ? stringValue(event.metadata.eventId) : null))
      .filter((id): id is string => Boolean(id))
  );
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const supabase = createSupabaseAdmin();

  try {
    const email = getOptionalEnv("ACLED_EMAIL");
    const password = getOptionalEnv("ACLED_PASSWORD");
    if (!email || !password) {
      return NextResponse.json(
        {
          error: "Missing optional server variables: ACLED_EMAIL and ACLED_PASSWORD",
          details: "ACLED uses myACLED OAuth credentials. Store them server-side only."
        },
        { status: 400 }
      );
    }

    const body = request.headers.get("content-length") === "0" ? {} : await request.json().catch(() => ({}));
    const input = querySchema.parse(body);
    const token = await getAcledToken(email, password);
    const { rows, totalCount, range, countries, eventTypes } = await fetchAcledRows(token, input);
    const minFatalities = input.minFatalities;
    const candidateEvents = rows
      .filter((row) => (numberValue(row.fatalities) ?? 0) >= minFatalities)
      .map(rowToEvent)
      .filter((event): event is Omit<MacroEvent, "id" | "created_at"> => Boolean(event));
    const existingIds = await existingAcledIds(supabase);
    const seen = new Set<string>();
    const newEvents = candidateEvents.filter((event) => {
      const eventId = isRecord(event.metadata) ? stringValue(event.metadata.eventId) : null;
      if (!eventId) return true;
      if (existingIds.has(eventId) || seen.has(eventId)) return false;
      seen.add(eventId);
      return true;
    });
    const duplicatesSkipped = candidateEvents.length - newEvents.length;

    if (input.dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        fetchedRows: rows.length,
        totalAvailable: totalCount,
        totalEvents: candidateEvents.length,
        storedEvents: newEvents.length,
        duplicatesSkipped,
        query: {
          days: input.days,
          limit: input.limit,
          countries,
          eventTypes,
          minFatalities,
          start: range.start,
          end: range.end
        },
        events: newEvents.slice(0, 10),
        timestamp: new Date().toISOString()
      });
    }

    const storedEvents = await createMacroEvents(supabase, newEvents);

    await recordSyncRun(supabase, {
      connector: "acled",
      action: "conflict_events",
      status: "success",
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries: 0,
      totalObservations: storedEvents.length,
      details: {
        days: input.days,
        limit: input.limit,
        countries,
        eventTypes,
        minFatalities,
        start: range.start,
        end: range.end,
        fetchedRows: rows.length,
        totalAvailable: totalCount,
        totalCandidates: candidateEvents.length,
        storedEvents: storedEvents.length,
        duplicatesSkipped
      }
    });

    return NextResponse.json({
      ok: true,
      fetchedRows: rows.length,
      totalAvailable: totalCount,
      totalEvents: candidateEvents.length,
      storedEvents: storedEvents.length,
      duplicatesSkipped,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    await recordSyncRun(supabase, {
      connector: "acled",
      action: "conflict_events",
      status: "failed",
      startedAt,
      durationMs: Date.now() - startedMs,
      failedCount: 1,
      error: error instanceof Error ? error.message : "Unknown ACLED sync error"
    });

    return jsonError(error, error instanceof Error && error.message.includes("HTTP 403") ? 403 : 500);
  }
}
