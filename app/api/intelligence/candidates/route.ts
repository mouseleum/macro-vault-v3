import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import {
  createIntelligenceCandidates,
  intelligenceSetupMessage,
  isIntelligenceSchemaCacheStale,
  isMissingIntelligenceTable,
  listIntelligenceCandidates
} from "@/lib/intelligence-store";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import type { IntelligenceSignalType, SourceTier } from "@/types/vault";

export const runtime = "nodejs";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(40)
});

const sourceTierSchema = z.enum(["user_supplied", "public_web", "licensed", "internal", "unknown"]);
const signalTypeSchema = z.enum(["numeric_observation", "event", "document_note"]);
const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();
const optionalUrl = z.string().trim().url().optional().or(z.literal("")).nullable();
const optionalDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .or(z.literal(""))
  .nullable();
const optionalNumber = z.preprocess(
  (value) => (value === "" || value === undefined ? null : value),
  z.coerce.number().finite().nullable().optional()
);
const optionalConfidence = z.preprocess(
  (value) => (value === "" || value === undefined ? null : value),
  z.coerce.number().min(0).max(1).nullable().optional()
);

const candidateInputSchema = z.object({
  signalType: signalTypeSchema.default("document_note"),
  title: z.string().trim().min(2).max(220),
  provider: optionalText(80),
  seriesCode: optionalText(120),
  countryCode: optionalText(16),
  date: optionalDate,
  value: optionalNumber,
  unit: optionalText(80),
  narrative: optionalText(4000),
  confidence: optionalConfidence,
  sourceDocumentId: optionalText(80),
  sourceUrl: optionalUrl,
  sourceTitle: optionalText(240),
  sourceTier: sourceTierSchema.default("unknown"),
  extractionMethod: z.string().trim().min(2).max(120).default("external_project"),
  metadata: z.record(z.string(), z.unknown()).default({})
});

const createCandidatesSchema = z.object({
  sourceProject: z.string().trim().min(2).max(80).default("external_project"),
  candidates: z.array(candidateInputSchema).min(1).max(50)
});

function nullable(value?: string | null) {
  return value?.trim() || null;
}

export async function GET(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const input = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const supabase = createSupabaseAdmin();
    const candidates = await listIntelligenceCandidates(supabase, input.limit);

    return NextResponse.json({
      setupRequired: false,
      candidates,
      count: candidates.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error && typeof error === "object" && isIntelligenceSchemaCacheStale(error as { code?: string; message?: string })) {
      return NextResponse.json({
        setupRequired: true,
        schemaCacheStale: true,
        candidates: [],
        count: 0,
        message:
          "Supabase REST cannot see the intelligence tables yet. Grant service_role access and run notify pgrst, 'reload schema'."
      });
    }

    if (error && typeof error === "object" && isMissingIntelligenceTable(error as { code?: string; message?: string })) {
      return NextResponse.json({
        setupRequired: true,
        candidates: [],
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
    const input = createCandidatesSchema.parse(await request.json());
    const supabase = createSupabaseAdmin();
    const candidates = await createIntelligenceCandidates(
      supabase,
      input.candidates.map((candidate) => ({
        signalType: candidate.signalType as IntelligenceSignalType,
        title: candidate.title,
        provider: nullable(candidate.provider),
        seriesCode: nullable(candidate.seriesCode),
        countryCode: nullable(candidate.countryCode),
        date: nullable(candidate.date),
        value: candidate.value ?? null,
        unit: nullable(candidate.unit),
        narrative: nullable(candidate.narrative),
        confidence: candidate.confidence ?? null,
        sourceDocumentId: nullable(candidate.sourceDocumentId),
        sourceUrl: nullable(candidate.sourceUrl),
        sourceTitle: nullable(candidate.sourceTitle),
        sourceTier: candidate.sourceTier as SourceTier,
        extractionMethod: candidate.extractionMethod,
        metadata: {
          source_project: input.sourceProject,
          intake: "external_project",
          review_status: "pending",
          ...candidate.metadata
        }
      }))
    );

    return NextResponse.json(
      {
        ok: true,
        setupRequired: false,
        candidates,
        count: candidates.length,
        message: "Candidates stored for review. Promote only trusted signals into canonical vault data."
      },
      { status: 201 }
    );
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
