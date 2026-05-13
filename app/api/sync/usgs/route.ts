import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createMacroEvents, listMacroEvents } from "@/lib/intelligence-store";
import { recordSyncRun } from "@/lib/sync-log";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import type { MacroEvent, SourceTier } from "@/types/vault";

export const runtime = "nodejs";

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  minMagnitude: z.coerce.number().min(2.5).max(10).default(5.5),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  dryRun: z.boolean().default(false)
});

type UsgsFeature = {
  id?: string;
  type?: string;
  properties?: Record<string, unknown>;
  geometry?: {
    type?: string;
    coordinates?: unknown[];
  } | null;
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
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function isoDateFromMs(value: unknown) {
  const ms = numberValue(value);
  if (!ms) return new Date().toISOString().slice(0, 10);
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function coordinate(feature: UsgsFeature, index: number) {
  const value = feature.geometry?.coordinates?.[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function impactScore(magnitude: number | null, tsunami: number | null, alert: string | null) {
  const magnitudeScore = magnitude === null ? 40 : Math.min(100, Math.max(0, magnitude * 12));
  const tsunamiBoost = tsunami ? 8 : 0;
  const alertBoost = alert === "red" ? 15 : alert === "orange" ? 10 : alert === "yellow" ? 5 : 0;
  return Math.min(100, Math.round(magnitudeScore + tsunamiBoost + alertBoost));
}

async function fetchEarthquakes(input: z.infer<typeof querySchema>) {
  const now = new Date();
  const start = addDays(now, -input.days).toISOString().slice(0, 10);
  const end = now.toISOString().slice(0, 10);
  const url = new URL("https://earthquake.usgs.gov/fdsnws/event/1/query");
  url.searchParams.set("format", "geojson");
  url.searchParams.set("starttime", start);
  url.searchParams.set("endtime", end);
  url.searchParams.set("minmagnitude", String(input.minMagnitude));
  url.searchParams.set("orderby", "time");
  url.searchParams.set("limit", String(input.limit));

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`USGS earthquake request failed: HTTP ${response.status}`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.features) ? (payload.features as UsgsFeature[]) : [];
}

function featureToMacroEvent(feature: UsgsFeature): Omit<MacroEvent, "id" | "created_at"> | null {
  const properties = isRecord(feature.properties) ? feature.properties : {};
  const title = stringValue(properties.title) ?? stringValue(properties.place);
  const sourceUrl = stringValue(properties.url);
  const magnitude = numberValue(properties.mag);
  const tsunami = numberValue(properties.tsunami);
  const alert = stringValue(properties.alert)?.toLowerCase() ?? null;
  const longitude = coordinate(feature, 0);
  const latitude = coordinate(feature, 1);
  const depthKm = coordinate(feature, 2);

  if (!title || !sourceUrl) return null;

  return {
    event_date: isoDateFromMs(properties.time),
    title,
    narrative: [
      magnitude !== null ? `Magnitude ${magnitude}` : null,
      stringValue(properties.place),
      depthKm !== null ? `depth ${depthKm} km` : null,
      alert ? `alert ${alert}` : null,
      tsunami ? "tsunami flag" : null
    ]
      .filter(Boolean)
      .join(" / "),
    category: "usgs_earthquake",
    country_code: "WLD",
    region: stringValue(properties.place) ?? "WLD",
    impact_score: impactScore(magnitude, tsunami, alert),
    confidence: 0.9,
    source_url: sourceUrl,
    source_title: "USGS Earthquake Hazards Program",
    source_tier: "public_web" as SourceTier,
    metadata: {
      source: "usgs_earthquake",
      provider: "usgs",
      usgsId: feature.id,
      magnitude,
      tsunami,
      alert,
      status: stringValue(properties.status),
      significance: numberValue(properties.sig),
      place: stringValue(properties.place),
      longitude,
      latitude,
      depthKm,
      geometry: feature.geometry,
      properties
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
    const features = await fetchEarthquakes(input);
    const existingEvents = await listMacroEvents(supabase, { limit: 500, category: "usgs_earthquake" });
    const existingIds = new Set(
      existingEvents.map((event) => (isRecord(event.metadata) ? stringValue(event.metadata.usgsId) : null)).filter(Boolean)
    );
    const candidateEvents = features
      .map(featureToMacroEvent)
      .filter((event): event is Omit<MacroEvent, "id" | "created_at"> => Boolean(event));
    const newEvents = candidateEvents.filter((event) => {
      const usgsId = isRecord(event.metadata) ? stringValue(event.metadata.usgsId) : null;
      return !usgsId || !existingIds.has(usgsId);
    });
    const duplicatesSkipped = candidateEvents.length - newEvents.length;

    if (input.dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        totalEvents: candidateEvents.length,
        newEvents: newEvents.length,
        duplicatesSkipped,
        events: newEvents.slice(0, 10),
        query: {
          days: input.days,
          minMagnitude: input.minMagnitude,
          limit: input.limit
        },
        timestamp: new Date().toISOString()
      });
    }

    const storedEvents = await createMacroEvents(supabase, newEvents);

    await recordSyncRun(supabase, {
      connector: "usgs",
      action: "earthquake_telemetry",
      status: "success",
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries: 0,
      totalObservations: storedEvents.length,
      details: {
        days: input.days,
        minMagnitude: input.minMagnitude,
        totalFetched: features.length,
        totalCandidates: candidateEvents.length,
        storedEvents: storedEvents.length,
        duplicatesSkipped
      }
    });

    return NextResponse.json({
      ok: true,
      totalEvents: candidateEvents.length,
      storedEvents: storedEvents.length,
      duplicatesSkipped,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    await recordSyncRun(supabase, {
      connector: "usgs",
      action: "earthquake_telemetry",
      status: "failed",
      startedAt,
      durationMs: Date.now() - startedMs,
      failedCount: 1,
      error: error instanceof Error ? error.message : "Unknown USGS sync error"
    });

    return jsonError(error);
  }
}
