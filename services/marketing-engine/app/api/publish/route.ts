import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requestBaseUrl } from "@/lib/api";
import { assertMarketingAuth } from "@/lib/auth";
import { channelAdapters } from "@/lib/channels";
import { isDryRun } from "@/lib/env";
import { createMarketingStore } from "@/lib/marketing-store";
import { getProject } from "@/lib/registry";
import type { ChannelId, PublishResult } from "@/types/marketing";

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

    const draft = await store.getDraft(input.draftId);
    if (!draft) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    if (draft.status === "rejected" || draft.status === "published") {
      return NextResponse.json({ error: `Draft is ${draft.status}; only pending or approved drafts publish.` }, { status: 409 });
    }

    const profile = getProject(draft.project);
    if (!profile) return NextResponse.json({ error: `Unknown project ${draft.project}` }, { status: 400 });

    const channels: ChannelId[] = input.channels
      ? input.channels.filter((channel) => profile.channels.includes(channel))
      : profile.channels;
    if (channels.length === 0) {
      return NextResponse.json({ error: "No requested channel is enabled for this project." }, { status: 400 });
    }

    const context = { baseUrl: requestBaseUrl(request), dryRun: isDryRun() };
    const results: PublishResult[] = [];
    for (const channel of channels) {
      try {
        results.push(await channelAdapters[channel](draft, profile, context));
      } catch (error) {
        results.push({
          channel,
          status: "failed",
          error: error instanceof Error ? error.message : "Unexpected publish error"
        });
      }
    }

    const posts = await store.createPosts(
      results.map((result) => ({
        draft_id: draft.id,
        channel: result.channel,
        external_id: result.externalId ?? null,
        url: result.url ?? null,
        status: result.status,
        error: result.error ?? null
      }))
    );

    const anyDelivered = results.some((result) => result.status === "posted" || result.status === "dry_run");
    const updated = anyDelivered
      ? await store.updateDraft(draft.id, { status: "published", reviewed_at: new Date().toISOString() })
      : draft;

    return NextResponse.json(
      {
        ok: anyDelivered,
        dryRun: context.dryRun,
        draft: updated,
        results,
        posts
      },
      { status: anyDelivered ? 200 : 502 }
    );
  } catch (error) {
    return jsonError(error);
  }
}
