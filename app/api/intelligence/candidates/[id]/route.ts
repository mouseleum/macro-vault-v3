import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import {
  intelligenceSetupMessage,
  isIntelligenceSchemaCacheStale,
  isMissingIntelligenceTable,
  updateIntelligenceCandidateStatus
} from "@/lib/intelligence-store";
import { createSupabaseAdmin } from "@/lib/supabase-server";

export const runtime = "nodejs";

const updateSchema = z.object({
  status: z.enum(["pending", "approved", "rejected"])
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const input = updateSchema.parse(await request.json());
    const supabase = createSupabaseAdmin();
    const candidate = await updateIntelligenceCandidateStatus(supabase, id, input.status);

    return NextResponse.json({
      ok: true,
      candidate
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
