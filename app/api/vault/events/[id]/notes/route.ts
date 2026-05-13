import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/api";
import { assertVaultAuth } from "@/lib/auth";
import {
  intelligenceSetupMessage,
  isIntelligenceSchemaCacheStale,
  isMissingIntelligenceTable,
  updateMacroEventPrepNotes
} from "@/lib/intelligence-store";
import { createSupabaseAdmin } from "@/lib/supabase-server";

export const runtime = "nodejs";

const notesSchema = z.object({
  market_expectation: z.string().max(1200).default("").transform((value) => value.trim()),
  upside_surprise: z.string().max(1200).default("").transform((value) => value.trim()),
  downside_surprise: z.string().max(1200).default("").transform((value) => value.trim()),
  likely_assets: z.string().max(1200).default("").transform((value) => value.trim()),
  trade_plan: z.string().max(2000).default("").transform((value) => value.trim()),
  post_release_read: z.string().max(2000).default("").transform((value) => value.trim())
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const input = notesSchema.parse(await request.json());
    const supabase = createSupabaseAdmin();
    const event = await updateMacroEventPrepNotes(supabase, id, input);

    return NextResponse.json({
      ok: true,
      event
    });
  } catch (error) {
    if (error && typeof error === "object" && isIntelligenceSchemaCacheStale(error as { code?: string; message?: string })) {
      return NextResponse.json(
        {
          setupRequired: true,
          schemaCacheStale: true,
          message:
            "Supabase REST cannot see the intelligence tables yet. Grant service_role access and run notify pgrst, 'reload schema'."
        },
        { status: 400 }
      );
    }

    if (error && typeof error === "object" && isMissingIntelligenceTable(error as { code?: string; message?: string })) {
      return NextResponse.json(
        {
          setupRequired: true,
          message: intelligenceSetupMessage
        },
        { status: 400 }
      );
    }

    return jsonError(error);
  }
}
