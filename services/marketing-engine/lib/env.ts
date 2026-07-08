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

export function getEnvStatus() {
  return Object.fromEntries(
    requiredServerEnv.map((name) => [name, Boolean(process.env[name]?.trim())])
  ) as Record<RequiredServerEnv, boolean>;
}

export function isDryRun() {
  const value = process.env.DRY_RUN?.trim().toLowerCase();
  return value === "1" || value === "true";
}

// Local development (next dev, no Supabase configured) runs against an
// in-memory store and template copywriting so the full pipeline can be
// exercised without any secrets.
export function isDevWithoutSupabase() {
  return process.env.NODE_ENV !== "production" && !getOptionalEnv("SUPABASE_URL");
}
