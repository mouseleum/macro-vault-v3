import type { ProjectProfile } from "../registry";
import type { MarketingDraft, PublishResult } from "@/types/marketing";

export type PublishContext = {
  // Public base URL of this engine deployment; the card image lives at
  // `${baseUrl}/api/render/${draft.id}`.
  baseUrl: string;
  dryRun: boolean;
};

export type ChannelAdapter = (
  draft: MarketingDraft,
  profile: ProjectProfile,
  context: PublishContext
) => Promise<PublishResult>;

export function cardImageUrl(context: PublishContext, draft: MarketingDraft) {
  return `${context.baseUrl}/api/render/${draft.id}`;
}

// How to record a non-OK response from an endpoint that CREATES a post.
// "failed" is a promise that nothing was delivered and a retry is safe, so it
// is reserved for responses the platform could only have produced before
// accepting the post (4xx validation/auth). A 5xx or 429 may well have been
// written before the error surfaced, so it is indeterminate and must not be
// retried without a human check. Responses from endpoints that only READ
// (fetching the card image) are always safe to call "failed".
export function writeFailureStatus(httpStatus: number): "failed" | "unknown" {
  return httpStatus >= 500 || httpStatus === 429 ? "unknown" : "failed";
}
