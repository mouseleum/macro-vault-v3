import { getOptionalEnv } from "./env";
import type { ChannelId, MarketingHighlightSeverity } from "@/types/marketing";

export type ProjectBrand = {
  // Hex colors used on the rendered share card.
  accent: string;
  accentSoft: string;
  logoText: string;
  handle: string;
  tagline: string;
};

export type ProjectProfile = {
  slug: string;
  name: string;
  enabled: boolean;
  // Env var names, not values, so the registry itself contains no secrets.
  feedUrlEnv: string;
  feedKeyEnv: string;
  // Fixture served instead of the feed when the URL env is unset in dev.
  devFixture: boolean;
  brand: ProjectBrand;
  // Prepended to every copywriting prompt for this project.
  voice: string;
  channels: ChannelId[];
  minSeverity: MarketingHighlightSeverity;
  maxDraftsPerDay: number;
};

export const projects: ProjectProfile[] = [
  {
    slug: "macro-vault",
    name: "Macro Vault",
    enabled: true,
    feedUrlEnv: "VAULT_FEED_URL",
    feedKeyEnv: "VAULT_API_KEY",
    devFixture: true,
    brand: {
      accent: "#00c48c",
      accentSoft: "#06281e",
      logoText: "MV",
      handle: "@macrovault",
      tagline: "Private macro data, public signal"
    },
    voice:
      "You write for Macro Vault, a private macroeconomic data platform. Voice: precise, data-first, quietly confident, no hype, no financial advice. Numbers carry the story; adjectives don't.",
    channels: ["zapier", "bluesky", "x", "linkedin"],
    minSeverity: "medium",
    maxDraftsPerDay: 3
  },
  {
    slug: "visual-alarmist",
    name: "Visual Alarmist",
    enabled: false,
    feedUrlEnv: "VISUAL_ALARMIST_FEED_URL",
    feedKeyEnv: "VISUAL_ALARMIST_API_KEY",
    devFixture: false,
    brand: {
      accent: "#ff4f64",
      accentSoft: "#3a0f16",
      logoText: "VA",
      handle: "@visualalarmist",
      tagline: "When the charts start screaming"
    },
    voice:
      "You write for Visual Alarmist, a dramatic macro-visualization app. Voice: urgent but factual, cinematic, a little tongue-in-cheek about its own alarmism. Never invent data.",
    channels: ["zapier", "bluesky", "x"],
    minSeverity: "high",
    maxDraftsPerDay: 2
  }
];

export function enabledProjects() {
  return projects.filter((project) => project.enabled);
}

export function getProject(slug: string) {
  return projects.find((project) => project.slug === slug) ?? null;
}

export function resolveFeed(profile: ProjectProfile) {
  return {
    url: getOptionalEnv(profile.feedUrlEnv),
    key: getOptionalEnv(profile.feedKeyEnv)
  };
}

const severityRank: Record<MarketingHighlightSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  extreme: 3
};

export function meetsSeverity(severity: MarketingHighlightSeverity, minimum: MarketingHighlightSeverity) {
  return severityRank[severity] >= severityRank[minimum];
}
