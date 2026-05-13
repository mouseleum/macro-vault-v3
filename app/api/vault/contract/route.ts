import { NextRequest, NextResponse } from "next/server";
import { assertVaultAuth } from "@/lib/auth";

export const runtime = "nodejs";

const contract = {
  name: "Macro Vault",
  version: "v1",
  purpose:
    "Private source-of-truth macro data vault for downstream intelligence, dashboard, alarm, and opportunity projects.",
  auth: {
    type: "bearer",
    header: "Authorization: Bearer <VAULT_API_KEY>",
    localDevelopment: "localhost requests bypass auth in non-production only"
  },
  downstreamEnvironment: {
    required: ["MACRO_VAULT_URL", "MACRO_VAULT_API_KEY"],
    example: {
      MACRO_VAULT_URL: "https://your-vault.vercel.app",
      MACRO_VAULT_API_KEY: "<server-only key>"
    }
  },
  stability: {
    status: "v1",
    rule: "Existing response fields are stable. New fields may be added without a version bump."
  },
  endpoints: {
    read: [
      {
        method: "GET",
        path: "/api/vault/contract",
        purpose: "Machine-readable contract for downstream apps and agents."
      },
      {
        method: "GET",
        path: "/api/vault/series",
        purpose: "Search and list available macro series.",
        query: ["provider", "country", "q", "limit"]
      },
      {
        method: "GET",
        path: "/api/vault/latest",
        purpose: "Latest observation for a specific provider, series code, and country.",
        query: ["provider", "code", "country"]
      },
      {
        method: "GET",
        path: "/api/vault/observations",
        purpose: "Historical observations for a specific series.",
        query: ["provider", "code", "country", "start", "end", "order", "limit"]
      },
      {
        method: "GET",
        path: "/api/vault/regime",
        purpose: "Latest macro regime snapshot."
      },
      {
        method: "GET",
        path: "/api/vault/dashboard-feed",
        purpose: "Downstream-ready bundle with totals, regime, upcoming critical events, surprises, and narrative signals.",
        query: ["days", "limit", "country"]
      },
      {
        method: "GET",
        path: "/api/vault/events",
        purpose: "Macro events, calendar releases, telemetry events, and promoted narrative signals.",
        query: ["limit", "category", "country", "from", "to"]
      },
      {
        method: "GET",
        path: "/api/vault/sync-runs",
        purpose: "Recent connector runs and partial failures.",
        query: ["limit"]
      },
      {
        method: "GET",
        path: "/api/knowledge/documents",
        purpose: "Saved source material and notes.",
        query: ["limit"]
      },
      {
        method: "GET",
        path: "/api/intelligence/candidates",
        purpose: "Review queue of candidate observations, events, and notes.",
        query: ["limit"]
      }
    ],
    controlledWrites: [
      {
        method: "POST",
        path: "/api/intelligence/candidates",
        purpose: "Primary write lane for downstream projects. Stores candidates as pending review items."
      },
      {
        method: "POST",
        path: "/api/knowledge/documents",
        purpose: "Store permitted source material or project notes."
      },
      {
        method: "PATCH",
        path: "/api/intelligence/candidates/:id",
        purpose: "Approve or reject a candidate."
      },
      {
        method: "POST",
        path: "/api/intelligence/candidates/:id/promote",
        purpose: "Promote approved candidates into canonical observations or macro events."
      }
    ]
  },
  schemas: {
    MacroSeries: {
      id: "uuid",
      provider: "string",
      series_code: "string",
      country_code: "string | null",
      name: "string | null",
      unit: "string | null",
      metadata: "object | null",
      last_synced: "datetime | null"
    },
    MacroObservation: {
      id: "uuid",
      series_id: "uuid",
      date: "date",
      value: "number",
      metadata: "object | null",
      created_at: "datetime"
    },
    MacroEvent: {
      id: "uuid",
      event_date: "date",
      title: "string",
      narrative: "string",
      category: "string | null",
      country_code: "string | null",
      region: "string | null",
      impact_score: "number | null",
      confidence: "0..1 | null",
      source_url: "string | null",
      source_title: "string | null",
      source_tier: "user_supplied | public_web | licensed | internal | unknown",
      metadata: "object"
    },
    IntelligenceCandidateWrite: {
      signalType: "numeric_observation | event | document_note",
      title: "string",
      provider: "string | null",
      seriesCode: "string | null",
      countryCode: "string | null",
      date: "YYYY-MM-DD | null",
      value: "number | null",
      unit: "string | null",
      narrative: "string | null",
      confidence: "0..1 | null",
      sourceUrl: "string | null",
      sourceTitle: "string | null",
      sourceTier: "user_supplied | public_web | licensed | internal | unknown",
      extractionMethod: "string",
      metadata: "object"
    }
  },
  downstreamRules: [
    "Treat Macro Vault as the source of truth for reusable macro data.",
    "Do not write directly to Supabase from downstream browser clients.",
    "Downstream projects may submit candidate signals, but canonical observations and events require review/promotion.",
    "Store project-specific UI state and proprietary analysis in the downstream project unless it is reusable vault data.",
    "Always preserve source URL, title, source tier, confidence, and source project metadata when writing candidates."
  ],
  examples: {
    latestObservation: {
      method: "GET",
      path: "/api/vault/latest?provider=fred&code=CPIAUCSL&country=US"
    },
    submitCandidate: {
      method: "POST",
      path: "/api/intelligence/candidates",
      body: {
        sourceProject: "visual_alarmist",
        candidates: [
          {
            signalType: "event",
            title: "Red Sea shipping stress remains elevated",
            provider: "visual_alarmist",
            seriesCode: "RED_SEA_SHIPPING_STRESS",
            countryCode: "WLD",
            date: "2026-05-06",
            narrative: "Agent scan detected persistent rerouting and insurance-cost pressure in recent public shipping reports.",
            confidence: 0.72,
            sourceUrl: "https://example.com/source",
            sourceTitle: "Example source",
            sourceTier: "public_web",
            extractionMethod: "agent_scan",
            metadata: {
              asset_relevance: ["oil", "freight", "global_equities"]
            }
          }
        ]
      }
    }
  }
};

export async function GET(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  return NextResponse.json({
    ...contract,
    timestamp: new Date().toISOString()
  });
}
