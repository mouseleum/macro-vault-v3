import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/api";
import { assertMarketingAuth } from "@/lib/auth";
import { BLUESKY_LIMIT, X_LIMIT } from "@/lib/text";
import { createMarketingStore } from "@/lib/marketing-store";

export const runtime = "nodejs";

const patchSchema = z
  .object({
    copy: z
      .object({
        x: z.string().min(1).max(X_LIMIT),
        bluesky: z.string().min(1).max(BLUESKY_LIMIT),
        linkedin: z.string().min(1).max(8000)
      })
      .optional(),
    status: z.enum(["pending", "approved", "rejected"]).optional()
  })
  .refine((value) => value.copy || value.status, { message: "Provide copy and/or status." });

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const authError = assertMarketingAuth(request);
  if (authError) return authError;

  try {
    const { id } = await context.params;
    const store = createMarketingStore();
    const draft = await store.getDraft(id);
    if (!draft) return NextResponse.json({ error: "Draft not found" }, { status: 404 });

    const posts = await store.listPosts(id);
    return NextResponse.json({ draft, posts });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const authError = assertMarketingAuth(request);
  if (authError) return authError;

  try {
    const { id } = await context.params;
    const input = patchSchema.parse(await request.json());
    const store = createMarketingStore();

    const existing = await store.getDraft(id);
    if (!existing) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    if (existing.status === "published") {
      return NextResponse.json({ error: "Published drafts cannot be edited." }, { status: 409 });
    }

    const draft = await store.updateDraft(id, {
      ...(input.copy ? { copy: input.copy } : {}),
      ...(input.status ? { status: input.status, reviewed_at: new Date().toISOString() } : {})
    });
    return NextResponse.json({ draft });
  } catch (error) {
    return jsonError(error);
  }
}
