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
