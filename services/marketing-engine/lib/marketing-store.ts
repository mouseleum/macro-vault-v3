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

export type PostInput = {
  draft_id: string;
  channel: MarketingPost["channel"];
  external_id: string | null;
  url: string | null;
  status: MarketingPostStatus;
  error: string | null;
};

export type DraftFilters = {
  status?: DraftStatus;
  project?: string;
  limit?: number;
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
  claimDraftForPublish(id: string): Promise<MarketingDraft | null>;
  listContentHashes(project: string): Promise<Set<string>>;
  countDraftsSince(project: string, sinceIso: string): Promise<number>;
  createPosts(posts: PostInput[]): Promise<MarketingPost[]>;
  listPosts(draftId: string): Promise<MarketingPost[]>;
}

function isUniqueViolation(error: { code?: string; message?: string }) {
  return error.code === "23505" || Boolean(error.message?.includes("duplicate key"));
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
    const { data, error } = await this.supabase
      .from("marketing_drafts")
      .update({ status: "published", reviewed_at: new Date().toISOString() })
      .eq("id", id)
      .in("status", ["pending", "approved"])
      .select("*");
    if (error) throw error;
    return (data?.[0] ?? null) as MarketingDraft | null;
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

  async createPosts(posts: PostInput[]) {
    if (posts.length === 0) return [];
    const { data, error } = await this.supabase.from("marketing_posts").insert(posts).select("*");
    if (error) throw error;
    return (data ?? []) as MarketingPost[];
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
    existing.status = "published";
    existing.reviewed_at = new Date().toISOString();
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

  async createPosts(posts: PostInput[]) {
    const created = posts.map((post) => ({
      ...post,
      id: crypto.randomUUID(),
      posted_at: new Date().toISOString()
    }));
    memoryState().posts.unshift(...created);
    return created;
  }

  async listPosts(draftId: string) {
    return memoryState().posts.filter((post) => post.draft_id === draftId);
  }
}

export function createMarketingStore(): MarketingStore {
  return isDevWithoutSupabase() ? new MemoryMarketingStore() : new SupabaseMarketingStore();
}

export function isMissingMarketingTable(error: { code?: string; message?: string }) {
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    Boolean(error.message?.includes("marketing_drafts")) ||
    Boolean(error.message?.includes("marketing_posts"))
  );
}
