import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createMacroEvents, listMacroEvents } from "@/lib/intelligence-store";
import { recordSyncRun } from "@/lib/sync-log";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import type { MacroEvent, SourceTier } from "@/types/vault";

export const runtime = "nodejs";

const airportEventsUrl = "https://nasstatus.faa.gov/api/airport-events";
const enrouteEventsUrl = "https://nasstatus.faa.gov/api/enroute-events";
const faaSourceTitle = "FAA National Airspace System Status";
const sourceTier: SourceTier = "public_web";

const syncSchema = z.object({
  includeFreeForm: z.boolean().default(false),
  dryRun: z.boolean().default(false)
});

type FaaEventCategory =
  | "faa_ground_stop"
  | "faa_ground_delay"
  | "faa_airport_closure"
  | "faa_arrival_delay"
  | "faa_departure_delay"
  | "faa_deicing"
  | "faa_enroute_constraint";

type FaaCandidate = Omit<MacroEvent, "id" | "created_at"> & {
  metadata: Record<string, unknown> & {
    stableKey: string;
    source: "faa_nas";
    provider: "faa";
  };
};

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

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return null;
}

function firstNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function isoDateFromValue(value: unknown) {
  const raw = stringValue(value);
  if (!raw) return new Date().toISOString().slice(0, 10);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw.slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function cleanText(value: string | null) {
  return value?.replace(/\s+/g, " ").trim() || null;
}

function eventTimeRange(record: Record<string, unknown>) {
  const start = firstString(record, ["startTime", "start", "startDateTime", "effectiveStart"]);
  const end = firstString(record, ["endTime", "end", "programExpirationTime", "expirationTime", "effectiveEnd"]);
  if (start && end) return `${start} to ${end}`;
  return start ?? end;
}

function eventReason(record: Record<string, unknown>) {
  return cleanText(
    firstString(record, [
      "impactingCondition",
      "reason",
      "description",
      "text",
      "simpleText",
      "freeText",
      "name",
      "programName"
    ])
  );
}

function airportLabel(parent: Record<string, unknown>) {
  const airportId = firstString(parent, ["airportId", "airport", "iata", "icao"]) ?? "UNKNOWN";
  const longName = firstString(parent, ["airportLongName", "airportName", "name"]);
  return longName ? `${airportId} ${longName}` : airportId;
}

function stableKey(category: FaaEventCategory, parent: Record<string, unknown>, event: Record<string, unknown>) {
  const id = firstString(event, ["id", "advisoryId", "fcaId", "programId"]);
  if (id) return `${category}:${id}`;

  return [
    category,
    firstString(parent, ["airportId", "airport"]) ?? firstString(event, ["airportId", "controlElement", "name"]) ?? "unknown",
    firstString(event, ["startTime", "sourceTimeStamp", "updateTime", "createdAt"]) ?? "unknown-start",
    firstString(event, ["endTime", "programExpirationTime", "expirationTime"]) ?? "unknown-end",
    eventReason(event) ?? "unknown-reason"
  ]
    .join(":")
    .toLowerCase();
}

function sourceUrl(event: Record<string, unknown>) {
  return firstString(event, ["advisoryUrl", "url", "sourceUrl"]) ?? "https://nasstatus.faa.gov/";
}

function eventDate(event: Record<string, unknown>) {
  return isoDateFromValue(
    firstString(event, ["startTime", "updateTime", "sourceTimeStamp", "createdAt", "issuedDate"]) ?? new Date().toISOString()
  );
}

function delayPhrase(record: Record<string, unknown>) {
  const avgDelay = firstNumber(record, ["avgDelay", "averageDelay"]);
  const maxDelay = firstNumber(record, ["maxDelay"]);
  const arrivalDeparture = isRecord(record.arrivalDeparture) ? record.arrivalDeparture : null;
  const min = arrivalDeparture ? firstString(arrivalDeparture, ["min"]) : null;
  const max = arrivalDeparture ? firstString(arrivalDeparture, ["max"]) : null;
  const trend = firstString(record, ["trend"]) ?? (arrivalDeparture ? firstString(arrivalDeparture, ["trend"]) : null);

  return [
    avgDelay !== null ? `average delay ${Math.round(avgDelay)} min` : null,
    maxDelay !== null ? `max delay ${Math.round(maxDelay)} min` : null,
    min && max ? `range ${min}-${max}` : null,
    trend ? `trend ${trend}` : null
  ]
    .filter(Boolean)
    .join(" / ");
}

function impactScore(category: FaaEventCategory, event: Record<string, unknown>) {
  if (category === "faa_airport_closure") return 90;
  if (category === "faa_ground_stop") return 85;
  if (category === "faa_enroute_constraint") return 70;
  if (category === "faa_deicing") return 35;

  const avgDelay = firstNumber(event, ["avgDelay", "averageDelay"]);
  const maxDelay = firstNumber(event, ["maxDelay"]);
  const delay = Math.max(avgDelay ?? 0, maxDelay ?? 0);

  if (category === "faa_ground_delay") {
    if (delay >= 90) return 80;
    if (delay >= 45) return 70;
    return 60;
  }

  if (category === "faa_arrival_delay" || category === "faa_departure_delay") {
    if (delay >= 45) return 60;
    if (delay >= 20) return 52;
    return 45;
  }

  return 50;
}

function shouldIgnoreFreeForm(event: Record<string, unknown>) {
  const text = `${firstString(event, ["simpleText", "text"]) ?? ""}`.toLowerCase();
  return (
    text.includes("non sked") ||
    text.includes("non-sked") ||
    text.includes("transient ga") ||
    text.includes(" ga acft") ||
    text.includes(" ppr") ||
    text.includes("prior permission")
  );
}

function isFreeFormAirportClosure(event: Record<string, unknown>) {
  const text = `${firstString(event, ["simpleText", "text"]) ?? ""}`.toLowerCase();
  return (
    text.includes(" ap clsd") ||
    text.includes("ad ap clsd") ||
    text.includes("airport closed") ||
    text.includes("airport closure")
  );
}

function buildAirportEvent(
  parent: Record<string, unknown>,
  event: Record<string, unknown>,
  category: FaaEventCategory,
  label: string
): FaaCandidate {
  const reason = eventReason(event);
  const range = eventTimeRange(event);
  const delay = delayPhrase(event);
  const airport = airportLabel(parent);
  const advisory = sourceUrl(event);
  const key = stableKey(category, parent, event);

  return {
    event_date: eventDate(event),
    title: `${firstString(parent, ["airportId"]) ?? "FAA"} ${label}`,
    narrative: [
      `${airport}: ${label}`,
      reason,
      range ? `window ${range}` : null,
      delay || null,
      advisory !== "https://nasstatus.faa.gov/" ? "FAA advisory available" : null
    ]
      .filter(Boolean)
      .join(" / "),
    category,
    country_code: "US",
    region: firstString(parent, ["airportId", "airport"]) ?? "US",
    impact_score: impactScore(category, event),
    confidence: 0.95,
    source_url: advisory,
    source_title: faaSourceTitle,
    source_tier: sourceTier,
    metadata: {
      stableKey: key,
      source: "faa_nas",
      provider: "faa",
      eventType: category,
      airportId: firstString(parent, ["airportId"]),
      airportLongName: firstString(parent, ["airportLongName"]),
      latitude: numberValue(parent.latitude),
      longitude: numberValue(parent.longitude),
      reason,
      timeRange: range,
      delay,
      raw: event,
      airportRecord: parent
    }
  };
}

function airportRecordToCandidates(record: Record<string, unknown>, includeFreeForm: boolean) {
  const candidates: FaaCandidate[] = [];
  const mappings: Array<[keyof typeof record, FaaEventCategory, string]> = [
    ["groundStop", "faa_ground_stop", "Ground Stop"],
    ["groundDelay", "faa_ground_delay", "Ground Delay Program"],
    ["airportClosure", "faa_airport_closure", "Airport Closure"],
    ["arrivalDelay", "faa_arrival_delay", "Arrival Delay"],
    ["departureDelay", "faa_departure_delay", "Departure Delay"],
    ["deicing", "faa_deicing", "Deicing"]
  ];

  for (const [key, category, label] of mappings) {
    const event = record[key];
    if (isRecord(event)) candidates.push(buildAirportEvent(record, event, category, label));
  }

  if (
    isRecord(record.freeForm) &&
    !shouldIgnoreFreeForm(record.freeForm) &&
    (isFreeFormAirportClosure(record.freeForm) || includeFreeForm)
  ) {
    candidates.push(buildAirportEvent(record, record.freeForm, "faa_airport_closure", "Airport Notice"));
  }

  return candidates;
}

function buildEnrouteEvent(event: Record<string, unknown>): FaaCandidate {
  const name = firstString(event, ["name", "programName", "fcaName", "controlElement", "id"]) ?? "FAA Enroute Constraint";
  const reason = eventReason(event);
  const range = eventTimeRange(event);
  const delay = delayPhrase(event);
  const key = stableKey("faa_enroute_constraint", event, event);
  const advisory = sourceUrl(event);

  return {
    event_date: eventDate(event),
    title: `${name} Enroute Constraint`,
    narrative: [
      `FAA enroute constraint ${name}`,
      reason,
      range ? `window ${range}` : null,
      delay || null,
      advisory !== "https://nasstatus.faa.gov/" ? "FAA advisory available" : null
    ]
      .filter(Boolean)
      .join(" / "),
    category: "faa_enroute_constraint",
    country_code: "US",
    region: firstString(event, ["center", "sourceCenter", "artcc", "controlElement"]) ?? "US",
    impact_score: impactScore("faa_enroute_constraint", event),
    confidence: 0.9,
    source_url: advisory,
    source_title: faaSourceTitle,
    source_tier: sourceTier,
    metadata: {
      stableKey: key,
      source: "faa_nas",
      provider: "faa",
      eventType: "faa_enroute_constraint",
      reason,
      timeRange: range,
      delay,
      raw: event
    }
  };
}

async function fetchJsonArray(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`FAA NAS request failed for ${url}: HTTP ${response.status}`);
  }

  if (!Array.isArray(data)) {
    throw new Error(`FAA NAS request returned an unexpected payload for ${url}.`);
  }

  return data.filter(isRecord);
}

async function existingFaaKeys(supabase: ReturnType<typeof createSupabaseAdmin>) {
  const categories: FaaEventCategory[] = [
    "faa_ground_stop",
    "faa_ground_delay",
    "faa_airport_closure",
    "faa_arrival_delay",
    "faa_departure_delay",
    "faa_deicing",
    "faa_enroute_constraint"
  ];
  const existing = await Promise.all(categories.map((category) => listMacroEvents(supabase, { limit: 500, category })));
  return new Set(
    existing
      .flat()
      .map((event) => (isRecord(event.metadata) ? stringValue(event.metadata.stableKey) : null))
      .filter((key): key is string => Boolean(key))
  );
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const supabase = createSupabaseAdmin();

  try {
    const input = syncSchema.parse(await request.json().catch(() => ({})));
    const [airportRows, enrouteRows] = await Promise.all([fetchJsonArray(airportEventsUrl), fetchJsonArray(enrouteEventsUrl)]);
    const airportCandidates = airportRows.flatMap((record) => airportRecordToCandidates(record, input.includeFreeForm));
    const enrouteCandidates = enrouteRows.map(buildEnrouteEvent);
    const candidates = [...airportCandidates, ...enrouteCandidates];
    const seen = new Set<string>();
    const uniqueCandidates = candidates.filter((event) => {
      const key = event.metadata.stableKey;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const existingKeys = await existingFaaKeys(supabase);
    const events = uniqueCandidates.filter((event) => !existingKeys.has(event.metadata.stableKey));
    const duplicatesSkipped = uniqueCandidates.length - events.length;

    if (input.dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        fetchedAirportRows: airportRows.length,
        fetchedEnrouteRows: enrouteRows.length,
        totalEvents: uniqueCandidates.length,
        storedEvents: events.length,
        duplicatesSkipped,
        events: events.slice(0, 10),
        timestamp: new Date().toISOString()
      });
    }

    const storedEvents = await createMacroEvents(supabase, events);

    await recordSyncRun(supabase, {
      connector: "faa",
      action: "nas_status",
      status: "success",
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries: 0,
      totalObservations: storedEvents.length,
      details: {
        fetchedAirportRows: airportRows.length,
        fetchedEnrouteRows: enrouteRows.length,
        totalCandidates: uniqueCandidates.length,
        storedEvents: storedEvents.length,
        duplicatesSkipped,
        includeFreeForm: input.includeFreeForm
      }
    });

    return NextResponse.json({
      ok: true,
      fetchedAirportRows: airportRows.length,
      fetchedEnrouteRows: enrouteRows.length,
      totalEvents: uniqueCandidates.length,
      storedEvents: storedEvents.length,
      duplicatesSkipped,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    await recordSyncRun(supabase, {
      connector: "faa",
      action: "nas_status",
      status: "failed",
      startedAt,
      durationMs: Date.now() - startedMs,
      failedCount: 1,
      error: error instanceof Error ? error.message : "Unknown FAA NAS sync error"
    });

    return jsonError(error);
  }
}
