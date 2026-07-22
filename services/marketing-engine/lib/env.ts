const requiredServerEnv = [
  "MARKETING_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GEMINI_API_KEY"
] as const;

export type RequiredServerEnv = (typeof requiredServerEnv)[number];

export function getEnv(name: RequiredServerEnv): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function isDryRun() {
  const value = process.env.DRY_RUN?.trim().toLowerCase();
  return value === "1" || value === "true";
}

// The single dev-mode switch: fixture feeds, template copywriting, and the
// localhost auth bypass all key off non-production builds.
export function isDevMode() {
  return process.env.NODE_ENV !== "production";
}

// Local development without Supabase configured additionally runs against an
// in-memory store so the full pipeline works with zero secrets.
export function isDevWithoutSupabase() {
  return isDevMode() && !getOptionalEnv("SUPABASE_URL");
}
