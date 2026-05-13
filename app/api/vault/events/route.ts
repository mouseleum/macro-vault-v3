import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { getMacroEventsStorageState, listMacroEvents } from "@/lib/intelligence-store";
import { createSupabaseAdmin } from "@/lib/supabase-server";

export const runtime = "nodejs";

const querySchema = z.object({
  country: z.string().trim().min(2).max(3).optional(),
  category: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

export async function GET(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const input = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const supabase = createSupabaseAdmin();
    const storageState = await getMacroEventsStorageState(supabase);
    const events = await listMacroEvents(supabase, input);

    return NextResponse.json({
      setupRequired: false,
      fallback: storageState.fallback,
      schemaCacheStale: storageState.schemaCacheStale,
      events,
      count: events.length,
      query: input,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return jsonError(error);
  }
}
