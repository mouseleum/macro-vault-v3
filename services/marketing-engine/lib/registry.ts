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
  // Key into feeds/index.ts, used when the URL env is unset. This is how
  // manual projects publish: edit the JSON, commit, deploy — no endpoint.
  feedFile?: string;
  // Fixture-flagged feed files carry sample data and only load in dev builds;
  // in production a missing URL is then an error instead of fake drafts.
  feedFileIsFixture?: boolean;
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
    feedFile: "macro-vault.fixture",
    feedFileIsFixture: true,
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
    // EDIT ME: artist name, handle, colors, and voice — see feeds/artist.json
    // for the matching starter content.
    slug: "artist",
    name: "EDIT ME (Artist)",
    enabled: true,
    feedUrlEnv: "ARTIST_FEED_URL",
    feedKeyEnv: "ARTIST_FEED_API_KEY",
    feedFile: "artist",
    brand: {
      accent: "#9d6bff",
      accentSoft: "#251448",
      logoText: "♪",
      handle: "@EDIT-ME",
      tagline: "New music, straight from the studio"
    },
    voice:
      "You write as an independent artist announcing their own music. Voice: warm, direct, first person, zero corporate speak, zero fake hype. Talk like you'd talk to people who already like your music. Releases are rare, so let them matter.",
    channels: ["zapier", "bluesky", "x"],
    minSeverity: "low",
    maxDraftsPerDay: 2
  },
  {
    slug: "song-blueprint",
    name: "Song Blueprint",
    enabled: true,
    feedUrlEnv: "SONG_BLUEPRINT_FEED_URL",
    feedKeyEnv: "SONG_BLUEPRINT_API_KEY",
    feedFile: "song-blueprint",
    brand: {
      accent: "#2c78ff",
      accentSoft: "#0b2147",
      logoText: "SB",
      handle: "@EDIT-ME",
      tagline: "Blueprints for better songs"
    },
    voice:
      "You write as an indie tool-maker sharing progress on Song Blueprint, a songwriting tool. Voice: curious, concrete, maker-to-maker; show the interesting detail, never oversell.",
    channels: ["zapier", "bluesky"],
    minSeverity: "medium",
    maxDraftsPerDay: 2
  },
  {
    slug: "visual-alarmist",
    name: "Visual Alarmist",
    enabled: false,
    feedUrlEnv: "VISUAL_ALARMIST_FEED_URL",
    feedKeyEnv: "VISUAL_ALARMIST_API_KEY",
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
