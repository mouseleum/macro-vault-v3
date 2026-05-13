import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  IntelligenceCandidate,
  IntelligenceCandidateStatus,
  IntelligenceSignalType,
  KnowledgeDocument,
  MacroEvent,
  MacroEventPrepNotes,
  SourceTier
} from "@/types/vault";

export const intelligenceSetupMessage =
  "Run supabase/intelligence.sql in Supabase SQL Editor to enable Knowledge Base and Web Intelligence.";
const fallbackProvider = "vault_system";
const fallbackSeriesCode = "INTELLIGENCE_STORE";
const fallbackCountry = "WLD";

type FallbackIntelligenceStore = {
  fallback: true;
  source: "macro_series.metadata";
  documents: KnowledgeDocument[];
  candidates: IntelligenceCandidate[];
  events: MacroEvent[];
};

export function isMissingIntelligenceTable(error: { code?: string; message?: string }) {
  return (
    error.code === "42P01" ||
    error.message?.includes("knowledge_documents") ||
    error.message?.includes("intelligence_candidates") ||
    error.message?.includes("macro_events")
  );
}

export function isIntelligenceSchemaCacheStale(error: { code?: string; message?: string }) {
  return error.code === "PGRST205" || Boolean(error.message?.includes("schema cache"));
}

function canUseFallback(error: { code?: string; message?: string }) {
  return isIntelligenceSchemaCacheStale(error) || isMissingIntelligenceTable(error);
}

export function parseTags(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.map((tag) => tag.trim()).filter(Boolean).slice(0, 12);
  return (value ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
}

export function summarizeText(value: string, maxLength = 420) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trim()}...`;
}

function normalizeFallbackStore(value: unknown): FallbackIntelligenceStore {
  if (!value || typeof value !== "object") {
    return {
      fallback: true,
      source: "macro_series.metadata",
      documents: [],
      candidates: [],
      events: []
    };
  }

  const record = value as Partial<FallbackIntelligenceStore>;
  return {
    fallback: true,
    source: "macro_series.metadata",
    documents: Array.isArray(record.documents) ? record.documents : [],
    candidates: Array.isArray(record.candidates) ? record.candidates : [],
    events: Array.isArray(record.events) ? record.events : []
  };
}

async function getFallbackIntelligenceStore(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("macro_series")
    .select("metadata")
    .eq("provider", fallbackProvider)
    .eq("series_code", fallbackSeriesCode)
    .eq("country_code", fallbackCountry)
    .maybeSingle();

  if (error) throw error;
  return normalizeFallbackStore(data?.metadata);
}

async function writeFallbackIntelligenceStore(supabase: SupabaseClient, store: FallbackIntelligenceStore) {
  const { error } = await supabase.from("macro_series").upsert(
    {
      provider: fallbackProvider,
      series_code: fallbackSeriesCode,
      country_code: fallbackCountry,
      name: "Intelligence Store Fallback",
      unit: "records",
      metadata: store,
      last_synced: new Date().toISOString()
    },
    { onConflict: "provider,series_code,country_code" }
  );

  if (error) throw error;
}

export async function listKnowledgeDocuments(supabase: SupabaseClient, limit = 25) {
  const { data, error } = await supabase
    .from("knowledge_documents")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (canUseFallback(error)) {
      const store = await getFallbackIntelligenceStore(supabase);
      return store.documents
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
    }

    throw error;
  }

  return (data ?? []) as KnowledgeDocument[];
}

export async function getKnowledgeDocument(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase.from("knowledge_documents").select("*").eq("id", id).maybeSingle();

  if (error) {
    if (canUseFallback(error)) {
      const store = await getFallbackIntelligenceStore(supabase);
      return store.documents.find((document) => document.id === id) ?? null;
    }

    throw error;
  }

  return (data ?? null) as KnowledgeDocument | null;
}

export async function createKnowledgeDocument(
  supabase: SupabaseClient,
  input: {
    title: string;
    contentText: string;
    sourceUrl?: string | null;
    sourceType?: string;
    sourceTier?: SourceTier;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }
) {
  const { data, error } = await supabase
    .from("knowledge_documents")
    .insert({
      title: input.title,
      source_url: input.sourceUrl || null,
      source_type: input.sourceType ?? "manual_paste",
      source_tier: input.sourceTier ?? "user_supplied",
      content_text: input.contentText,
      summary: summarizeText(input.contentText),
      tags: input.tags ?? [],
      metadata: input.metadata ?? {}
    })
    .select("*")
    .single();

  if (error) {
    if (canUseFallback(error)) {
      const now = new Date().toISOString();
      const document: KnowledgeDocument = {
        id: crypto.randomUUID(),
        title: input.title,
        source_url: input.sourceUrl || null,
        source_type: input.sourceType ?? "manual_paste",
        source_tier: input.sourceTier ?? "user_supplied",
        content_text: input.contentText,
        summary: summarizeText(input.contentText),
        tags: input.tags ?? [],
        metadata: input.metadata ?? {},
        created_at: now,
        updated_at: now
      };
      const store = await getFallbackIntelligenceStore(supabase);
      await writeFallbackIntelligenceStore(supabase, {
        ...store,
        documents: [document, ...store.documents].slice(0, 100)
      });
      return document;
    }

    throw error;
  }

  return data as KnowledgeDocument;
}

export async function listIntelligenceCandidates(supabase: SupabaseClient, limit = 40) {
  const { data, error } = await supabase
    .from("intelligence_candidates")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (canUseFallback(error)) {
      const store = await getFallbackIntelligenceStore(supabase);
      return store.candidates
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
    }

    throw error;
  }

  return (data ?? []) as IntelligenceCandidate[];
}

export async function createIntelligenceCandidates(
  supabase: SupabaseClient,
  candidates: Array<{
    signalType: IntelligenceSignalType;
    title: string;
    provider?: string | null;
    seriesCode?: string | null;
    countryCode?: string | null;
    date?: string | null;
    value?: number | null;
    unit?: string | null;
    narrative?: string | null;
    confidence?: number | null;
    sourceDocumentId?: string | null;
    sourceUrl?: string | null;
    sourceTitle?: string | null;
    sourceTier?: SourceTier;
    extractionMethod: string;
    metadata?: Record<string, unknown>;
  }>
) {
  const rows = candidates.map((candidate) => ({
    signal_type: candidate.signalType,
    title: candidate.title,
    provider: candidate.provider || null,
    series_code: candidate.seriesCode || null,
    country_code: candidate.countryCode || null,
    date: candidate.date || null,
    value: candidate.value ?? null,
    unit: candidate.unit || null,
    narrative: candidate.narrative || null,
    confidence: candidate.confidence ?? null,
    source_document_id: candidate.sourceDocumentId || null,
    source_url: candidate.sourceUrl || null,
    source_title: candidate.sourceTitle || null,
    source_tier: candidate.sourceTier ?? "unknown",
    extraction_method: candidate.extractionMethod,
    metadata: candidate.metadata ?? {}
  }));

  const { data, error } = await supabase.from("intelligence_candidates").insert(rows).select("*");

  if (error) {
    if (canUseFallback(error)) {
      const now = new Date().toISOString();
      const inserted = rows.map((candidate) => ({
        id: crypto.randomUUID(),
        status: "pending",
        created_at: now,
        reviewed_at: null,
        ...candidate
      })) as IntelligenceCandidate[];
      const store = await getFallbackIntelligenceStore(supabase);
      await writeFallbackIntelligenceStore(supabase, {
        ...store,
        candidates: [...inserted, ...store.candidates].slice(0, 200)
      });
      return inserted;
    }

    throw error;
  }

  return (data ?? []) as IntelligenceCandidate[];
}

export async function updateIntelligenceCandidateStatus(
  supabase: SupabaseClient,
  id: string,
  status: IntelligenceCandidateStatus
) {
  const { data, error } = await supabase
    .from("intelligence_candidates")
    .update({
      status,
      reviewed_at: new Date().toISOString()
    })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    if (canUseFallback(error)) {
      const store = await getFallbackIntelligenceStore(supabase);
      const reviewedAt = new Date().toISOString();
      const candidate = store.candidates.find((item) => item.id === id);
      if (!candidate) throw new Error("Candidate not found");
      const updated: IntelligenceCandidate = {
        ...candidate,
        status,
        reviewed_at: reviewedAt
      };
      await writeFallbackIntelligenceStore(supabase, {
        ...store,
        candidates: store.candidates.map((item) => (item.id === id ? updated : item))
      });
      return updated;
    }

    throw error;
  }

  return data as IntelligenceCandidate;
}

export async function getIntelligenceCandidate(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase.from("intelligence_candidates").select("*").eq("id", id).maybeSingle();

  if (error) {
    if (canUseFallback(error)) {
      const store = await getFallbackIntelligenceStore(supabase);
      return store.candidates.find((candidate) => candidate.id === id) ?? null;
    }

    throw error;
  }

  return (data ?? null) as IntelligenceCandidate | null;
}

export async function getMacroEventsStorageState(supabase: SupabaseClient) {
  const { error } = await supabase.from("macro_events").select("id", { count: "exact", head: true }).limit(1);

  if (error) {
    if (canUseFallback(error)) {
      return {
        fallback: true,
        schemaCacheStale: isIntelligenceSchemaCacheStale(error)
      };
    }

    throw error;
  }

  return {
    fallback: false,
    schemaCacheStale: false
  };
}

export async function listMacroEvents(
  supabase: SupabaseClient,
  filters: {
    limit?: number;
    country?: string | null;
    category?: string | null;
    q?: string | null;
  } = {}
) {
  const limit = filters.limit ?? 50;
  let query = supabase.from("macro_events").select("*");

  if (filters.country) query = query.eq("country_code", filters.country.toUpperCase());
  if (filters.category) query = query.eq("category", filters.category);

  const { data, error } = await query.order("event_date", { ascending: false }).limit(limit);

  if (error) {
    if (canUseFallback(error)) {
      const search = filters.q?.trim().toLowerCase();
      const store = await getFallbackIntelligenceStore(supabase);
      return store.events
        .filter((event) => !filters.country || event.country_code === filters.country?.toUpperCase())
        .filter((event) => !filters.category || event.category === filters.category)
        .filter((event) =>
          search
            ? [event.title, event.narrative, event.category, event.country_code, event.source_title]
                .filter(Boolean)
                .some((value) => String(value).toLowerCase().includes(search))
            : true
        )
        .sort((a, b) => String(b.event_date).localeCompare(String(a.event_date)))
        .slice(0, limit);
    }

    throw error;
  }

  const events = (data ?? []) as MacroEvent[];
  const search = filters.q?.trim().toLowerCase();
  return search
    ? events.filter((event) =>
        [event.title, event.narrative, event.category, event.country_code, event.source_title]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(search))
      )
    : events;
}

export async function createMacroEvent(
  supabase: SupabaseClient,
  event: Omit<MacroEvent, "id" | "created_at">
) {
  const { data, error } = await supabase.from("macro_events").insert(event).select("*").single();

  if (error) {
    if (canUseFallback(error)) {
      const now = new Date().toISOString();
      const storedEvent: MacroEvent = {
        id: crypto.randomUUID(),
        created_at: now,
        ...event
      };
      const store = await getFallbackIntelligenceStore(supabase);
      await writeFallbackIntelligenceStore(supabase, {
        ...store,
        events: [storedEvent, ...store.events].slice(0, 500)
      });
      return storedEvent;
    }

    throw error;
  }

  return data as MacroEvent;
}

export async function createMacroEvents(
  supabase: SupabaseClient,
  events: Array<Omit<MacroEvent, "id" | "created_at">>
) {
  const stored: MacroEvent[] = [];

  for (const event of events) {
    stored.push(await createMacroEvent(supabase, event));
  }

  return stored;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function updateFallbackMacroEventPrepNotes(
  supabase: SupabaseClient,
  id: string,
  notes: MacroEventPrepNotes
) {
  const store = await getFallbackIntelligenceStore(supabase);
  const existing = store.events.find((event) => event.id === id);
  if (!existing) throw new Error("Macro event not found");

  const updated: MacroEvent = {
    ...existing,
    metadata: {
      ...asRecord(existing.metadata),
      prep_notes: notes
    }
  };

  await writeFallbackIntelligenceStore(supabase, {
    ...store,
    events: store.events.map((event) => (event.id === id ? updated : event))
  });

  return updated;
}

export async function updateMacroEventPrepNotes(
  supabase: SupabaseClient,
  id: string,
  notes: Omit<MacroEventPrepNotes, "updated_at">
) {
  const timestampedNotes: MacroEventPrepNotes = {
    ...notes,
    updated_at: new Date().toISOString()
  };
  const { data: existing, error: fetchError } = await supabase.from("macro_events").select("*").eq("id", id).maybeSingle();

  if (fetchError) {
    if (canUseFallback(fetchError)) {
      return updateFallbackMacroEventPrepNotes(supabase, id, timestampedNotes);
    }

    throw fetchError;
  }

  if (!existing) throw new Error("Macro event not found");

  const { data, error } = await supabase
    .from("macro_events")
    .update({
      metadata: {
        ...asRecord((existing as MacroEvent).metadata),
        prep_notes: timestampedNotes
      }
    })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    if (canUseFallback(error)) {
      return updateFallbackMacroEventPrepNotes(supabase, id, timestampedNotes);
    }

    throw error;
  }

  return data as MacroEvent;
}

export async function createMacroEventFromCandidate(supabase: SupabaseClient, candidate: IntelligenceCandidate) {
  return createMacroEvent(supabase, {
    event_date: candidate.date ?? new Date().toISOString().slice(0, 10),
    title: candidate.title,
    narrative: candidate.narrative ?? candidate.title,
    category: candidate.series_code ?? candidate.provider ?? "web_intelligence",
    country_code: candidate.country_code ?? "WLD",
    region: candidate.country_code ?? "WLD",
    impact_score: candidate.value,
    confidence: candidate.confidence,
    source_url: candidate.source_url,
    source_title: candidate.source_title,
    source_tier: candidate.source_tier,
    metadata: {
      source: "intelligence_candidate",
      candidate_id: candidate.id,
      source_document_id: candidate.source_document_id,
      extraction_method: candidate.extraction_method,
      original_signal_type: candidate.signal_type,
      ...candidate.metadata
    }
  });
}
