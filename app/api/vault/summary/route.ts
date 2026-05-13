import { NextRequest, NextResponse } from "next/server";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { getEnvStatus } from "@/lib/env";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { listObservations, listSeries } from "@/lib/vault-store";
import type { SeriesPreview } from "@/types/vault";

export const runtime = "nodejs";

function calculateChange(values: number[]) {
  if (values.length < 2) return { change: null, changePct: null };

  const latest = values.at(-1) ?? 0;
  const previous = values.at(-2) ?? 0;
  const change = latest - previous;
  const changePct = previous === 0 ? null : (change / Math.abs(previous)) * 100;

  return { change, changePct };
}

export async function GET(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const supabase = createSupabaseAdmin();
    const series = await listSeries(supabase, {
      provider: request.nextUrl.searchParams.get("provider"),
      country: request.nextUrl.searchParams.get("country")
    });

    const { count: observationCount, error: countError } = await supabase
      .from("macro_observations")
      .select("id", { count: "exact", head: true });

    if (countError) throw countError;

    const previewSeries = [...series]
      .sort((a, b) => String(b.last_synced ?? "").localeCompare(String(a.last_synced ?? "")))
      .slice(0, 9);

    const cards = await Promise.all(
      previewSeries.map(async (item): Promise<SeriesPreview> => {
        const observations = await listObservations(supabase, item.id, 12);
        const ascending = [...observations].reverse();
        const points = ascending.map((observation) => ({
          date: observation.date,
          value: Number(observation.value)
        }));
        const values = points.map((point) => point.value);
        const { change, changePct } = calculateChange(values);

        return {
          series: item,
          latest: observations[0] ?? null,
          previous: observations[1] ?? null,
          change,
          changePct,
          points
        };
      })
    );

    const env = getEnvStatus();
    const envValues = Object.values(env);
    const envOk = envValues.filter(Boolean).length;
    const latestSynced = series.reduce<string | null>((latest, item) => {
      if (!item.last_synced) return latest;
      if (!latest) return item.last_synced;
      return item.last_synced > latest ? item.last_synced : latest;
    }, null);

    return NextResponse.json({
      totals: {
        series: series.length,
        observations: observationCount ?? 0
      },
      health: {
        envOk,
        envTotal: envValues.length,
        syncHealth: envValues.length ? Math.round((envOk / envValues.length) * 100) : 0
      },
      latestSynced,
      cards,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return jsonError(error);
  }
}
