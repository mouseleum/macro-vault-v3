import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requestBaseUrl } from "@/lib/api";
import { assertMarketingAuth } from "@/lib/auth";
import { channelAdapters } from "@/lib/channels";
import { isDryRun } from "@/lib/env";
import { createMarketingStore, isMissingMarketingTable, marketingSetupMessage, type MarketingStore } from "@/lib/marketing-store";
import { getProject } from "@/lib/registry";
import type { ChannelId, MarketingDraft, MarketingPost, PublishResult } from "@/types/marketing";

export const runtime = "nodejs";
export const maxDuration = 120;

const publishSchema = z.object({
  draftId: z.string().min(1),
  channels: z.array(z.enum(["zapier", "bluesky", "x", "linkedin"])).min(1).optional()
});

type ChannelRun = {
  result: PublishResult;
  post: MarketingPost | null;
};

// Claims the channel slot, runs the adapter, and resolves the claim. The
// claim insert is what makes concurrent publishes/retries safe: only one
// caller can hold the pending/posted slot for a draft+channel at a time.
async function publishChannel(
  store: MarketingStore,
  draft: MarketingDraft,
  channel: ChannelId,
  profile: NonNullable<ReturnType<typeof getProject>>,
  context: { baseUrl: string; dryRun: boolean }
): Promise<ChannelRun> {
  const claim = await store.claimChannelPost(draft.id, channel);
  if (!claim) {
    return {
      result: { channel, status: "skipped", error: "already posted or another publish is in flight" },
      post: null
    };
  }

  let result: PublishResult;
  try {
    result = await channelAdapters[channel](draft, profile, context);
  } catch (error) {
    result = { channel, status: "failed", error: error instanceof Error ? error.message : "Unexpected publish error" };
  }

  let post: MarketingPost | null = null;
  try {
    post = await store.resolveChannelPost(claim.id, {
      status: result.status === "pending" ? "failed" : result.status,
      external_id: result.externalId ?? null,
      url: result.url ?? null,
      error: result.error ?? null
    });
  } catch (error) {
    // The outcome is still returned; the unresolved claim goes stale and
    // becomes supersedable after the stale window, so nothing is stranded.
    console.error(`[publish] failed to resolve channel claim ${claim.id}`, error);
  }

  return { result, post };
}

export async function POST(request: NextRequest) {
  const authError = assertMarketingAuth(request);
  if (authError) return authError;

  const store = createMarketingStore();

  try {
    const input = publishSchema.parse(await request.json());

    // Atomically claim the draft (pending/approved → published) BEFORE any
    // channel call. A published draft may be re-published to explicitly named
    // channels — the per-channel claims prevent double-posting there.
    const claimed = await store.claimDraftForPublish(input.draftId);
    let draft: MarketingDraft;
    if (claimed) {
      draft = claimed.draft;
    } else {
      const existing = await store.getDraft(input.draftId);
      if (!existing) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
      if (existing.status === "published" && input.channels) {
        draft = existing;
      } else {
        return NextResponse.json(
          { error: `Draft is ${existing.status}; only pending or approved drafts publish (published drafts allow retries with explicit channels).` },
          { status: 409 }
        );
      }
    }

    // From here on, any early exit or unexpected error must release the
    // draft claim, or the draft is stranded as "published" with no posts.
    const revert = async () => {
      if (!claimed) return draft;
      try {
        return await store.updateDraft(draft.id, { status: claimed.priorStatus });
      } catch (error) {
        console.error(`[publish] failed to revert draft ${draft.id} to ${claimed.priorStatus}`, error);
        return draft;
      }
    };

    try {
      const profile = getProject(draft.project);
      if (!profile) {
        await revert();
        return NextResponse.json({ error: `Unknown project ${draft.project}` }, { status: 400 });
      }

      const channels: ChannelId[] = input.channels
        ? input.channels.filter((channel) => profile.channels.includes(channel))
        : profile.channels;
      if (channels.length === 0) {
        await revert();
        return NextResponse.json({ error: "No requested channel is enabled for this project." }, { status: 400 });
      }

      const context = { baseUrl: requestBaseUrl(request), dryRun: isDryRun() };
      const runs = await Promise.all(channels.map((channel) => publishChannel(store, draft, channel, profile, context)));
      const results = runs.map((run) => run.result);
      const posts = runs.flatMap((run) => (run.post ? [run.post] : []));

      const anyPosted = results.some((result) => result.status === "posted");
      const anyDryRun = results.some((result) => result.status === "dry_run");

      // A dry run or a fully failed publish must not consume the draft:
      // restore the exact pre-claim status so pending drafts stay pending.
      let updated = draft;
      if (claimed && !anyPosted) {
        updated = await revert();
      }

      const ok = anyPosted || anyDryRun;
      return NextResponse.json(
        {
          ok,
          dryRun: context.dryRun,
          draft: updated,
          results,
          posts
        },
        { status: ok ? 200 : 502 }
      );
    } catch (error) {
      await revert();
      throw error;
    }
  } catch (error) {
    if (error && typeof error === "object" && isMissingMarketingTable(error as { code?: string; message?: string })) {
      return NextResponse.json({ setupRequired: true, message: marketingSetupMessage }, { status: 400 });
    }
    return jsonError(error);
  }
}
