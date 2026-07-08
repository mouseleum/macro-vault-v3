import { getOptionalEnv } from "../env";
import { cardImageUrl, type ChannelAdapter } from "./types";

// Generic fan-out: POST the approved draft to a Zapier catch hook and let the
// Zap route it anywhere (Slack, Notion, LinkedIn, email digests, ...).
export const publishToZapier: ChannelAdapter = async (draft, profile, context) => {
  const webhookUrl = getOptionalEnv("ZAPIER_WEBHOOK_URL");
  if (!webhookUrl) {
    return { channel: "zapier", status: "skipped", error: "ZAPIER_WEBHOOK_URL not configured" };
  }

  const payload = {
    event: "marketing.post",
    project: profile.slug,
    projectName: profile.name,
    draftId: draft.id,
    headline: draft.headline,
    narrative: draft.narrative,
    severity: draft.severity,
    copy: draft.copy,
    imageUrl: cardImageUrl(context, draft),
    link: draft.link,
    tags: draft.tags
  };

  if (context.dryRun) {
    console.log("[dry-run] zapier payload", JSON.stringify(payload));
    return { channel: "zapier", status: "dry_run" };
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    return { channel: "zapier", status: "failed", error: `Zapier hook returned ${response.status}` };
  }

  const body = (await response.json().catch(() => ({}))) as { id?: string; request_id?: string };
  return { channel: "zapier", status: "posted", externalId: body.id ?? body.request_id ?? null };
};
