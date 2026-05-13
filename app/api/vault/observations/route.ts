import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { clampLimit, findSeries, listObservations } from "@/lib/vault-store";

export const runtime = "nodejs";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.object({
  code: z.string().trim().min(1),
  provider: z.string().trim().min(1).optional(),
  country: z.string().trim().min(2).max(3).optional(),
  limit: z.string().optional(),
  start: dateSchema.optional(),
  end: dateSchema.optional(),
  order: z.enum(["asc", "desc"]).default("desc")
});

export async function GET(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const input = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const limit = clampLimit(input.limit ?? null);
    const supabase = createSupabaseAdmin();
    const series = await findSeries(supabase, { code: input.code, provider: input.provider, country: input.country });
    if (!series) {
      return NextResponse.json({ error: "Series not found", code: input.code }, { status: 404 });
    }

    const observations = await listObservations(supabase, series.id, {
      limit,
      start: input.start,
      end: input.end,
      order: input.order
    });

    return NextResponse.json({
      series,
      observations,
      count: observations.length,
      query: {
        limit,
        start: input.start ?? null,
        end: input.end ?? null,
        order: input.order
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return jsonError(error);
  }
}
