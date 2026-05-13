# Macro Vault Contract v1

Macro Vault is the private source-of-truth data layer for downstream macro projects such as Visual Alarmist, Visual Opportunist, and the Asymmetric Macro Engine.

Downstream apps should attach to the vault through authenticated server-to-server API calls. They should not write directly to Supabase from browser clients.

## Connection

Each downstream project should keep these values server-side:

```txt
MACRO_VAULT_URL=https://your-vault.vercel.app
MACRO_VAULT_API_KEY=<server-only vault key>
```

Every request uses:

```txt
Authorization: Bearer <MACRO_VAULT_API_KEY>
```

Localhost development has a local-only auth bypass. Production does not.

## Stable Read Endpoints

```txt
GET /api/vault/contract
GET /api/vault/series
GET /api/vault/latest
GET /api/vault/observations
GET /api/vault/regime
GET /api/vault/dashboard-feed
GET /api/vault/events
GET /api/vault/sync-runs
GET /api/knowledge/documents
GET /api/intelligence/candidates
```

Useful query examples:

```txt
GET /api/vault/series?q=inflation&limit=25
GET /api/vault/series?provider=fred&country=US
GET /api/vault/latest?provider=fred&code=CPIAUCSL&country=US
GET /api/vault/observations?provider=fred&code=CPIAUCSL&country=US&start=2020-01-01&order=asc&limit=250
GET /api/vault/dashboard-feed?days=30&limit=10
GET /api/vault/events?limit=100
```

## Controlled Write Endpoints

The primary write lane for downstream projects is the intelligence candidate queue:

```txt
POST /api/intelligence/candidates
```

This stores pending review items. It does not immediately mutate canonical observations or official macro events.

Review and promotion stay explicit:

```txt
PATCH /api/intelligence/candidates/:id
POST /api/intelligence/candidates/:id/promote
```

Projects can also store permitted source notes or internal research documents:

```txt
POST /api/knowledge/documents
```

## Candidate Write Shape

```json
{
  "sourceProject": "visual_alarmist",
  "candidates": [
    {
      "signalType": "event",
      "title": "Red Sea shipping stress remains elevated",
      "provider": "visual_alarmist",
      "seriesCode": "RED_SEA_SHIPPING_STRESS",
      "countryCode": "WLD",
      "date": "2026-05-06",
      "value": null,
      "unit": null,
      "narrative": "Agent scan detected persistent rerouting and insurance-cost pressure in public shipping reports.",
      "confidence": 0.72,
      "sourceUrl": "https://example.com/source",
      "sourceTitle": "Example source",
      "sourceTier": "public_web",
      "extractionMethod": "agent_scan",
      "metadata": {
        "asset_relevance": ["oil", "freight", "global_equities"]
      }
    }
  ]
}
```

Allowed `signalType` values:

```txt
numeric_observation
event
document_note
```

Allowed `sourceTier` values:

```txt
user_supplied
public_web
licensed
internal
unknown
```

## Downstream Rules

- Treat Macro Vault as the source of truth for reusable macro data.
- Use the API from server code only; never expose `MACRO_VAULT_API_KEY` in a browser bundle.
- Downstream projects can submit candidates, but canonical data requires review and promotion.
- Preserve provenance: source URL, source title, source tier, extraction method, confidence, and source project.
- Keep product-specific UI state and proprietary analysis inside the downstream project unless it becomes reusable vault data.

## Compatibility Promise

This is `v1`.

Existing response fields should not be renamed or removed without a version bump. New fields may be added.
