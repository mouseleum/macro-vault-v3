import { NextResponse } from "next/server";
import { getEnvStatus, getOptionalEnv } from "@/lib/env";

export const runtime = "nodejs";

export async function GET() {
  const env = getEnvStatus();

  return NextResponse.json({
    ok: Object.values(env).every(Boolean),
    env,
    optional: {
      FRED_API_KEY: Boolean(getOptionalEnv("FRED_API_KEY"))
    },
    timestamp: new Date().toISOString()
  });
}
