import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { getFallbackSyncRuns, type SyncRunRecord } from "@/lib/sync-log";

export const runtime = "nodejs";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

function isMissingSyncRunsTable(error: { code?: string; message?: string }) {
  return error.code === "42P01" || error.message?.includes("does not exist");
}

function isSchemaCacheStale(error: { code?: string; message?: string }) {
  return error.code === "PGRST205" || error.message?.includes("schema cache");
}

async function fallbackResponse(supabase: ReturnType<typeof createSupabaseAdmin>, limit: number, message: string, schemaCacheStale = false) {
  const runs = await getFallbackSyncRuns(supabase, limit);

  return NextResponse.json({
    ok: true,
    setupRequired: runs.length === 0,
    fallback: true,
    schemaCacheStale,
    runs,
    count: runs.length,
    message
  });
}

export async function GET(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const input = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const supabase = createSupabaseAdmin();
    const { data, error } = await supabase
      .from("sync_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(input.limit);

    if (error) {
      if (isSchemaCacheStale(error)) {
        return fallbackResponse(
          supabase,
          input.limit,
          "Using fallback logs because Supabase REST cannot see public.sync_runs in its schema cache yet.",
          true
        );
      }

      if (isMissingSyncRunsTable(error)) {
        return fallbackResponse(
          supabase,
          input.limit,
          "Using fallback logs from macro_series.metadata. Create public.sync_runs with supabase/sync_runs.sql for the permanent log table."
        );
      }

      throw error;
    }

    return NextResponse.json({
      ok: true,
      setupRequired: false,
      runs: (data ?? []) as SyncRunRecord[],
      count: data?.length ?? 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return jsonError(error);
  }
}
