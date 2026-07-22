import type {
  MacroDashboardEvent,
  MacroDashboardOpportunity,
  MacroEvent,
  MacroEventPrepNotes
} from "@/types/vault";

// macro_events carrying a promoted engine report use this category.
const ENGINE_OPPORTUNITY_CATEGORY = "engine_opportunity";

export function addIsoDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function eventMetadataText(event: MacroEvent, key: string) {
  return stringValue(event.metadata?.[key]);
}

export function isEconomicCalendarEvent(event: MacroEvent) {
  return event.category === "economic_calendar" || event.metadata?.source === "economic_calendar";
}

export function isEngineOpportunityEvent(event: MacroEvent) {
  return event.category === ENGINE_OPPORTUNITY_CATEGORY;
}

export function severityFromScore(score: number | null): MacroDashboardOpportunity["severity"] {
  const value = Number(score ?? 0);
  if (value >= 90) return "extreme";
  if (value >= 70) return "high";
  if (value >= 40) return "medium";
  return "low";
}

function metadataStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

export function toOpportunity(event: MacroEvent): MacroDashboardOpportunity {
  const metadata = isRecord(event.metadata) ? event.metadata : {};
  const conviction = Number(event.impact_score ?? metadata.score ?? 0);
  const divergenceScore = Number(metadata.divergence_score ?? metadata.divergenceScore ?? conviction);

  return {
    id: event.id,
    label: event.title,
    status: "opportunity",
    severity: severityFromScore(event.impact_score),
    conviction,
    divergenceScore,
    coordinates: metadata.coordinates ?? null,
    assetBasket: metadata.asset_basket ?? metadata.assetBasket ?? null,
    catalysts: metadataStringArray(metadata.catalysts),
    invalidation: stringValue(metadata.invalidation),
    report: stringValue(metadata.report),
    rawTelemetry: metadata.raw_telemetry ?? metadata.rawTelemetry ?? null,
    situation: event.narrative,
    updatedAt: event.created_at,
    sources: event.source_url || event.source_title ? [{ title: event.source_title, url: event.source_url }] : []
  };
}

function classifyCalendarTheme(event: MacroEvent) {
  const text = `${event.title} ${event.narrative}`.toLowerCase();
  if (text.includes("cpi") || text.includes("inflation") || text.includes("price")) return "Inflation";
  if (text.includes("unemployment") || text.includes("job") || text.includes("payroll") || text.includes("wage")) return "Labor";
  if (text.includes("gdp") || text.includes("growth")) return "Growth";
  if (text.includes("pmi") || text.includes("manufacturing") || text.includes("industrial")) return "Activity";
  if (text.includes("housing") || text.includes("home") || text.includes("mortgage")) return "Housing";
  if (text.includes("trade") || text.includes("export") || text.includes("import")) return "Trade";
  if (text.includes("rate") || text.includes("fed") || text.includes("ecb") || text.includes("central bank")) return "Rates";
  return "Other";
}

export function classifyMacroCriticalEvent(event: MacroEvent) {
  const text = `${event.title} ${event.narrative}`.toLowerCase();

  if (text.includes("core cpi")) return "Core CPI";
  if (text.includes("cpi") || text.includes("consumer price")) return "CPI";
  if (text.includes("nonfarm") || text.includes("nfp") || text.includes("payroll")) return "NFP";
  if (text.includes("unemployment")) return "Unemployment";
  if (text.includes("retail sales")) return "Retail Sales";
  if (text.includes("gdp") || text.includes("gross domestic")) return "GDP";
  if (text.includes("pmi") || text.includes("ism")) return "PMI";
  if (
    text.includes("interest rate") ||
    text.includes("rate decision") ||
    text.includes("fed decision") ||
    text.includes("ecb decision") ||
    text.includes("boe decision") ||
    text.includes("central bank")
  ) {
    return "Central Bank";
  }

  return null;
}

export function isMacroCriticalRelease(event: MacroEvent) {
  return Boolean(classifyMacroCriticalEvent(event)) || Number(event.impact_score ?? 0) >= 70;
}

function parseEventNumber(value: string | null) {
  if (!value) return null;
  const multiplier = value.toLowerCase().includes("k") ? 1000 : value.toLowerCase().includes("m") ? 1000000 : 1;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed * multiplier : null;
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 2
  }).format(value);
}

function buildSurprise(event: MacroEvent) {
  const actualNumber = parseEventNumber(eventMetadataText(event, "actual"));
  const forecastNumber = parseEventNumber(eventMetadataText(event, "forecast"));
  if (actualNumber === null || forecastNumber === null) return null;

  const value = actualNumber - forecastNumber;
  if (Math.abs(value) < 0.0001) {
    return {
      value,
      label: "In line with forecast",
      direction: "in_line" as const
    };
  }

  return {
    value,
    label: `${value > 0 ? "+" : ""}${formatCompact(value)} vs forecast`,
    direction: value > 0 ? ("above_forecast" as const) : ("below_forecast" as const)
  };
}

function getPrepNotes(event: MacroEvent): MacroEventPrepNotes | null {
  const notes = event.metadata?.prep_notes;
  if (!isRecord(notes)) return null;

  return {
    market_expectation: stringValue(notes.market_expectation) ?? "",
    upside_surprise: stringValue(notes.upside_surprise) ?? "",
    downside_surprise: stringValue(notes.downside_surprise) ?? "",
    likely_assets: stringValue(notes.likely_assets) ?? "",
    trade_plan: stringValue(notes.trade_plan) ?? "",
    post_release_read: stringValue(notes.post_release_read) ?? "",
    updated_at: stringValue(notes.updated_at) ?? undefined
  };
}

export function toDashboardEvent(event: MacroEvent): MacroDashboardEvent {
  const theme = classifyCalendarTheme(event);

  return {
    ...event,
    event_type: classifyMacroCriticalEvent(event) ?? theme,
    theme,
    is_macro_critical: isMacroCriticalRelease(event),
    actual: eventMetadataText(event, "actual"),
    forecast: eventMetadataText(event, "forecast"),
    previous: eventMetadataText(event, "previous"),
    surprise: buildSurprise(event),
    prep_notes: getPrepNotes(event)
  };
}
