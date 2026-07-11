import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requestBaseUrl } from "@/lib/api";
import { assertMarketingAuth } from "@/lib/auth";
import { channelAdapters } from "@/lib/channels";
import { isDryRun } from "@/lib/env";
import { createMarketingStore } from "@/lib/marketing-store";
import { getProject } from "@/lib/registry";
import type { ChannelId, MarketingDraft, PublishResult } from "@/types/marketing";

export const runtime = "nodejs";
export const maxDuration = 120;

const publishSchema = z.object({
  draftId: z.string().min(1),
  channels: z.array(z.enum(["zapier", "bluesky", "x", "linkedin"])).min(1).optional()
});

export async function POST(request: NextRequest) {
  const authError = assertMarketingAuth(request);
  if (authError) return authError;

  try {
    const input = publishSchema.parse(await request.json());
    const store = createMarketingStore();

    // Atomically claim the draft (pending/approved → published) BEFORE any
    // channel call, so concurrent publish requests cannot double-post. A
    // published draft can still be re-published to explicitly named channels
    // (retrying a previously failed adapter).
    let draft: MarketingDraft | null = await store.claimDraftForPublish(input.draftId);
    let claimed = true;
    if (!draft) {
      const existing = await store.getDraft(input.draftId);
      if (!existing) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
      if (existing.status === "published" && input.channels) {
        draft = existing;
        claimed = false;
      } else {
        return NextResponse.json(
          { error: `Draft is ${existing.status}; only pending or approved drafts publish (published drafts allow retries with explicit channels).` },
          { status: 409 }
        );
      }
    }

    const profile = getProject(draft.project);
    if (!profile) {
      if (claimed) await store.updateDraft(draft.id, { status: "approved" });
      return NextResponse.json({ error: `Unknown project ${draft.project}` }, { status: 400 });
    }

    const channels: ChannelId[] = input.channels
      ? input.channels.filter((channel) => profile.channels.includes(channel))
      : profile.channels;
    if (channels.length === 0) {
      if (claimed) await store.updateDraft(draft.id, { status: "approved" });
      return NextResponse.json({ error: "No requested channel is enabled for this project." }, { status: 400 });
    }

    const context = { baseUrl: requestBaseUrl(request), dryRun: isDryRun() };
    const publishTarget = draft;
    const results: PublishResult[] = await Promise.all(
      channels.map(async (channel): Promise<PublishResult> => {
        try {
          return await channelAdapters[channel](publishTarget, profile, context);
        } catch (error) {
          return {
            channel,
            status: "failed",
            error: error instanceof Error ? error.message : "Unexpected publish error"
          };
        }
      })
    );

    const posts = await store.createPosts(
      results.map((result) => ({
        draft_id: publishTarget.id,
        channel: result.channel,
        external_id: result.externalId ?? null,
        url: result.url ?? null,
        status: result.status,
        error: result.error ?? null
      }))
    );

    const anyPosted = results.some((result) => result.status === "posted");
    const anyDryRun = results.some((result) => result.status === "dry_run");

    // A dry run or a fully failed publish must not consume the draft: release
    // the claim back to "approved" so it can be (re)published for real.
    let updated = publishTarget;
    if (claimed && !anyPosted) {
      updated = await store.updateDraft(publishTarget.id, { status: "approved", reviewed_at: new Date().toISOString() });
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
    return jsonError(error);
  }
}
