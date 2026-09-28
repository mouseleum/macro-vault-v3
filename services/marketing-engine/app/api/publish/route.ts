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
  channels: z.array(z.enum(["zapier", "bluesky", "x", "linkedin"])).min(1).optional(),
  // Overrides a channel whose previous outcome is unknown. Only a human who has
  // checked the platform should set this: it can produce a duplicate post.
  force: z.boolean().optional()
});

type ChannelRun = {
  result: PublishResult;
  post: MarketingPost | null;
  // The draft must not be handed back as publishable while this channel is
  // live or unresolved — reverting it would hide the override control and
  // invite a duplicate.
  blocksRevert: boolean;
};

// A refusal is reported with the status that describes the channel's real
// state, not "skipped": an unresolved or in-flight channel is genuinely
// unknown, and reporting it as skipped made the aggregation below believe
// nothing had happened.
const claimRefusal: Record<
  "already_posted" | "unresolved_outcome" | "in_flight",
  { status: "skipped" | "unknown"; error: string }
> = {
  already_posted: { status: "skipped", error: "already posted to this channel" },
  unresolved_outcome: {
    status: "unknown",
    error: "a previous attempt's outcome is unknown — verify on the platform, then retry with force"
  },
  in_flight: { status: "unknown", error: "another publish is in flight for this channel" }
};

// Claims the channel slot, runs the adapter, and resolves the claim. The claim
// insert is what makes concurrent publishes/retries safe: only one caller can
// hold the slot for a draft+channel at a time.
async function publishChannel(
  store: MarketingStore,
  draft: MarketingDraft,
  channel: ChannelId,
  profile: NonNullable<ReturnType<typeof getProject>>,
  context: { baseUrl: string; dryRun: boolean; force: boolean }
): Promise<ChannelRun> {
  const claim = await store.claimChannelPost(draft.id, channel, { force: context.force });
  if (!claim.ok) {
    const refusal = claimRefusal[claim.reason];
    return {
      result: { channel, status: refusal.status, error: refusal.error },
      post: null,
      // Every refusal means the database already holds a live, posted or
      // unresolved row for this channel, so none of them may trigger a revert.
      blocksRevert: true
    };
  }

  let result: PublishResult;
  try {
    result = await channelAdapters[channel](draft, profile, context);
  } catch (error) {
    // A throw means the request died mid-flight: the platform may already have
    // accepted the post. Adapters return status "failed" when they got a real
    // error response (definite non-delivery, safe to retry); anything that
    // throws is indeterminate and must not be retried automatically. Some
    // throws are in fact pre-send, but erring toward "unknown" only costs an
    // extra confirmation, while erring toward "failed" costs a duplicate post.
    result = {
      channel,
      status: "unknown",
      error: `outcome unknown: ${error instanceof Error ? error.message : "unexpected publish error"}`
    };
  }

  let post: MarketingPost | null = null;
  try {
    post = await store.resolveChannelPost(claim.post.id, {
      status: result.status === "pending" ? "unknown" : result.status,
      external_id: result.externalId ?? null,
      url: result.url ?? null,
      error: result.error ?? null
    });
  } catch (error) {
    // The post itself may have succeeded — log everything needed to reconcile
    // by hand, because the row cannot record it. The claim stays "pending" and
    // is later demoted to "unknown" (never "failed"), so no automatic retry can
    // duplicate it.
    console.error(
      `[publish] channel ${channel} finished as ${result.status} but the claim ${claim.post.id} could not be resolved` +
        `${result.externalId ? ` (external_id=${result.externalId})` : ""}` +
        `${result.url ? ` (url=${result.url})` : ""}`,
      error
    );
  }

  return { result, post, blocksRevert: result.status === "posted" || result.status === "unknown" };
}

export async function POST(request: NextRequest) {
  const authError = assertMarketingAuth(request);
  if (authError) return authError;

  try {
    // Inside the try so a missing env var surfaces as a readable JSON error
    // instead of an opaque framework 500 the UI cannot even parse.
    const store = createMarketingStore();
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

    // From here on, any early exit or unexpected error must release the draft
    // claim, or the draft is stranded as "published" with no posts. Both the
    // status and the claim's reviewed_at stamp are restored.
    const revert = async () => {
      if (!claimed) return draft;
      try {
        return await store.updateDraft(draft.id, {
          status: claimed.priorStatus,
          reviewed_at: claimed.priorReviewedAt
        });
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

      const context = { baseUrl: requestBaseUrl(request), dryRun: isDryRun(), force: input.force ?? false };
      const runs = await Promise.all(channels.map((channel) => publishChannel(store, draft, channel, profile, context)));
      const results = runs.map((run) => run.result);
      const posts = runs.flatMap((run) => (run.post ? [run.post] : []));

      const anyPosted = results.some((result) => result.status === "posted");
      const anyDryRun = results.some((result) => result.status === "dry_run");
      const anyUnknown = results.some((result) => result.status === "unknown");

      // A dry run or a definitely-failed publish must not consume the draft:
      // restore the exact pre-claim state so pending drafts stay pending. Any
      // channel that is live or unresolved blocks the revert — the post may
      // already be out, and a reverted draft hides the retry control.
      let updated = draft;
      if (claimed && !runs.some((run) => run.blocksRevert)) {
        updated = await revert();
      }

      const ok = anyPosted || anyDryRun;
      return NextResponse.json(
        {
          ok,
          dryRun: context.dryRun,
          needsAttention: anyUnknown,
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
      // `error` as well as `message`: callers read body.error.
      return NextResponse.json(
        { setupRequired: true, error: marketingSetupMessage, message: marketingSetupMessage },
        { status: 400 }
      );
    }
    return jsonError(error);
  }
}
