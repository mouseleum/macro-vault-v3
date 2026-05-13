"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  EconomicCalendarSyncResponse,
  HealthStatus,
  IntelligenceCandidate,
  IntelligenceCandidatesResponse,
  KnowledgeDocument,
  KnowledgeDocumentsResponse,
  MacroEvent,
  MacroEventPrepNotes,
  MacroEventsResponse,
  MacroSeries,
  Observation,
  SeriesPreview,
  SyncRunsResponse,
  VaultSummary
} from "@/types/vault";

type ApiState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

type RegimeResult = {
  ok: boolean;
  model?: string;
  regime: {
    regime?: string;
    risk_appetite?: number;
    confidence?: number;
    reasoning?: string;
    catalysts?: string[];
  };
};

const navItems = [
  ["DASHBOARD", "dashboard", "▦"],
  ["SYNTHESIS ENGINE", "regime", "⚡"],
  ["SERIES EXPLORER", "series", "◉"],
  ["SYNC ENGINE", "sync", "↻"],
  ["KNOWLEDGE BASE", "knowledge", "▣"],
  ["WEB INTELLIGENCE", "intel", "◎"],
  ["MACRO EVENTS", "events", "◇"],
  ["SYNC LOGS", "logs", "▤"],
  ["API HEALTH", "health", "⌁"],
  ["API ACCESS", "api", "⌘"],
  ["DEPLOYMENT", "deploy", "◇"]
] as const;

type NavViewId = (typeof navItems)[number][1];
type ViewId = NavViewId | "detail";
type SyncAction =
  | "worldbank"
  | "fred"
  | "eia"
  | "gdelt"
  | "reliefweb"
  | "usgs"
  | "treasury"
  | "cftc"
  | "eurostat"
  | "fx"
  | "fearGreed"
  | "regime"
  | "health"
  | "calendar";
type SyncSummary = {
  ok: boolean;
  seriesCode: string | null;
  observations: number;
  totalSeries?: number;
  totalObservations?: number;
  synced?: Array<{ seriesCode: string; observations: number }>;
  failed?: Array<{ countryCode: string; indicatorCode: string; error: string }>;
};
type SyncOptions = {
  refresh?: boolean;
};
type KnowledgeForm = {
  title: string;
  sourceUrl: string;
  sourceTier: "user_supplied" | "public_web" | "licensed" | "internal" | "unknown";
  tags: string;
  contentText: string;
};
type ExtractForm = {
  mode: "web" | "document";
  query: string;
  documentId: string;
  provider: string;
  seriesCode: string;
  countryCode: string;
  unit: string;
};
type CalendarWindow = "today" | "week" | "thirty" | "all";

type EventPrep = {
  critical: boolean;
  eventType: string;
  marketExpects: string;
  upsideSurprise: string;
  downsideSurprise: string;
  likelyAssets: string;
  asymmetry: string;
  surprise: string | null;
  surpriseTone: "positive" | "negative" | "neutral";
};
type PrepCard = {
  event: MacroEvent;
  prep: EventPrep;
};
type ReleaseInterpretation = {
  actual: string;
  forecast: string;
  previous: string | null;
  signal: string;
  regimeRead: string;
  assetRead: string;
  suggestedRead: string;
};

const localDevVaultKey = "local-dev";
const calendarWindows: Array<{ id: CalendarWindow; label: string }> = [
  { id: "today", label: "Today" },
  { id: "week", label: "This Week" },
  { id: "thirty", label: "Next 30 Days" },
  { id: "all", label: "All Stored" }
];
const navViewIds = navItems.map(([, id]) => id) as NavViewId[];
const viewIds = [...navViewIds, "detail"] as ViewId[];
const syncModules: Array<{
  tag: string;
  title: string;
  description: string;
  actionLabel: string;
  tone: "green" | "blue" | "amber" | "red" | "purple";
  action?: SyncAction;
}> = [
  {
    tag: "World Bank",
    title: "Global Macro Bundle",
    description: "Extracts GDP, growth, inflation, unemployment, trade, and population indicators.",
    actionLabel: "Sync Macro Bundle",
    tone: "green",
    action: "worldbank"
  },
  {
    tag: "Gemini Intelligence",
    title: "Market Regime Snapshot",
    description: "Synthesizes the current vault state into a compact risk appetite and regime readout.",
    actionLabel: "Sync Market Regime",
    tone: "purple",
    action: "regime"
  },
  {
    tag: "Runtime",
    title: "API Health Check",
    description: "Validates required server variables and confirms the private vault can operate.",
    actionLabel: "Check Health",
    tone: "blue",
    action: "health"
  },
  {
    tag: "Federal Reserve",
    title: "US Macro & Liquidity Bundle",
    description: "Bulk fetches CPI, unemployment, Fed assets, reverse repo, and reserve balances.",
    actionLabel: "Sync Bundle",
    tone: "amber",
    action: "fred"
  },
  {
    tag: "Economic Calendar",
    title: "Scheduled Macro Events",
    description: "Fetches upcoming and recent economic releases into the macro events layer.",
    actionLabel: "Sync Calendar",
    tone: "amber",
    action: "calendar"
  },
  {
    tag: "GDELT News",
    title: "Global Stress Scan",
    description: "Scans global news metadata for supply, credit, and geopolitical stress signals.",
    actionLabel: "Sync News Stress",
    tone: "purple",
    action: "gdelt"
  },
  {
    tag: "ReliefWeb",
    title: "Humanitarian Stress Scan",
    description: "Stores conflict, displacement, food stress, and disaster report metadata as macro events.",
    actionLabel: "Sync Relief Signals",
    tone: "red",
    action: "reliefweb"
  },
  {
    tag: "USGS",
    title: "Earthquake Telemetry",
    description: "Stores significant earthquake events with magnitude, depth, alert, and coordinates.",
    actionLabel: "Sync Quakes",
    tone: "amber",
    action: "usgs"
  },
  {
    tag: "U.S. Treasury",
    title: "Fiscal Liquidity Bundle",
    description: "Syncs TGA balances, Treasury cash flows, and public debt outstanding.",
    actionLabel: "Sync Fiscal Data",
    tone: "green",
    action: "treasury"
  },
  {
    tag: "Yahoo Finance",
    title: "Asset Baseline Bundle",
    description: "Fetches historical quotes for equity, rates, commodity, and crypto proxies.",
    actionLabel: "Sync Assets",
    tone: "blue"
  },
  {
    tag: "EIA Energy",
    title: "Physical Energy Bundle",
    description: "Syncs oil, gas, inventories, production, and refinery utilization into the vault.",
    actionLabel: "Sync Energy",
    tone: "red",
    action: "eia"
  },
  {
    tag: "Eurostat",
    title: "EU Macro Bundle",
    description: "Bulk fetches unemployment, inflation, GDP growth, and ECB-area macro indicators.",
    actionLabel: "Sync EU Bundle",
    tone: "blue",
    action: "eurostat"
  },
  {
    tag: "Alternative.me",
    title: "Fear & Greed Index",
    description: "Fetches historical market sentiment from the crypto fear and greed API.",
    actionLabel: "Sync Fear & Greed",
    tone: "red",
    action: "fearGreed"
  },
  {
    tag: "Frankfurter ECB",
    title: "Forex Exchange Rates",
    description: "Pulls daily reference exchange rates established by the European Central Bank.",
    actionLabel: "Sync Currencies",
    tone: "green",
    action: "fx"
  },
  {
    tag: "CFTC Gov",
    title: "COT Net Position",
    description: "Parses Commitments of Traders reports into non-commercial positioning series.",
    actionLabel: "Sync COT Report",
    tone: "green",
    action: "cftc"
  }
];

function parseViewHash() {
  if (typeof window === "undefined") return "dashboard";
  const hash = window.location.hash.replace("#", "");
  return viewIds.includes(hash as ViewId) ? (hash as ViewId) : "dashboard";
}

function getStoredVaultKey() {
  if (typeof window === "undefined") return "";
  if (isLocalDevHost()) return localDevVaultKey;
  return window.sessionStorage.getItem("macroVaultKey") ?? "";
}

function isLocalDevHost() {
  if (typeof window === "undefined") return false;
  return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || window.location.hostname === "::1";
}

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || data?.details || `Request failed with ${response.status}`);
  }
  return data as T;
}

function formatCompact(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  return new Intl.NumberFormat("en", {
    notation: Math.abs(value) >= 100000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2
  }).format(value);
}

function formatDelta(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatCompact(value)}`;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Never";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatUptime(ms: number) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`;
}

function formatDurationMs(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return "--";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function getTrendClass(change: number | null | undefined) {
  if (change === null || change === undefined) return "neutral";
  return change >= 0 ? "positive" : "negative";
}

function buildSparklinePath(points: SeriesPreview["points"]) {
  if (points.length < 2) return "M 0 24 L 100 24";

  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * 100;
      const y = 40 - ((point.value - min) / range) * 32;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function Sparkline({ points, trend }: { points: SeriesPreview["points"]; trend: string }) {
  return (
    <svg className={`sparkline ${trend}`} viewBox="0 0 100 44" preserveAspectRatio="none" aria-hidden="true">
      <path d={buildSparklinePath(points)} />
    </svg>
  );
}

function buildChartPath(observations: Observation[]) {
  const points = [...observations]
    .reverse()
    .map((observation) => ({ date: observation.date, value: Number(observation.value) }))
    .filter((point) => Number.isFinite(point.value));

  if (points.length < 2) return { path: "M 0 90 L 100 90", points };

  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const path = points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * 100;
      const y = 100 - ((point.value - min) / range) * 82 - 8;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  return { path, points };
}

function DetailChart({ observations }: { observations: Observation[] }) {
  const { path, points } = buildChartPath(observations);
  const first = points[0];
  const last = points.at(-1);

  return (
    <div className="detail-chart">
      <svg viewBox="0 0 100 110" preserveAspectRatio="none" aria-label="Series value chart">
        <path className="grid-line" d="M 0 10 L 100 10" />
        <path className="grid-line" d="M 0 55 L 100 55" />
        <path className="grid-line" d="M 0 100 L 100 100" />
        <path className="chart-line" d={path} />
      </svg>
      <div className="chart-axis">
        <span>{first?.date ?? "--"}</span>
        <span>{last?.date ?? "--"}</span>
      </div>
    </div>
  );
}

function addIsoDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isEconomicCalendarEvent(event: MacroEvent) {
  return event.category === "economic_calendar" || event.metadata?.source === "economic_calendar";
}

function eventMetadataText(event: MacroEvent, key: string) {
  const value = event.metadata?.[key];
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function classifyCalendarTheme(event: MacroEvent) {
  const text = `${event.title} ${event.narrative}`.toLowerCase();
  if (text.includes("cpi") || text.includes("inflation") || text.includes("price")) return "Inflation";
  if (text.includes("unemployment") || text.includes("job") || text.includes("payroll") || text.includes("wage")) return "Labor";
  if (text.includes("gdp") || text.includes("growth")) return "Growth";
  if (text.includes("pmi") || text.includes("manufacturing") || text.includes("industrial")) return "Activity";
  if (text.includes("housing") || text.includes("home") || text.includes("mortgage")) return "Housing";
  if (text.includes("trade") || text.includes("export") || text.includes("import")) return "Trade";
  if (text.includes("rate") || text.includes("fed") || text.includes("ecb") || text.includes("central bank")) return "Rates";
  return "Other";
}

function classifyMacroCriticalEvent(event: MacroEvent) {
  const text = `${event.title} ${event.narrative}`.toLowerCase();

  if (text.includes("core cpi")) return "Core CPI";
  if (text.includes("cpi") || text.includes("consumer price")) return "CPI";
  if (text.includes("nonfarm") || text.includes("nfp") || text.includes("payroll")) return "NFP";
  if (text.includes("unemployment")) return "Unemployment";
  if (text.includes("retail sales")) return "Retail Sales";
  if (text.includes("gdp") || text.includes("gross domestic")) return "GDP";
  if (text.includes("pmi") || text.includes("ism")) return "PMI";
  if (
    text.includes("interest rate") ||
    text.includes("rate decision") ||
    text.includes("fed decision") ||
    text.includes("ecb decision") ||
    text.includes("boe decision") ||
    text.includes("central bank")
  ) {
    return "Central Bank";
  }

  return null;
}

function isMacroCriticalRelease(event: MacroEvent) {
  return Boolean(classifyMacroCriticalEvent(event)) || Number(event.impact_score ?? 0) >= 70;
}

function parseEventNumber(value: string | null) {
  if (!value) return null;
  const multiplier = value.toLowerCase().includes("k") ? 1000 : value.toLowerCase().includes("m") ? 1000000 : 1;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed * multiplier : null;
}

function formatSurprise(actual: string | null, forecast: string | null) {
  const actualNumber = parseEventNumber(actual);
  const forecastNumber = parseEventNumber(forecast);
  if (actualNumber === null || forecastNumber === null) return { label: null, tone: "neutral" as const };

  const surprise = actualNumber - forecastNumber;
  if (Math.abs(surprise) < 0.0001) return { label: "In line with forecast", tone: "neutral" as const };

  const sign = surprise > 0 ? "+" : "";
  return {
    label: `${sign}${formatCompact(surprise)} vs forecast`,
    tone: surprise > 0 ? ("positive" as const) : ("negative" as const)
  };
}

function buildEventPrep(event: MacroEvent): EventPrep {
  const eventType = classifyMacroCriticalEvent(event) ?? classifyCalendarTheme(event);
  const forecast = eventMetadataText(event, "forecast");
  const previous = eventMetadataText(event, "previous");
  const actual = eventMetadataText(event, "actual");
  const expectationBase = forecast ? `Forecast: ${forecast}` : previous ? `Previous: ${previous}` : "No consensus in vault";
  const surprise = formatSurprise(actual, forecast);

  if (eventType === "CPI" || eventType === "Core CPI" || eventType === "Inflation") {
    return {
      critical: isMacroCriticalRelease(event),
      eventType,
      marketExpects: expectationBase,
      upsideSurprise: "Hotter inflation than forecast; hawkish rates repricing risk.",
      downsideSurprise: "Softer inflation than forecast; duration and risk relief.",
      likelyAssets: "UST yields, USD, gold, Nasdaq, S&P 500, rate futures.",
      asymmetry: "Hot prints usually matter more when the market is positioned for cuts.",
      surprise: surprise.label,
      surpriseTone: surprise.tone
    };
  }

  if (eventType === "NFP" || eventType === "Unemployment" || eventType === "Labor") {
    return {
      critical: isMacroCriticalRelease(event),
      eventType,
      marketExpects: expectationBase,
      upsideSurprise: "Stronger jobs or lower unemployment; growth resilient, yields can rise.",
      downsideSurprise: "Labor weakness or higher unemployment; recession risk and curve bull steepening.",
      likelyAssets: "2Y/10Y yields, USD, equities, credit spreads, Fed funds futures.",
      asymmetry: "Weak labor shocks can dominate if growth data is already slowing.",
      surprise: surprise.label,
      surpriseTone: surprise.tone
    };
  }

  if (eventType === "GDP" || eventType === "Retail Sales" || eventType === "PMI" || eventType === "Growth" || eventType === "Activity") {
    return {
      critical: isMacroCriticalRelease(event),
      eventType,
      marketExpects: expectationBase,
      upsideSurprise: "Better activity than expected; cyclical growth and yields can catch a bid.",
      downsideSurprise: "Weaker activity than expected; growth scare risk and defensive rotation.",
      likelyAssets: "Equities, cyclicals, copper, oil, credit, yields, USD crosses.",
      asymmetry: "Growth misses matter more when inflation is not falling fast enough.",
      surprise: surprise.label,
      surpriseTone: surprise.tone
    };
  }

  if (eventType === "Central Bank" || eventType === "Rates") {
    return {
      critical: isMacroCriticalRelease(event),
      eventType,
      marketExpects: expectationBase,
      upsideSurprise: "More hawkish decision or guidance; front-end yields and currency higher.",
      downsideSurprise: "More dovish decision or guidance; rate-cut path reprices lower.",
      likelyAssets: "Front-end rates, yield curve, FX, bank equities, gold, broad risk.",
      asymmetry: "Guidance can matter more than the headline decision.",
      surprise: surprise.label,
      surpriseTone: surprise.tone
    };
  }

  return {
    critical: isMacroCriticalRelease(event),
    eventType,
    marketExpects: expectationBase,
    upsideSurprise: "Higher-than-expected reading; watch whether it reinforces the current regime.",
    downsideSurprise: "Lower-than-expected reading; watch whether it challenges the current regime.",
    likelyAssets: "Rates, FX, equities, commodities, and credit depending on country and theme.",
    asymmetry: "Use forecast versus actual to decide whether the release changes the macro story.",
    surprise: surprise.label,
    surpriseTone: surprise.tone
  };
}

function buildEditablePrepNotes(event: MacroEvent, prep: EventPrep): MacroEventPrepNotes {
  const storedNotes = isRecord(event.metadata?.prep_notes) ? event.metadata.prep_notes : {};

  return {
    market_expectation: stringValue(storedNotes.market_expectation) || prep.marketExpects,
    upside_surprise: stringValue(storedNotes.upside_surprise) || prep.upsideSurprise,
    downside_surprise: stringValue(storedNotes.downside_surprise) || prep.downsideSurprise,
    likely_assets: stringValue(storedNotes.likely_assets) || prep.likelyAssets,
    trade_plan: stringValue(storedNotes.trade_plan),
    post_release_read: stringValue(storedNotes.post_release_read),
    updated_at: stringValue(storedNotes.updated_at) || undefined
  };
}

function buildReleaseInterpretation(event: MacroEvent, prep: EventPrep): ReleaseInterpretation | null {
  const actual = eventMetadataText(event, "actual");
  const forecast = eventMetadataText(event, "forecast");
  const previous = eventMetadataText(event, "previous");
  if (!actual || !forecast) return null;
  if (parseEventNumber(actual) === null || parseEventNumber(forecast) === null) return null;

  const signal = describeSurpriseSignal(event, prep);
  const above = prep.surpriseTone === "positive";
  const below = prep.surpriseTone === "negative";
  let regimeRead = "The release was close enough to consensus that it probably needs confirmation from the next data point.";
  let assetRead = `Watch ${prep.likelyAssets.toLowerCase()} for confirmation rather than treating the print as a standalone regime change.`;

  if (["CPI", "Core CPI", "Inflation"].includes(prep.eventType)) {
    regimeRead = above
      ? "Hotter inflation keeps policy risk alive and pushes against an easy-cut, duration-friendly regime."
      : below
        ? "Cooler inflation supports disinflation and gives duration and risk assets more room to breathe."
        : regimeRead;
    assetRead = above
      ? "Watch front-end yields, USD, gold, Nasdaq, and rate futures for hawkish repricing."
      : below
        ? "Watch duration, equities, gold, and rate futures for dovish relief."
        : assetRead;
  } else if (prep.eventType === "Unemployment") {
    regimeRead = above
      ? "Higher unemployment is a labor-cooling signal; growth risk rises and policy relief becomes more plausible."
      : below
        ? "Lower unemployment keeps labor tight and can delay dovish policy repricing."
        : regimeRead;
    assetRead = above
      ? "Watch bull steepening, credit spreads, defensive equities, and USD risk tone."
      : below
        ? "Watch 2Y yields, USD, cyclicals, and Fed funds futures."
        : assetRead;
  } else if (["NFP", "Labor"].includes(prep.eventType)) {
    regimeRead = above
      ? "Labor resilience supports nominal growth and can keep yields firm."
      : below
        ? "Labor softness raises growth-risk and recession-scare sensitivity."
        : regimeRead;
    assetRead = above
      ? "Watch yields, USD, cyclicals, credit, and equity breadth."
      : below
        ? "Watch curve steepening, defensive sectors, credit spreads, and rate-cut pricing."
        : assetRead;
  } else if (["GDP", "Retail Sales", "PMI", "Growth", "Activity"].includes(prep.eventType)) {
    regimeRead = above
      ? "Growth resilience argues against an immediate slowdown regime and supports cyclical risk."
      : below
        ? "Growth weakness raises slowdown risk, especially if inflation is not falling fast enough."
        : regimeRead;
    assetRead = above
      ? "Watch cyclicals, copper, oil, credit, yields, and growth-sensitive FX."
      : below
        ? "Watch defensives, duration, credit spreads, oil, copper, and equity breadth."
        : assetRead;
  } else if (["Central Bank", "Rates"].includes(prep.eventType)) {
    regimeRead = above
      ? "The decision or guidance landed hawkish versus expectations and can reprice the front end."
      : below
        ? "The decision or guidance landed dovish versus expectations and can pull rate expectations lower."
        : regimeRead;
    assetRead = above
      ? "Watch front-end rates, FX, curve shape, banks, gold, and broad risk."
      : below
        ? "Watch rate-cut pricing, duration, FX, gold, and equity multiples."
        : assetRead;
  }

  const suggestedRead = [
    `${signal}: actual ${actual} versus forecast ${forecast}${previous ? ` and previous ${previous}` : ""}.`,
    regimeRead,
    assetRead
  ].join(" ");

  return {
    actual,
    forecast,
    previous,
    signal,
    regimeRead,
    assetRead,
    suggestedRead
  };
}

function buildRiskBalanceRows(allCards: PrepCard[], nearTermCards: PrepCard[]) {
  const buckets = [
    {
      label: "Inflation",
      types: ["CPI", "Core CPI", "Inflation"],
      activeBias: "Release risk active",
      upperBias: "Hot surprise bias",
      lowerBias: "Cool surprise bias",
      description: "CPI and price data can reset the rate path."
    },
    {
      label: "Growth",
      types: ["GDP", "Retail Sales", "PMI", "Growth", "Activity"],
      activeBias: "Growth test ahead",
      upperBias: "Demand stronger than expected",
      lowerBias: "Growth scare bias",
      description: "Activity data checks whether resilience is broadening or cracking."
    },
    {
      label: "Labor",
      types: ["NFP", "Unemployment", "Labor"],
      activeBias: "Labor shock window",
      upperBias: "Labor market hotter",
      lowerBias: "Labor market softer",
      description: "Jobs data drives recession odds and front-end rates."
    },
    {
      label: "Policy",
      types: ["Central Bank", "Rates"],
      activeBias: "Policy repricing risk",
      upperBias: "Hawkish surprise bias",
      lowerBias: "Dovish surprise bias",
      description: "Decision language can matter more than the rate move."
    }
  ];

  return buckets.map((bucket) => {
    const allMatches = allCards.filter((card) => bucket.types.includes(card.prep.eventType));
    const nearTermMatches = nearTermCards.filter((card) => bucket.types.includes(card.prep.eventType));
    const positiveSurprises = allMatches.filter((card) => card.prep.surpriseTone === "positive").length;
    const negativeSurprises = allMatches.filter((card) => card.prep.surpriseTone === "negative").length;
    const realizedSurprises = positiveSurprises + negativeSurprises;
    const status =
      positiveSurprises > negativeSurprises
        ? bucket.upperBias
        : negativeSurprises > positiveSurprises
          ? bucket.lowerBias
          : nearTermMatches.length
            ? bucket.activeBias
            : "Quiet";
    const tone =
      positiveSurprises > negativeSurprises
        ? "positive"
        : negativeSurprises > positiveSurprises
          ? "negative"
          : nearTermMatches.length
            ? "warning"
            : "neutral";
    const detail = realizedSurprises
      ? `${positiveSurprises} above-forecast and ${negativeSurprises} below-forecast realized prints in stored data.`
      : nearTermMatches.length
        ? `${nearTermMatches.length} macro-critical release${nearTermMatches.length === 1 ? "" : "s"} need pre-release prep.`
        : "No macro-critical release in the current stored window.";

    return {
      ...bucket,
      detail,
      nearTermCount: nearTermMatches.length,
      status,
      tone
    };
  });
}

function buildAssetReactionRows(prepCards: PrepCard[]) {
  const exposures = new Map<string, { count: number; themes: Set<string> }>();

  for (const card of prepCards) {
    const assets = card.prep.likelyAssets
      .replace(/\band\b/gi, ",")
      .split(",")
      .map((asset) => asset.trim().replace(/\.$/, ""))
      .filter(Boolean);

    for (const asset of assets) {
      const current = exposures.get(asset) ?? { count: 0, themes: new Set<string>() };
      current.count += 1;
      current.themes.add(card.prep.eventType);
      exposures.set(asset, current);
    }
  }

  return [...exposures.entries()]
    .map(([asset, value]) => ({
      asset,
      count: value.count,
      themes: [...value.themes].slice(0, 3).join(", ")
    }))
    .sort((a, b) => b.count - a.count || a.asset.localeCompare(b.asset))
    .slice(0, 8);
}

function describeSurpriseSignal(event: MacroEvent, prep: EventPrep) {
  if (!prep.surprise || prep.surpriseTone === "neutral") return "In line";
  const above = prep.surpriseTone === "positive";

  if (["CPI", "Core CPI", "Inflation"].includes(prep.eventType)) {
    return above ? "Hotter inflation" : "Cooler inflation";
  }

  if (prep.eventType === "Unemployment") {
    return above ? "Labor softer" : "Labor tighter";
  }

  if (["NFP", "Labor"].includes(prep.eventType)) {
    return above ? "Labor stronger" : "Labor weaker";
  }

  if (["GDP", "Retail Sales", "PMI", "Growth", "Activity"].includes(prep.eventType)) {
    return above ? "Growth stronger" : "Growth weaker";
  }

  if (["Central Bank", "Rates"].includes(prep.eventType)) {
    return above ? "Hawkish pressure" : "Dovish pressure";
  }

  return `${event.country_code ?? "WLD"} ${above ? "above forecast" : "below forecast"}`;
}

export function VaultClient() {
  const [vaultKey, setVaultKey] = useState("");
  const [activeView, setActiveView] = useState<ViewId>("dashboard");
  const [selectedSeries, setSelectedSeries] = useState<MacroSeries | null>(null);
  const [loadedStoredKey, setLoadedStoredKey] = useState(false);
  const [localDevAuth, setLocalDevAuth] = useState(false);
  const [calendarWindow, setCalendarWindow] = useState<CalendarWindow>("thirty");
  const [macroCriticalOnly, setMacroCriticalOnly] = useState(true);
  const [eventNotesDrafts, setEventNotesDrafts] = useState<Record<string, MacroEventPrepNotes>>({});
  const [eventNoteSaving, setEventNoteSaving] = useState<string | null>(null);
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [appOrigin, setAppOrigin] = useState("http://localhost:3000");
  const [lastAction, setLastAction] = useState("Standing by");

  const [health, setHealth] = useState<ApiState<HealthStatus>>({ loading: false, error: null, data: null });
  const [summary, setSummary] = useState<ApiState<VaultSummary>>({ loading: false, error: null, data: null });
  const [series, setSeries] = useState<ApiState<{ series: MacroSeries[]; count: number }>>({
    loading: false,
    error: null,
    data: null
  });
  const [sync, setSync] = useState<ApiState<SyncSummary>>({
    loading: false,
    error: null,
    data: null
  });
  const [fredSync, setFredSync] = useState<
    ApiState<{
      ok: boolean;
      totalSeries: number;
      totalObservations: number;
      synced: Array<{ seriesCode: string; observations: number }>;
      failed?: Array<{ fredSeriesId: string; error: string }>;
    }>
  >({
    loading: false,
    error: null,
    data: null
  });
  const [eiaSync, setEiaSync] = useState<
    ApiState<{
      ok: boolean;
      totalSeries: number;
      totalObservations: number;
      synced: Array<{ seriesCode: string; observations: number }>;
      failed?: Array<{ eiaSeriesId: string; error: string }>;
    }>
  >({
    loading: false,
    error: null,
    data: null
  });
  const [gdeltSync, setGdeltSync] = useState<
    ApiState<{
      ok: boolean;
      totalEvents: number;
      storedEvents: number;
      failed?: Array<{ theme: string; error: string }>;
    }>
  >({
    loading: false,
    error: null,
    data: null
  });
  const [reliefWebSync, setReliefWebSync] = useState<
    ApiState<{
      ok: boolean;
      totalEvents: number;
      storedEvents: number;
      failed?: Array<{ theme: string; error: string }>;
    }>
  >({
    loading: false,
    error: null,
    data: null
  });
  const [usgsSync, setUsgsSync] = useState<
    ApiState<{
      ok: boolean;
      totalEvents: number;
      storedEvents: number;
    }>
  >({
    loading: false,
    error: null,
    data: null
  });
  const [treasurySync, setTreasurySync] = useState<
    ApiState<{
      ok: boolean;
      totalSeries: number;
      totalObservations: number;
      synced: Array<{ seriesCode: string; observations: number }>;
    }>
  >({
    loading: false,
    error: null,
    data: null
  });
  const [eurostatSync, setEurostatSync] = useState<
    ApiState<{
      ok: boolean;
      totalSeries: number;
      totalObservations: number;
      synced: Array<{ seriesCode: string; observations: number }>;
    }>
  >({
    loading: false,
    error: null,
    data: null
  });
  const [cftcSync, setCftcSync] = useState<
    ApiState<{
      ok: boolean;
      totalMarkets: number;
      totalSeries: number;
      totalObservations: number;
      synced: Array<{ seriesCode: string; observations: number }>;
      failed?: Array<{ market: string; metric: string; error: string }>;
    }>
  >({
    loading: false,
    error: null,
    data: null
  });
  const [fxSync, setFxSync] = useState<
    ApiState<{ ok: boolean; totalSeries: number; totalObservations: number; synced: Array<{ seriesCode: string; observations: number }> }>
  >({
    loading: false,
    error: null,
    data: null
  });
  const [fearGreedSync, setFearGreedSync] = useState<ApiState<{ ok: boolean; seriesCode: string; observations: number }>>({
    loading: false,
    error: null,
    data: null
  });
  const [calendarSync, setCalendarSync] = useState<ApiState<EconomicCalendarSyncResponse>>({
    loading: false,
    error: null,
    data: null
  });
  const [observations, setObservations] = useState<
    ApiState<{ series: MacroSeries; observations: Observation[]; count: number }>
  >({
    loading: false,
    error: null,
    data: null
  });
  const [regime, setRegime] = useState<ApiState<RegimeResult>>({
    loading: false,
    error: null,
    data: null
  });
  const [coreSync, setCoreSync] = useState<ApiState<{ completed: string[]; failed: string[] }>>({
    loading: false,
    error: null,
    data: null
  });
  const [syncRuns, setSyncRuns] = useState<ApiState<SyncRunsResponse>>({
    loading: false,
    error: null,
    data: null
  });
  const [knowledgeDocs, setKnowledgeDocs] = useState<ApiState<KnowledgeDocumentsResponse>>({
    loading: false,
    error: null,
    data: null
  });
  const [knowledgeSave, setKnowledgeSave] = useState<ApiState<{ document: KnowledgeDocument }>>({
    loading: false,
    error: null,
    data: null
  });
  const [intelCandidates, setIntelCandidates] = useState<ApiState<IntelligenceCandidatesResponse>>({
    loading: false,
    error: null,
    data: null
  });
  const [macroEvents, setMacroEvents] = useState<ApiState<MacroEventsResponse>>({
    loading: false,
    error: null,
    data: null
  });
  const [intelExtract, setIntelExtract] = useState<
    ApiState<{ candidates: IntelligenceCandidate[]; count: number; model?: string; sources?: Array<{ url: string | null; title: string | null }> }>
  >({
    loading: false,
    error: null,
    data: null
  });
  const [candidateAction, setCandidateAction] = useState<string | null>(null);
  const [knowledgeForm, setKnowledgeForm] = useState<KnowledgeForm>({
    title: "",
    sourceUrl: "",
    sourceTier: "user_supplied",
    tags: "",
    contentText: ""
  });
  const [extractForm, setExtractForm] = useState<ExtractForm>({
    mode: "web",
    query: "",
    documentId: "",
    provider: "web_intelligence",
    seriesCode: "",
    countryCode: "WLD",
    unit: ""
  });

  const authHeaders = useMemo(
    () => ({
      Authorization: `Bearer ${vaultKey}`,
      "Content-Type": "application/json"
    }),
    [vaultKey]
  );

  const checkHealth = useCallback(async () => {
    if (!vaultKey) return;

    setHealth({ loading: true, error: null, data: null });
    try {
      const data = await readJson<HealthStatus>(await fetch("/api/health", { headers: authHeaders, cache: "no-store" }));
      setHealth({ loading: false, error: null, data });
      setLastAction("Health check complete");
    } catch (error) {
      setHealth({ loading: false, error: error instanceof Error ? error.message : "Health check failed", data: null });
    }
  }, [authHeaders, vaultKey]);

  const refreshVault = useCallback(async () => {
    if (!vaultKey) return;

    setSummary((current) => ({ loading: true, error: null, data: current.data }));
    setSeries((current) => ({ loading: true, error: null, data: current.data }));

    try {
      const [summaryData, seriesData] = await Promise.all([
        readJson<VaultSummary>(await fetch("/api/vault/summary", { headers: authHeaders, cache: "no-store" })),
        readJson<{ series: MacroSeries[]; count: number }>(
          await fetch("/api/vault/series", { headers: authHeaders, cache: "no-store" })
        )
      ]);

      setSummary({ loading: false, error: null, data: summaryData });
      setSeries({ loading: false, error: null, data: seriesData });
      setLastAction("Vault refreshed");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Vault refresh failed";
      setSummary((current) => ({ loading: false, error: message, data: current.data }));
      setSeries((current) => ({ loading: false, error: message, data: current.data }));
    }
  }, [authHeaders, vaultKey]);

  const loadSyncRuns = useCallback(async () => {
    if (!vaultKey) return;

    setSyncRuns((current) => ({ loading: true, error: null, data: current.data }));

    try {
      const data = await readJson<SyncRunsResponse>(
        await fetch("/api/vault/sync-runs?limit=40", { headers: authHeaders, cache: "no-store" })
      );
      setSyncRuns({ loading: false, error: null, data });
      setLastAction("Sync logs refreshed");
    } catch (error) {
      setSyncRuns({
        loading: false,
        error: error instanceof Error ? error.message : "Sync log load failed",
        data: null
      });
    }
  }, [authHeaders, vaultKey]);

  const loadKnowledgeDocuments = useCallback(async () => {
    if (!vaultKey) return;

    setKnowledgeDocs((current) => ({ loading: true, error: null, data: current.data }));

    try {
      const data = await readJson<KnowledgeDocumentsResponse>(
        await fetch("/api/knowledge/documents?limit=25", { headers: authHeaders, cache: "no-store" })
      );
      setKnowledgeDocs({ loading: false, error: null, data });
      setLastAction("Knowledge base refreshed");
    } catch (error) {
      setKnowledgeDocs({
        loading: false,
        error: error instanceof Error ? error.message : "Knowledge load failed",
        data: null
      });
    }
  }, [authHeaders, vaultKey]);

  const loadIntelligenceCandidates = useCallback(async () => {
    if (!vaultKey) return;

    setIntelCandidates((current) => ({ loading: true, error: null, data: current.data }));

    try {
      const data = await readJson<IntelligenceCandidatesResponse>(
        await fetch("/api/intelligence/candidates?limit=40", { headers: authHeaders, cache: "no-store" })
      );
      setIntelCandidates({ loading: false, error: null, data });
      setLastAction("Intelligence queue refreshed");
    } catch (error) {
      setIntelCandidates({
        loading: false,
        error: error instanceof Error ? error.message : "Candidate load failed",
        data: null
      });
    }
  }, [authHeaders, vaultKey]);

  const loadMacroEvents = useCallback(async () => {
    if (!vaultKey) return;

    setMacroEvents((current) => ({ loading: true, error: null, data: current.data }));

    try {
      const data = await readJson<MacroEventsResponse>(
        await fetch("/api/vault/events?limit=100", { headers: authHeaders, cache: "no-store" })
      );
      setMacroEvents({ loading: false, error: null, data });
      setLastAction("Macro events refreshed");
    } catch (error) {
      setMacroEvents({
        loading: false,
        error: error instanceof Error ? error.message : "Macro event load failed",
        data: null
      });
    }
  }, [authHeaders, vaultKey]);

  function updatePrepNoteDraft(id: string, field: keyof Omit<MacroEventPrepNotes, "updated_at">, value: string) {
    const source = eventRows.find((event) => event.id === id);
    const prepSource = source ? buildEditablePrepNotes(source, buildEventPrep(source)) : null;

    setEventNotesDrafts((current) => ({
      ...current,
      [id]: {
        ...(current[id] ?? prepSource ?? {
          market_expectation: "",
          upside_surprise: "",
          downside_surprise: "",
          likely_assets: "",
          trade_plan: "",
          post_release_read: ""
        }),
        [field]: value
      }
    }));
  }

  async function savePrepNotes(event: MacroEvent, prep: EventPrep, override?: Partial<MacroEventPrepNotes>) {
    const draft = {
      ...(eventNotesDrafts[event.id] ?? buildEditablePrepNotes(event, prep)),
      ...override
    };
    setEventNoteSaving(event.id);

    try {
      const data = await readJson<{ event: MacroEvent }>(
        await fetch(`/api/vault/events/${event.id}/notes`, {
          method: "PATCH",
          headers: authHeaders,
          body: JSON.stringify({
            market_expectation: draft.market_expectation,
            upside_surprise: draft.upside_surprise,
            downside_surprise: draft.downside_surprise,
            likely_assets: draft.likely_assets,
            trade_plan: draft.trade_plan,
            post_release_read: draft.post_release_read
          })
        })
      );

      setMacroEvents((current) =>
        current.data
          ? {
              loading: false,
              error: null,
              data: {
                ...current.data,
                events: current.data.events.map((item) => (item.id === data.event.id ? data.event : item))
              }
            }
          : current
      );
      setEventNotesDrafts((current) => ({
        ...current,
        [data.event.id]: buildEditablePrepNotes(data.event, buildEventPrep(data.event))
      }));
      setLastAction("Event prep note saved");
    } catch (error) {
      setMacroEvents((current) => ({
        loading: false,
        error: error instanceof Error ? error.message : "Prep note save failed",
        data: current.data
      }));
    } finally {
      setEventNoteSaving(null);
    }
  }

  useEffect(() => {
    const isLocal = isLocalDevHost();
    const storedKey = getStoredVaultKey();
    setLocalDevAuth(isLocal);
    setVaultKey(storedKey);
    setLoadedStoredKey(Boolean(storedKey));
    setActiveView(parseViewHash());
    setAppOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    function handleHashChange() {
      setActiveView(parseViewHash());
    }

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!loadedStoredKey || !vaultKey) return;
    setLoadedStoredKey(false);
    void checkHealth();
    void refreshVault();
  }, [checkHealth, loadedStoredKey, refreshVault, vaultKey]);

  useEffect(() => {
    if (activeView !== "logs" || !vaultKey) return;
    void loadSyncRuns();
  }, [activeView, loadSyncRuns, vaultKey]);

  useEffect(() => {
    if (activeView !== "deploy" || !vaultKey) return;
    void checkHealth();
    void refreshVault();
    void loadSyncRuns();
    void loadKnowledgeDocuments();
  }, [activeView, checkHealth, loadKnowledgeDocuments, loadSyncRuns, refreshVault, vaultKey]);

  useEffect(() => {
    if (activeView !== "knowledge" || !vaultKey) return;
    void loadKnowledgeDocuments();
  }, [activeView, loadKnowledgeDocuments, vaultKey]);

  useEffect(() => {
    if (activeView !== "intel" || !vaultKey) return;
    void loadKnowledgeDocuments();
    void loadIntelligenceCandidates();
  }, [activeView, loadIntelligenceCandidates, loadKnowledgeDocuments, vaultKey]);

  useEffect(() => {
    if (activeView !== "events" || !vaultKey) return;
    void loadMacroEvents();
  }, [activeView, loadMacroEvents, vaultKey]);

  function saveKey() {
    if (localDevAuth) {
      setVaultKey(localDevVaultKey);
      setLastAction("Local dev auth enabled");
      return;
    }

    window.sessionStorage.setItem("macroVaultKey", vaultKey);
    setLastAction("Session key saved");
  }

  function switchView(view: ViewId) {
    setActiveView(view);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${view}`);
    }
  }

  async function copyApiContract() {
    try {
      await navigator.clipboard.writeText(
        [
          "GET /api/vault/contract",
          "GET /api/vault/series",
          "GET /api/vault/series?q=inflation&provider=world_bank&limit=25",
          "GET /api/vault/latest?code=WB_US_NY_GDP_MKTP_CD&provider=world_bank&country=US",
          "GET /api/vault/observations?code=WB_US_NY_GDP_MKTP_CD&provider=world_bank&country=US&start=2015-01-01&end=2025-12-31&order=asc&limit=250",
          "GET /api/vault/regime",
          "GET /api/vault/sync-runs?limit=40",
          "GET /api/vault/events?limit=100",
          "GET /api/knowledge/documents?limit=25",
          "GET /api/intelligence/candidates?limit=40",
          "POST /api/intelligence/candidates"
        ].join("\n")
      );
      setLastAction("API contract copied");
    } catch {
      setLastAction("Clipboard blocked; API contract visible");
    }
  }

  async function copyText(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setLastAction(`${label} copied`);
    } catch {
      setLastAction("Clipboard blocked; text visible in API Access");
    }
  }

  async function saveKnowledgeDocument() {
    setKnowledgeSave({ loading: true, error: null, data: null });

    try {
      const data = await readJson<{ document: KnowledgeDocument }>(
        await fetch("/api/knowledge/documents", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(knowledgeForm)
        })
      );
      setKnowledgeSave({ loading: false, error: null, data });
      setKnowledgeForm({
        title: "",
        sourceUrl: "",
        sourceTier: "user_supplied",
        tags: "",
        contentText: ""
      });
      setLastAction("Knowledge document saved");
      await loadKnowledgeDocuments();
    } catch (error) {
      setKnowledgeSave({
        loading: false,
        error: error instanceof Error ? error.message : "Knowledge save failed",
        data: null
      });
    }
  }

  async function runIntelligenceExtraction() {
    setIntelExtract({ loading: true, error: null, data: null });

    try {
      const body = {
        mode: extractForm.mode,
        query: extractForm.mode === "web" ? extractForm.query : undefined,
        documentId: extractForm.mode === "document" ? extractForm.documentId : undefined,
        target: {
          provider: extractForm.provider || undefined,
          seriesCode: extractForm.seriesCode || undefined,
          countryCode: extractForm.countryCode || undefined,
          unit: extractForm.unit || undefined
        }
      };
      const data = await readJson<{
        candidates: IntelligenceCandidate[];
        count: number;
        model?: string;
        sources?: Array<{ url: string | null; title: string | null }>;
      }>(
        await fetch("/api/intelligence/extract", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(body)
        })
      );
      setIntelExtract({ loading: false, error: null, data });
      setLastAction(`Extracted ${data.count} intelligence candidates`);
      await loadIntelligenceCandidates();
    } catch (error) {
      setIntelExtract({
        loading: false,
        error: error instanceof Error ? error.message : "Intelligence extraction failed",
        data: null
      });
    }
  }

  async function updateCandidateStatus(id: string, status: "pending" | "approved" | "rejected") {
    setCandidateAction(id);
    try {
      await readJson<{ candidate: IntelligenceCandidate }>(
        await fetch(`/api/intelligence/candidates/${id}`, {
          method: "PATCH",
          headers: authHeaders,
          body: JSON.stringify({ status })
        })
      );
      setLastAction(`Candidate ${status}`);
      await loadIntelligenceCandidates();
    } catch (error) {
      setIntelCandidates((current) => ({
        loading: false,
        error: error instanceof Error ? error.message : "Candidate update failed",
        data: current.data
      }));
    } finally {
      setCandidateAction(null);
    }
  }

  async function promoteCandidate(id: string) {
    setCandidateAction(id);
    try {
      const data = await readJson<{ candidate: IntelligenceCandidate; seriesId?: string; event?: MacroEvent }>(
        await fetch(`/api/intelligence/candidates/${id}/promote`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({})
        })
      );
      setLastAction(data.event ? "Candidate promoted into macro events" : "Candidate promoted into macro observations");
      await loadIntelligenceCandidates();
      await loadMacroEvents();
      await refreshVault();
    } catch (error) {
      setIntelCandidates((current) => ({
        loading: false,
        error: error instanceof Error ? error.message : "Candidate promotion failed",
        data: current.data
      }));
    } finally {
      setCandidateAction(null);
    }
  }

  async function loadObservations(item: MacroSeries) {
    setSelectedSeries(item);
    setObservations({ loading: true, error: null, data: null });

    const params = new URLSearchParams({
      code: item.series_code,
      provider: item.provider,
      limit: "25"
    });
    if (item.country_code) params.set("country", item.country_code);

    try {
      const data = await readJson<{ series: MacroSeries; observations: Observation[]; count: number }>(
        await fetch(`/api/vault/observations?${params.toString()}`, { headers: authHeaders, cache: "no-store" })
      );
      setSelectedSeries(data.series);
      setObservations({ loading: false, error: null, data });
      setLastAction(`Loaded ${data.count} observations`);
    } catch (error) {
      setObservations({
        loading: false,
        error: error instanceof Error ? error.message : "Observation load failed",
        data: null
      });
    }
  }

  async function openSeriesDetail(item: MacroSeries) {
    switchView("detail");
    await loadObservations(item);
  }

  function buildSeriesEndpoint(kind: "latest" | "observations") {
    if (!selectedSeries || typeof window === "undefined") return "";

    const params = new URLSearchParams({
      code: selectedSeries.series_code,
      provider: selectedSeries.provider
    });
    if (selectedSeries.country_code) params.set("country", selectedSeries.country_code);
    if (kind === "observations") params.set("limit", "100");

    return `${window.location.origin}/api/vault/${kind}?${params.toString()}`;
  }

  function buildEndpointForSeries(seriesItem: Pick<MacroSeries, "series_code" | "provider" | "country_code">, kind: "latest" | "observations") {
    const params = new URLSearchParams({
      code: seriesItem.series_code,
      provider: seriesItem.provider
    });
    if (seriesItem.country_code) params.set("country", seriesItem.country_code);
    if (kind === "observations") {
      params.set("start", "2015-01-01");
      params.set("order", "asc");
      params.set("limit", "250");
    }

    return `${appOrigin}/api/vault/${kind}?${params.toString()}`;
  }

  async function copySeriesEndpoint(kind: "latest" | "observations") {
    const endpoint = buildSeriesEndpoint(kind);
    if (!endpoint) return;

    try {
      await navigator.clipboard.writeText(endpoint);
      setLastAction(`${kind === "latest" ? "Latest" : "Observations"} endpoint copied`);
    } catch {
      setLastAction("Clipboard blocked; endpoint visible in detail view");
    }
  }

  async function syncWorldBank(options: SyncOptions = {}) {
    const shouldRefresh = options.refresh ?? true;
    setSync({ loading: true, error: null, data: null });
    try {
      const data = await readJson<{
        ok: boolean;
        seriesCode: string | null;
        observations: number;
        totalSeries?: number;
        totalObservations?: number;
        synced?: Array<{ seriesCode: string; observations: number }>;
        failed?: Array<{ countryCode: string; indicatorCode: string; error: string }>;
      }>(
        await fetch("/api/sync/worldbank", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            countryCodes: ["WLD", "US", "CHN", "JPN", "DEU", "GBR", "EMU"],
            indicators: [
              {
                indicatorCode: "NY.GDP.MKTP.CD",
                name: "GDP current US$",
                unit: "current US$"
              },
              {
                indicatorCode: "NY.GDP.MKTP.KD.ZG",
                name: "GDP growth",
                unit: "annual %"
              },
              {
                indicatorCode: "FP.CPI.TOTL.ZG",
                name: "Inflation consumer prices",
                unit: "annual %"
              },
              {
                indicatorCode: "SL.UEM.TOTL.ZS",
                name: "Unemployment total",
                unit: "% of total labor force"
              },
              {
                indicatorCode: "NE.TRD.GNFS.ZS",
                name: "Trade",
                unit: "% of GDP"
              },
              {
                indicatorCode: "SP.POP.TOTL",
                name: "Population total",
                unit: "people"
              }
            ]
          })
        })
      );
      setSync({ loading: false, error: null, data });
      setLastAction(`World Bank synced ${data.totalSeries ?? 1} series`);
      if (shouldRefresh) await refreshVault();
      return true;
    } catch (error) {
      setSync({ loading: false, error: error instanceof Error ? error.message : "World Bank sync failed", data: null });
      return false;
    }
  }

  async function syncFred(options: SyncOptions = {}) {
    const shouldRefresh = options.refresh ?? true;
    setFredSync({ loading: true, error: null, data: null });
    try {
      const data = await readJson<{
        ok: boolean;
        totalSeries: number;
        totalObservations: number;
        synced: Array<{ seriesCode: string; observations: number }>;
        failed?: Array<{ fredSeriesId: string; error: string }>;
      }>(
        await fetch("/api/sync/fred", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({})
        })
      );
      setFredSync({ loading: false, error: null, data });
      setLastAction(`FRED synced ${data.totalSeries} series`);
      if (shouldRefresh) await refreshVault();
      return true;
    } catch (error) {
      setFredSync({ loading: false, error: error instanceof Error ? error.message : "FRED sync failed", data: null });
      return false;
    }
  }

  async function syncEia(options: SyncOptions = {}) {
    const shouldRefresh = options.refresh ?? true;
    setEiaSync({ loading: true, error: null, data: null });
    try {
      const data = await readJson<{
        ok: boolean;
        totalSeries: number;
        totalObservations: number;
        synced: Array<{ seriesCode: string; observations: number }>;
        failed?: Array<{ eiaSeriesId: string; error: string }>;
      }>(
        await fetch("/api/sync/eia", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({})
        })
      );
      setEiaSync({ loading: false, error: null, data });
      setLastAction(`EIA synced ${data.totalSeries} energy series`);
      if (shouldRefresh) await refreshVault();
      return true;
    } catch (error) {
      setEiaSync({ loading: false, error: error instanceof Error ? error.message : "EIA sync failed", data: null });
      return false;
    }
  }

  async function syncGdelt(options: SyncOptions = {}) {
    const shouldRefresh = options.refresh ?? true;
    setGdeltSync({ loading: true, error: null, data: null });
    try {
      const data = await readJson<{
        ok: boolean;
        totalEvents: number;
        storedEvents: number;
        failed?: Array<{ theme: string; error: string }>;
      }>(
        await fetch("/api/sync/gdelt", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({})
        })
      );
      setGdeltSync({ loading: false, error: null, data });
      setLastAction(`GDELT stored ${data.storedEvents} news events`);
      if (shouldRefresh) {
        await loadMacroEvents();
        await loadSyncRuns();
      }
      return true;
    } catch (error) {
      setGdeltSync({ loading: false, error: error instanceof Error ? error.message : "GDELT sync failed", data: null });
      return false;
    }
  }

  async function syncReliefWeb(options: SyncOptions = {}) {
    const shouldRefresh = options.refresh ?? true;
    setReliefWebSync({ loading: true, error: null, data: null });
    try {
      const data = await readJson<{
        ok: boolean;
        totalEvents: number;
        storedEvents: number;
        failed?: Array<{ theme: string; error: string }>;
      }>(
        await fetch("/api/sync/reliefweb", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({})
        })
      );
      setReliefWebSync({ loading: false, error: null, data });
      setLastAction(`ReliefWeb stored ${data.storedEvents} stress events`);
      if (shouldRefresh) {
        await loadMacroEvents();
        await loadSyncRuns();
      }
      return true;
    } catch (error) {
      setReliefWebSync({ loading: false, error: error instanceof Error ? error.message : "ReliefWeb sync failed", data: null });
      return false;
    }
  }

  async function syncUsgs(options: SyncOptions = {}) {
    const shouldRefresh = options.refresh ?? true;
    setUsgsSync({ loading: true, error: null, data: null });
    try {
      const data = await readJson<{
        ok: boolean;
        totalEvents: number;
        storedEvents: number;
      }>(
        await fetch("/api/sync/usgs", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({})
        })
      );
      setUsgsSync({ loading: false, error: null, data });
      setLastAction(`USGS stored ${data.storedEvents} earthquake events`);
      if (shouldRefresh) {
        await loadMacroEvents();
        await loadSyncRuns();
      }
      return true;
    } catch (error) {
      setUsgsSync({ loading: false, error: error instanceof Error ? error.message : "USGS sync failed", data: null });
      return false;
    }
  }

  async function syncTreasury(options: SyncOptions = {}) {
    const shouldRefresh = options.refresh ?? true;
    setTreasurySync({ loading: true, error: null, data: null });
    try {
      const data = await readJson<{
        ok: boolean;
        totalSeries: number;
        totalObservations: number;
        synced: Array<{ seriesCode: string; observations: number }>;
      }>(
        await fetch("/api/sync/treasury", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({})
        })
      );
      setTreasurySync({ loading: false, error: null, data });
      setLastAction(`Treasury synced ${data.totalSeries} fiscal series`);
      if (shouldRefresh) {
        await refreshVault();
        await loadSyncRuns();
      }
      return true;
    } catch (error) {
      setTreasurySync({ loading: false, error: error instanceof Error ? error.message : "Treasury sync failed", data: null });
      return false;
    }
  }

  async function syncEurostat(options: SyncOptions = {}) {
    const shouldRefresh = options.refresh ?? true;
    setEurostatSync({ loading: true, error: null, data: null });
    try {
      const data = await readJson<{
        ok: boolean;
        totalSeries: number;
        totalObservations: number;
        synced: Array<{ seriesCode: string; observations: number }>;
      }>(
        await fetch("/api/sync/eurostat", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({})
        })
      );
      setEurostatSync({ loading: false, error: null, data });
      setLastAction(`Eurostat synced ${data.totalSeries} EU macro series`);
      if (shouldRefresh) {
        await refreshVault();
        await loadSyncRuns();
      }
      return true;
    } catch (error) {
      setEurostatSync({ loading: false, error: error instanceof Error ? error.message : "Eurostat sync failed", data: null });
      return false;
    }
  }

  async function syncCftc(options: SyncOptions = {}) {
    const shouldRefresh = options.refresh ?? true;
    setCftcSync({ loading: true, error: null, data: null });
    try {
      const data = await readJson<{
        ok: boolean;
        totalMarkets: number;
        totalSeries: number;
        totalObservations: number;
        synced: Array<{ seriesCode: string; observations: number }>;
        failed?: Array<{ market: string; metric: string; error: string }>;
      }>(
        await fetch("/api/sync/cftc", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({})
        })
      );
      setCftcSync({ loading: false, error: null, data });
      setLastAction(`CFTC synced ${data.totalSeries} positioning series`);
      if (shouldRefresh) await refreshVault();
      return true;
    } catch (error) {
      setCftcSync({ loading: false, error: error instanceof Error ? error.message : "CFTC sync failed", data: null });
      return false;
    }
  }

  async function syncFx(options: SyncOptions = {}) {
    const shouldRefresh = options.refresh ?? true;
    setFxSync({ loading: true, error: null, data: null });
    try {
      const data = await readJson<{
        ok: boolean;
        totalSeries: number;
        totalObservations: number;
        synced: Array<{ seriesCode: string; observations: number }>;
      }>(
        await fetch("/api/sync/fx", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({})
        })
      );
      setFxSync({ loading: false, error: null, data });
      setLastAction(`FX synced ${data.totalSeries} pairs`);
      if (shouldRefresh) await refreshVault();
      return true;
    } catch (error) {
      setFxSync({ loading: false, error: error instanceof Error ? error.message : "FX sync failed", data: null });
      return false;
    }
  }

  async function syncFearGreed(options: SyncOptions = {}) {
    const shouldRefresh = options.refresh ?? true;
    setFearGreedSync({ loading: true, error: null, data: null });
    try {
      const data = await readJson<{ ok: boolean; seriesCode: string; observations: number }>(
        await fetch("/api/sync/fear-greed", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ limit: 0 })
        })
      );
      setFearGreedSync({ loading: false, error: null, data });
      setLastAction(`${data.seriesCode} synced`);
      if (shouldRefresh) await refreshVault();
      return true;
    } catch (error) {
      setFearGreedSync({
        loading: false,
        error: error instanceof Error ? error.message : "Fear & Greed sync failed",
        data: null
      });
      return false;
    }
  }

  async function syncEconomicCalendar(options: SyncOptions = {}) {
    const shouldRefresh = options.refresh ?? true;
    setCalendarSync({ loading: true, error: null, data: null });
    try {
      const data = await readJson<EconomicCalendarSyncResponse>(
        await fetch("/api/sync/economic-calendar", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            provider: "fmp",
            limit: 60
          })
        })
      );
      setCalendarSync({ loading: false, error: null, data });
      setLastAction(`Economic calendar stored ${data.storedEvents} events`);
      if (shouldRefresh) {
        await loadMacroEvents();
        await loadSyncRuns();
      }
      return true;
    } catch (error) {
      setCalendarSync({
        loading: false,
        error: error instanceof Error ? error.message : "Economic calendar sync failed",
        data: null
      });
      return false;
    }
  }

  async function generateRegime(options: SyncOptions = {}) {
    const shouldRefresh = options.refresh ?? true;
    setRegime({ loading: true, error: null, data: null });
    try {
      const data = await readJson<RegimeResult>(
        await fetch("/api/regime", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({})
        })
      );
      setRegime({ loading: false, error: null, data });
      setLastAction("Market regime synced");
      if (shouldRefresh) await refreshVault();
      return true;
    } catch (error) {
      setRegime({ loading: false, error: error instanceof Error ? error.message : "Regime generation failed", data: null });
      return false;
    }
  }

  async function runCorePipeline() {
    const completed: string[] = [];
    const failed: string[] = [];
    const steps: Array<{ label: string; run: () => Promise<boolean> }> = [
      { label: "World Bank macro", run: () => syncWorldBank({ refresh: false }) },
      { label: "FRED liquidity", run: () => syncFred({ refresh: false }) },
      { label: "FX rates", run: () => syncFx({ refresh: false }) },
      { label: "Fear & Greed", run: () => syncFearGreed({ refresh: false }) },
      { label: "Market regime", run: () => generateRegime({ refresh: false }) }
    ];

    setCoreSync({ loading: true, error: null, data: null });

    for (const step of steps) {
      setLastAction(`Pipeline: ${step.label}`);
      const ok = await step.run();
      if (ok) {
        completed.push(step.label);
      } else {
        failed.push(step.label);
      }
    }

    await refreshVault();
    await loadSyncRuns();

    setCoreSync({
      loading: false,
      error: failed.length ? `${failed.length} pipeline step${failed.length === 1 ? "" : "s"} need attention` : null,
      data: { completed, failed }
    });
    setLastAction(failed.length ? `Pipeline completed with ${failed.length} issue${failed.length === 1 ? "" : "s"}` : "Core pipeline complete");
  }

  async function runSyncAction(action: SyncAction) {
    if (action === "worldbank") {
      await syncWorldBank();
      return;
    }

    if (action === "fred") {
      await syncFred();
      return;
    }

    if (action === "eia") {
      await syncEia();
      return;
    }

    if (action === "gdelt") {
      await syncGdelt();
      return;
    }

    if (action === "reliefweb") {
      await syncReliefWeb();
      return;
    }

    if (action === "usgs") {
      await syncUsgs();
      return;
    }

    if (action === "treasury") {
      await syncTreasury();
      return;
    }

    if (action === "eurostat") {
      await syncEurostat();
      return;
    }

    if (action === "cftc") {
      await syncCftc();
      return;
    }

    if (action === "fx") {
      await syncFx();
      return;
    }

    if (action === "fearGreed") {
      await syncFearGreed();
      return;
    }

    if (action === "regime") {
      await generateRegime();
      return;
    }

    if (action === "calendar") {
      await syncEconomicCalendar();
      return;
    }

    await checkHealth();
  }

  const envOk = health.data ? Object.values(health.data.env).filter(Boolean).length : summary.data?.health.envOk ?? 0;
  const envTotal = health.data ? Object.values(health.data.env).length : summary.data?.health.envTotal ?? 0;
  const syncHealth = summary.data?.health.syncHealth ?? (envTotal ? Math.round((envOk / envTotal) * 100) : 0);
  const signalCards = summary.data?.cards ?? [];
  const seriesList = series.data?.series ?? [];
  const syncRunRows = syncRuns.data?.runs ?? [];
  const documentRows = knowledgeDocs.data?.documents ?? [];
  const candidateRows = intelCandidates.data?.candidates ?? [];
  const eventRows = macroEvents.data?.events ?? [];
  const todayIso = new Date().toISOString().slice(0, 10);
  const nextSevenIso = addIsoDays(todayIso, 7);
  const nextThirtyIso = addIsoDays(todayIso, 30);
  const majorCalendarCountries = new Set(["US", "EMU", "GB", "DE", "FR", "IT", "JP", "CN", "CA", "AU", "WLD"]);
  const calendarEventRows = eventRows
    .filter(isEconomicCalendarEvent)
    .sort((a, b) => a.event_date.localeCompare(b.event_date) || a.title.localeCompare(b.title));
  const narrativeEventRows = eventRows
    .filter((event) => !isEconomicCalendarEvent(event))
    .sort((a, b) => b.event_date.localeCompare(a.event_date) || a.title.localeCompare(b.title));
  const upcomingCalendarRows = calendarEventRows.filter((event) => event.event_date >= todayIso && event.event_date <= nextSevenIso);
  const highImpactCalendarRows = calendarEventRows.filter((event) => Number(event.impact_score ?? 0) >= 60);
  const calendarWindowRows = calendarEventRows.filter((event) => {
    if (calendarWindow === "today") return event.event_date === todayIso;
    if (calendarWindow === "week") return event.event_date >= todayIso && event.event_date <= nextSevenIso;
    if (calendarWindow === "thirty") return event.event_date >= todayIso && event.event_date <= nextThirtyIso;
    return true;
  });
  const windowLabel = calendarWindows.find((window) => window.id === calendarWindow)?.label ?? "Next 30 Days";
  const allMacroCriticalRows = calendarEventRows.filter(isMacroCriticalRelease);
  const windowMacroCriticalRows = calendarWindowRows.filter(isMacroCriticalRelease);
  const visibleCalendarRows = (macroCriticalOnly ? windowMacroCriticalRows : calendarWindowRows).sort(
    (a, b) => a.event_date.localeCompare(b.event_date) || Number(b.impact_score ?? 0) - Number(a.impact_score ?? 0)
  );
  const nextCriticalReleaseRows = calendarEventRows
    .filter((event) => event.event_date >= todayIso && isMacroCriticalRelease(event))
    .sort((a, b) => a.event_date.localeCompare(b.event_date) || Number(b.impact_score ?? 0) - Number(a.impact_score ?? 0))
    .slice(0, 10);
  const prepSourceRows = (
    nextCriticalReleaseRows.length
      ? nextCriticalReleaseRows
      : visibleCalendarRows.filter(
          (event) => isMacroCriticalRelease(event) || Number(event.impact_score ?? 0) >= 45 || majorCalendarCountries.has(event.country_code ?? "")
        )
  ).slice(0, 10);
  const prepBoardScope = nextCriticalReleaseRows.length ? "Next 10 macro-critical releases" : `${windowLabel} focus releases`;
  const macroCriticalPrepRows = windowMacroCriticalRows.map((event) => ({
    event,
    prep: buildEventPrep(event)
  }));
  const prepCards = prepSourceRows.map((event) => ({
    event,
    prep: buildEventPrep(event)
  }));
  const criticalInflationCount = macroCriticalPrepRows.filter((card) =>
    ["CPI", "Core CPI", "Inflation"].includes(card.prep.eventType)
  ).length;
  const criticalGrowthCount = macroCriticalPrepRows.filter((card) =>
    ["GDP", "Retail Sales", "PMI", "Growth", "Activity"].includes(card.prep.eventType)
  ).length;
  const criticalLaborCount = macroCriticalPrepRows.filter((card) =>
    ["NFP", "Unemployment", "Labor"].includes(card.prep.eventType)
  ).length;
  const criticalPolicyCount = macroCriticalPrepRows.filter((card) =>
    ["Central Bank", "Rates"].includes(card.prep.eventType)
  ).length;
  const riskBalanceRows = buildRiskBalanceRows(macroCriticalPrepRows, prepCards);
  const assetReactionRows = buildAssetReactionRows(prepCards);
  const surpriseTrackerRows = macroCriticalPrepRows
    .filter((card) => card.prep.surprise)
    .sort((a, b) => b.event.event_date.localeCompare(a.event.event_date) || a.event.title.localeCompare(b.event.title))
    .slice(0, 6);
  const windowReleaseRows = visibleCalendarRows
    .map((event) => {
      const prep = buildEventPrep(event);
      return {
        event,
        prep,
        interpretation: buildReleaseInterpretation(event, prep)
      };
    })
    .filter((row): row is { event: MacroEvent; prep: EventPrep; interpretation: ReleaseInterpretation } =>
      Boolean(row.interpretation)
    );
  const recentReleaseRows = calendarEventRows
    .map((event) => {
      const prep = buildEventPrep(event);
      return {
        event,
        prep,
        interpretation: buildReleaseInterpretation(event, prep)
      };
    })
    .filter((row): row is { event: MacroEvent; prep: EventPrep; interpretation: ReleaseInterpretation } =>
      Boolean(row.interpretation)
    )
    .sort((a, b) => b.event.event_date.localeCompare(a.event.event_date) || a.event.title.localeCompare(b.event.title));
  const releaseDeskRows = (windowReleaseRows.length ? windowReleaseRows : recentReleaseRows).slice(0, 6);
  const releaseDeskScope = windowReleaseRows.length ? windowLabel : "Latest realized";
  const latestSync = summary.data?.latestSynced ?? null;
  const dbStatus = summary.data || series.data ? "SUPABASE_OK" : health.error ? "CHECK_FAILED" : "PENDING";
  const authStatus = localDevAuth ? "LOCAL_DEV" : vaultKey ? "SYSTEM_KEY" : "MISSING_KEY";
  const rawAlertMessage =
    summary.error ||
    series.error ||
    regime.error ||
    sync.error ||
    fredSync.error ||
    eiaSync.error ||
    gdeltSync.error ||
    reliefWebSync.error ||
    usgsSync.error ||
    treasurySync.error ||
    eurostatSync.error ||
    cftcSync.error ||
    fxSync.error ||
    fearGreedSync.error ||
    calendarSync.error ||
    coreSync.error ||
    syncRuns.error ||
    knowledgeDocs.error ||
    knowledgeSave.error ||
    intelCandidates.error ||
    intelExtract.error ||
    macroEvents.error ||
    (activeView === "health" || activeView === "deploy" ? health.error : null);
  const alertMessage = localDevAuth && (summary.data || series.data) && rawAlertMessage === "Unauthorized" ? null : rawAlertMessage;
  const pipelineBusy =
    coreSync.loading ||
    sync.loading ||
    fredSync.loading ||
    eiaSync.loading ||
    gdeltSync.loading ||
    reliefWebSync.loading ||
    usgsSync.loading ||
    treasurySync.loading ||
    eurostatSync.loading ||
    cftcSync.loading ||
    fxSync.loading ||
    fearGreedSync.loading ||
    calendarSync.loading ||
    regime.loading;
  const extractionDisabledReason = !vaultKey
    ? "Save the Vault API key first."
    : intelExtract.loading
      ? "Extraction is already running."
      : extractForm.mode === "web" && extractForm.query.trim().length < 10
        ? "Add a search brief."
        : extractForm.mode === "document" && !extractForm.documentId
          ? "Select a document."
          : null;
  const detailObservations =
    selectedSeries && observations.data?.series.id === selectedSeries.id ? observations.data.observations : [];
  const latestObservation = detailObservations[0] ?? null;
  const previousObservation = detailObservations[1] ?? null;
  const detailChange =
    latestObservation && previousObservation ? Number(latestObservation.value) - Number(previousObservation.value) : null;
  const detailChangePct =
    detailChange !== null && previousObservation && Number(previousObservation.value) !== 0
      ? (detailChange / Math.abs(Number(previousObservation.value))) * 100
      : null;
  const detailMetadata = selectedSeries?.metadata ? JSON.stringify(selectedSeries.metadata, null, 2) : "{}";
  const latestEndpoint = selectedSeries ? buildSeriesEndpoint("latest") : "";
  const observationsEndpoint = selectedSeries ? buildSeriesEndpoint("observations") : "";
  const apiSampleSeries = selectedSeries ??
    seriesList.find((item) => item.series_code === "WB_US_NY_GDP_MKTP_CD") ??
    seriesList[0] ?? {
      series_code: "WB_US_NY_GDP_MKTP_CD",
      provider: "world_bank",
      country_code: "US",
      name: "US GDP current US$"
    };
  const apiEndpoints = {
    contract: `${appOrigin}/api/vault/contract`,
    series: `${appOrigin}/api/vault/series`,
    seriesSearch: `${appOrigin}/api/vault/series?q=inflation&limit=25`,
    latest: buildEndpointForSeries(apiSampleSeries, "latest"),
    observations: buildEndpointForSeries(apiSampleSeries, "observations"),
    regime: `${appOrigin}/api/vault/regime`,
    syncRuns: `${appOrigin}/api/vault/sync-runs?limit=40`,
    events: `${appOrigin}/api/vault/events?limit=100`,
    knowledge: `${appOrigin}/api/knowledge/documents?limit=25`,
    candidates: `${appOrigin}/api/intelligence/candidates?limit=40`
  };
  const connectorStatuses = health.data?.connectors ?? {};
  const requiredEnvReady = health.data ? Object.values(health.data.env).every(Boolean) : false;
  const coreConnectorKeys = [
    "supabase",
    "worldBank",
    "eurostat",
    "frankfurter",
    "alternativeMe",
    "cftc",
    "fred",
    "fmp",
    "gemini",
    "treasury",
    "usgs"
  ];
  const coreConnectorsReady = health.data
    ? coreConnectorKeys.every((key) => {
        const connector = connectorStatuses[key];
        return connector?.ok || connector?.status === "warning";
      })
    : false;
  const optionalConnectorRows = [
    {
      label: "EIA physical energy",
      key: "eia",
      detail: connectorStatuses.eia?.detail ?? "Add EIA_API_KEY when ready."
    },
    {
      label: "ReliefWeb humanitarian stress",
      key: "reliefweb",
      detail: connectorStatuses.reliefweb?.detail ?? "Provider approval or anti-bot clearance pending."
    },
    {
      label: "GDELT news stress",
      key: "gdelt",
      detail: connectorStatuses.gdelt?.detail ?? "Often rate-limits or times out during probes."
    }
  ];
  const deploymentChecks = [
    {
      label: "Required server env",
      ready: requiredEnvReady,
      warning: false,
      detail: health.data ? `${envOk}/${envTotal} configured` : "Run health check."
    },
    {
      label: "Core upstream connectors",
      ready: coreConnectorsReady,
      warning: health.data ? coreConnectorKeys.some((key) => connectorStatuses[key]?.status === "warning") : false,
      detail: health.data ? `${coreConnectorKeys.length} core probes checked` : "Run health check."
    },
    {
      label: "Vault data loaded",
      ready: Boolean(summary.data && series.data),
      warning: false,
      detail: summary.data
        ? `${summary.data.totals.series.toLocaleString()} series / ${summary.data.totals.observations.toLocaleString()} observations`
        : "Refresh vault."
    },
    {
      label: "Sync log visibility",
      ready: Boolean(syncRuns.data && !syncRuns.data.setupRequired),
      warning: Boolean(syncRuns.data?.schemaCacheStale || syncRuns.data?.fallback),
      detail: syncRuns.data?.setupRequired
        ? "Run supabase/sync_runs.sql."
        : syncRuns.data?.schemaCacheStale
          ? "Reload Supabase REST schema cache."
          : syncRuns.data
            ? `${syncRuns.data.runs.length} recent runs visible`
            : "Refresh Sync Logs."
    },
    {
      label: "Intelligence tables",
      ready: Boolean(knowledgeDocs.data && !knowledgeDocs.data.setupRequired),
      warning: Boolean(knowledgeDocs.data?.schemaCacheStale),
      detail: knowledgeDocs.data?.setupRequired
        ? "Run supabase/intelligence.sql."
        : knowledgeDocs.data?.schemaCacheStale
          ? "Reload Supabase REST schema cache."
          : knowledgeDocs.data
            ? `${documentRows.length} knowledge documents visible`
            : "Open Knowledge Base once."
    }
  ];
  const deployGateReady = deploymentChecks.every((check) => check.ready);
  const vercelEnvVars = [
    "VAULT_API_KEY",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "GEMINI_API_KEY",
    "FRED_API_KEY",
    "FMP_API_KEY",
    "GEMINI_MODEL",
    "GEMINI_INTELLIGENCE_MODEL",
    "EIA_API_KEY",
    "RELIEFWEB_APP_NAME",
    "APIFY_TOKEN"
  ];
  const curlExample = `curl -H "Authorization: Bearer $VAULT_API_KEY" \\\n  "${apiEndpoints.latest}"`;
  const fetchExample = `const response = await fetch("${apiEndpoints.latest}", {\n  headers: {\n    Authorization: "Bearer " + process.env.VAULT_API_KEY\n  }\n});\nconst data = await response.json();`;

  return (
    <div className="terminal-shell">
      <aside className="command-rail">
        <div className="brand-lockup">
          <span className="prompt-mark">&gt;_</span>
          <span>MACRO_VAULT_v3</span>
        </div>

        <nav className="nav-stack" aria-label="Vault sections">
          {navItems.map(([label, target, icon]) => (
            <a
              key={target}
              className={`nav-item ${activeView === target || (activeView === "detail" && target === "series") ? "active" : ""}`}
              href={`#${target}`}
              aria-current={activeView === target || (activeView === "detail" && target === "series") ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                switchView(target);
              }}
            >
              <span className="nav-icon" aria-hidden="true">
                {icon}
              </span>
              <span>{label}</span>
            </a>
          ))}
        </nav>

        <div className="access-panel">
          {localDevAuth ? (
            <>
              <span className="micro-label">Vault API Key</span>
              <div className="local-auth-card">
                <strong>Local dev auth</strong>
                <span>Enabled for localhost only</span>
              </div>
            </>
          ) : (
            <>
              <label className="micro-label" htmlFor="vault-key">
                Vault API Key
              </label>
              <input
                id="vault-key"
                className="terminal-input"
                type="password"
                value={vaultKey}
                onChange={(event) => setVaultKey(event.target.value)}
                placeholder="Paste VAULT_API_KEY"
              />
              <button className="ghost-button full" onClick={saveKey}>
                Save Session Key
              </button>
            </>
          )}
        </div>

        <div className="rail-status">
          <div>DB_CONNECTION: {dbStatus}</div>
          <div>AUTH: {authStatus}</div>
          <div>LAST_ACTION: {lastAction}</div>
        </div>
      </aside>

      <div className="workspace">
        <header className="telemetry-bar" id="dashboard">
          <div className="metric">
            <span>Total Series</span>
            <strong>{summary.data?.totals.series ?? series.data?.count ?? "--"}</strong>
          </div>
          <div className="metric">
            <span>Observations</span>
            <strong>{summary.data ? formatCompact(summary.data.totals.observations) : "--"}</strong>
          </div>
          <div className="metric">
            <span>Sync Health</span>
            <strong className={syncHealth === 100 ? "ok-text" : syncHealth ? "warn-text" : ""}>
              {syncHealth ? `${syncHealth}.0% ${syncHealth === 100 ? "[OK]" : "[WARNING]"}` : "UNKNOWN"}
            </strong>
          </div>
          <div className="metric">
            <span>Uptime</span>
            <strong>{formatUptime(now - mountedAt)}</strong>
          </div>
          <button className="icon-button" onClick={refreshVault} disabled={!vaultKey || summary.loading} title="Refresh vault">
            ↻
          </button>
        </header>

        <main className={`mission view-${activeView}`}>
          {alertMessage && <section className="alert-strip">{alertMessage}</section>}

          {activeView === "dashboard" && (
            <>
              <section className="mission-hero">
                <div>
                  <h1>Mission Control</h1>
                  <p>High-level overview of your private macroeconomic vault.</p>
                </div>

                <div className="mission-actions">
                  <button className="outline-button" onClick={copyApiContract}>
                    Copy API Contract
                  </button>
                  <button className="primary-button" onClick={() => generateRegime()} disabled={regime.loading || !vaultKey}>
                    {regime.loading ? "Syncing Regime" : "Sync Market Regime"}
                  </button>
                  <div className="timestamp-card">
                    <span>Last synced:</span>
                    <strong>{formatDateTime(latestSync)}</strong>
                  </div>
                </div>
              </section>

              <section className="signal-grid" aria-label="Vault signal previews">
                {signalCards.map((card) => {
                  const trend = getTrendClass(card.change);
                  return (
                    <button
                      type="button"
                      key={card.series.id}
                      className={`signal-card ${selectedSeries?.id === card.series.id ? "active" : ""}`}
                      onClick={() => openSeriesDetail(card.series)}
                    >
                      <div className="card-topline">
                        <span>{card.series.provider}</span>
                        <strong>{card.latest ? formatCompact(Number(card.latest.value)) : "--"}</strong>
                      </div>
                      <div className="card-title">{card.series.name ?? card.series.series_code}</div>
                      <div className="card-code">{card.series.series_code}</div>
                      <div className={`card-delta ${trend}`}>{formatDelta(card.change)}</div>
                      <Sparkline points={card.points} trend={trend} />
                    </button>
                  );
                })}

                {!signalCards.length && (
                  <div className="empty-console">
                    <strong>No dashboard signals loaded</strong>
                    <span>Save the vault key, then refresh the vault.</span>
                  </div>
                )}
              </section>
            </>
          )}

          {activeView === "sync" && (
            <>
              <section className="page-head">
                <div>
                  <h1>Sync Engine</h1>
                  <p>
                    Manage manual data ingestion across integrations. Staged modules mirror the original vault roadmap;
                    available modules are wired to the v3 backend.
                  </p>
                </div>
                <button className="primary-button" onClick={runCorePipeline} disabled={pipelineBusy || !vaultKey}>
                  {coreSync.loading ? "Running Pipeline" : "Run Core Pipeline"}
                </button>
              </section>

              <section className="sync-module-grid" aria-label="Sync modules">
                {syncModules.map((module) => {
                  const busy =
                    coreSync.loading ||
                    (module.action === "worldbank" && sync.loading) ||
                    (module.action === "fred" && fredSync.loading) ||
                    (module.action === "eia" && eiaSync.loading) ||
                    (module.action === "gdelt" && gdeltSync.loading) ||
                    (module.action === "reliefweb" && reliefWebSync.loading) ||
                    (module.action === "usgs" && usgsSync.loading) ||
                    (module.action === "treasury" && treasurySync.loading) ||
                    (module.action === "eurostat" && eurostatSync.loading) ||
                    (module.action === "cftc" && cftcSync.loading) ||
                    (module.action === "fx" && fxSync.loading) ||
                    (module.action === "fearGreed" && fearGreedSync.loading) ||
                    (module.action === "calendar" && calendarSync.loading) ||
                    (module.action === "regime" && regime.loading) ||
                    (module.action === "health" && health.loading);
                  return (
                    <article key={`${module.tag}-${module.title}`} className={`sync-module ${module.tone}`}>
                      <span className="module-tag">{module.tag}</span>
                      <h2>{module.title}</h2>
                      <p>{module.description}</p>
                      <button
                        className={`module-button ${module.tone}`}
                        onClick={() => module.action && runSyncAction(module.action)}
                        disabled={!module.action || !vaultKey || busy}
                      >
                        &gt; {busy ? "Running" : module.action ? module.actionLabel : `${module.actionLabel} (Staged)`}
                      </button>
                    </article>
                  );
                })}
              </section>
              {coreSync.data && (
                <section className="console-panel">
                  <span className="micro-label">Core Pipeline</span>
                  <h2>Pipeline run complete</h2>
                  <p className="muted-line">
                    {coreSync.data.completed.length} steps completed
                    {coreSync.data.failed.length ? `; ${coreSync.data.failed.length} need attention.` : "."}
                  </p>
                  {!!coreSync.data.failed.length && <p className="error-text">Failed steps: {coreSync.data.failed.join(", ")}</p>}
                </section>
              )}
              {fredSync.data && (
                <section className="console-panel">
                  <span className="micro-label">Federal Reserve</span>
                  <h2>FRED sync complete</h2>
                  <p className="muted-line">
                    {fredSync.data.totalSeries} series and {fredSync.data.totalObservations.toLocaleString()} observations
                    upserted.
                  </p>
                  {!!fredSync.data.failed?.length && (
                    <>
                      <p className="error-text">{fredSync.data.failed.length} FRED series failed after retries.</p>
                      <ul className="error-list">
                        {fredSync.data.failed.map((item) => (
                          <li key={item.fredSeriesId}>
                            <strong>{item.fredSeriesId}</strong>: {item.error}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>
              )}
              {eiaSync.data && (
                <section className="console-panel">
                  <span className="micro-label">EIA Energy</span>
                  <h2>Energy sync complete</h2>
                  <p className="muted-line">
                    {eiaSync.data.totalSeries} series and {eiaSync.data.totalObservations.toLocaleString()} observations
                    upserted.
                  </p>
                  {!!eiaSync.data.failed?.length && (
                    <>
                      <p className="error-text">{eiaSync.data.failed.length} EIA series failed after retries.</p>
                      <ul className="error-list">
                        {eiaSync.data.failed.map((item) => (
                          <li key={item.eiaSeriesId}>
                            <strong>{item.eiaSeriesId}</strong>: {item.error}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>
              )}
              {gdeltSync.data && (
                <section className="console-panel">
                  <span className="micro-label">GDELT News</span>
                  <h2>News stress scan complete</h2>
                  <p className="muted-line">
                    {gdeltSync.data.storedEvents.toLocaleString()} new events stored from {gdeltSync.data.totalEvents.toLocaleString()} candidates.
                  </p>
                  {!!gdeltSync.data.failed?.length && (
                    <p className="error-text">{gdeltSync.data.failed.length} GDELT themes failed. Check sync logs for details.</p>
                  )}
                </section>
              )}
              {reliefWebSync.data && (
                <section className="console-panel">
                  <span className="micro-label">ReliefWeb</span>
                  <h2>Humanitarian stress scan complete</h2>
                  <p className="muted-line">
                    {reliefWebSync.data.storedEvents.toLocaleString()} new events stored from{" "}
                    {reliefWebSync.data.totalEvents.toLocaleString()} candidates.
                  </p>
                  {!!reliefWebSync.data.failed?.length && (
                    <p className="error-text">{reliefWebSync.data.failed.length} ReliefWeb themes failed. Check sync logs for details.</p>
                  )}
                </section>
              )}
              {usgsSync.data && (
                <section className="console-panel">
                  <span className="micro-label">USGS</span>
                  <h2>Earthquake telemetry sync complete</h2>
                  <p className="muted-line">
                    {usgsSync.data.storedEvents.toLocaleString()} new earthquake events stored from{" "}
                    {usgsSync.data.totalEvents.toLocaleString()} candidates.
                  </p>
                </section>
              )}
              {treasurySync.data && (
                <section className="console-panel">
                  <span className="micro-label">U.S. Treasury</span>
                  <h2>Fiscal liquidity sync complete</h2>
                  <p className="muted-line">
                    {treasurySync.data.totalSeries} series and {treasurySync.data.totalObservations.toLocaleString()} observations upserted.
                  </p>
                </section>
              )}
              {eurostatSync.data && (
                <section className="console-panel">
                  <span className="micro-label">Eurostat</span>
                  <h2>EU macro sync complete</h2>
                  <p className="muted-line">
                    {eurostatSync.data.totalSeries} series and {eurostatSync.data.totalObservations.toLocaleString()} observations upserted.
                  </p>
                </section>
              )}
              {cftcSync.data && (
                <section className="console-panel">
                  <span className="micro-label">CFTC COT</span>
                  <h2>Positioning sync complete</h2>
                  <p className="muted-line">
                    {cftcSync.data.totalSeries} series and {cftcSync.data.totalObservations.toLocaleString()} positioning
                    observations upserted across {cftcSync.data.totalMarkets} markets.
                  </p>
                  {!!cftcSync.data.failed?.length && (
                    <p className="error-text">{cftcSync.data.failed.length} CFTC metrics failed. Check sync logs for details.</p>
                  )}
                </section>
              )}
              {fxSync.data && (
                <section className="console-panel">
                  <span className="micro-label">Frankfurter ECB</span>
                  <h2>FX sync complete</h2>
                  <p className="muted-line">
                    {fxSync.data.totalSeries} currency pairs and {fxSync.data.totalObservations.toLocaleString()} observations
                    upserted.
                  </p>
                </section>
              )}
              {sync.data && (
                <section className="console-panel">
                  <span className="micro-label">World Bank</span>
                  <h2>Macro bundle sync complete</h2>
                  <p className="muted-line">
                    {sync.data.totalSeries ?? 1} series and {(sync.data.totalObservations ?? sync.data.observations).toLocaleString()} observations
                    upserted.
                  </p>
                  {!!sync.data.failed?.length && (
                    <p className="error-text">{sync.data.failed.length} World Bank series failed. Check route response for details.</p>
                  )}
                </section>
              )}
              {fearGreedSync.data && (
                <section className="console-panel">
                  <span className="micro-label">Alternative.me</span>
                  <h2>Fear & Greed sync complete</h2>
                  <p className="muted-line">
                    {fearGreedSync.data.observations.toLocaleString()} sentiment observations upserted.
                  </p>
                </section>
              )}
              {calendarSync.data && (
                <section className="console-panel">
                  <span className="micro-label">Economic Calendar</span>
                  <h2>Calendar sync complete</h2>
                  <p className="muted-line">
                    {calendarSync.data.storedEvents.toLocaleString()} events stored from {calendarSync.data.provider.toUpperCase()} for{" "}
                    {calendarSync.data.from} to {calendarSync.data.to}.
                  </p>
                  {calendarSync.data.fallback && (
                    <p className="muted-line">Using the FMP demo key. Add FMP_API_KEY for stable production usage.</p>
                  )}
                </section>
              )}
            </>
          )}

          {activeView === "knowledge" && (
            <>
              <section className="page-head">
                <div>
                  <h1>Knowledge Base</h1>
                  <p>Store user-approved reports, minutes, notes, and article excerpts as source material for later extraction.</p>
                </div>
                <button className="ghost-button" onClick={loadKnowledgeDocuments} disabled={knowledgeDocs.loading || !vaultKey}>
                  {knowledgeDocs.loading ? "Loading" : "Refresh Documents"}
                </button>
              </section>

              {knowledgeDocs.data?.setupRequired ? (
                <section className="console-panel">
                  <span className="micro-label">Database Setup</span>
                  <h2>{knowledgeDocs.data.schemaCacheStale ? "Supabase schema cache needs refresh" : "Knowledge tables are not installed yet"}</h2>
                  <p className="muted-line">
                    {knowledgeDocs.data.message ?? (
                      <>
                        Run <code>supabase/intelligence.sql</code> in Supabase SQL Editor, then refresh this page.
                      </>
                    )}
                  </p>
                </section>
              ) : (
                <section className="console-grid">
                  <div className="console-panel">
                    <div className="panel-header">
                      <div>
                        <span className="micro-label">Intake</span>
                        <h2>Add source material</h2>
                      </div>
                      {knowledgeSave.loading && <span className="loading-pill">Saving</span>}
                    </div>

                    <div className="form-grid">
                      <label className="field-stack" htmlFor="knowledge-title">
                        <span>Title</span>
                        <input
                          id="knowledge-title"
                          className="terminal-input"
                          value={knowledgeForm.title}
                          onChange={(event) => setKnowledgeForm((current) => ({ ...current, title: event.target.value }))}
                          placeholder="FOMC minutes, broker note, article excerpt"
                        />
                      </label>
                      <label className="field-stack" htmlFor="knowledge-source-url">
                        <span>Source URL</span>
                        <input
                          id="knowledge-source-url"
                          className="terminal-input"
                          value={knowledgeForm.sourceUrl}
                          onChange={(event) => setKnowledgeForm((current) => ({ ...current, sourceUrl: event.target.value }))}
                          placeholder="https://..."
                        />
                      </label>
                      <label className="field-stack" htmlFor="knowledge-source-tier">
                        <span>Source tier</span>
                        <select
                          id="knowledge-source-tier"
                          className="terminal-input"
                          value={knowledgeForm.sourceTier}
                          onChange={(event) =>
                            setKnowledgeForm((current) => ({
                              ...current,
                              sourceTier: event.target.value as KnowledgeForm["sourceTier"]
                            }))
                          }
                        >
                          <option value="user_supplied">User supplied</option>
                          <option value="public_web">Public web</option>
                          <option value="licensed">Licensed</option>
                          <option value="internal">Internal</option>
                          <option value="unknown">Unknown</option>
                        </select>
                      </label>
                      <label className="field-stack" htmlFor="knowledge-tags">
                        <span>Tags</span>
                        <input
                          id="knowledge-tags"
                          className="terminal-input"
                          value={knowledgeForm.tags}
                          onChange={(event) => setKnowledgeForm((current) => ({ ...current, tags: event.target.value }))}
                          placeholder="fomc, inflation, rates"
                        />
                      </label>
                      <label className="field-stack wide" htmlFor="knowledge-content">
                        <span>Text</span>
                        <textarea
                          id="knowledge-content"
                          className="terminal-textarea"
                          value={knowledgeForm.contentText}
                          onChange={(event) => setKnowledgeForm((current) => ({ ...current, contentText: event.target.value }))}
                          placeholder="Paste source text or your own notes here."
                        />
                      </label>
                    </div>

                    <button
                      className="primary-button"
                      onClick={saveKnowledgeDocument}
                      disabled={!vaultKey || knowledgeSave.loading || knowledgeForm.title.length < 2 || knowledgeForm.contentText.length < 20}
                    >
                      {knowledgeSave.loading ? "Saving Document" : "Save Document"}
                    </button>
                  </div>

                  <div className="console-panel">
                    <div className="panel-header">
                      <div>
                        <span className="micro-label">Sources</span>
                        <h2>{documentRows.length ? `${documentRows.length} recent documents` : "No documents yet"}</h2>
                      </div>
                    </div>

                    <div className="stacked-list">
                      {documentRows.map((document) => (
                        <article key={document.id} className="review-card">
                          <div className="review-meta">
                            <span>{document.source_tier}</span>
                            <span>{formatDateTime(document.created_at)}</span>
                          </div>
                          <h3>{document.title}</h3>
                          <p>{document.summary ?? "No summary stored."}</p>
                          {!!document.tags.length && <div className="tag-row">{document.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
                          {document.source_url && (
                            <a href={document.source_url} target="_blank" rel="noreferrer" className="source-link">
                              {document.source_url}
                            </a>
                          )}
                        </article>
                      ))}
                      {!documentRows.length && (
                        <div className="empty-console">
                          <strong>No source material stored</strong>
                          <span>Add a document after installing the intelligence tables.</span>
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              )}
            </>
          )}

          {activeView === "intel" && (
            <>
              <section className="page-head">
                <div>
                  <h1>Web Intelligence</h1>
                  <p>Create reviewable candidate signals from grounded web search or saved knowledge documents.</p>
                </div>
                <button className="ghost-button" onClick={loadIntelligenceCandidates} disabled={intelCandidates.loading || !vaultKey}>
                  {intelCandidates.loading ? "Loading" : "Refresh Queue"}
                </button>
              </section>

              {intelCandidates.data?.setupRequired || knowledgeDocs.data?.setupRequired ? (
                <section className="console-panel">
                  <span className="micro-label">Database Setup</span>
                  <h2>
                    {intelCandidates.data?.schemaCacheStale || knowledgeDocs.data?.schemaCacheStale
                      ? "Supabase schema cache needs refresh"
                      : "Intelligence tables are not installed yet"}
                  </h2>
                  <p className="muted-line">
                    {intelCandidates.data?.message ?? knowledgeDocs.data?.message ?? (
                      <>
                        Run <code>supabase/intelligence.sql</code> in Supabase SQL Editor, then refresh this page.
                      </>
                    )}
                  </p>
                </section>
              ) : (
                <>
                  <section className="console-grid">
                    <div className="console-panel">
                      <div className="panel-header">
                        <div>
                          <span className="micro-label">Extraction</span>
                          <h2>Generate candidates</h2>
                        </div>
                        {intelExtract.loading && <span className="loading-pill">Running</span>}
                      </div>

                      <div className="form-grid">
                        <label className="field-stack" htmlFor="extract-mode">
                          <span>Mode</span>
                          <select
                            id="extract-mode"
                            className="terminal-input"
                            value={extractForm.mode}
                            onChange={(event) =>
                              setExtractForm((current) => ({ ...current, mode: event.target.value as ExtractForm["mode"] }))
                            }
                          >
                            <option value="web">Grounded web</option>
                            <option value="document">Saved document</option>
                          </select>
                        </label>
                        <label className="field-stack" htmlFor="extract-document">
                          <span>Document</span>
                          <select
                            id="extract-document"
                            className="terminal-input"
                            value={extractForm.documentId}
                            onChange={(event) => setExtractForm((current) => ({ ...current, documentId: event.target.value }))}
                            disabled={extractForm.mode !== "document"}
                          >
                            <option value="">Select document</option>
                            {documentRows.map((document) => (
                              <option key={document.id} value={document.id}>
                                {document.title}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field-stack wide" htmlFor="extract-query">
                          <span>Search brief</span>
                          <textarea
                            id="extract-query"
                            className="terminal-textarea short"
                            value={extractForm.query}
                            onChange={(event) => setExtractForm((current) => ({ ...current, query: event.target.value }))}
                            placeholder="Find recent public evidence for shipping stress, credit tightening, layoffs, supply disruption..."
                            disabled={extractForm.mode !== "web"}
                          />
                        </label>
                        <label className="field-stack" htmlFor="extract-provider">
                          <span>Provider</span>
                          <input
                            id="extract-provider"
                            className="terminal-input"
                            value={extractForm.provider}
                            onChange={(event) => setExtractForm((current) => ({ ...current, provider: event.target.value }))}
                          />
                        </label>
                        <label className="field-stack" htmlFor="extract-series-code">
                          <span>Series code</span>
                          <input
                            id="extract-series-code"
                            className="terminal-input"
                            value={extractForm.seriesCode}
                            onChange={(event) => setExtractForm((current) => ({ ...current, seriesCode: event.target.value }))}
                            placeholder="WEB_SUPPLY_STRESS"
                          />
                        </label>
                        <label className="field-stack" htmlFor="extract-country">
                          <span>Country</span>
                          <input
                            id="extract-country"
                            className="terminal-input"
                            value={extractForm.countryCode}
                            onChange={(event) => setExtractForm((current) => ({ ...current, countryCode: event.target.value.toUpperCase() }))}
                            maxLength={3}
                          />
                        </label>
                        <label className="field-stack" htmlFor="extract-unit">
                          <span>Unit</span>
                          <input
                            id="extract-unit"
                            className="terminal-input"
                            value={extractForm.unit}
                            onChange={(event) => setExtractForm((current) => ({ ...current, unit: event.target.value }))}
                            placeholder="index, %, count"
                          />
                        </label>
                      </div>

                      <button
                        className="primary-button"
                        onClick={runIntelligenceExtraction}
                        disabled={Boolean(extractionDisabledReason)}
                      >
                        {intelExtract.loading ? "Extracting" : "Generate Candidates"}
                      </button>
                      {extractionDisabledReason && <p className="muted-line">{extractionDisabledReason}</p>}
                    </div>

                    <div className="console-panel">
                      <div className="panel-header">
                        <div>
                          <span className="micro-label">Last Extraction</span>
                          <h2>{intelExtract.data ? `${intelExtract.data.count} candidates` : "No extraction in session"}</h2>
                        </div>
                        {intelExtract.data?.model && <span className="loading-pill">{intelExtract.data.model}</span>}
                      </div>
                      <div className="stacked-list compact">
                        {(intelExtract.data?.sources ?? []).map((source, index) => (
                          <div key={`${source.url ?? source.title}-${index}`} className="source-pill">
                            <span>{source.title ?? "Grounded source"}</span>
                            {source.url && (
                              <a href={source.url} target="_blank" rel="noreferrer">
                                {source.url}
                              </a>
                            )}
                          </div>
                        ))}
                        {!intelExtract.data?.sources?.length && (
                          <p className="muted-line">Sources will appear here after grounded extraction.</p>
                        )}
                      </div>
                    </div>
                  </section>

                  <section className="console-panel">
                    <div className="panel-header">
                      <div>
                        <span className="micro-label">Review Queue</span>
                        <h2>{candidateRows.length ? `${candidateRows.length} intelligence candidates` : "No candidates yet"}</h2>
                      </div>
                    </div>

                    <div className="stacked-list candidates">
                      {candidateRows.map((candidate) => {
                        const busy = candidateAction === candidate.id;
                        const canPromote =
                          candidate.signal_type !== "numeric_observation" ||
                          (Boolean(candidate.provider && candidate.series_code && candidate.date) &&
                            candidate.value !== null &&
                            candidate.value !== undefined);

                        return (
                          <article key={candidate.id} className="review-card candidate-card">
                            <div className="review-meta">
                              <span className={`status-chip ${candidate.status}`}>{candidate.status}</span>
                              <span>{candidate.signal_type}</span>
                              <span>{formatDateTime(candidate.created_at)}</span>
                            </div>
                            <h3>{candidate.title}</h3>
                            <p>{candidate.narrative ?? "No narrative extracted."}</p>
                            <dl className="metadata-list mini">
                              <div>
                                <dt>Series</dt>
                                <dd>{candidate.series_code ?? "-"}</dd>
                              </div>
                              <div>
                                <dt>Date</dt>
                                <dd>{candidate.date ?? "-"}</dd>
                              </div>
                              <div>
                                <dt>Value</dt>
                                <dd>{candidate.value ?? "-"}</dd>
                              </div>
                              <div>
                                <dt>Confidence</dt>
                                <dd>{candidate.confidence ?? "-"}</dd>
                              </div>
                            </dl>
                            {candidate.source_url && (
                              <a href={candidate.source_url} target="_blank" rel="noreferrer" className="source-link">
                                {candidate.source_title ?? candidate.source_url}
                              </a>
                            )}
                            <div className="review-actions">
                              <button
                                className="table-action"
                                onClick={() => updateCandidateStatus(candidate.id, "approved")}
                                disabled={busy || candidate.status === "promoted"}
                              >
                                Approve
                              </button>
                              <button
                                className="table-action"
                                onClick={() => promoteCandidate(candidate.id)}
                                disabled={busy || candidate.status === "promoted" || !canPromote}
                              >
                                {candidate.signal_type === "numeric_observation" ? "Promote" : "Promote Event"}
                              </button>
                              <button
                                className="table-action danger"
                                onClick={() => updateCandidateStatus(candidate.id, "rejected")}
                                disabled={busy || candidate.status === "promoted"}
                              >
                                Reject
                              </button>
                            </div>
                          </article>
                        );
                      })}
                      {!candidateRows.length && (
                        <div className="empty-console">
                          <strong>No candidate signals</strong>
                          <span>Run a grounded extraction or extract from a saved document.</span>
                        </div>
                      )}
                    </div>
                  </section>
                </>
              )}
            </>
          )}

          {activeView === "events" && (
            <>
              <section className="page-head">
                <div>
                  <h1>Macro Events</h1>
                  <p>Surface event signal density first; keep raw calendar releases available without letting them dominate the vault.</p>
                </div>
                <div className="page-actions">
                  <button className="primary-button" onClick={() => syncEconomicCalendar()} disabled={calendarSync.loading || !vaultKey}>
                    {calendarSync.loading ? "Syncing Calendar" : "Sync Calendar"}
                  </button>
                  <button className="ghost-button" onClick={loadMacroEvents} disabled={macroEvents.loading || !vaultKey || calendarSync.loading}>
                    {macroEvents.loading ? "Loading" : "Refresh Events"}
                  </button>
                </div>
              </section>

              {macroEvents.data?.schemaCacheStale && (
                <section className="console-panel">
                  <span className="micro-label">Database Setup</span>
                  <h2>Supabase schema cache needs refresh</h2>
                  <p className="muted-line">
                    Run <code>notify pgrst, 'reload schema';</code> in Supabase SQL Editor, then refresh this view.
                  </p>
                </section>
              )}

              {macroEvents.data?.fallback && (
                <section className="console-panel">
                  <span className="micro-label">Storage Mode</span>
                  <h2>Fallback event store</h2>
                  <p className="muted-line">
                    Events are available through the fallback store until Supabase REST sees the permanent macro_events table.
                  </p>
                </section>
              )}

              {calendarSync.data && (
                <section className="console-panel calendar-sync-result">
                  <div>
                    <span className="micro-label">Calendar Sync</span>
                    <h2>FMP calendar refreshed</h2>
                  </div>
                  <p className="muted-line">
                    {calendarSync.data.storedEvents.toLocaleString()} events stored for {calendarSync.data.from} to {calendarSync.data.to}.
                  </p>
                  {calendarSync.data.fallback && (
                    <p className="muted-line">Using FMP demo access. Add FMP_API_KEY for stable production usage.</p>
                  )}
                </section>
              )}

              <section className="event-summary-grid" aria-label="Macro event summary">
                <div className="event-metric">
                  <span>Narrative Signals</span>
                  <strong>{narrativeEventRows.length}</strong>
                  <small>Promoted web and knowledge events</small>
                </div>
                <div className="event-metric">
                  <span>Calendar Rows</span>
                  <strong>{calendarEventRows.length}</strong>
                  <small>Structured scheduled releases</small>
                </div>
                <div className="event-metric">
                  <span>Next Critical</span>
                  <strong>{nextCriticalReleaseRows.length}</strong>
                  <small>Upcoming macro-critical focus list</small>
                </div>
                <div className="event-metric">
                  <span>High Impact</span>
                  <strong>{highImpactCalendarRows.length}</strong>
                  <small>Impact score 60 or higher</small>
                </div>
              </section>

              <section className="event-filter-bar" aria-label="Macro event filters">
                <div>
                  <span className="micro-label">Calendar Window</span>
                  <div className="segmented-control">
                    {calendarWindows.map((window) => (
                      <button
                        key={window.id}
                        className={calendarWindow === window.id ? "active" : ""}
                        onClick={() => setCalendarWindow(window.id)}
                        type="button"
                      >
                        {window.label}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  className={`toggle-button ${macroCriticalOnly ? "active" : ""}`}
                  onClick={() => setMacroCriticalOnly((current) => !current)}
                  type="button"
                >
                  {macroCriticalOnly ? "Macro-critical only" : "All calendar rows"}
                </button>
                <div className="filter-readout">
                  <span>{windowLabel}</span>
                  <strong>{visibleCalendarRows.length}</strong>
                  <small>
                    {macroCriticalOnly
                      ? `${windowMacroCriticalRows.length} of ${allMacroCriticalRows.length} macro-critical releases`
                      : `${calendarWindowRows.length} releases in window`}
                  </small>
                </div>
              </section>

              <section className="console-panel">
                <div className="panel-header">
                  <div>
                    <span className="micro-label">Regime Scorecards</span>
                    <h2>{windowLabel} pressure map</h2>
                  </div>
                  <span className="status-chip ok">{windowMacroCriticalRows.length} macro-critical</span>
                </div>
                <div className="scorecard-grid">
                  <div className="scorecard-card">
                    <span>Inflation Pressure</span>
                    <strong>{criticalInflationCount}</strong>
                    <small>CPI, core CPI, and price-sensitive releases</small>
                  </div>
                  <div className="scorecard-card">
                    <span>Growth Pulse</span>
                    <strong>{criticalGrowthCount}</strong>
                    <small>GDP, retail sales, PMIs, and activity data</small>
                  </div>
                  <div className="scorecard-card">
                    <span>Labor Shock</span>
                    <strong>{criticalLaborCount}</strong>
                    <small>NFP, unemployment, payrolls, and wage data</small>
                  </div>
                  <div className="scorecard-card">
                    <span>Policy Risk</span>
                    <strong>{criticalPolicyCount}</strong>
                    <small>Central bank decisions and rate-sensitive events</small>
                  </div>
                </div>
              </section>

              <section className="console-panel">
                <div className="panel-header">
                  <div>
                    <span className="micro-label">Post-Release Desk</span>
                    <h2>{releaseDeskRows.length ? `${releaseDeskScope} interpretations` : "No realized releases yet"}</h2>
                  </div>
                  <span className="loading-pill">Actual vs forecast</span>
                </div>

                <div className="release-desk-list">
                  {releaseDeskRows.map(({ event, prep, interpretation }) => {
                    const saving = eventNoteSaving === event.id;

                    return (
                      <article key={event.id} className="release-card">
                        <div className="review-meta">
                          <span>{event.event_date}</span>
                          <span>{event.country_code ?? "WLD"}</span>
                          <span>{prep.eventType}</span>
                        </div>
                        <div className="prep-card-head">
                          <h3>{event.title}</h3>
                          <span className={`surprise-chip ${prep.surpriseTone}`}>{interpretation.signal}</span>
                        </div>
                        <dl className="release-stats">
                          <div>
                            <dt>Actual</dt>
                            <dd>{interpretation.actual}</dd>
                          </div>
                          <div>
                            <dt>Forecast</dt>
                            <dd>{interpretation.forecast}</dd>
                          </div>
                          <div>
                            <dt>Previous</dt>
                            <dd>{interpretation.previous ?? "-"}</dd>
                          </div>
                          <div>
                            <dt>Surprise</dt>
                            <dd>{prep.surprise ?? "In line"}</dd>
                          </div>
                        </dl>
                        <div className="release-read-grid">
                          <div>
                            <span>Regime interpretation</span>
                            <p>{interpretation.regimeRead}</p>
                          </div>
                          <div>
                            <span>Asset reaction watch</span>
                            <p>{interpretation.assetRead}</p>
                          </div>
                        </div>
                        <div className="note-actions">
                          <button
                            className="table-action"
                            onClick={() => savePrepNotes(event, prep, { post_release_read: interpretation.suggestedRead })}
                            disabled={saving}
                          >
                            {saving ? "Saving" : "Save Interpretation"}
                          </button>
                          <span>{buildEditablePrepNotes(event, prep).post_release_read ? "Post-release note exists" : "Generated read ready"}</span>
                        </div>
                      </article>
                    );
                  })}
                  {!releaseDeskRows.length && (
                    <div className="empty-console">
                      <strong>No actual-versus-forecast releases</strong>
                      <span>Run the calendar sync after releases print, or switch to All Stored for historical realized events.</span>
                    </div>
                  )}
                </div>
              </section>

              <section className="console-panel">
                <div className="panel-header">
                  <div>
                    <span className="micro-label">Macro Prep Board</span>
                    <h2>{prepBoardScope}</h2>
                  </div>
                  <span className="status-chip ok">{prepCards.length} tracked</span>
                </div>
                <div className="prep-list">
                  {prepCards.map(({ event, prep }) => {
                    const notesDraft = eventNotesDrafts[event.id] ?? buildEditablePrepNotes(event, prep);
                    const savedAt = buildEditablePrepNotes(event, prep).updated_at;
                    const saving = eventNoteSaving === event.id;

                    return (
                      <article key={event.id} className="prep-card">
                        <div className="review-meta">
                          <span className={prep.critical ? "critical-badge" : ""}>
                            {prep.critical ? "macro-critical" : "watch"}
                          </span>
                          <span>{event.event_date}</span>
                          <span>{event.country_code ?? "WLD"}</span>
                          <span>{prep.eventType}</span>
                        </div>
                        <div className="prep-card-head">
                          <h3>{event.title}</h3>
                          <span className={`surprise-chip ${prep.surpriseTone}`}>
                            {prep.surprise ?? "pre-release"}
                          </span>
                        </div>
                        <div className="prep-grid prep-note-fields">
                          {(
                            [
                              ["market_expectation", "Market expects", "Consensus, whisper, positioning, or baseline setup."],
                              ["upside_surprise", "Upside surprise", "What would make this meaningfully hotter or stronger?"],
                              ["downside_surprise", "Downside surprise", "What would make this meaningfully cooler or weaker?"],
                              ["likely_assets", "Likely assets", "Rates, FX, equities, commodities, credit, or specific proxies."],
                              ["trade_plan", "Prep / trade plan", "What to watch before the release and what would change your view."],
                              ["post_release_read", "Post-release read", "Write the after-action interpretation once actuals arrive."]
                            ] as const
                          ).map(([field, label, placeholder]) => (
                            <label key={field} className={field === "trade_plan" || field === "post_release_read" ? "wide" : ""}>
                              <span>{label}</span>
                              <textarea
                                className="terminal-textarea prep-note-textarea"
                                value={notesDraft[field]}
                                onChange={(changeEvent) => updatePrepNoteDraft(event.id, field, changeEvent.target.value)}
                                placeholder={placeholder}
                                rows={field === "trade_plan" || field === "post_release_read" ? 3 : 2}
                              />
                            </label>
                          ))}
                          <div className="wide asymmetry-note">
                            <span>Asymmetry detection</span>
                            <p>{prep.asymmetry}</p>
                          </div>
                        </div>
                        <div className="note-actions">
                          <button className="table-action" onClick={() => savePrepNotes(event, prep)} disabled={saving}>
                            {saving ? "Saving" : "Save Prep Note"}
                          </button>
                          <span>{savedAt ? `Saved ${formatDateTime(savedAt)}` : "Not saved yet"}</span>
                        </div>
                      </article>
                    );
                  })}
                  {!prepCards.length && (
                    <div className="empty-console">
                      <strong>No macro-critical releases found</strong>
                      <span>Run the economic calendar sync or expand the stored date range.</span>
                    </div>
                  )}
                </div>
              </section>

              <section className="event-intelligence-grid">
                <div className="console-panel">
                  <div className="panel-header">
                    <div>
                      <span className="micro-label">Theme Risk Balance</span>
                      <h2>What the calendar is testing</h2>
                    </div>
                    <span className="status-chip ok">
                      {riskBalanceRows.filter((row) => row.nearTermCount > 0).length} active
                    </span>
                  </div>

                  <div className="risk-list">
                    {riskBalanceRows.map((row) => (
                      <div key={row.label} className={`risk-row ${row.tone}`}>
                        <div>
                          <span>{row.label}</span>
                          <strong>{row.status}</strong>
                          <small>{row.description}</small>
                        </div>
                        <div className="risk-count">
                          <strong>{row.nearTermCount}</strong>
                          <span>queued</span>
                        </div>
                        <p>{row.detail}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="console-panel">
                  <div className="panel-header">
                    <div>
                      <span className="micro-label">Asset Reaction Map</span>
                      <h2>Likely pressure points</h2>
                    </div>
                    <span className="status-chip ok">{assetReactionRows.length} assets</span>
                  </div>

                  <div className="asset-map">
                    {assetReactionRows.map((row) => (
                      <div key={row.asset} className="asset-row">
                        <div>
                          <strong>{row.asset}</strong>
                          <span>{row.themes}</span>
                        </div>
                        <meter value={row.count} max={Math.max(1, assetReactionRows[0]?.count ?? 1)} />
                        <b>{row.count}</b>
                      </div>
                    ))}
                    {!assetReactionRows.length && <p className="muted-line">No asset reaction map until macro-critical events load.</p>}
                  </div>
                </div>

                <div className="console-panel wide-panel">
                  <div className="panel-header">
                    <div>
                      <span className="micro-label">Surprise Tracker</span>
                      <h2>{surpriseTrackerRows.length ? "Realized macro surprises" : "No realized surprises yet"}</h2>
                    </div>
                    <span className="loading-pill">Actual vs forecast</span>
                  </div>

                  <div className="surprise-list">
                    {surpriseTrackerRows.map(({ event, prep }) => (
                      <div key={event.id} className="surprise-row">
                        <span className={`surprise-chip ${prep.surpriseTone}`}>{describeSurpriseSignal(event, prep)}</span>
                        <div>
                          <strong>{event.title}</strong>
                          <small>
                            {event.event_date} · {event.country_code ?? "WLD"} · {prep.eventType}
                          </small>
                        </div>
                        <span>{prep.surprise}</span>
                      </div>
                    ))}
                    {!surpriseTrackerRows.length && (
                      <p className="muted-line">
                        Surprise rows will appear after synced calendar releases include both actual and forecast values.
                      </p>
                    )}
                  </div>
                </div>
              </section>

              <section className="console-panel">
                <div className="panel-header">
                  <div>
                    <span className="micro-label">Narrative Signals</span>
                    <h2>{narrativeEventRows.length ? `${narrativeEventRows.length} promoted events` : "No narrative signals yet"}</h2>
                  </div>
                  <span className="status-chip ok">Curated</span>
                </div>

                <div className="stacked-list candidates">
                  {narrativeEventRows.map((event) => (
                    <article key={event.id} className="review-card candidate-card">
                      <div className="review-meta">
                        <span>{event.category ?? "macro_event"}</span>
                        <span>{event.event_date}</span>
                        <span>{event.country_code ?? "WLD"}</span>
                      </div>
                      <h3>{event.title}</h3>
                      <p>{event.narrative}</p>
                      <dl className="metadata-list mini">
                        <div>
                          <dt>Impact</dt>
                          <dd>{event.impact_score ?? "-"}</dd>
                        </div>
                        <div>
                          <dt>Confidence</dt>
                          <dd>{event.confidence ?? "-"}</dd>
                        </div>
                        <div>
                          <dt>Source</dt>
                          <dd>{event.source_title ?? event.source_tier}</dd>
                        </div>
                        <div>
                          <dt>Stored</dt>
                          <dd>{formatDateTime(event.created_at)}</dd>
                        </div>
                      </dl>
                      {event.source_url && (
                        <a href={event.source_url} target="_blank" rel="noreferrer" className="source-link">
                          {event.source_url}
                        </a>
                      )}
                    </article>
                  ))}
                  {!narrativeEventRows.length && (
                    <div className="empty-console">
                      <strong>No promoted narrative events</strong>
                      <span>Promote Web Intelligence candidates when they represent durable macro signals.</span>
                    </div>
                  )}
                </div>
              </section>

              <section className="console-panel">
                <div className="panel-header">
                  <div>
                    <span className="micro-label">Economic Calendar</span>
                    <h2>{visibleCalendarRows.length} filtered releases</h2>
                  </div>
                  <span className="loading-pill">{macroCriticalOnly ? "Critical" : "Expanded"}</span>
                </div>
                <p className="muted-line">
                  Showing {macroCriticalOnly ? "macro-critical releases" : "all stored calendar rows"} for {windowLabel.toLowerCase()}.
                  Change the window above when you want today-only prep or broader historical context.
                </p>

                <div className="table-frame calendar-frame">
                  <table className="terminal-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Country</th>
                        <th>Theme</th>
                        <th>Flag</th>
                        <th>Impact</th>
                        <th>Surprise</th>
                        <th>Event</th>
                        <th>Actual</th>
                        <th>Forecast</th>
                        <th>Previous</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleCalendarRows.map((event) => {
                        const prep = buildEventPrep(event);
                        return (
                          <tr key={event.id}>
                            <td className="nowrap">{event.event_date}</td>
                            <td>{event.country_code ?? "WLD"}</td>
                            <td>{classifyCalendarTheme(event)}</td>
                            <td>{prep.critical ? "Critical" : "Watch"}</td>
                            <td className="number">{event.impact_score ?? "-"}</td>
                            <td className="nowrap">{prep.surprise ?? "-"}</td>
                            <td>{event.title}</td>
                            <td className="nowrap">{eventMetadataText(event, "actual") ?? "-"}</td>
                            <td className="nowrap">{eventMetadataText(event, "forecast") ?? "-"}</td>
                            <td className="nowrap">{eventMetadataText(event, "previous") ?? "-"}</td>
                          </tr>
                        );
                      })}
                      {!visibleCalendarRows.length && (
                        <tr>
                          <td colSpan={10} className="muted-cell">
                            No calendar rows match the selected window and criticality filter.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}

          {activeView === "logs" && (
            <>
              <section className="page-head">
                <div>
                  <h1>Sync Logs</h1>
                  <p>Inspect recent connector runs, written observations, partial failures, and retry-worthy errors.</p>
                </div>
                <button className="primary-button" onClick={loadSyncRuns} disabled={syncRuns.loading || !vaultKey}>
                  {syncRuns.loading ? "Loading Logs" : "Refresh Logs"}
                </button>
              </section>

              {syncRuns.data?.setupRequired ? (
                <section className="console-panel">
                  <span className="micro-label">Database Setup</span>
                  <h2>{syncRuns.data.schemaCacheStale ? "Supabase schema cache needs refresh" : "Sync log table is not installed yet"}</h2>
                  <p className="muted-line">
                    {syncRuns.data.schemaCacheStale ? (
                      <>
                        Run <code>notify pgrst, 'reload schema';</code> in Supabase SQL Editor, then click Refresh Logs.
                      </>
                    ) : (
                      <>
                        Run <code>supabase/sync_runs.sql</code> in Supabase SQL Editor. Connectors already ignore missing logs, so
                        syncs can keep running while this is pending.
                      </>
                    )}
                  </p>
                </section>
              ) : (
                <section className="console-panel">
                  <div className="panel-header">
                    <div>
                      <span className="micro-label">Recent Runs</span>
                      <h2>{syncRunRows.length ? `${syncRunRows.length} sync runs` : "No sync runs recorded"}</h2>
                    </div>
                    <span className="loading-pill">{syncRuns.loading ? "Loading" : "Latest"}</span>
                  </div>

                  {syncRuns.data?.fallback && (
                    <p className="muted-line">
                      {syncRuns.data.message ?? "Using fallback sync logs until the permanent sync_runs table is visible."}
                    </p>
                  )}

                  {syncRunRows.length ? (
                    <div className="table-frame">
                      <table className="terminal-table">
                        <thead>
                          <tr>
                            <th>Started</th>
                            <th>Connector</th>
                            <th>Action</th>
                            <th>Status</th>
                            <th>Series</th>
                            <th>Observations</th>
                            <th>Duration</th>
                            <th>Error</th>
                          </tr>
                        </thead>
                        <tbody>
                          {syncRunRows.map((run) => (
                            <tr key={run.id}>
                              <td className="nowrap">{formatDateTime(run.started_at)}</td>
                              <td>{run.connector}</td>
                              <td>{run.action}</td>
                              <td>
                                <span className={`status-chip ${run.status}`}>{run.status}</span>
                              </td>
                              <td className="number">{run.total_series}</td>
                              <td className="number">{run.total_observations.toLocaleString()}</td>
                              <td className="nowrap">{formatDurationMs(run.duration_ms)}</td>
                              <td className={run.error ? "error-text" : "muted-cell"}>{run.error ?? "--"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="empty-console">
                      <strong>No logs yet</strong>
                      <span>Run the core pipeline after creating the sync_runs table.</span>
                    </div>
                  )}
                </section>
              )}
            </>
          )}

          {activeView === "series" && (
            <>
              <section className="page-head">
                <div>
                  <h1>Series Explorer</h1>
                  <p>Browse stored metadata and inspect the latest observations for each vault series.</p>
                </div>
                <button className="ghost-button" onClick={refreshVault} disabled={!vaultKey || series.loading}>
                  {series.loading ? "Loading" : "Refresh Series"}
                </button>
              </section>

              <section className="console-grid">
                <div className="console-panel">
                  <div className="panel-header">
                    <div>
                      <span className="micro-label">Series Explorer</span>
                      <h2>Stored metadata</h2>
                    </div>
                  </div>

                  <div className="table-frame">
                    <table className="terminal-table">
                      <thead>
                        <tr>
                          <th>Code</th>
                          <th>Name</th>
                          <th>Provider</th>
                          <th>Country</th>
                          <th>Last Synced</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {seriesList.map((item) => (
                          <tr key={item.id} className={selectedSeries?.id === item.id ? "selected" : ""}>
                            <td>{item.series_code}</td>
                            <td>{item.name ?? "-"}</td>
                            <td>{item.provider}</td>
                            <td>{item.country_code ?? "-"}</td>
                            <td className="nowrap">{formatDateTime(item.last_synced)}</td>
                            <td>
                              <button
                                className="table-action"
                                onClick={() => openSeriesDetail(item)}
                                disabled={observations.loading || !vaultKey}
                              >
                                Open
                              </button>
                            </td>
                          </tr>
                        ))}
                        {!seriesList.length && (
                          <tr>
                            <td colSpan={6} className="muted-cell">
                              No series loaded yet.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="console-panel">
                  <div className="panel-header">
                    <div>
                      <span className="micro-label">Observations</span>
                      <h2>{selectedSeries ? selectedSeries.series_code : "Select a series"}</h2>
                    </div>
                    {observations.loading && <span className="loading-pill">Loading</span>}
                  </div>

                  {observations.error && <p className="error-text">{observations.error}</p>}

                  <div className="table-frame compact">
                    <table className="terminal-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Value</th>
                          <th>Metadata</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(observations.data?.observations ?? []).map((item) => (
                          <tr key={item.id}>
                            <td className="nowrap">{item.date}</td>
                            <td className="number">{Number(item.value).toLocaleString()}</td>
                            <td>{item.metadata ? "Yes" : "-"}</td>
                          </tr>
                        ))}
                        {!observations.data?.observations?.length && (
                          <tr>
                            <td colSpan={3} className="muted-cell">
                              No observations loaded yet.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>
            </>
          )}

          {activeView === "detail" && (
            <>
              <section className="page-head detail-head">
                <div>
                  <h1>{selectedSeries?.name ?? selectedSeries?.series_code ?? "Series Detail"}</h1>
                  <p>
                    {selectedSeries
                      ? `${selectedSeries.series_code} · ${selectedSeries.provider} · ${selectedSeries.country_code ?? "N/A"}`
                      : "Open a series from the dashboard or Series Explorer to inspect it."}
                  </p>
                </div>
                <div className="mission-actions">
                  <button className="ghost-button" onClick={() => switchView("series")}>
                    Back To Series
                  </button>
                  <button className="outline-button" onClick={() => copySeriesEndpoint("latest")} disabled={!selectedSeries}>
                    Copy Latest API
                  </button>
                  <button
                    className="outline-button"
                    onClick={() => copySeriesEndpoint("observations")}
                    disabled={!selectedSeries}
                  >
                    Copy Observations API
                  </button>
                </div>
              </section>

              {selectedSeries ? (
                <section className="detail-grid">
                  <div className="console-panel detail-primary">
                    <div className="panel-header">
                      <div>
                        <span className="micro-label">Series Chart</span>
                        <h2>{selectedSeries.series_code}</h2>
                      </div>
                      {observations.loading && <span className="loading-pill">Loading</span>}
                    </div>

                    <div className="detail-stat-row">
                      <div className="detail-stat">
                        <span>Latest</span>
                        <strong>{latestObservation ? formatCompact(Number(latestObservation.value)) : "--"}</strong>
                        <small>{latestObservation?.date ?? "No observation"}</small>
                      </div>
                      <div className={`detail-stat ${getTrendClass(detailChange)}`}>
                        <span>Change</span>
                        <strong>{formatDelta(detailChange)}</strong>
                        <small>{detailChangePct === null ? "--" : `${detailChangePct.toFixed(2)}%`}</small>
                      </div>
                      <div className="detail-stat">
                        <span>Unit</span>
                        <strong>{selectedSeries.unit ?? "--"}</strong>
                        <small>{formatDateTime(selectedSeries.last_synced)}</small>
                      </div>
                    </div>

                    <DetailChart observations={detailObservations} />
                  </div>

                  <div className="console-panel detail-side">
                    <div className="panel-header">
                      <div>
                        <span className="micro-label">Metadata</span>
                        <h2>Source record</h2>
                      </div>
                    </div>
                    <dl className="metadata-list">
                      <div>
                        <dt>Provider</dt>
                        <dd>{selectedSeries.provider}</dd>
                      </div>
                      <div>
                        <dt>Country</dt>
                        <dd>{selectedSeries.country_code ?? "-"}</dd>
                      </div>
                      <div>
                        <dt>Series ID</dt>
                        <dd>{selectedSeries.id}</dd>
                      </div>
                    </dl>
                    <div className="endpoint-stack">
                      <div>
                        <span>Latest API</span>
                        <code>{latestEndpoint}</code>
                      </div>
                      <div>
                        <span>Observations API</span>
                        <code>{observationsEndpoint}</code>
                      </div>
                    </div>
                    <pre className="metadata-json">{detailMetadata}</pre>
                  </div>

                  <div className="console-panel detail-observations">
                    <div className="panel-header">
                      <div>
                        <span className="micro-label">Observations</span>
                        <h2>{detailObservations.length} loaded rows</h2>
                      </div>
                    </div>

                    {observations.error && <p className="error-text">{observations.error}</p>}

                    <div className="table-frame detail-table-frame">
                      <table className="terminal-table">
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Value</th>
                            <th>Metadata</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detailObservations.map((item) => (
                            <tr key={item.id}>
                              <td className="nowrap">{item.date}</td>
                              <td className="number">{Number(item.value).toLocaleString()}</td>
                              <td>{item.metadata ? JSON.stringify(item.metadata) : "-"}</td>
                            </tr>
                          ))}
                          {!detailObservations.length && (
                            <tr>
                              <td colSpan={3} className="muted-cell">
                                No observations loaded yet.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </section>
              ) : (
                <section className="empty-console">
                  <strong>No series selected</strong>
                  <span>Open a series from the dashboard or Series Explorer.</span>
                </section>
              )}
            </>
          )}

          {activeView === "regime" && (
            <>
              <section className="page-head">
                <div>
                  <h1>Synthesis Engine</h1>
                  <p>Generate a compact AI market regime from the latest macro vault snapshot.</p>
                </div>
                <button className="primary-button" onClick={() => generateRegime()} disabled={regime.loading || !vaultKey}>
                  {regime.loading ? "Generating" : "Generate Regime"}
                </button>
              </section>

              <section className="console-panel synthesis-panel">
                <div className="panel-header">
                  <div>
                    <span className="micro-label">Market Regime</span>
                    <h2>{regime.data?.regime.regime ?? "No live regime in session"}</h2>
                  </div>
                  {regime.data?.model && <span className="loading-pill">{regime.data.model}</span>}
                </div>
                <p className="regime-copy">
                  {regime.data?.regime.reasoning ??
                    "Run the synthesis engine to store a current risk appetite and regime observation in Supabase."}
                </p>
                <div className="regime-score">
                  <span>Risk appetite</span>
                  <strong>{regime.data?.regime.risk_appetite ?? "--"}</strong>
                </div>
              </section>
            </>
          )}

          {activeView === "health" && (
            <>
              <section className="page-head">
                <div>
                  <h1>API Health</h1>
                  <p>Inspect the runtime environment and required server-only configuration.</p>
                </div>
                <button className="ghost-button" onClick={checkHealth} disabled={health.loading || !vaultKey}>
                  {health.loading ? "Checking" : "Check Health"}
                </button>
              </section>

              <section className="console-panel">
                <div className="panel-header">
                  <div>
                    <span className="micro-label">Runtime environment</span>
                    <h2>Server variables</h2>
                  </div>
                  <span className={health.data?.ok ? "status-chip ok" : "status-chip"}>
                    {health.data?.ok ? "Ready" : "Unknown"}
                  </span>
                </div>
                <div className="env-grid">
                  {health.data ? (
                    Object.entries(health.data.env).map(([key, ok]) => (
                      <div key={key} className="env-item">
                        <span className={`status-dot ${ok ? "ok" : ""}`} />
                        <span>{key}</span>
                      </div>
                    ))
                  ) : (
                    <div className="env-item">Run health check to inspect required server variables.</div>
                  )}
                </div>
              </section>

              <section className="console-panel">
                <div className="panel-header">
                  <div>
                    <span className="micro-label">Connector reachability</span>
                    <h2>Live upstream probes</h2>
                  </div>
                  <span className={health.data?.connectors ? "status-chip ok" : "status-chip"}>
                    {health.data?.connectors ? "Checked" : "Waiting"}
                  </span>
                </div>
                <div className="env-grid">
                  {health.data?.connectors ? (
                    Object.entries(health.data.connectors).map(([key, connector]) => (
                      <div key={key} className="env-item connector-item">
                        <span
                          className={`status-dot ${
                            connector.status === "ok" ? "ok" : connector.status === "missing" || connector.status === "warning" ? "warning" : ""
                          }`}
                        />
                        <div>
                          <span>{key}</span>
                          <small>
                            {connector.detail}
                            {connector.latencyMs !== null ? ` / ${connector.latencyMs}ms` : ""}
                          </small>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="env-item">Run health check to probe Supabase and upstream APIs.</div>
                  )}
                </div>
              </section>
            </>
          )}

          {activeView === "api" && (
            <>
              <section className="page-head">
                <div>
                  <h1>API Access</h1>
                  <p>Use the vault as a private data service for other projects with one server-side bearer token.</p>
                </div>
                <button className="outline-button" onClick={copyApiContract}>
                  Copy Endpoint List
                </button>
              </section>

              <section className="api-grid">
                <div className="console-panel api-panel">
                  <div className="panel-header">
                    <div>
                      <span className="micro-label">Authentication</span>
                      <h2>Request header</h2>
                    </div>
                    <button
                      className="table-action"
                      onClick={() => copyText("Auth header", "Authorization: Bearer <VAULT_API_KEY>")}
                    >
                      Copy
                    </button>
                  </div>
                  <code className="code-block">Authorization: Bearer &lt;VAULT_API_KEY&gt;</code>
                  <p className="muted-line">
                    Keep the key server-side in downstream apps. Browser clients should call their own backend first.
                  </p>
                </div>

                <div className="console-panel api-panel">
                  <div className="panel-header">
                    <div>
                      <span className="micro-label">Sample series</span>
                      <h2>{apiSampleSeries.series_code}</h2>
                    </div>
                    <button className="table-action" onClick={() => switchView("series")}>
                      Browse
                    </button>
                  </div>
                  <dl className="metadata-list">
                    <div>
                      <dt>Name</dt>
                      <dd>{apiSampleSeries.name ?? apiSampleSeries.series_code}</dd>
                    </div>
                    <div>
                      <dt>Provider</dt>
                      <dd>{apiSampleSeries.provider}</dd>
                    </div>
                    <div>
                      <dt>Country</dt>
                      <dd>{apiSampleSeries.country_code ?? "-"}</dd>
                    </div>
                  </dl>
                </div>
              </section>

              <section className="endpoint-grid" aria-label="Vault API endpoints">
                {[
                  ["Series Index", "GET", apiEndpoints.series],
                  ["Vault Contract", "GET", apiEndpoints.contract],
                  ["Series Search", "GET", apiEndpoints.seriesSearch],
                  ["Latest Observation", "GET", apiEndpoints.latest],
                  ["Date Range History", "GET", apiEndpoints.observations],
                  ["Latest AI Regime", "GET", apiEndpoints.regime],
                  ["Sync Run Logs", "GET", apiEndpoints.syncRuns],
                  ["Macro Events", "GET", apiEndpoints.events],
                  ["Knowledge Documents", "GET", apiEndpoints.knowledge],
                  ["Intelligence Queue", "GET", apiEndpoints.candidates],
                  ["Submit Candidates", "POST", `${appOrigin}/api/intelligence/candidates`]
                ].map(([title, method, endpoint]) => (
                  <article key={title} className="endpoint-card">
                    <div>
                      <span className="method-pill">{method}</span>
                      <h2>{title}</h2>
                    </div>
                    <code>{endpoint}</code>
                    <button className="module-button green" onClick={() => copyText(title, endpoint)}>
                      &gt; Copy Endpoint
                    </button>
                  </article>
                ))}
              </section>

              <section className="api-examples">
                <div className="console-panel api-panel">
                  <div className="panel-header">
                    <div>
                      <span className="micro-label">Curl</span>
                      <h2>Terminal example</h2>
                    </div>
                    <button className="table-action" onClick={() => copyText("curl example", curlExample)}>
                      Copy
                    </button>
                  </div>
                  <pre className="code-block">{curlExample}</pre>
                </div>

                <div className="console-panel api-panel">
                  <div className="panel-header">
                    <div>
                      <span className="micro-label">JavaScript</span>
                      <h2>Server fetch example</h2>
                    </div>
                    <button className="table-action" onClick={() => copyText("fetch example", fetchExample)}>
                      Copy
                    </button>
                  </div>
                  <pre className="code-block">{fetchExample}</pre>
                </div>
              </section>
            </>
          )}

          {activeView === "deploy" && (
            <>
              <section className="page-head">
                <div>
                  <h1>Deployment</h1>
                  <p>Local development stays the working lane until the first Vercel smoke deploy gate is green.</p>
                </div>
                <div className="action-row">
                  <button className="ghost-button" onClick={checkHealth} disabled={health.loading || !vaultKey}>
                    {health.loading ? "Checking" : "Check Health"}
                  </button>
                  <button className="outline-button" onClick={refreshVault} disabled={summary.loading || !vaultKey}>
                    {summary.loading ? "Refreshing" : "Refresh Vault"}
                  </button>
                </div>
              </section>

              <section className="console-grid short">
                <div className="console-panel deploy-panel">
                  <span className="micro-label">Vercel smoke test gate</span>
                  <h2>{deployGateReady ? "Ready for smoke deploy" : "Still needs a local pass"}</h2>
                  <p>
                    {deployGateReady
                      ? "Push to GitHub, import in Vercel, add the server env vars, deploy, then test health, series load, observation view, and one downstream API call."
                      : "Run health, refresh the vault, and check setup warnings before pushing to Vercel."}
                  </p>
                </div>

                <div className="console-panel deploy-panel">
                  <span className="micro-label">Readiness checks</span>
                  <h2>{deploymentChecks.filter((check) => check.ready).length}/{deploymentChecks.length} gates green</h2>
                  <div className="env-grid">
                    {deploymentChecks.map((check) => (
                      <div key={check.label} className="env-item connector-item">
                        <span className={`status-dot ${check.ready ? (check.warning ? "warning" : "ok") : ""}`} />
                        <div>
                          <span>{check.label}</span>
                          <small>{check.detail}</small>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="console-panel deploy-panel">
                  <span className="micro-label">Vercel env vars</span>
                  <h2>Server-only configuration</h2>
                  <div className="env-grid">
                    {vercelEnvVars.map((key) => (
                      <div key={key} className="env-item">
                        <span
                          className={`status-dot ${
                            health.data?.env[key] || health.data?.optional?.[key]
                              ? "ok"
                              : ["EIA_API_KEY", "RELIEFWEB_APP_NAME", "APIFY_TOKEN", "GEMINI_MODEL", "GEMINI_INTELLIGENCE_MODEL"].includes(key)
                                ? "warning"
                                : ""
                          }`}
                        />
                        <span>{key}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="console-panel deploy-panel">
                  <span className="micro-label">Optional source status</span>
                  <h2>Useful, not deploy-blocking</h2>
                  <div className="env-grid">
                    {optionalConnectorRows.map((item) => {
                      const connector = connectorStatuses[item.key];
                      return (
                        <div key={item.key} className="env-item connector-item">
                          <span className={`status-dot ${connector?.ok ? "ok" : "warning"}`} />
                          <div>
                            <span>{item.label}</span>
                            <small>{item.detail}</small>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="console-panel deploy-panel">
                  <span className="micro-label">Supabase SQL</span>
                  <h2>Install once, then reload schema</h2>
                  <p>
                    Required: <code>supabase/schema.sql</code>. Recommended: <code>supabase/sync_runs.sql</code> and{" "}
                    <code>supabase/intelligence.sql</code>. If logs or intelligence tables look missing after install, run{" "}
                    <code>notify pgrst, 'reload schema';</code>.
                  </p>
                </div>

                <div className="console-panel deploy-panel">
                  <span className="micro-label">Later</span>
                  <h2>Clerk and agents stay outside the smoke gate</h2>
                  <p>
                    Clerk can replace the temporary vault key after preview. Hostinger or Apify collectors should enter through
                    server routes, never by writing directly to Supabase from a browser.
                  </p>
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
