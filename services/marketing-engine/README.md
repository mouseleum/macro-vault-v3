# Marketing Engine

A standalone service that turns project data into shareable marketing content:
it pulls "highlights" from registered projects on a daily cron, writes
per-channel copy with Gemini, renders a branded 1200×675 data card, queues
everything for **human review**, and publishes approved drafts to X, Bluesky,
LinkedIn (via Zapier), and a generic Zapier fan-out webhook.

It lives in this repo for convenience but shares no code with the vault app —
only the HTTP contract in `../../docs/marketing-contract.md` — so it deploys as
its own Vercel project and can be extracted to its own repo by moving this
directory.

## How it works

```
project feeds ──► /api/cron/generate ──► marketing_drafts (pending)
 (highlights)      select · dedupe            │
                   copywrite · score          ▼
                                        Review UI (/)
                                        edit copy · card preview
                                              │ approve
                                              ▼
                                        /api/publish ──► zapier · bluesky · x · linkedin
                                              │
                                              ▼
                                        marketing_posts (audit log)
```

- **Selection** (`lib/select.ts`): drops expired highlights, applies the
  project's severity threshold, dedupes by content hash, caps drafts/day, and
  lets Gemini break ties when there are more candidates than slots.
- **Copy** (`lib/copywriter.ts`): one Gemini call per draft returns X (≤280),
  Bluesky (≤300), and LinkedIn variants in the project's voice.
- **Card** (`app/api/render/[draftId]/route.tsx`): satori-rendered PNG — brand
  accent, severity chip, up to 3 stat tiles, optional sparkline. The route is
  public (unguessable UUID) so social channels can fetch it.
- **Publishing** (`lib/channels/`): every adapter is skipped (never fatal) until
  its env vars exist; `DRY_RUN=1` logs payloads instead of posting.
- **Registry** (`lib/registry.ts`): one entry per project — feed URL env, brand,
  voice prompt, channels, thresholds. Adding a project is adding an entry.

## Local development — zero secrets needed

```bash
npm install
npm run dev            # http://localhost:3100
```

With no `SUPABASE_URL` set, the engine uses an in-memory store, the bundled
fixture feed (`lib/fixtures/sample-highlights.json`), and template copywriting
(no Gemini). Auth is bypassed on localhost. Open the review UI, hit
**RUN GENERATE NOW**, and walk the whole pipeline; set `DRY_RUN=1` to inspect
publish payloads in the dev server log.

Set `GEMINI_API_KEY` locally to exercise real copywriting against the fixture.

## Production setup

1. **Vercel**: create a new project from this repo with **Root Directory**
   `services/marketing-engine`. The cron in `vercel.json` runs
   `/api/cron/generate` daily at 06:30 UTC (after the vault's syncs).
2. **Supabase**: run `supabase/marketing.sql` in the SQL editor (the vault's
   Supabase project or a separate one).
3. **Env vars**: copy `.env.example` into Vercel. Minimum:
   `MARKETING_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `GEMINI_API_KEY`, `VAULT_FEED_URL`, `VAULT_API_KEY`, plus `CRON_SECRET`.
4. **Channels** (each optional; unconfigured = skipped):
   - `ZAPIER_WEBHOOK_URL` — generic fan-out catch hook.
   - `BLUESKY_IDENTIFIER` + `BLUESKY_APP_PASSWORD` — app password from Bluesky
     settings; free.
   - `X_API_KEY/SECRET` + `X_ACCESS_TOKEN/SECRET` — needs the paid Basic tier.
   - `LINKEDIN_ZAPIER_WEBHOOK_URL` — a Zap wired to a LinkedIn share action.
5. Recommended first run: set `DRY_RUN=1`, approve a draft, check the logs,
   then clear the flag.

## Adding a project

1. Implement the highlights contract (`../../docs/marketing-contract.md`) —
   one authenticated JSON endpoint, a static `highlights.json`, **or a
   repo-local feed file** in `feeds/` (for manual marketing with no endpoint:
   edit JSON → commit → deploy; register it in `feeds/index.ts`).
2. Add a `ProjectProfile` to `lib/registry.ts` (brand, voice, channels,
   thresholds) and set its feed env vars and/or `feedFile`.
3. Done — the next cron run picks it up.

## Music projects

Two music profiles ship enabled with manual feed files: `artist` (your
releases — **edit the EDIT-ME brand/handle/voice in `lib/registry.ts` and the
starter content in `feeds/artist.json`**) and `song-blueprint`
(`feeds/song-blueprint.json`). Music highlights use the optional `media`
contract field: `coverImageUrl` renders square art on the card (a branded
gradient placeholder is used when null), `waveform` (0–1 amplitudes) draws a
waveform strip instead of the sparkline, and `links` (Spotify/Bandcamp/…)
are woven into the generated copy. Release `milestone` highlights drop the
severity chip on the card.

## API

All routes take `Authorization: Bearer <MARKETING_API_KEY>` (localhost is
open in dev). `/api/render/[draftId]` is public.

| Route | Purpose |
| --- | --- |
| `GET /api/cron/generate` | Pull feeds → create pending drafts (cron; also `CRON_SECRET`) |
| `GET /api/drafts?status=pending` | List drafts |
| `GET /api/drafts/:id` | Draft + its publish log |
| `PATCH /api/drafts/:id` | Edit copy / set status (approve, reject, reopen) |
| `POST /api/publish` | `{draftId, channels?}` → publish + record `marketing_posts` |
| `GET /api/render/:draftId` | The share-card PNG |
