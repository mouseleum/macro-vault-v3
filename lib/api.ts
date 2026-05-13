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
