import { NextRequest, NextResponse } from "next/server";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import {
  createMacroEventFromCandidate,
  getIntelligenceCandidate,
  intelligenceSetupMessage,
  isIntelligenceSchemaCacheStale,
  isMissingIntelligenceTable,
  updateIntelligenceCandidateStatus
} from "@/lib/intelligence-store";
import { createSupabaseAdmin } from "@/lib/supabase-server";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const supabase = createSupabaseAdmin();
    const candidate = await getIntelligenceCandidate(supabase, id);

    if (!candidate) {
      return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    }

    if (candidate.signal_type !== "numeric_observation") {
      const event = await createMacroEventFromCandidate(supabase, candidate);
      const promoted = await updateIntelligenceCandidateStatus(supabase, id, "promoted");

      return NextResponse.json({
        ok: true,
        candidate: promoted,
        event,
        eventId: event.id,
        promotedTo: "macro_events"
      });
    }

    if (!candidate.provider || !candidate.series_code || !candidate.date) {
      return NextResponse.json(
        {
          error: "Only numeric candidates with provider, series_code, and date can be promoted."
        },
        { status: 400 }
      );
    }

    if (candidate.value === null || candidate.value === undefined || Number.isNaN(Number(candidate.value))) {
      return NextResponse.json({ error: "Candidate has no numeric value to promote." }, { status: 400 });
    }

    const { data: series, error: seriesError } = await supabase
      .from("macro_series")
      .upsert(
        {
          provider: candidate.provider,
          series_code: candidate.series_code,
          country_code: candidate.country_code ?? "WLD",
          name: candidate.title,
          unit: candidate.unit,
          metadata: {
            source: "intelligence_candidate",
            source_url: candidate.source_url,
            source_title: candidate.source_title,
            source_tier: candidate.source_tier,
            confidence: candidate.confidence
          },
          last_synced: new Date().toISOString()
        },
        { onConflict: "provider,series_code,country_code" }
      )
      .select("id")
      .single();

    if (seriesError) throw seriesError;

    const { error: observationError } = await supabase.from("macro_observations").upsert(
      {
        series_id: series.id,
        date: candidate.date,
        value: Number(candidate.value),
        metadata: {
          source: "intelligence_candidate",
          candidate_id: candidate.id,
          source_document_id: candidate.source_document_id,
          source_url: candidate.source_url,
          source_title: candidate.source_title,
          source_tier: candidate.source_tier,
          extraction_method: candidate.extraction_method,
          confidence: candidate.confidence,
          narrative: candidate.narrative
        }
      },
      { onConflict: "series_id,date" }
    );

    if (observationError) throw observationError;

    const promoted = await updateIntelligenceCandidateStatus(supabase, id, "promoted");

    return NextResponse.json({
      ok: true,
      candidate: promoted,
      seriesId: series.id
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
