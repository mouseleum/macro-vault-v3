# Vercel Smoke Deploy Checklist

This is the first remote smoke deploy, not the final production launch.

## Goal

Prove that Macro Vault works outside localhost with:

- Vercel server runtime
- Supabase service-role access
- server-only environment variables
- authenticated downstream API calls
- the vault contract endpoint

## Before Pushing

Run locally:

```bash
npm run lint
npm run build
```

Never commit:

```txt
.env.local
.next
node_modules
.vercel
```

## GitHub

Create a GitHub repository for this folder and push the project.

Recommended repository name:

```txt
macro-vault-v3
```

## Vercel Import

In Vercel:

1. Add New Project.
2. Import the GitHub repository.
3. Framework Preset: Next.js.
4. Root Directory: repository root.
5. Build Command: `npm run build`.
6. Install Command: `npm install`.

For this smoke deploy, keep production reachable from the public internet by
turning Vercel Deployment Protection off. The app API should still reject
unauthenticated requests with Macro Vault's own `VAULT_API_KEY` check.

## Required Environment Variables

Add these to Vercel Project Settings -> Environment Variables:

```txt
VAULT_API_KEY
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
GEMINI_API_KEY
FRED_API_KEY
```

## Optional Environment Variables

Add now if available, otherwise leave for later:

```txt
FMP_API_KEY
GEMINI_MODEL
GEMINI_INTELLIGENCE_MODEL
EIA_API_KEY
RELIEFWEB_APP_NAME
APIFY_TOKEN
NEXT_PUBLIC_APP_NAME
```

Recommended Gemini defaults:

```txt
GEMINI_MODEL=gemini-2.5-flash-lite
GEMINI_INTELLIGENCE_MODEL=gemini-2.5-flash
NEXT_PUBLIC_APP_NAME=Macro Vault v3
```

## Supabase SQL

Confirm these have been run in Supabase:

```txt
supabase/schema.sql
supabase/sync_runs.sql
supabase/intelligence.sql
```

If Vercel shows missing tables after deploy, run:

```sql
notify pgrst, 'reload schema';
```

## First Remote Checks

Open the Vercel URL and run:

1. Deployment -> Check Health.
2. Dashboard -> confirm total series and observations load.
3. Series Explorer -> open one series.
4. API Health -> confirm required env is green.
5. API Access -> copy the Vault Contract endpoint.

Then test:

```bash
curl -H "Authorization: Bearer $VAULT_API_KEY" \
  "https://YOUR-VERCEL-URL/api/vault/contract"
```

And:

```bash
curl -H "Authorization: Bearer $VAULT_API_KEY" \
  "https://YOUR-VERCEL-URL/api/vault/series?limit=5"
```

## Success Criteria

The smoke deploy is good enough when:

- Vercel build passes.
- The Vercel URL opens without Vercel's own authentication page.
- Unauthenticated API calls return the app's `401`, not a Vercel protection page.
- `GET /api/vault/contract` works remotely.
- `GET /api/vault/series?limit=5` works remotely.
- Dashboard totals load.
- Required env vars are present.
- Optional connector failures are warnings, not blockers.

After this, downstream apps can attach using:

```txt
MACRO_VAULT_URL=https://YOUR-VERCEL-URL
MACRO_VAULT_API_KEY=<same vault key, server-side only>
```

Later hardening target: split dashboard/user access from the vault API contract.
Keep server-to-server vault access stable with project keys, then protect the
dashboard/workbench separately with Clerk.
