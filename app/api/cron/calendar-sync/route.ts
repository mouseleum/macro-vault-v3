import { NextRequest, NextResponse } from "next/server";
import { POST as syncEconomicCalendar } from "@/app/api/sync/economic-calendar/route";
import { assertVaultAuth } from "@/lib/auth";
import { getEnv, getOptionalEnv } from "@/lib/env";

export const runtime = "nodejs";

// Vercel Cron (see vercel.json) calls this with GET and
// `Authorization: Bearer ${CRON_SECRET}`. The vault key is also accepted so
// the job can be triggered manually.
export async function GET(request: NextRequest) {
  const cronSecret = getOptionalEnv("CRON_SECRET");
  const authHeader = request.headers.get("authorization");
  const isCronRequest = Boolean(cronSecret) && authHeader === `Bearer ${cronSecret}`;

  if (!isCronRequest) {
    const authError = assertVaultAuth(request);
    if (authError) return authError;
  }

  const syncRequest = new NextRequest(new URL("/api/sync/economic-calendar", request.url), {
    method: "POST",
    headers: { authorization: `Bearer ${getEnv("VAULT_API_KEY")}` },
    body: JSON.stringify({})
  });

  const response = await syncEconomicCalendar(syncRequest);
  const payload = await response.json().catch(() => null);

  return NextResponse.json(
    { ok: response.ok, cron: "calendar-sync", sync: payload },
    { status: response.status }
  );
}
