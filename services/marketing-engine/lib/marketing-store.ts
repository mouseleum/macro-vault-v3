import type { SupabaseClient } from "@supabase/supabase-js";
import { isDevWithoutSupabase } from "./env";
import { createSupabaseAdmin } from "./supabase";
import type {
  DraftStatus,
  MarketingDraft,
  MarketingPost,
  MarketingPostStatus
} from "@/types/marketing";

export const marketingSetupMessage =
  "Run services/marketing-engine/supabase/marketing.sql in the Supabase SQL Editor to enable the marketing engine.";

export type DraftInput = Omit<MarketingDraft, "id" | "status" | "created_at" | "reviewed_at">;

export type DraftFilters = {
  status?: DraftStatus;
  project?: string;
  limit?: number;
};

export type ClaimedDraft = {
  draft: MarketingDraft;
  // State the draft had before the claim, so failed/dry-run publishes can
  // restore it instead of escalating pending drafts to approved. reviewed_at is
  // restored too: the claim stamps it, and leaving it set would mark a
  // never-reviewed draft as human-approved.
  priorStatus: "pending" | "approved";
  priorReviewedAt: string | null;
};

// Why a claim was refused. "unresolved_outcome" is the important one: a prior
// attempt may or may not have reached the platform, so retrying needs an
// explicit human decision (force) rather than a plain retry.
export type ChannelClaim =
  | { ok: true; post: MarketingPost }
  | { ok: false; reason: "already_posted" | "unresolved_outcome" | "in_flight" };

export type ChannelPostOutcome = {
  status: Exclude<MarketingPostStatus, "pending">;
  external_id?: string | null;
  url?: string | null;
  error?: string | null;
};

export interface MarketingStore {
  listDrafts(filters?: DraftFilters): Promise<MarketingDraft[]>;
  getDraft(id: string): Promise<MarketingDraft | null>;
  // Returns null when the content hash already exists (duplicate → skip).
  createDraft(input: DraftInput): Promise<MarketingDraft | null>;
  updateDraft(
    id: string,
    patch: Partial<Pick<MarketingDraft, "copy" | "status" | "reviewed_at">>
  ): Promise<MarketingDraft>;
  // Atomically claims a pending/approved draft by setting it to "published";
  // returns null when the draft is already claimed, rejected, or missing —
  // the caller must not post to any channel without a successful claim.
  claimDraftForPublish(id: string): Promise<ClaimedDraft | null>;
  // Channel-level idempotency: inserts an in-flight "pending" row for
  // draft+channel, guarded by a partial unique index over pending/unknown rows
  // plus an explicit already-posted check. The caller must not call the channel
  // API unless this returns ok. `force` overrides an unresolved outcome and is
  // only for a human who has verified the platform themselves.
  claimChannelPost(
    draftId: string,
    channel: MarketingPost["channel"],
    options?: { force?: boolean }
  ): Promise<ChannelClaim>;
  // Resolves an in-flight claim to its terminal status.
  resolveChannelPost(postId: string, outcome: ChannelPostOutcome): Promise<MarketingPost>;
  listContentHashes(project: string): Promise<Set<string>>;
  countDraftsSince(project: string, sinceIso: string): Promise<number>;
  listPosts(draftId: string): Promise<MarketingPost[]>;
}

function isUniqueViolation(error: { code?: string; message?: string }) {
  return error.code === "23505" || Boolean(error.message?.includes("duplicate key"));
}

// An in-flight claim older than this is treated as a crashed run and can be
// superseded (publish maxDuration is 120s, so 10 minutes is safely past it).
const STALE_CLAIM_MS = 10 * 60 * 1000;

function isStalePending(post: MarketingPost) {
  return post.status === "pending" && Date.now() - new Date(post.posted_at).getTime() > STALE_CLAIM_MS;
}

class SupabaseMarketingStore implements MarketingStore {
  private supabase: SupabaseClient;

  constructor() {
    this.supabase = createSupabaseAdmin();
  }

  async listDrafts(filters: DraftFilters = {}) {
    let query = this.supabase.from("marketing_drafts").select("*");
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.project) query = query.eq("project", filters.project);

    const { data, error } = await query.order("created_at", { ascending: false }).limit(filters.limit ?? 50);
    if (error) throw error;
    return (data ?? []) as MarketingDraft[];
  }

  async getDraft(id: string) {
    const { data, error } = await this.supabase.from("marketing_drafts").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data ?? null) as MarketingDraft | null;
  }

  async createDraft(input: DraftInput) {
    const { data, error } = await this.supabase.from("marketing_drafts").insert(input).select("*").single();
    if (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
    return data as MarketingDraft;
  }

  async updateDraft(id: string, patch: Partial<Pick<MarketingDraft, "copy" | "status" | "reviewed_at">>) {
    const { data, error } = await this.supabase
      .from("marketing_drafts")
      .update(patch)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw error;
    return data as MarketingDraft;
  }

  async claimDraftForPublish(id: string) {
    // Read first so priorStatus/priorReviewedAt are known exactly, then claim
    // with a conditional update on that status. Retried because the status can
    // move between the read and the update: a single .in() update would be
    // atomic but would not reveal which status it replaced, while testing each
    // status in a fixed order could miss a draft that changed mid-sequence.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.getDraft(id);
      if (!current) return null;
      if (current.status !== "pending" && current.status !== "approved") return null;
      const priorStatus = current.status;

      const { data, error } = await this.supabase
        .from("marketing_drafts")
        .update({ status: "published", reviewed_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", priorStatus)
        .select("*");
      if (error) throw error;
      if (data?.[0]) {
        return { draft: data[0] as MarketingDraft, priorStatus, priorReviewedAt: current.reviewed_at };
      }
    }
    return null;
  }

  async claimChannelPost(
    draftId: string,
    channel: MarketingPost["channel"],
    options: { force?: boolean } = {}
  ): Promise<ChannelClaim> {
    const { data: existing, error: existingError } = await this.supabase
      .from("marketing_posts")
      .select("*")
      .eq("draft_id", draftId)
      .eq("channel", channel)
      .in("status", ["posted", "pending", "unknown"]);
    if (existingError) throw existingError;
    const rows = (existing ?? []) as MarketingPost[];

    // "posted" is not in the claim index (see marketing.sql), so it is checked
    // here instead. force does NOT override this: a confirmed live post must
    // never be duplicated by a retry meant for an unresolved one.
    if (rows.some((row) => row.status === "posted")) {
      return { ok: false, reason: "already_posted" };
    }
    if (rows.some((row) => row.status === "pending" && !isStalePending(row))) {
      return { ok: false, reason: "in_flight" };
    }

    // A crashed run's claim has an indeterminate outcome — the post may have
    // landed before the function died — so it becomes "unknown", never
    // "failed", and cannot be retried without an explicit force.
    const stale = rows.filter((row) => isStalePending(row));
    for (const row of stale) {
      const { error } = await this.supabase
        .from("marketing_posts")
        .update({ status: "unknown", error: "publish did not finish; outcome unknown" })
        .eq("id", row.id)
        .eq("status", "pending");
      if (error) throw error;
    }

    const unresolved = stale.length > 0 || rows.some((row) => row.status === "unknown");
    if (unresolved && !options.force) return { ok: false, reason: "unresolved_outcome" };

    if (options.force) {
      // Scoped to the ids just read, never to (draft_id, channel): a broad
      // update would also clear a live claim inserted after the read, vacating
      // the index slot and letting two publishes post at once.
      const supersede = rows.filter((row) => row.status === "pending" || row.status === "unknown").map((row) => row.id);
      if (supersede.length > 0) {
        const { error } = await this.supabase
          .from("marketing_posts")
          .update({ status: "failed", error: "superseded by forced retry" })
          .in("id", supersede);
        if (error) throw error;
      }
    }

    const { data, error } = await this.supabase
      .from("marketing_posts")
      .insert({ draft_id: draftId, channel, status: "pending", external_id: null, url: null, error: null })
      .select("*")
      .single();
    if (error) {
      // Lost the race to a concurrent claim; the index kept one winner.
      if (isUniqueViolation(error)) return { ok: false, reason: "in_flight" };
      throw error;
    }
    const claim = data as MarketingPost;

    // Re-check for a posted row now that the claim is held. "posted" is not in
    // the claim index, so a concurrent publish that finished between the read
    // above and this insert would otherwise go undetected and post twice. The
    // claim is released before returning so the channel stays usable.
    const { data: postedRows, error: postedError } = await this.supabase
      .from("marketing_posts")
      .select("id")
      .eq("draft_id", draftId)
      .eq("channel", channel)
      .eq("status", "posted")
      .limit(1);
    if (postedError) throw postedError;
    if ((postedRows ?? []).length > 0) {
      await this.supabase
        .from("marketing_posts")
        .update({ status: "skipped", error: "another publish posted this channel first" })
        .eq("id", claim.id);
      return { ok: false, reason: "already_posted" };
    }

    return { ok: true, post: claim };
  }

  async resolveChannelPost(postId: string, outcome: ChannelPostOutcome) {
    const { data, error } = await this.supabase
      .from("marketing_posts")
      .update({
        status: outcome.status,
        external_id: outcome.external_id ?? null,
        url: outcome.url ?? null,
        error: outcome.error ?? null,
        posted_at: new Date().toISOString()
      })
      .eq("id", postId)
      .select("*")
      .single();
    if (error) throw error;
    return data as MarketingPost;
  }

  async listContentHashes(project: string) {
    const { data, error } = await this.supabase
      .from("marketing_drafts")
      .select("content_hash")
      .eq("project", project)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error) throw error;
    return new Set((data ?? []).map((row) => row.content_hash as string));
  }

  async countDraftsSince(project: string, sinceIso: string) {
    const { count, error } = await this.supabase
      .from("marketing_drafts")
      .select("id", { count: "exact", head: true })
      .eq("project", project)
      .gte("created_at", sinceIso);
    if (error) throw error;
    return count ?? 0;
  }

  async listPosts(draftId: string) {
    const { data, error } = await this.supabase
      .from("marketing_posts")
      .select("*")
      .eq("draft_id", draftId)
      .order("posted_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as MarketingPost[];
  }
}

// In-memory store for local development without Supabase. State survives HMR
// via globalThis; it is never used in production.
type MemoryState = {
  drafts: MarketingDraft[];
  posts: MarketingPost[];
};

function memoryState(): MemoryState {
  const holder = globalThis as { __marketingMemoryStore?: MemoryState };
  holder.__marketingMemoryStore ??= { drafts: [], posts: [] };
  return holder.__marketingMemoryStore;
}

class MemoryMarketingStore implements MarketingStore {
  async listDrafts(filters: DraftFilters = {}) {
    return memoryState()
      .drafts.filter((draft) => !filters.status || draft.status === filters.status)
      .filter((draft) => !filters.project || draft.project === filters.project)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, filters.limit ?? 50);
  }

  async getDraft(id: string) {
    return memoryState().drafts.find((draft) => draft.id === id) ?? null;
  }

  async createDraft(input: DraftInput) {
    const state = memoryState();
    if (state.drafts.some((draft) => draft.content_hash === input.content_hash)) return null;
    const draft: MarketingDraft = {
      ...input,
      id: crypto.randomUUID(),
      status: "pending",
      created_at: new Date().toISOString(),
      reviewed_at: null
    };
    state.drafts.unshift(draft);
    return draft;
  }

  async updateDraft(id: string, patch: Partial<Pick<MarketingDraft, "copy" | "status" | "reviewed_at">>) {
    const state = memoryState();
    const existing = state.drafts.find((draft) => draft.id === id);
    if (!existing) throw new Error("Draft not found");
    Object.assign(existing, patch);
    return existing;
  }

  async claimDraftForPublish(id: string) {
    const existing = memoryState().drafts.find((draft) => draft.id === id);
    if (!existing || (existing.status !== "pending" && existing.status !== "approved")) return null;
    const priorStatus = existing.status;
    const priorReviewedAt = existing.reviewed_at;
    existing.status = "published";
    existing.reviewed_at = new Date().toISOString();
    return { draft: existing, priorStatus, priorReviewedAt };
  }

  // Mirrors the Supabase precedence exactly so dev behaviour matches prod.
  async claimChannelPost(
    draftId: string,
    channel: MarketingPost["channel"],
    options: { force?: boolean } = {}
  ): Promise<ChannelClaim> {
    const state = memoryState();
    const rows = state.posts.filter(
      (post) =>
        post.draft_id === draftId &&
        post.channel === channel &&
        (post.status === "posted" || post.status === "pending" || post.status === "unknown")
    );

    // force does NOT override a confirmed post — same rule as Supabase.
    if (rows.some((row) => row.status === "posted")) {
      return { ok: false, reason: "already_posted" };
    }
    if (rows.some((row) => row.status === "pending" && !isStalePending(row))) {
      return { ok: false, reason: "in_flight" };
    }

    const stale = rows.filter((row) => isStalePending(row));
    for (const row of stale) {
      row.status = "unknown";
      row.error = "publish did not finish; outcome unknown";
    }

    const unresolved = stale.length > 0 || rows.some((row) => row.status === "unknown");
    if (unresolved && !options.force) return { ok: false, reason: "unresolved_outcome" };

    if (options.force) {
      for (const row of rows) {
        if (row.status === "pending" || row.status === "unknown") {
          row.status = "failed";
          row.error = "superseded by forced retry";
        }
      }
    }

    const claim: MarketingPost = {
      id: crypto.randomUUID(),
      draft_id: draftId,
      channel,
      external_id: null,
      url: null,
      status: "pending",
      error: null,
      posted_at: new Date().toISOString()
    };
    state.posts.unshift(claim);
    return { ok: true, post: claim };
  }

  async resolveChannelPost(postId: string, outcome: ChannelPostOutcome) {
    const existing = memoryState().posts.find((post) => post.id === postId);
    if (!existing) throw new Error("Post claim not found");
    existing.status = outcome.status;
    existing.external_id = outcome.external_id ?? null;
    existing.url = outcome.url ?? null;
    existing.error = outcome.error ?? null;
    existing.posted_at = new Date().toISOString();
    return existing;
  }

  async listContentHashes(project: string) {
    return new Set(
      memoryState()
        .drafts.filter((draft) => draft.project === project)
        .map((draft) => draft.content_hash)
    );
  }

  async countDraftsSince(project: string, sinceIso: string) {
    return memoryState().drafts.filter((draft) => draft.project === project && draft.created_at >= sinceIso).length;
  }

  async listPosts(draftId: string) {
    return memoryState().posts.filter((post) => post.draft_id === draftId);
  }
}

export function createMarketingStore(): MarketingStore {
  return isDevWithoutSupabase() ? new MemoryMarketingStore() : new SupabaseMarketingStore();
}

export function isMissingMarketingTable(error: { code?: string; message?: string }) {
  // Only genuine "relation does not exist" conditions. Matching on the table
  // name alone misreported RLS denials, check-constraint violations and
  // statement timeouts as a missing-table setup problem, and downgraded those
  // 500s to 400s — sending operators to re-run a migration that was fine.
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  const message = error.message ?? "";
  if (!/marketing_drafts|marketing_posts/.test(message)) return false;
  return /does not exist|could not find the table/i.test(message);
}
