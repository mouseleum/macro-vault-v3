import { Type } from "@google/genai";
import { isDevMode } from "./env";
import { createGeminiClient, getGeminiModel } from "./gemini";
import { BLUESKY_LIMIT, truncateCopy, X_LIMIT } from "./text";
import type { ProjectProfile } from "./registry";
import type { DraftCopy, MarketingHighlight } from "@/types/marketing";

const copySchema = {
  type: Type.OBJECT,
  properties: {
    x: { type: Type.STRING },
    bluesky: { type: Type.STRING },
    linkedin: { type: Type.STRING }
  },
  required: ["x", "bluesky", "linkedin"]
};

function hashtags(highlight: MarketingHighlight, max = 2) {
  return highlight.tags
    .filter((tag) => /^[a-z0-9]+$/i.test(tag))
    .slice(0, max)
    .map((tag) => `#${tag}`)
    .join(" ");
}

function primaryLink(highlight: MarketingHighlight) {
  return highlight.link ?? highlight.media?.links?.[0]?.url ?? "";
}

// Deterministic copy for local development without a Gemini key — keeps the
// full pipeline runnable with zero secrets. Never used in production. Parts
// are dropped whole (never sliced) until the platform limit fits, so links
// stay intact.
export function templateCopy(profile: ProjectProfile, highlight: MarketingHighlight): DraftCopy {
  const metricLine = highlight.metrics
    .map((metric) => `${metric.label}: ${metric.value}${metric.delta ? ` (${metric.delta})` : ""}`)
    .join(" · ");
  const linksLine = (highlight.media?.links ?? [])
    .map((item) => `${item.label}: ${item.url}`)
    .join("\n");
  const link = primaryLink(highlight);

  const shortFor = (limit: number) => {
    // Drop optional parts (hashtags first, then metrics) until the post fits;
    // the headline and link are never sliced apart.
    const candidates = [
      [highlight.headline, metricLine, hashtags(highlight), link],
      [highlight.headline, metricLine, link],
      [highlight.headline, link],
      [highlight.headline]
    ];
    for (const parts of candidates) {
      const composed = parts.filter(Boolean).join("\n");
      if (composed.length <= limit) return composed;
    }
    return truncateCopy(highlight.headline, limit);
  };

  const long = [
    highlight.headline,
    "",
    highlight.narrative,
    metricLine ? `\n${metricLine}` : "",
    linksLine ? `\n${linksLine}` : highlight.link ? `\n${highlight.link}` : "",
    `\n— ${profile.name}`
  ]
    .filter(Boolean)
    .join("\n");

  return {
    x: shortFor(X_LIMIT),
    bluesky: shortFor(BLUESKY_LIMIT),
    linkedin: long
  };
}

export async function generateCopy(profile: ProjectProfile, highlight: MarketingHighlight): Promise<DraftCopy> {
  const ai = createGeminiClient();
  if (!ai) {
    if (isDevMode()) return templateCopy(profile, highlight);
    throw new Error("Missing required environment variable: GEMINI_API_KEY");
  }

  const links = highlight.media?.links ?? [];
  const result = await ai.models.generateContent({
    model: getGeminiModel(),
    contents: [
      profile.voice,
      "Write social media copy for the highlight below. The post ships with a rendered card image, so the text should complement it, not repeat every number.",
      `Rules:
- "x": one post, hard limit ${X_LIMIT} characters including the link, at most 2 hashtags.
- "bluesky": one post, hard limit ${BLUESKY_LIMIT} characters, hashtags optional.
- "linkedin": 2-4 short paragraphs, professional but not stiff, no hashtag spam (max 3 at the end).
- Include the primary link if one is provided.${links.length ? " Mention where to listen using the provided platform links (primary link in short posts; all platforms in the linkedin version)." : ""} Never invent numbers, tickers, or predictions. No emojis unless the voice calls for it.`,
      "Highlight JSON:",
      JSON.stringify({
        type: highlight.type,
        headline: highlight.headline,
        narrative: highlight.narrative,
        severity: highlight.severity,
        metrics: highlight.metrics,
        link: primaryLink(highlight) || null,
        platformLinks: links,
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
    x: truncateCopy(parsed.x || fallback.x, X_LIMIT),
    bluesky: truncateCopy(parsed.bluesky || fallback.bluesky, BLUESKY_LIMIT),
    linkedin: (parsed.linkedin || fallback.linkedin).trim()
  };
}
