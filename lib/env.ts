const requiredServerEnv = [
  "VAULT_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
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
