import { getOptionalEnv } from "../env";
import { cardImageUrl, type ChannelAdapter } from "./types";

// LinkedIn ships through a dedicated Zapier hook wired to a "Create Share
// Update" action — the native LinkedIn API needs app review, which isn't
// worth it for v1. Requires its own hook (LINKEDIN_ZAPIER_WEBHOOK_URL) so a
// generic ZAPIER_WEBHOOK_URL fan-out doesn't double-post.
export const publishToLinkedIn: ChannelAdapter = async (draft, profile, context) => {
  const webhookUrl = getOptionalEnv("LINKEDIN_ZAPIER_WEBHOOK_URL");
  if (!webhookUrl) {
    return { channel: "linkedin", status: "skipped", error: "LINKEDIN_ZAPIER_WEBHOOK_URL not configured" };
  }

  const payload = {
    event: "marketing.post.linkedin",
    project: profile.slug,
    draftId: draft.id,
    text: draft.copy.linkedin,
    imageUrl: cardImageUrl(context, draft),
    link: draft.link
  };

  if (context.dryRun) {
    console.log("[dry-run] linkedin payload", JSON.stringify(payload));
    return { channel: "linkedin", status: "dry_run" };
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    return { channel: "linkedin", status: "failed", error: `LinkedIn hook returned ${response.status}` };
  }

  return { channel: "linkedin", status: "posted" };
};
