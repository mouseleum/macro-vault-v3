import { NextRequest, NextResponse } from "next/server";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { listSeries } from "@/lib/vault-store";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const supabase = createSupabaseAdmin();
    const series = await listSeries(supabase, {
      provider: request.nextUrl.searchParams.get("provider"),
      country: request.nextUrl.searchParams.get("country")
    });

    return NextResponse.json({
      series,
      count: series.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return jsonError(error);
  }
}
