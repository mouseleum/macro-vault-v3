// Highlights contract — kept in sync with docs/marketing-contract.md and
// types/vault.ts in macro-vault-v3. Copied (not imported) so the engine stays
// standalone and extractable to its own repo.
export type MarketingHighlightType = "alert" | "stat" | "surprise" | "event" | "milestone";

export type MarketingHighlightSeverity = "low" | "medium" | "high" | "extreme";

export type MarketingHighlightMetric = {
  label: string;
  value: string;
  delta?: string | null;
};

export type SparklinePoint = { t: string; v: number };

// Optional media attachments — used by music/creative projects: square cover
// art rendered on the card, a waveform strip (0–1 amplitudes) drawn in place
// of the sparkline, and streaming/pre-save links woven into the copy.
export type MarketingHighlightMedia = {
  coverImageUrl?: string | null;
  waveform?: number[];
  links?: Array<{ label: string; url: string }>;
};

export type MarketingHighlight = {
  id: string;
  type: MarketingHighlightType;
  headline: string;
  narrative: string;
  severity: MarketingHighlightSeverity;
  metrics: MarketingHighlightMetric[];
  sparkline?: SparklinePoint[];
  media?: MarketingHighlightMedia | null;
  link?: string | null;
  tags: string[];
  expiresAt?: string | null;
};

export type MarketingHighlightsResponse = {
  project: string;
  generatedAt: string;
  highlights: MarketingHighlight[];
};

// Engine-side records.
export type ChannelId = "zapier" | "bluesky" | "x" | "linkedin";

export type DraftStatus = "pending" | "approved" | "rejected" | "published";

export type DraftCopy = {
  x: string;
  bluesky: string;
  linkedin: string;
};

export type MarketingDraft = {
  id: string;
  project: string;
  highlight_id: string;
  content_hash: string;
  type: MarketingHighlightType;
  headline: string;
  narrative: string;
  severity: MarketingHighlightSeverity;
  metrics: MarketingHighlightMetric[];
  sparkline: SparklinePoint[] | null;
  media: MarketingHighlightMedia | null;
  link: string | null;
  tags: string[];
  copy: DraftCopy;
  score: number;
  status: DraftStatus;
  created_at: string;
  reviewed_at: string | null;
};

export type MarketingPostStatus = "posted" | "failed" | "skipped" | "dry_run";

export type MarketingPost = {
  id: string;
  draft_id: string;
  channel: ChannelId;
  external_id: string | null;
  url: string | null;
  status: MarketingPostStatus;
  error: string | null;
  posted_at: string;
};

export type PublishResult = {
  channel: ChannelId;
  status: MarketingPostStatus;
  externalId?: string | null;
  url?: string | null;
  error?: string | null;
};
