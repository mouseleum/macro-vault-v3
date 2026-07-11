import { GoogleGenAI, Type } from "@google/genai";
import { getOptionalEnv, isDevWithoutSupabase } from "./env";
import type { ProjectProfile } from "./registry";
import type { DraftCopy, MarketingHighlight } from "@/types/marketing";

const X_LIMIT = 280;
const BLUESKY_LIMIT = 300;

const copySchema = {
  type: Type.OBJECT,
  properties: {
    x: { type: Type.STRING },
    bluesky: { type: Type.STRING },
    linkedin: { type: Type.STRING }
  },
  required: ["x", "bluesky", "linkedin"]
};

function truncate(value: string, limit: number) {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

function hashtags(highlight: MarketingHighlight, max = 2) {
  return highlight.tags
    .filter((tag) => /^[a-z0-9]+$/i.test(tag))
    .slice(0, max)
    .map((tag) => `#${tag}`)
    .join(" ");
}

// Deterministic copy for local development without a Gemini key — keeps the
// full pipeline runnable with zero secrets. Never used in production.
export function templateCopy(profile: ProjectProfile, highlight: MarketingHighlight): DraftCopy {
  const metricLine = highlight.metrics
    .map((metric) => `${metric.label}: ${metric.value}${metric.delta ? ` (${metric.delta})` : ""}`)
    .join(" · ");
  const tagLine = hashtags(highlight);
  const link = highlight.link ?? "";
  const short = [highlight.headline, metricLine, tagLine, link].filter(Boolean).join("\n");
  const long = [
    highlight.headline,
    "",
    highlight.narrative,
    metricLine ? `\n${metricLine}` : "",
    link ? `\n${link}` : "",
    `\n— ${profile.name}`
  ]
    .filter(Boolean)
    .join("\n");

  return {
    x: truncate(short, X_LIMIT),
    bluesky: truncate(short, BLUESKY_LIMIT),
    linkedin: long
  };
}

export async function generateCopy(profile: ProjectProfile, highlight: MarketingHighlight): Promise<DraftCopy> {
  const apiKey = getOptionalEnv("GEMINI_API_KEY");
  if (!apiKey) {
    if (isDevWithoutSupabase()) return templateCopy(profile, highlight);
    throw new Error("Missing required environment variable: GEMINI_API_KEY");
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = getOptionalEnv("GEMINI_MODEL") ?? "gemini-2.5-flash-lite";

  const result = await ai.models.generateContent({
    model,
    contents: [
      profile.voice,
      "Write social media copy for the highlight below. The post ships with a rendered data card image, so the text should complement it, not repeat every number.",
      `Rules:
- "x": one post, hard limit ${X_LIMIT} characters including the link, at most 2 hashtags.
- "bluesky": one post, hard limit ${BLUESKY_LIMIT} characters, hashtags optional.
- "linkedin": 2-4 short paragraphs, professional but not stiff, no hashtag spam (max 3 at the end).
- Include the link if one is provided. Never invent numbers, tickers, or predictions. No emojis unless the voice calls for it.`,
      "Highlight JSON:",
      JSON.stringify({
        type: highlight.type,
        headline: highlight.headline,
        narrative: highlight.narrative,
        severity: highlight.severity,
        metrics: highlight.metrics,
        link: highlight.link ?? null,
        tags: highlight.tags
      })
    ].join("\n\n"),
    config: {
      temperature: 0.6,
      maxOutputTokens: 1200,
      responseMimeType: "application/json",
      responseSchema: copySchema
    }
  });

  if (!result.text) throw new Error("Gemini returned an empty copywriting response.");

  const parsed = JSON.parse(result.text) as Partial<DraftCopy>;
  const fallback = templateCopy(profile, highlight);

  return {
    x: truncate(parsed.x || fallback.x, X_LIMIT),
    bluesky: truncate(parsed.bluesky || fallback.bluesky, BLUESKY_LIMIT),
    linkedin: (parsed.linkedin || fallback.linkedin).trim()
  };
}
