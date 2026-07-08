import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/api";
import { assertCronAuth } from "@/lib/auth";
import { generateCopy } from "@/lib/copywriter";
import { createMarketingStore } from "@/lib/marketing-store";
import { enabledProjects, resolveFeed, type ProjectProfile } from "@/lib/registry";
import { selectHighlights } from "@/lib/select";
import sampleHighlights from "@/lib/fixtures/sample-highlights.json";
import type { MarketingHighlightsResponse } from "@/types/marketing";

export const runtime = "nodejs";
export const maxDuration = 300;

const highlightsSchema = z.object({
  project: z.string().min(1),
  generatedAt: z.string(),
  highlights: z.array(
    z.object({
      id: z.string().min(1),
      type: z.enum(["alert", "stat", "surprise", "event", "milestone"]),
      headline: z.string().min(1).max(200),
      narrative: z.string().min(1).max(2000),
      severity: z.enum(["low", "medium", "high", "extreme"]),
      metrics: z
        .array(
          z.object({
            label: z.string().min(1).max(40),
            value: z.string().min(1).max(40),
            delta: z.string().max(60).nullish()
          })
        )
        .max(8)
        .default([]),
      sparkline: z.array(z.object({ t: z.string(), v: z.number() })).max(400).optional(),
      link: z.string().url().nullish(),
      tags: z.array(z.string().max(40)).max(12).default([]),
      expiresAt: z.string().nullish()
    })
  )
});

async function fetchHighlights(profile: ProjectProfile): Promise<MarketingHighlightsResponse> {
  const feed = resolveFeed(profile);

  if (!feed.url) {
    if (profile.devFixture && process.env.NODE_ENV !== "production") {
      return highlightsSchema.parse(sampleHighlights);
    }
    throw new Error(`Feed URL env ${profile.feedUrlEnv} is not set.`);
  }

  const response = await fetch(feed.url, {
    headers: feed.key ? { Authorization: `Bearer ${feed.key}` } : {},
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    throw new Error(`Feed returned ${response.status}`);
  }

  return highlightsSchema.parse(await response.json());
}

type ProjectRunResult = {
  project: string;
  ok: boolean;
  fetched?: number;
  selected?: number;
  drafted?: string[];
  error?: string;
};

async function runProject(profile: ProjectProfile): Promise<ProjectRunResult> {
  const store = createMarketingStore();
  const feed = await fetchHighlights(profile);

  const [existingHashes, draftsToday] = await Promise.all([
    store.listContentHashes(profile.slug),
    store.countDraftsSince(profile.slug, `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`)
  ]);

  const selected = await selectHighlights(profile, feed.highlights, existingHashes, draftsToday);

  const drafted: string[] = [];
  for (const candidate of selected) {
    const copy = await generateCopy(profile, candidate.highlight);
    const draft = await store.createDraft({
      project: profile.slug,
      highlight_id: candidate.highlight.id,
      content_hash: candidate.contentHash,
      type: candidate.highlight.type,
      headline: candidate.highlight.headline,
      narrative: candidate.highlight.narrative,
      severity: candidate.highlight.severity,
      metrics: candidate.highlight.metrics,
      sparkline: candidate.highlight.sparkline ?? null,
      link: candidate.highlight.link ?? null,
      tags: candidate.highlight.tags,
      copy,
      score: candidate.score
    });
    drafted.push(draft.id);
  }

  return {
    project: profile.slug,
    ok: true,
    fetched: feed.highlights.length,
    selected: selected.length,
    drafted
  };
}

export async function GET(request: NextRequest) {
  const authError = assertCronAuth(request);
  if (authError) return authError;

  try {
    const results = await Promise.all(
      enabledProjects().map(async (profile): Promise<ProjectRunResult> => {
        try {
          return await runProject(profile);
        } catch (error) {
          return {
            project: profile.slug,
            ok: false,
            error: error instanceof Error ? error.message : "Unexpected error"
          };
        }
      })
    );

    const failed = results.filter((result) => !result.ok);
    return NextResponse.json(
      {
        ok: failed.length === 0,
        results,
        timestamp: new Date().toISOString()
      },
      { status: failed.length === 0 ? 200 : failed.length === results.length ? 500 : 207 }
    );
  } catch (error) {
    return jsonError(error);
  }
}
