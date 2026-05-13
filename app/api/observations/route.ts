import { NextRequest, NextResponse } from "next/server";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { clampLimit, findSeries, listObservations } from "@/lib/vault-store";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  const code = request.nextUrl.searchParams.get("code");
  const provider = request.nextUrl.searchParams.get("provider");
  const country = request.nextUrl.searchParams.get("country");
  const limit = clampLimit(request.nextUrl.searchParams.get("limit"));

  if (!code) {
    return NextResponse.json({ error: "Missing required query param: code" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdmin();
    const series = await findSeries(supabase, { code, provider, country });
    if (!series) {
      return NextResponse.json({ error: "Series not found", code }, { status: 404 });
    }

    const observations = await listObservations(supabase, series.id, limit);

    return NextResponse.json({
      series,
      observations,
      count: observations.length
    });
  } catch (error) {
    return jsonError(error);
  }
}
