import { AtpAgent } from "@atproto/api";
import { getOptionalEnv } from "../env";
import { cardImageUrl, type ChannelAdapter } from "./types";

export const publishToBluesky: ChannelAdapter = async (draft, profile, context) => {
  const identifier = getOptionalEnv("BLUESKY_IDENTIFIER");
  const password = getOptionalEnv("BLUESKY_APP_PASSWORD");
  if (!identifier || !password) {
    return { channel: "bluesky", status: "skipped", error: "BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD not configured" };
  }

  if (context.dryRun) {
    console.log("[dry-run] bluesky post", JSON.stringify({ text: draft.copy.bluesky, image: cardImageUrl(context, draft) }));
    return { channel: "bluesky", status: "dry_run" };
  }

  const agent = new AtpAgent({ service: getOptionalEnv("BLUESKY_SERVICE") ?? "https://bsky.social" });
  await agent.login({ identifier, password });

  const imageResponse = await fetch(cardImageUrl(context, draft));
  if (!imageResponse.ok) {
    return { channel: "bluesky", status: "failed", error: `Card render fetch returned ${imageResponse.status}` };
  }
  const imageBytes = new Uint8Array(await imageResponse.arrayBuffer());
  const upload = await agent.uploadBlob(imageBytes, { encoding: "image/png" });

  const post = await agent.post({
    text: draft.copy.bluesky,
    embed: {
      $type: "app.bsky.embed.images",
      images: [
        {
          image: upload.data.blob,
          alt: draft.headline,
          aspectRatio: { width: 1200, height: 675 }
        }
      ]
    },
    createdAt: new Date().toISOString()
  });

  // at://did:plc:xxx/app.bsky.feed.post/rkey -> https://bsky.app/profile/handle/post/rkey
  const rkey = post.uri.split("/").pop();
  const url = rkey ? `https://bsky.app/profile/${agent.session?.handle ?? identifier}/post/${rkey}` : null;

  return { channel: "bluesky", status: "posted", externalId: post.uri, url };
};
