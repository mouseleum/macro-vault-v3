import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import {
  createKnowledgeDocument,
  intelligenceSetupMessage,
  isIntelligenceSchemaCacheStale,
  isMissingIntelligenceTable,
  listKnowledgeDocuments,
  parseTags
} from "@/lib/intelligence-store";
import { createSupabaseAdmin } from "@/lib/supabase-server";

export const runtime = "nodejs";

const createDocumentSchema = z.object({
  title: z.string().trim().min(2).max(180),
  contentText: z.string().trim().min(20).max(120000),
  sourceUrl: z.string().trim().url().optional().or(z.literal("")),
  sourceType: z.string().trim().min(2).max(60).default("manual_paste"),
  sourceTier: z.enum(["user_supplied", "public_web", "licensed", "internal", "unknown"]).default("user_supplied"),
  tags: z.union([z.string(), z.array(z.string())]).optional()
});

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

export async function GET(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const input = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const supabase = createSupabaseAdmin();
    const documents = await listKnowledgeDocuments(supabase, input.limit);

    return NextResponse.json({
      setupRequired: false,
      documents,
      count: documents.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error && typeof error === "object" && isIntelligenceSchemaCacheStale(error as { code?: string; message?: string })) {
      return NextResponse.json({
        setupRequired: true,
        schemaCacheStale: true,
        documents: [],
        count: 0,
        message:
          "Supabase REST cannot see the intelligence tables yet. Grant service_role access and run notify pgrst, 'reload schema'."
      });
    }

    if (error && typeof error === "object" && isMissingIntelligenceTable(error as { code?: string; message?: string })) {
      return NextResponse.json({
        setupRequired: true,
        documents: [],
        count: 0,
        message: intelligenceSetupMessage
      });
    }

    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const input = createDocumentSchema.parse(await request.json());
    const supabase = createSupabaseAdmin();
    const document = await createKnowledgeDocument(supabase, {
      title: input.title,
      contentText: input.contentText,
      sourceUrl: input.sourceUrl || null,
      sourceType: input.sourceType,
      sourceTier: input.sourceTier,
      tags: parseTags(input.tags),
      metadata: {
        intake: "manual",
        note: "Store only content you have rights to use."
      }
    });

    return NextResponse.json({
      ok: true,
      setupRequired: false,
      document
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
