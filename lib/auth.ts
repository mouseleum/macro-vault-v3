import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "./env";

function isLocalDevRequest(request: NextRequest) {
  if (process.env.NODE_ENV === "production") return false;

  const host = request.headers.get("host")?.split(":")[0];
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function assertVaultAuth(request: NextRequest): NextResponse | null {
  if (isLocalDevRequest(request)) return null;

  const configuredKey = getEnv("VAULT_API_KEY");
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  const vaultHeader = request.headers.get("x-vault-key")?.trim();
  const suppliedKey = bearer || vaultHeader;

  if (!suppliedKey || suppliedKey !== configuredKey) {
    return NextResponse.json(
      { error: "Unauthorized", details: "Provide Authorization: Bearer <VAULT_API_KEY>." },
      { status: 401 }
    );
  }

  return null;
}
