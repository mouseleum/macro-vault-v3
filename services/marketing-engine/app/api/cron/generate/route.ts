import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, todayIsoDate } from "@/lib/api";
import { assertCronAuth } from "@/lib/auth";
import { generateCopy } from "@/lib/copywriter";
import { isDevMode } from "@/lib/env";
import { createMarketingStore } from "@/lib/marketing-store";
import { enabledProjects, resolveFeed, type ProjectProfile } from "@/lib/registry";
import { selectHighlights } from "@/lib/select";
import { feedFiles } from "@/feeds";
import type { MarketingHighlight } from "@/types/marketing";

export const runtime = "nodejs";
export const maxDuration = 300;

const highlightSchema = z.object({
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
  media: z
    .object({
      coverImageUrl: z.string().url().nullish(),
      waveform: z.array(z.number().min(0).max(1)).max(200).optional(),
      links: z.array(z.object({ label: z.string().min(1).max(20), url: z.string().url() })).max(6).optional()
    })
    .nullish(),
  link: z.string().url().nullish(),
  tags: z.array(z.string().max(40)).max(12).default([]),
  expiresAt: z.string().nullish()
});

// The envelope is strict but each highlight is salvaged individually: one
// malformed item is dropped (and counted) instead of starving the whole feed.
const feedEnvelopeSchema = z.object({
  project: z.string().min(1),
  generatedAt: z.string(),
  highlights: z.array(z.unknown()).max(100)
});

type FetchedFeed = {
  highlights: MarketingHighlight[];
  dropped: number;
};

function parseFeed(profile: ProjectProfile, payload: unknown): FetchedFeed {
  const envelope = feedEnvelopeSchema.parse(payload);
  if (envelope.project !== profile.slug) {
    throw new Error(`Feed project "${envelope.project}" does not match profile "${profile.slug}" — check the feed URL wiring.`);
  }

  const highlights: MarketingHighlight[] = [];
  let dropped = 0;
  for (const item of envelope.highlights) {
    const parsed = highlightSchema.safeParse(item);
    if (parsed.success) {
      highlights.push(parsed.data);
    } else {
      dropped += 1;
      console.warn(`[generate] ${profile.slug}: dropped malformed highlight`, parsed.error.issues[0]?.message);
    }
  }

  return { highlights, dropped };
}

async function fetchHighlights(profile: ProjectProfile): Promise<FetchedFeed> {
  const feed = resolveFeed(profile);

  if (!feed.url) {
    if (profile.feedFile && (!profile.feedFileIsFixture || isDevMode())) {
      const payload = feedFiles[profile.feedFile];
      if (!payload) throw new Error(`Feed file "${profile.feedFile}" is not registered in feeds/index.ts.`);
      return parseFeed(profile, payload);
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

  return parseFeed(profile, await response.json());
}

type ProjectRunResult = {
  project: string;
  ok: boolean;
  fetched?: number;
  droppedInvalid?: number;
  selected?: number;
  drafted?: string[];
  skippedDuplicate?: number;
  failedDrafts?: number;
  error?: string;
};

async function runProject(profile: ProjectProfile): Promise<ProjectRunResult> {
  const store = createMarketingStore();
  const feed = await fetchHighlights(profile);

  const [existingHashes, draftsToday] = await Promise.all([
    store.listContentHashes(profile.slug),
    store.countDraftsSince(profile.slug, `${todayIsoDate()}T00:00:00.000Z`)
  ]);

  const selected = await selectHighlights(profile, feed.highlights, existingHashes, draftsToday);

  // Copywriting calls are independent — run them in parallel, and never let
  // one bad candidate abort the rest.
  const outcomes = await Promise.all(
    selected.map(async (candidate) => {
      try {
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
          media: candidate.highlight.media ?? null,
          link: candidate.highlight.link ?? null,
          tags: candidate.highlight.tags,
          copy,
          score: candidate.score
        });
        return draft ? { draftId: draft.id } : { duplicate: true };
      } catch (error) {
        console.error(`[generate] ${profile.slug}: draft failed for ${candidate.highlight.id}`, error);
        return { failed: true };
      }
    })
  );

  return {
    project: profile.slug,
    ok: outcomes.every((outcome) => !("failed" in outcome)),
    fetched: feed.highlights.length,
    droppedInvalid: feed.dropped,
    selected: selected.length,
    drafted: outcomes.flatMap((outcome) => ("draftId" in outcome && outcome.draftId ? [outcome.draftId] : [])),
    skippedDuplicate: outcomes.filter((outcome) => "duplicate" in outcome).length,
    failedDrafts: outcomes.filter((outcome) => "failed" in outcome).length
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
