import { NextRequest, NextResponse } from "next/server";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getLatestRegime } from "@/lib/vault-store";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const supabase = createSupabaseAdmin();
    const regime = await getLatestRegime(supabase);

    if (!regime.series) {
      return NextResponse.json({ error: "Regime has not been generated yet." }, { status: 404 });
    }

    return NextResponse.json({
      ...regime,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return jsonError(error);
  }
}
