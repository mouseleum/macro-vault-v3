import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError, todayIsoDate } from "@/lib/api";
import {
  addIsoDays,
  classifyMacroCriticalEvent,
  isEconomicCalendarEvent,
  isEngineOpportunityEvent,
  isRecord,
  severityFromScore,
  toDashboardEvent,
  toOpportunity
} from "@/lib/dashboard-feed";
import { listMacroEvents } from "@/lib/intelligence-store";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getLatestRegime } from "@/lib/vault-store";
import type {
  MacroDashboardEvent,
  MacroDashboardOpportunity,
  MarketingHighlight,
  MarketingHighlightsResponse
} from "@/types/vault";

export const runtime = "nodejs";

const PROJECT_NAME = "macro-vault";

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  limit: z.coerce.number().int().min(1).max(50).default(12)
});

function clampText(value: string, limit: number) {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

function validUrlOrNull(value: string | null | undefined) {
  if (!value) return null;
  try {
    new URL(value);
    return value;
  } catch {
    return null;
  }
}

// The marketing contract (docs/marketing-contract.md) bounds every field;
// vault data (candidate narratives up to 4000 chars, 220-char titles,
// free-form catalyst tags) can legitimately exceed them, so clamp at the
// boundary instead of letting the consumer reject the highlight.
function clampToContract(highlight: MarketingHighlight): MarketingHighlight {
  return {
    ...highlight,
    headline: clampText(highlight.headline, 200),
    narrative: clampText(highlight.narrative, 2000),
    metrics: highlight.metrics.slice(0, 8).map((metric) => ({
      label: clampText(metric.label, 40),
      value: clampText(metric.value, 40),
      ...(metric.delta ? { delta: clampText(metric.delta, 60) } : {})
    })),
    tags: highlight.tags
      .filter((tag) => tag.trim().length > 0)
      .map((tag) => clampText(tag, 40))
      .slice(0, 12),
    link: validUrlOrNull(highlight.link)
  };
}

function opportunityHighlight(opportunity: MacroDashboardOpportunity): MarketingHighlight {
  const metrics: MarketingHighlight["metrics"] = [
    { label: "Conviction", value: String(Math.round(opportunity.conviction)) }
  ];
  if (opportunity.divergenceScore && opportunity.divergenceScore !== opportunity.conviction) {
    metrics.push({ label: "Divergence", value: String(Math.round(opportunity.divergenceScore)) });
  }

  return {
    id: `opportunity-${opportunity.id}`,
    type: "alert",
    headline: opportunity.label,
    narrative: opportunity.situation,
    severity: opportunity.severity,
    metrics,
    link: opportunity.sources[0]?.url ?? null,
    tags: ["macro", "opportunity", ...opportunity.catalysts.slice(0, 3)]
  };
}

function surpriseHighlight(event: MacroDashboardEvent): MarketingHighlight {
  const metrics: MarketingHighlight["metrics"] = [];
  if (event.actual) metrics.push({ label: "Actual", value: event.actual, delta: event.surprise?.label ?? null });
  if (event.forecast) metrics.push({ label: "Forecast", value: event.forecast });
  if (event.previous) metrics.push({ label: "Previous", value: event.previous });

  return {
    id: `surprise-${event.id}`,
    type: "surprise",
    headline: `${event.title}: ${event.surprise?.label ?? "released"}`,
    narrative: event.narrative,
    severity: severityFromScore(event.impact_score),
    metrics,
    link: event.source_url,
    tags: ["macro", event.theme.toLowerCase(), ...(event.country_code ? [event.country_code.toLowerCase()] : [])]
  };
}

function upcomingEventHighlight(event: MacroDashboardEvent): MarketingHighlight {
  const metrics: MarketingHighlight["metrics"] = [{ label: "Date", value: event.event_date }];
  if (event.forecast) metrics.push({ label: "Forecast", value: event.forecast });
  if (event.previous) metrics.push({ label: "Previous", value: event.previous });

  const label = classifyMacroCriticalEvent(event) ?? event.theme;

  return {
    id: `event-${event.id}`,
    type: "event",
    headline: `${label} ahead: ${event.title} (${event.event_date})`,
    narrative: event.narrative,
    severity: severityFromScore(event.impact_score),
    metrics,
    link: event.source_url,
    tags: ["macro", "calendar", event.theme.toLowerCase()],
    expiresAt: event.event_date
  };
}

function regimeHighlight(regime: Record<string, unknown>): MarketingHighlight | null {
  const name =
    typeof regime.name === "string"
      ? regime.name
      : typeof regime.label === "string"
        ? regime.label
        : typeof regime.regime === "string"
          ? regime.regime
          : null;
  if (!name) return null;

  // The regime writer (app/api/regime/route.ts) stores its analysis under
  // "reasoning"; the other keys cover alternative producers.
  const narrative =
    typeof regime.reasoning === "string"
      ? regime.reasoning
      : typeof regime.summary === "string"
        ? regime.summary
        : typeof regime.narrative === "string"
          ? regime.narrative
          : typeof regime.description === "string"
            ? regime.description
            : `The vault's AI regime read currently sits at "${name}".`;
  const confidence = Number(regime.confidence ?? regime.score ?? NaN);

  return {
    id: `regime-${name.toLowerCase().replace(/\s+/g, "-")}`,
    type: "stat",
    headline: `Macro regime: ${name}`,
    narrative,
    severity: "medium",
    metrics: Number.isFinite(confidence) ? [{ label: "Confidence", value: String(Math.round(confidence)) }] : [],
    tags: ["macro", "regime"]
  };
}

export async function GET(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const input = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const supabase = createSupabaseAdmin();
    const todayIso = todayIsoDate();
    const recentStart = addIsoDays(todayIso, -input.days);
    const upcomingEnd = addIsoDays(todayIso, input.days);

    // Calendar events are windowed both ways, but opportunities keep no upper
    // bound: a promoted opportunity may carry a catalyst date weeks out and
    // must still be marketed today.
    const [regimeResult, calendarWindow, recentEvents] = await Promise.all([
      getLatestRegime(supabase),
      listMacroEvents(supabase, { limit: 500, category: "economic_calendar", from: recentStart, to: upcomingEnd }),
      listMacroEvents(supabase, { limit: 500, from: recentStart })
    ]);

    const calendarEvents = calendarWindow.filter(isEconomicCalendarEvent).map(toDashboardEvent);

    const highlights: MarketingHighlight[] = [];

    const regime = isRecord(regimeResult.regime) ? regimeHighlight(regimeResult.regime) : null;
    if (regime) highlights.push(regime);

    recentEvents
      .filter(isEngineOpportunityEvent)
      .sort((a, b) => Number(b.impact_score ?? 0) - Number(a.impact_score ?? 0))
      .slice(0, input.limit)
      .map(toOpportunity)
      .forEach((opportunity) => highlights.push(opportunityHighlight(opportunity)));

    calendarEvents
      .filter((event) => event.surprise && event.event_date <= todayIso)
      .filter((event) => event.is_macro_critical)
      .sort((a, b) => b.event_date.localeCompare(a.event_date))
      .slice(0, input.limit)
      .forEach((event) => highlights.push(surpriseHighlight(event)));

    // Future dates are always "upcoming"; today-dated events count only until
    // an actual exists — once the number is out, the release is no longer
    // ahead even when a missing/unparseable forecast prevents a surprise entry.
    calendarEvents
      .filter((event) => event.event_date > todayIso || (event.event_date === todayIso && !event.actual))
      .filter((event) => event.is_macro_critical)
      .sort((a, b) => a.event_date.localeCompare(b.event_date))
      .slice(0, input.limit)
      .forEach((event) => highlights.push(upcomingEventHighlight(event)));

    const response: MarketingHighlightsResponse = {
      project: PROJECT_NAME,
      generatedAt: new Date().toISOString(),
      highlights: highlights.slice(0, input.limit).map(clampToContract)
    };

    return NextResponse.json(response);
  } catch (error) {
    return jsonError(error);
  }
}
