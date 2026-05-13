import { GoogleGenAI, Type } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { getEnv, getOptionalEnv } from "@/lib/env";
import {
  createIntelligenceCandidates,
  getKnowledgeDocument,
  intelligenceSetupMessage,
  isIntelligenceSchemaCacheStale,
  isMissingIntelligenceTable,
  summarizeText
} from "@/lib/intelligence-store";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import type { IntelligenceSignalType } from "@/types/vault";

export const runtime = "nodejs";

const extractionSchema = {
  type: Type.OBJECT,
  properties: {
    candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          signal_type: { type: Type.STRING },
          title: { type: Type.STRING },
          provider: { type: Type.STRING },
          series_code: { type: Type.STRING },
          country_code: { type: Type.STRING },
          date: { type: Type.STRING },
          value: { type: Type.NUMBER },
          unit: { type: Type.STRING },
          narrative: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
          source_url: { type: Type.STRING },
          source_title: { type: Type.STRING }
        },
        required: ["signal_type", "title", "narrative", "confidence"]
      }
    }
  },
  required: ["candidates"]
};

const extractSchema = z
  .object({
    mode: z.enum(["web", "document"]).default("web"),
    query: z.string().trim().max(2000).optional(),
    documentId: z.string().uuid().optional(),
    target: z
      .object({
        provider: z.string().trim().min(2).max(80).optional(),
        seriesCode: z.string().trim().min(2).max(120).optional(),
        countryCode: z.string().trim().min(2).max(3).optional(),
        unit: z.string().trim().min(1).max(80).optional()
      })
      .optional()
  })
  .refine((value) => (value.mode === "web" ? Boolean(value.query && value.query.length >= 10) : Boolean(value.documentId)), {
    message: "Web extraction needs a query; document extraction needs a documentId."
  });

type GroundingSource = {
  url: string | null;
  title: string | null;
};

type RawCandidate = {
  signal_type?: string;
  title?: string;
  provider?: string;
  series_code?: string;
  country_code?: string;
  date?: string;
  value?: number | string | null;
  unit?: string;
  narrative?: string;
  confidence?: number | string | null;
  source_url?: string;
  source_title?: string;
};

function normalizeSignalType(value: string | undefined, hasValue: boolean): IntelligenceSignalType {
  if (value === "numeric_observation" || value === "event" || value === "document_note") return value;
  return hasValue ? "numeric_observation" : "event";
}

function normalizeNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeConfidence(value: number | string | null | undefined) {
  const parsed = normalizeNumber(value);
  if (parsed === null) return null;
  return Math.min(Math.max(parsed, 0), 1);
}

function normalizeDate(value: string | undefined) {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function extractGroundingSources(response: unknown): GroundingSource[] {
  const candidates = response && typeof response === "object" ? (response as { candidates?: unknown }).candidates : null;
  const firstCandidate = Array.isArray(candidates) ? candidates[0] : null;
  const metadata =
    firstCandidate && typeof firstCandidate === "object"
      ? (firstCandidate as { groundingMetadata?: { groundingChunks?: unknown[] } }).groundingMetadata
      : null;

  return (metadata?.groundingChunks ?? [])
    .map((chunk) => {
      const record = chunk && typeof chunk === "object" ? (chunk as { web?: { uri?: string; title?: string } }) : {};
      return {
        url: record.web?.uri ?? null,
        title: record.web?.title ?? null
      };
    })
    .filter((source) => source.url || source.title)
    .slice(0, 8);
}

function extractJsonObject(text: string) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = cleaned.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < cleaned.length; index += 1) {
    const char = cleaned[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return cleaned.slice(start, index + 1);
  }

  return cleaned.slice(start);
}

function escapeJsonStringControlCharacters(value: string) {
  let inString = false;
  let escaped = false;
  let output = "";

  for (const char of value) {
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }

    if (char === "\"") {
      output += char;
      inString = !inString;
      continue;
    }

    if (inString) {
      if (char === "\n") {
        output += "\\n";
        continue;
      }
      if (char === "\r") {
        output += "\\r";
        continue;
      }
      if (char === "\t") {
        output += "\\t";
        continue;
      }
    }

    output += char;
  }

  return output;
}

function parseExtractionText(text: string): RawCandidate[] {
  const jsonText = extractJsonObject(text);
  if (!jsonText) throw new Error("Gemini extraction did not return parseable JSON.");

  let parsed: { candidates?: RawCandidate[] };
  try {
    parsed = JSON.parse(jsonText) as { candidates?: RawCandidate[] };
  } catch {
    parsed = JSON.parse(escapeJsonStringControlCharacters(jsonText)) as { candidates?: RawCandidate[] };
  }

  return Array.isArray(parsed.candidates) ? parsed.candidates : [];
}

function getIntelligenceModel() {
  return getOptionalEnv("GEMINI_INTELLIGENCE_MODEL") ?? getOptionalEnv("GEMINI_MODEL") ?? "gemini-2.5-flash";
}

function buildTargetInstruction(target: z.infer<typeof extractSchema>["target"]) {
  return target
    ? `Preferred target series: provider=${target.provider ?? ""}, series_code=${target.seriesCode ?? ""}, country=${
        target.countryCode ?? ""
      }, unit=${target.unit ?? ""}.`
    : "If no target series is obvious, leave provider and series_code blank.";
}

async function generateDocumentExtraction(ai: GoogleGenAI, model: string, sourceText: string, targetInstruction: string) {
  return ai.models.generateContent({
    model,
    contents: [
      "Extract candidate macroeconomic intelligence for a private data vault.",
      "Return only facts that are supported by the supplied document.",
      "Do not promote anything directly into the canonical vault.",
      "Use signal_type numeric_observation only when a dated numeric value is explicit.",
      "Use ISO dates, confidence from 0 to 1, and concise source titles.",
      targetInstruction,
      sourceText
    ].join("\n\n"),
    config: {
      temperature: 0.1,
      maxOutputTokens: 2200,
      responseMimeType: "application/json",
      responseSchema: extractionSchema
    }
  });
}

async function generateGroundedWebBrief(ai: GoogleGenAI, model: string, sourceText: string, targetInstruction: string) {
  return ai.models.generateContent({
    model,
    contents: [
      "Research macroeconomic intelligence for a private data vault using Google Search grounding.",
      "Return a concise factual brief, not JSON.",
      "Include only source-supported dated numeric facts or concise event signals.",
      "For every fact, include the source title and URL when available.",
      targetInstruction,
      sourceText
    ].join("\n\n"),
    config: {
      temperature: 0.15,
      maxOutputTokens: 1800,
      tools: [{ googleSearch: {} }]
    }
  });
}

async function structureGroundedWebBrief(
  ai: GoogleGenAI,
  model: string,
  brief: string,
  sources: GroundingSource[],
  targetInstruction: string
) {
  return ai.models.generateContent({
    model,
    contents: [
      "Convert this grounded research brief into candidate macroeconomic intelligence JSON.",
      "Do not add facts that are not present in the brief.",
      "Use signal_type numeric_observation only when a dated numeric value is explicit.",
      "Use event for narrative events without a reliable numeric value.",
      "Use ISO dates where available. If a precise date is unavailable, leave date empty.",
      "Known grounding sources:",
      JSON.stringify(sources),
      targetInstruction,
      "Grounded brief:",
      brief
    ].join("\n\n"),
    config: {
      temperature: 0,
      maxOutputTokens: 1800,
      responseMimeType: "application/json",
      responseSchema: extractionSchema
    }
  });
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  try {
    const input = extractSchema.parse(await request.json());
    const supabase = createSupabaseAdmin();
    const document = input.mode === "document" && input.documentId ? await getKnowledgeDocument(supabase, input.documentId) : null;

    if (input.mode === "document" && !document) {
      return NextResponse.json({ error: "Knowledge document not found" }, { status: 404 });
    }

    const sourceText =
      input.mode === "document"
        ? `Document title: ${document?.title}\nSource URL: ${document?.source_url ?? "none"}\n\n${document?.content_text}`
        : `Live web search query: ${input.query}`;

    const model = getIntelligenceModel();
    const ai = new GoogleGenAI({ apiKey: getEnv("GEMINI_API_KEY") });
    const targetInstruction = buildTargetInstruction(input.target);
    const firstPass =
      input.mode === "web"
        ? await generateGroundedWebBrief(ai, model, sourceText, targetInstruction)
        : await generateDocumentExtraction(ai, model, sourceText, targetInstruction);
    const sources = input.mode === "web" ? extractGroundingSources(firstPass) : [];
    const result =
      input.mode === "web"
        ? await structureGroundedWebBrief(ai, model, firstPass.text ?? "", sources, targetInstruction)
        : firstPass;

    if (!result.text) throw new Error("Gemini returned an empty extraction response.");

    const firstSource = sources[0] ?? { url: document?.source_url ?? null, title: document?.title ?? null };
    const rawCandidates = parseExtractionText(result.text).slice(0, 8);

    if (!rawCandidates.length) {
      return NextResponse.json({
        ok: true,
        setupRequired: false,
        model,
        candidates: [],
        count: 0,
        sources,
        message: "No high-confidence candidates were extracted."
      });
    }

    const candidates = rawCandidates.map((candidate) => {
      const value = normalizeNumber(candidate.value);
      const sourceUrl = candidate.source_url || firstSource.url;
      const sourceTitle = candidate.source_title || firstSource.title || document?.title || input.query || "Unstructured source";
      const signalType = normalizeSignalType(candidate.signal_type, value !== null);

      return {
        signalType,
        title: candidate.title || sourceTitle,
        provider: candidate.provider || input.target?.provider || null,
        seriesCode: candidate.series_code || input.target?.seriesCode || null,
        countryCode: candidate.country_code || input.target?.countryCode || null,
        date: normalizeDate(candidate.date),
        value,
        unit: candidate.unit || input.target?.unit || null,
        narrative: candidate.narrative || summarizeText(candidate.title || sourceTitle, 240),
        confidence: normalizeConfidence(candidate.confidence),
        sourceDocumentId: document?.id ?? null,
        sourceUrl,
        sourceTitle,
        sourceTier: input.mode === "web" ? ("public_web" as const) : document?.source_tier ?? ("user_supplied" as const),
        extractionMethod: input.mode === "web" ? "gemini_search_grounding" : "gemini_document_extract",
        metadata: {
          model,
          query: input.query ?? null,
          sources
        }
      };
    });

    const inserted = await createIntelligenceCandidates(supabase, candidates);

    return NextResponse.json({
      ok: true,
      setupRequired: false,
      model,
      candidates: inserted,
      count: inserted.length,
      sources
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
