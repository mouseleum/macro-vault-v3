import { createHmac, randomBytes } from "node:crypto";
import { getOptionalEnv } from "../env";
import { cardImageUrl, type ChannelAdapter } from "./types";

// Minimal OAuth 1.0a (HMAC-SHA1) signing — enough for the two X endpoints we
// call, avoiding a dependency. Body params are excluded from the signature,
// which is correct for multipart/form-data and JSON bodies.
type OAuthCredentials = {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
};

function percentEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function oauthHeader(credentials: OAuthCredentials, method: string, url: string) {
  const params: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0"
  };

  const paramString = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join("&");
  const baseString = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join("&");
  const signingKey = `${percentEncode(credentials.apiSecret)}&${percentEncode(credentials.accessSecret)}`;
  params.oauth_signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  const header = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(params[key])}"`)
    .join(", ");
  return `OAuth ${header}`;
}

async function uploadMedia(credentials: OAuthCredentials, imageBytes: ArrayBuffer) {
  const url = "https://upload.twitter.com/1.1/media/upload.json";
  const form = new FormData();
  form.append("media", new Blob([imageBytes], { type: "image/png" }), "card.png");

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: oauthHeader(credentials, "POST", url) },
    body: form
  });

  if (!response.ok) {
    throw new Error(`X media upload returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const body = (await response.json()) as { media_id_string?: string };
  if (!body.media_id_string) throw new Error("X media upload returned no media_id_string.");
  return body.media_id_string;
}

export const publishToX: ChannelAdapter = async (draft, profile, context) => {
  const apiKey = getOptionalEnv("X_API_KEY");
  const apiSecret = getOptionalEnv("X_API_SECRET");
  const accessToken = getOptionalEnv("X_ACCESS_TOKEN");
  const accessSecret = getOptionalEnv("X_ACCESS_SECRET");
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    return { channel: "x", status: "skipped", error: "X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET not configured" };
  }

  if (context.dryRun) {
    console.log("[dry-run] x post", JSON.stringify({ text: draft.copy.x, image: cardImageUrl(context, draft) }));
    return { channel: "x", status: "dry_run" };
  }

  const credentials: OAuthCredentials = { apiKey, apiSecret, accessToken, accessSecret };

  const imageResponse = await fetch(cardImageUrl(context, draft));
  if (!imageResponse.ok) {
    return { channel: "x", status: "failed", error: `Card render fetch returned ${imageResponse.status}` };
  }
  const mediaId = await uploadMedia(credentials, await imageResponse.arrayBuffer());

  const tweetUrl = "https://api.x.com/2/tweets";
  const response = await fetch(tweetUrl, {
    method: "POST",
    headers: {
      Authorization: oauthHeader(credentials, "POST", tweetUrl),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text: draft.copy.x, media: { media_ids: [mediaId] } })
  });

  if (!response.ok) {
    return { channel: "x", status: "failed", error: `X tweet create returned ${response.status}: ${(await response.text()).slice(0, 200)}` };
  }

  const body = (await response.json()) as { data?: { id?: string } };
  const id = body.data?.id ?? null;
  return { channel: "x", status: "posted", externalId: id, url: id ? `https://x.com/i/status/${id}` : null };
};
