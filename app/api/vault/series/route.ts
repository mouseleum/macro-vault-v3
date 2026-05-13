import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { listSeries } from "@/lib/vault-store";

export const runtime = "nodejs";

const querySchema = z.object({
  provider: z.string().trim().min(1).optional(),
  country: z.string().trim().min(2).max(3).optional(),
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500)
});

export async function GET(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const input = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const supabase = createSupabaseAdmin();
    const series = await listSeries(supabase, {
      provider: input.provider,
      country: input.country,
      q: input.q,
      limit: input.limit
    });

    return NextResponse.json({
      series,
      count: series.length,
      query: input,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return jsonError(error);
  }
}
