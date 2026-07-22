# Marketing Highlights Contract

Any project can plug into the standalone marketing engine (`services/marketing-engine`)
by exposing **one authenticated JSON endpoint**. The engine polls it on a daily cron,
turns the best highlights into branded share cards + per-channel copy, and queues them
for human review before publishing.

## Endpoint

```
GET /api/marketing/highlights
Authorization: Bearer <project API key>
```

The path is conventional, not required — the engine's registry stores the full feed URL,
so a static `highlights.json` behind a CDN works too (e.g. for frontend-only projects
like visual-alarmist).

Projects with no endpoint at all (manual marketing: releases, announcements) can
instead ship a **repo-local feed file** in `services/marketing-engine/feeds/` and
reference it from their registry profile via `feedFile` — edit the JSON, commit,
deploy. The `project` field must match the profile slug; the engine rejects
mismatched feeds to catch mis-wired env vars.

## Response shape

```jsonc
{
  "project": "macro-vault",              // stable project slug, matches registry entry
  "generatedAt": "2026-07-08T06:00:00Z",
  "highlights": [
    {
      "id": "opportunity-abc123",        // stable + unique; engine dedupes on content
      "type": "alert",                   // "alert" | "stat" | "surprise" | "event" | "milestone"
      "headline": "BTC MVRV crosses 3.2 — historically frothy",
      "narrative": "1–3 plain-language sentences telling the story.",
      "severity": "high",                // "low" | "medium" | "high" | "extreme"
      "metrics": [                        // 0–4 entries; rendered as the card's stat row
        { "label": "MVRV", "value": "3.21", "delta": "+0.4 / 30d" }
      ],
      "sparkline": [                      // optional; rendered as a mini chart on the card
        { "t": "2026-06-01", "v": 2.8 }
      ],
      "link": "https://…",               // optional CTA URL included in the post copy
      "tags": ["bitcoin", "onchain"],    // used for hashtags and channel routing
      "expiresAt": "2026-07-10",         // optional; engine drops the highlight after this date
      "media": {                          // optional; music/creative projects
        "coverImageUrl": "https://…",    //   square art rendered on the card
        "waveform": [0.1, 0.6, 0.8],     //   0–1 amplitudes → waveform strip
        "links": [                        //   streaming/pre-save links for the copy
          { "label": "Spotify", "url": "https://…" }
        ]
      }
    }
  ]
}
```

Field limits (the engine validates them): headline ≤ 200, narrative ≤ 2000,
metric label/value ≤ 40, delta ≤ 60, ≤ 8 metrics, tag ≤ 40 chars / ≤ 12 tags,
`link` must be a valid URL. Media limits: `coverImageUrl` must be a valid URL,
waveform 0–1 values with ≤ 200 points (**and ≥ 8 points to actually render** —
shorter waveforms validate but the card omits the strip), ≤ 6 links with
labels ≤ 20 chars. A highlight violating a limit is **dropped individually**
(and counted in the cron result) — it does not fail the feed.

Reference TypeScript types: `MarketingHighlight` / `MarketingHighlightsResponse` in
`types/vault.ts`.

## Producer guidelines

- **IDs must be stable** across polls for the same underlying story; the engine also
  hashes headline + metrics, so cosmetic re-wording creates a new draft.
- **severity is the primary selection signal.** The engine's default threshold is
  `medium`; emit `low` freely — it just won't be posted unless quiet weeks lower the bar.
- Emit at most ~20 highlights; the engine caps drafts per project per day anyway.
- `narrative` is fed to the copywriter model as source material — write it factually,
  the brand voice is applied by the engine's per-project voice prompt.

## Reference implementation

`app/api/marketing/highlights/route.ts` in macro-vault-v3 maps existing vault data to
the contract: engine opportunities → `alert`, realized data surprises → `surprise`,
the AI regime read → `stat`, imminent critical releases → `event`.
