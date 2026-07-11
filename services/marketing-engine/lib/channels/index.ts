import { publishToBluesky } from "./bluesky";
import { publishToLinkedIn } from "./linkedin";
import { publishToX } from "./x";
import { publishToZapier } from "./zapier";
import type { ChannelAdapter } from "./types";
import type { ChannelId } from "@/types/marketing";

export const channelAdapters: Record<ChannelId, ChannelAdapter> = {
  zapier: publishToZapier,
  bluesky: publishToBluesky,
  x: publishToX,
  linkedin: publishToLinkedIn
};

export type { PublishContext } from "./types";
