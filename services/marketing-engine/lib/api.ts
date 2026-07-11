import { NextResponse } from "next/server";

export function jsonError(error: unknown, status = 500) {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message
        : "Unexpected server error";
  return NextResponse.json({ error: message }, { status });
}

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function requestBaseUrl(request: Request) {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
