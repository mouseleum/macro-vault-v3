import { NextRequest, NextResponse } from "next/server";
import { getEnv, getOptionalEnv } from "./env";

function isLocalDevRequest(request: NextRequest) {
  if (process.env.NODE_ENV === "production") return false;

  const host = request.headers.get("host")?.split(":")[0];
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function suppliedKey(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  return bearer || request.headers.get("x-marketing-key")?.trim() || "";
}

export function assertMarketingAuth(request: NextRequest): NextResponse | null {
  if (isLocalDevRequest(request)) return null;

  const key = suppliedKey(request);
  if (!key || key !== getEnv("MARKETING_API_KEY")) {
    return NextResponse.json(
      { error: "Unauthorized", details: "Provide Authorization: Bearer <MARKETING_API_KEY>." },
      { status: 401 }
    );
  }

  return null;
}

// Cron requests carry CRON_SECRET (injected by Vercel); manual triggers may
// use MARKETING_API_KEY instead — same convention as the vault's cron routes.
export function assertCronAuth(request: NextRequest): NextResponse | null {
  if (isLocalDevRequest(request)) return null;

  const key = suppliedKey(request);
  const cronSecret = getOptionalEnv("CRON_SECRET");
  if (key && cronSecret && key === cronSecret) return null;
  if (key && key === getEnv("MARKETING_API_KEY")) return null;

  // Vercel only attaches the Authorization header to cron invocations when
  // the CRON_SECRET env var exists on the project — an unauthenticated cron
  // hit is almost always that missing configuration, so say so loudly.
  const isVercelCron = request.headers.get("user-agent")?.includes("vercel-cron") ?? false;
  if (isVercelCron && !key) {
    console.error(
      "[cron] Vercel cron request arrived with no Authorization header — set the CRON_SECRET env var on this project (and redeploy) or scheduled generation will never run."
    );
  }

  return NextResponse.json(
    {
      error: "Unauthorized",
      details:
        isVercelCron && !key
          ? "Vercel cron carries no auth until the CRON_SECRET env var is set on the project."
          : "Provide Authorization: Bearer <CRON_SECRET or MARKETING_API_KEY>."
    },
    { status: 401 }
  );
}
