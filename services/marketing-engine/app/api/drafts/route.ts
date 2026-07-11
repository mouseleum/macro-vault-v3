import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/api";
import { assertMarketingAuth } from "@/lib/auth";
import { createMarketingStore, isMissingMarketingTable, marketingSetupMessage } from "@/lib/marketing-store";

export const runtime = "nodejs";

const querySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "published"]).optional(),
  project: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

export async function GET(request: NextRequest) {
  const authError = assertMarketingAuth(request);
  if (authError) return authError;

  try {
    const input = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const store = createMarketingStore();
    const drafts = await store.listDrafts(input);
    return NextResponse.json({ drafts, count: drafts.length });
  } catch (error) {
    if (error && typeof error === "object" && isMissingMarketingTable(error as { code?: string; message?: string })) {
      return NextResponse.json({ setupRequired: true, message: marketingSetupMessage }, { status: 400 });
    }
    return jsonError(error);
  }
}
