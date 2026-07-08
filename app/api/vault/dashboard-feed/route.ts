import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import {
  addIsoDays,
  isEconomicCalendarEvent,
  isEngineOpportunityEvent,
  isMacroCriticalRelease,
  isRecord,
  toDashboardEvent,
  toOpportunity
} from "@/lib/dashboard-feed";
import { listMacroEvents } from "@/lib/intelligence-store";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getLatestRegime, listSeries } from "@/lib/vault-store";

export const runtime = "nodejs";

const querySchema = z.object({
  country: z.string().trim().min(2).max(3).optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(25).default(10)
});

export async function GET(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const input = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const supabase = createSupabaseAdmin();
    const todayIso = new Date().toISOString().slice(0, 10);
    const endIso = addIsoDays(todayIso, input.days);
    const country = input.country?.toUpperCase();

    const [series, observationCountResult, regime, events] = await Promise.all([
      listSeries(supabase, { limit: 5000 }),
      supabase.from("macro_observations").select("id", { count: "exact", head: true }),
      getLatestRegime(supabase),
      listMacroEvents(supabase, {
        limit: 500,
        country,
        category: "economic_calendar"
      })
    ]);

    if (observationCountResult.error) throw observationCountResult.error;

    const latestSynced = series.reduce<string | null>((latest, item) => {
      if (!item.last_synced) return latest;
      if (!latest) return item.last_synced;
      return item.last_synced > latest ? item.last_synced : latest;
    }, null);

    const calendarEvents = events.filter(isEconomicCalendarEvent);
    const upcomingCriticalEvents = calendarEvents
      .filter((event) => event.event_date >= todayIso && event.event_date <= endIso)
      .filter(isMacroCriticalRelease)
      .sort((a, b) => a.event_date.localeCompare(b.event_date) || Number(b.impact_score ?? 0) - Number(a.impact_score ?? 0))
      .slice(0, input.limit)
      .map(toDashboardEvent);
    const realizedSurprises = calendarEvents
      .map(toDashboardEvent)
      .filter((event) => event.surprise)
      .sort((a, b) => b.event_date.localeCompare(a.event_date) || a.title.localeCompare(b.title))
      .slice(0, input.limit);
    const allEvents = await listMacroEvents(supabase, {
      limit: 500,
      country
    });
    const opportunities = allEvents
      .filter(isEngineOpportunityEvent)
      .sort((a, b) => Number(b.impact_score ?? 0) - Number(a.impact_score ?? 0) || b.event_date.localeCompare(a.event_date))
      .slice(0, input.limit)
      .map(toOpportunity);
    const narrativeSignals = allEvents
      .filter((event) => !isEconomicCalendarEvent(event) && !isEngineOpportunityEvent(event))
      .slice(0, input.limit);

    return NextResponse.json({
      summary: {
        totalSeries: series.length,
        totalObservations: observationCountResult.count ?? 0,
        latestSynced
      },
      regime: isRecord(regime.regime) ? regime.regime : null,
      opportunities,
      upcomingCriticalEvents,
      realizedSurprises,
      narrativeSignals,
      query: {
        days: input.days,
        limit: input.limit,
        ...(country ? { country } : {})
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return jsonError(error);
  }
}
