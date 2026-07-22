import { createHash } from "node:crypto";
import { Type } from "@google/genai";
import { todayIsoDate } from "./api";
import { createGeminiClient, getGeminiModel } from "./gemini";
import { meetsSeverity, type ProjectProfile } from "./registry";
import type { MarketingHighlight, MarketingHighlightSeverity, MarketingHighlightType } from "@/types/marketing";

const severityScore: Record<MarketingHighlightSeverity, number> = {
  low: 10,
  medium: 40,
  high: 70,
  extreme: 90
};

const typeScore: Record<MarketingHighlightType, number> = {
  alert: 10,
  surprise: 8,
  milestone: 6,
  stat: 4,
  event: 2
};

export function contentHash(project: string, highlight: MarketingHighlight) {
  return createHash("sha256")
    .update(JSON.stringify([project, highlight.id, highlight.headline, highlight.metrics]))
    .digest("hex");
}

export function ruleScore(highlight: MarketingHighlight) {
  let score = severityScore[highlight.severity] + typeScore[highlight.type];
  if (highlight.metrics.length > 0) score += 3;
  if (highlight.sparkline && highlight.sparkline.length >= 2) score += 3;
  return score;
}

export type SelectedHighlight = {
  highlight: MarketingHighlight;
  contentHash: string;
  score: number;
};

// Starter feed files ship with EDIT-ME markers; never let unedited placeholder
// content become a draft that a routine approval click could publish.
const placeholderPattern = /EDIT[-\s]?ME/i;

export function isPlaceholderHighlight(highlight: MarketingHighlight) {
  const linkText = [highlight.link ?? "", ...(highlight.media?.links ?? []).map((item) => `${item.label} ${item.url}`)].join(" ");
  return placeholderPattern.test(`${highlight.headline} ${highlight.narrative} ${linkText}`);
}

// Ask Gemini to order candidates by shareability when there are more than the
// day's remaining slots. Falls back silently to rule ordering.
async function geminiRank(profile: ProjectProfile, candidates: SelectedHighlight[]): Promise<SelectedHighlight[]> {
  const ai = createGeminiClient();
  if (!ai || candidates.length < 2) return candidates;

  try {
    const result = await ai.models.generateContent({
      model: getGeminiModel(),
      contents: [
        `Rank these ${profile.name} highlights by how compelling they would be as a social media post today.`,
        "Judge on: concreteness of the numbers, surprise factor, and broad-audience interest.",
        "Return the ids ordered best-first. Include every id exactly once.",
        JSON.stringify(candidates.map(({ highlight }) => ({
          id: highlight.id,
          type: highlight.type,
          severity: highlight.severity,
          headline: highlight.headline,
          narrative: highlight.narrative,
          metrics: highlight.metrics
        })))
      ].join("\n\n"),
      config: {
        temperature: 0,
        maxOutputTokens: 600,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            ranking: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ["ranking"]
        }
      }
    });

    const parsed = JSON.parse(result.text ?? "{}") as { ranking?: string[] };
    if (!Array.isArray(parsed.ranking)) return candidates;

    const byId = new Map(candidates.map((candidate) => [candidate.highlight.id, candidate]));
    const ranked = parsed.ranking
      .map((id) => byId.get(id))
      .filter((candidate): candidate is SelectedHighlight => Boolean(candidate));
    const missing = candidates.filter((candidate) => !parsed.ranking?.includes(candidate.highlight.id));
    return [...ranked, ...missing];
  } catch {
    return candidates;
  }
}

export async function selectHighlights(
  profile: ProjectProfile,
  highlights: MarketingHighlight[],
  existingHashes: Set<string>,
  draftsToday: number
): Promise<SelectedHighlight[]> {
  const todayIso = todayIsoDate();
  const slots = Math.max(0, profile.maxDraftsPerDay - draftsToday);
  if (slots === 0) return [];

  const candidates = highlights
    .filter((highlight) => {
      if (!isPlaceholderHighlight(highlight)) return true;
      console.warn(`[select] ${profile.slug}: skipped placeholder highlight ${highlight.id} (contains EDIT-ME marker)`);
      return false;
    })
    .filter((highlight) => !highlight.expiresAt || highlight.expiresAt >= todayIso)
    .filter((highlight) => meetsSeverity(highlight.severity, profile.minSeverity))
    .map((highlight) => ({
      highlight,
      contentHash: contentHash(profile.slug, highlight),
      score: ruleScore(highlight)
    }))
    .filter((candidate) => !existingHashes.has(candidate.contentHash))
    .sort((a, b) => b.score - a.score);

  if (candidates.length <= slots) return candidates;

  const ranked = await geminiRank(profile, candidates.slice(0, slots * 3));
  return ranked.slice(0, slots);
}
