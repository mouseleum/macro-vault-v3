export type HealthStatus = {
  ok: boolean;
  env: Record<string, boolean>;
  optional?: Record<string, boolean>;
  connectors?: Record<
    string,
    {
      ok: boolean;
      status: "ok" | "warning" | "error" | "missing";
      latencyMs: number | null;
      detail: string;
    }
  >;
  timestamp: string;
};

export type MacroSeries = {
  id: string;
  provider: string;
  series_code: string;
  name: string | null;
  country_code: string | null;
  unit: string | null;
  metadata: Record<string, unknown> | null;
  last_synced: string | null;
};

export type Observation = {
  id: string;
  series_id: string;
  date: string;
  value: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type SeriesPreview = {
  series: MacroSeries;
  latest: Observation | null;
  previous: Observation | null;
  change: number | null;
  changePct: number | null;
  points: Array<{
    date: string;
    value: number;
  }>;
};

export type VaultSummary = {
  totals: {
    series: number;
    observations: number;
  };
  health: {
    envOk: number;
    envTotal: number;
    syncHealth: number;
  };
  latestSynced: string | null;
  cards: SeriesPreview[];
  timestamp: string;
};

export type SyncRunStatus = "success" | "partial" | "failed";

export type SyncRun = {
  id: string;
  connector: string;
  action: string;
  status: SyncRunStatus;
  started_at: string;
  finished_at: string;
  duration_ms: number | null;
  total_series: number;
  total_observations: number;
  failed_count: number;
  error: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
};

export type SyncRunsResponse = {
  setupRequired: boolean;
  fallback?: boolean;
  schemaCacheStale?: boolean;
  runs: SyncRun[];
  count: number;
  message?: string;
};

export type SourceTier = "user_supplied" | "public_web" | "licensed" | "internal" | "unknown";

export type KnowledgeDocument = {
  id: string;
  title: string;
  source_url: string | null;
  source_type: string;
  source_tier: SourceTier;
  content_text: string;
  summary: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type IntelligenceCandidateStatus = "pending" | "approved" | "rejected" | "promoted";
export type IntelligenceSignalType = "numeric_observation" | "event" | "document_note";

export type IntelligenceCandidate = {
  id: string;
  status: IntelligenceCandidateStatus;
  signal_type: IntelligenceSignalType;
  title: string;
  provider: string | null;
  series_code: string | null;
  country_code: string | null;
  date: string | null;
  value: number | null;
  unit: string | null;
  narrative: string | null;
  confidence: number | null;
  source_document_id: string | null;
  source_url: string | null;
  source_title: string | null;
  source_tier: SourceTier;
  extraction_method: string;
  metadata: Record<string, unknown>;
  created_at: string;
  reviewed_at: string | null;
};

export type MacroEvent = {
  id: string;
  event_date: string;
  title: string;
  narrative: string;
  category: string | null;
  country_code: string | null;
  region: string | null;
  impact_score: number | null;
  confidence: number | null;
  source_url: string | null;
  source_title: string | null;
  source_tier: SourceTier;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type MacroEventPrepNotes = {
  market_expectation: string;
  upside_surprise: string;
  downside_surprise: string;
  likely_assets: string;
  trade_plan: string;
  post_release_read: string;
  updated_at?: string;
};

export type MacroEventsResponse = {
  setupRequired: boolean;
  fallback?: boolean;
  schemaCacheStale?: boolean;
  events: MacroEvent[];
  count: number;
  message?: string;
};

export type MacroDashboardEvent = MacroEvent & {
  event_type: string;
  theme: string;
  is_macro_critical: boolean;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  surprise: {
    value: number;
    label: string;
    direction: "above_forecast" | "below_forecast" | "in_line";
  } | null;
  prep_notes: MacroEventPrepNotes | null;
};

// Opportunity rows surfaced from promoted engine reports (macro_events with
// category "engine_opportunity"). Shape matches what the Asymmetric Macro
// Finder dashboard parses directly (label/report/coordinates/basket/etc.).
export type MacroDashboardOpportunity = {
  id: string;
  label: string;
  status: "opportunity";
  severity: "low" | "medium" | "high" | "extreme";
  conviction: number;
  divergenceScore: number;
  coordinates: unknown;
  assetBasket: unknown;
  catalysts: string[];
  invalidation: string | null;
  report: string | null;
  rawTelemetry: unknown;
  situation: string;
  updatedAt: string;
  sources: Array<{ title: string | null; url: string | null }>;
};

export type MacroDashboardFeedResponse = {
  summary: {
    totalSeries: number;
    totalObservations: number;
    latestSynced: string | null;
  };
  regime: Record<string, unknown> | null;
  opportunities: MacroDashboardOpportunity[];
  upcomingCriticalEvents: MacroDashboardEvent[];
  realizedSurprises: MacroDashboardEvent[];
  narrativeSignals: MacroEvent[];
  query: {
    days: number;
    limit: number;
    country?: string;
  };
  timestamp: string;
};

export type EconomicCalendarSyncResponse = {
  ok: boolean;
  provider: string;
  fallback?: boolean;
  totalEvents: number;
  storedEvents: number;
  failedCount: number;
  from: string;
  to: string;
  events: MacroEvent[];
};

export type KnowledgeDocumentsResponse = {
  setupRequired: boolean;
  schemaCacheStale?: boolean;
  documents: KnowledgeDocument[];
  count: number;
  message?: string;
};

export type IntelligenceCandidatesResponse = {
  setupRequired: boolean;
  schemaCacheStale?: boolean;
  candidates: IntelligenceCandidate[];
  count: number;
  message?: string;
};
