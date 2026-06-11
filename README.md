# Macro Vault v3

A clean private macro data vault for Vercel + Supabase.

## Goals

- Keep all privileged keys server-side.
- Use one simple `VAULT_API_KEY` for private API access in v1.
- Store macro series and observations in Supabase.
- Add data integrations one at a time.
- Treat dashboard and interpretation surfaces as downstream consumers, not the core vault product.

## Product Boundary

Macro Vault is the storage, ingestion, curation, provenance, and private API layer.
It can include light workbench views for testing and review, but polished macro
dashboards should be separate apps that consume the vault API.

Good vault responsibilities:

- Sync and store series, observations, calendar events, source documents, candidates, and sync logs.
- Preserve provenance, metadata, prep notes, and reviewed/promoted intelligence.
- Expose stable authenticated API contracts for other projects.

Good downstream-app responsibilities:

- Render macro dashboards, scorecards, asymmetry views, and trading workflows.
- Consume `/api/vault/*` endpoints rather than writing directly to Supabase.
- Own product-specific UI and interpretation logic.

## Later Roadmap

- Split the deployed surface into a clean option 4 architecture: a stable
  server-to-server vault API protected by project keys, plus a dashboard/workbench
  protected separately with Clerk or another user auth layer.
- Add Alpha Vantage as an optional market-proxy connector for daily reaction assets such as SPY, QQQ, IWM, TLT, HYG, LQD, GLD, UUP, oil, copper, and natural gas. Keep this after the core FMP calendar, FRED, regime, intelligence, Vercel, and Clerk work because the free tier is useful but limited.

## Data Source Roadmap

Active connector priorities:

- EIA physical energy data: oil, gas, inventories, production, and refinery utilization.
- Eurostat EU macro data: HICP inflation, unemployment, and real GDP growth.
- GDELT global news metadata: supply, credit, liquidity, and geopolitical stress events.
- CFTC Commitments of Traders: leveraged-fund, asset-manager, managed-money, dealer, and open-interest positioning.
- ReliefWeb humanitarian stress reports: conflict, displacement, food stress, and disaster metadata.
- ACLED conflict event data: battles, protests, riots, explosions, civilian violence, actors, fatalities, and locations.
- USGS earthquake telemetry: significant seismic events with magnitude, depth, alert, and coordinates.
- FAA NAS Status: U.S. airport closures, ground stops, delay programs, deicing, and enroute flow constraints.
- U.S. Treasury FiscalData: TGA balances, Treasury cash flows, and public debt outstanding.

Next connector candidates:

- NASA FIRMS for fire and heat anomaly telemetry.
- Alpha Vantage as a later market proxy connector after the core vault is deployed.

## Local Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000` and run the health check. Localhost development
uses a local-only auth bypass, so you do not need to paste `VAULT_API_KEY` while
working locally. Production deployments still require the bearer token.

## Private Vault API

All vault endpoints require:

```txt
Authorization: Bearer <VAULT_API_KEY>
```

Stable read endpoints for downstream projects:

```txt
GET /api/vault/contract
GET /api/vault/series
GET /api/vault/series?provider=world_bank&country=US
GET /api/vault/series?q=inflation&limit=25
GET /api/vault/observations?code=WB_US_NY_GDP_MKTP_CD&provider=world_bank&country=US&limit=25
GET /api/vault/observations?code=WB_US_NY_GDP_MKTP_CD&provider=world_bank&country=US&start=2015-01-01&end=2025-12-31&order=asc&limit=250
GET /api/vault/latest?code=WB_US_NY_GDP_MKTP_CD&provider=world_bank&country=US
GET /api/vault/regime
GET /api/vault/events?limit=100
GET /api/vault/dashboard-feed?days=30&limit=10
GET /api/knowledge/documents?limit=25
GET /api/intelligence/candidates?limit=40
```

Observation history supports `start`, `end`, `order=asc|desc`, and `limit`.
Series listing supports `provider`, `country`, `q`, and `limit`.
The dashboard feed packages a downstream-ready payload with vault totals, the
latest regime, upcoming macro-critical events, realized surprises, and promoted
narrative signals.

Mutation and sync endpoints stay server-authenticated too:

```txt
POST /api/sync/worldbank
POST /api/sync/fred
POST /api/sync/eia
POST /api/sync/eurostat
POST /api/sync/gdelt
POST /api/sync/reliefweb
POST /api/sync/acled
POST /api/sync/usgs
POST /api/sync/faa
POST /api/sync/treasury
POST /api/sync/cftc
POST /api/sync/fx
POST /api/sync/fear-greed
POST /api/sync/economic-calendar
POST /api/regime
POST /api/knowledge/documents
POST /api/intelligence/extract
POST /api/intelligence/candidates
PATCH /api/intelligence/candidates/:id
POST /api/intelligence/candidates/:id/promote
```

For downstream apps, prefer `POST /api/intelligence/candidates` as the main
write lane. It stores reviewable pending candidates with `sourceProject`,
provenance, confidence, and metadata. Promote only trusted candidates into
canonical observations or macro events.

Recent connector runs are exposed at:

```txt
GET /api/vault/sync-runs?limit=40
```

## Vercel Environment Variables

Set these in Vercel Project Settings:

- `VAULT_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY`
- `GEMINI_MODEL` optional; defaults to `gemini-2.5-flash-lite`
- `GEMINI_INTELLIGENCE_MODEL` optional; defaults to `GEMINI_MODEL`, then `gemini-2.5-flash`
- `FRED_API_KEY`
- `EIA_API_KEY` optional for the EIA physical energy connector
- `RELIEFWEB_APP_NAME` optional for the ReliefWeb connector; ReliefWeb requires an approved appname
- `ACLED_EMAIL` and `ACLED_PASSWORD` optional for the ACLED connector; ACLED uses myACLED OAuth credentials and may require account-level API access
- `FMP_API_KEY` optional for the economic calendar connector's `fmp` provider (post-release actuals require a paid FMP plan); the default `forex_factory` provider uses the free Forex Factory weekly feed and needs no key
- `APIFY_TOKEN` optional; staged for later Apify actor imports

## Supabase

Run `supabase/schema.sql` in the Supabase SQL editor before syncing data.

For persistent sync run history, also run `supabase/sync_runs.sql`. The app and
sync endpoints continue to work before this table exists, but the Sync Logs page
will show a setup-required message until it is installed.

For Knowledge Base, Web Intelligence, and Macro Events, run
`supabase/intelligence.sql`. These tables store source documents, reviewable
extracted candidates, and promoted or calendar-synced event records. Numeric
candidate signals are not written into `macro_observations` until you explicitly
promote them from the app.

If you already have a Supabase database, first run
`supabase/diagnostics/check_existing_schema.sql` in the SQL editor. It is read-only
and reports whether the existing schema can support this project.

## Vault Contract

The formal downstream-app contract lives in `docs/vault-contract.md` and is
also available as JSON:

```txt
GET /api/vault/contract
```

Future projects should connect with `MACRO_VAULT_URL` and
`MACRO_VAULT_API_KEY`, call stable read endpoints server-to-server, and write
new reusable signals through the intelligence candidate queue instead of direct
Supabase browser writes.

## First Vercel Smoke Deploy

Deploy when local checks pass and the core vault API is stable enough to test in
production. This first deploy is only a smoke test, not the final release.

For the smoke deploy, Vercel Deployment Protection should be off for production
so downstream projects can reach the app. Macro Vault API routes remain protected
by `Authorization: Bearer <VAULT_API_KEY>`.

1. Push the project to a GitHub repository.
2. Import the repository in Vercel as a Next.js project.
3. Add every environment variable listed above.
4. Run the Supabase SQL files: `schema.sql`, `sync_runs.sql`, and optionally `intelligence.sql`.
5. Deploy.
6. Open the Vercel URL, paste `VAULT_API_KEY`, then run:
   - Check Health
   - Load Series
   - View observations for one series
   - Open Knowledge Base and Web Intelligence if `intelligence.sql` is installed
7. Test one downstream-style API call with `Authorization: Bearer <VAULT_API_KEY>`.

## Intelligence Workflow

The vault separates unstructured extraction from canonical data:

1. Add permitted source material in Knowledge Base, or run a grounded web extraction.
2. Review extracted candidates in Web Intelligence.
3. Approve or reject candidates.
4. Promote only numeric candidates you trust into `macro_series` and `macro_observations`; promote event candidates into `macro_events`.

Economic calendar syncs also write into `macro_events`. Treat those rows as
context and scheduling metadata, not canonical time-series observations.

Avoid storing full paywalled or copyrighted articles unless you have rights to
use that content. Prefer your own notes, public documents, source metadata,
short excerpts, and derived candidate observations.
