const acledTokenUrl = "https://acleddata.com/oauth/token";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

// Module-scope cache: ACLED issues tokens via a password grant, which is rate
// limited per account, so reuse the token across requests within a warm lambda
// instead of re-authenticating on every call.
let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getAcledToken(
  email: string,
  password: string,
  options: { signal?: AbortSignal } = {}
) {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  const body = new URLSearchParams({
    username: email,
    password,
    grant_type: "password",
    client_id: "acled",
    scope: "authenticated"
  });
  const response = await fetch(acledTokenUrl, {
    method: "POST",
    cache: "no-store",
    signal: options.signal,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload = await response.json().catch(() => null);
  const token = isRecord(payload) ? stringValue(payload.access_token) : null;

  if (!response.ok || !token) {
    const message = isRecord(payload) ? stringValue(payload.error_description) ?? stringValue(payload.message) : null;
    throw new Error(`ACLED OAuth failed: HTTP ${response.status}${message ? ` - ${message}` : ""}`);
  }

  const expiresInRaw = isRecord(payload) ? Number(payload.expires_in) : NaN;
  const expiresInSeconds = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? expiresInRaw : 3600;
  // Refresh five minutes early so a token never expires mid-request.
  cachedToken = { token, expiresAt: Date.now() + Math.max(expiresInSeconds - 300, 60) * 1000 };
  return token;
}
