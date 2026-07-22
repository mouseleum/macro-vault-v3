"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BLUESKY_LIMIT, X_LIMIT } from "@/lib/text";
import type {
  DraftCopy,
  DraftStatus,
  MarketingDraft,
  PublishResult
} from "@/types/marketing";

const statusTabs: Array<DraftStatus | "all"> = ["pending", "approved", "published", "rejected", "all"];
const copyChannels = ["x", "bluesky", "linkedin"] as const;
const copyLimits: Record<(typeof copyChannels)[number], number | null> = {
  x: X_LIMIT,
  bluesky: BLUESKY_LIMIT,
  linkedin: null
};

async function patchDraft(id: string, authHeaders: Record<string, string>, body: Record<string, unknown>) {
  const response = await fetch(`/api/drafts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
}

type PublishState = {
  loading: boolean;
  dryRun?: boolean;
  results?: PublishResult[];
  error?: string;
};

function DraftCard({
  draft,
  authHeaders,
  onChanged
}: {
  draft: MarketingDraft;
  authHeaders: Record<string, string>;
  onChanged: () => void;
}) {
  const [copy, setCopy] = useState<DraftCopy>(draft.copy);
  const [channel, setChannel] = useState<(typeof copyChannels)[number]>("x");
  const [publishState, setPublishState] = useState<PublishState>({ loading: false });
  const [saving, setSaving] = useState(false);

  useEffect(() => setCopy(draft.copy), [draft.copy]);

  const dirty = useMemo(() => JSON.stringify(copy) !== JSON.stringify(draft.copy), [copy, draft.copy]);
  const limit = copyLimits[channel];
  const editable = draft.status === "pending" || draft.status === "approved";

  const saveCopy = useCallback(async () => {
    setSaving(true);
    try {
      await patchDraft(draft.id, authHeaders, { copy });
      onChanged();
    } catch (error) {
      setPublishState({ loading: false, error: error instanceof Error ? error.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }, [authHeaders, copy, draft.id, onChanged]);

  const setStatus = useCallback(
    async (status: "rejected" | "pending") => {
      try {
        await patchDraft(draft.id, authHeaders, { status });
        onChanged();
      } catch (error) {
        setPublishState({ loading: false, error: error instanceof Error ? error.message : "Status change failed" });
      }
    },
    [authHeaders, draft.id, onChanged]
  );

  const publish = useCallback(async () => {
    setPublishState({ loading: true });
    try {
      if (dirty) {
        await patchDraft(draft.id, authHeaders, { copy });
      }
      const response = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ draftId: draft.id })
      });
      const body = (await response.json()) as { dryRun?: boolean; results?: PublishResult[]; error?: string };
      if (!response.ok && !body.results) throw new Error(body.error ?? `HTTP ${response.status}`);
      setPublishState({ loading: false, dryRun: body.dryRun, results: body.results });
      onChanged();
    } catch (error) {
      setPublishState({ loading: false, error: error instanceof Error ? error.message : "Publish failed" });
    }
  }, [authHeaders, copy, dirty, draft.id, onChanged]);

  return (
    <article className="draft-card">
      <div>
        {/* Cache-bust on copy save so the preview tracks edits to metrics-bearing drafts. */}
        <img src={`/api/render/${draft.id}?v=${draft.reviewed_at ?? draft.created_at}`} alt={draft.headline} />
      </div>
      <div>
        <div className="draft-meta">
          <span className="chip">{draft.project}</span>
          <span className="chip">{draft.type}</span>
          <span className={`chip sev-${draft.severity}`}>{draft.severity}</span>
          <span className={`chip status-${draft.status}`}>{draft.status}</span>
          <span>score {Math.round(draft.score)}</span>
          <span>{draft.created_at.slice(0, 16).replace("T", " ")}</span>
        </div>
        <h2 className="draft-headline">{draft.headline}</h2>
        <p className="draft-narrative">{draft.narrative}</p>

        <div className="copy-tabs">
          {copyChannels.map((item) => (
            <button key={item} className={item === channel ? "active" : ""} onClick={() => setChannel(item)}>
              {item}
            </button>
          ))}
        </div>
        <textarea
          className="copy-edit"
          value={copy[channel]}
          readOnly={!editable}
          onChange={(event) => setCopy((previous) => ({ ...previous, [channel]: event.target.value }))}
        />
        <div className={`char-count ${limit && copy[channel].length > limit ? "over" : ""}`}>
          {copy[channel].length}
          {limit ? ` / ${limit}` : ""}
        </div>

        {editable ? (
          <div className="actions">
            <button className="btn primary" onClick={publish} disabled={publishState.loading}>
              {publishState.loading ? "PUBLISHING…" : "APPROVE & PUBLISH"}
            </button>
            <button className="btn" onClick={saveCopy} disabled={!dirty || saving}>
              {saving ? "SAVING…" : "SAVE COPY"}
            </button>
            <button className="btn danger" onClick={() => setStatus("rejected")}>
              REJECT
            </button>
          </div>
        ) : draft.status === "rejected" ? (
          <div className="actions">
            <button className="btn" onClick={() => setStatus("pending")}>
              REOPEN
            </button>
          </div>
        ) : null}

        {publishState.error ? <div className="notice error">{publishState.error}</div> : null}
        {publishState.results ? (
          <ul className="publish-results">
            {publishState.dryRun ? <li className="result-dry_run">DRY RUN — nothing was posted.</li> : null}
            {publishState.results.map((result) => (
              <li key={result.channel} className={`result-${result.status}`}>
                {result.channel}: {result.status}
                {result.url ? (
                  <>
                    {" — "}
                    <a href={result.url} target="_blank" rel="noreferrer">
                      {result.url}
                    </a>
                  </>
                ) : null}
                {result.error ? ` — ${result.error}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

export function ReviewClient() {
  const [marketingKey, setMarketingKey] = useState("");
  const [status, setStatusTab] = useState<DraftStatus | "all">("pending");
  const [drafts, setDrafts] = useState<MarketingDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const authHeaders = useMemo(() => {
    const headers: Record<string, string> = {};
    if (marketingKey) headers.Authorization = `Bearer ${marketingKey}`;
    return headers;
  }, [marketingKey]);

  const loadDrafts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = status === "all" ? "" : `?status=${status}`;
      const response = await fetch(`/api/drafts${query}`, { headers: authHeaders });
      const body = (await response.json()) as { drafts?: MarketingDraft[]; error?: string; message?: string };
      if (!response.ok) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
      setDrafts(body.drafts ?? []);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Failed to load drafts");
    } finally {
      setLoading(false);
    }
  }, [authHeaders, status]);

  useEffect(() => {
    void loadDrafts();
  }, [loadDrafts]);

  const runGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const response = await fetch("/api/cron/generate", { headers: authHeaders });
      const body = (await response.json()) as { error?: string };
      if (!response.ok && response.status !== 207) throw new Error(body.error ?? `HTTP ${response.status}`);
      await loadDrafts();
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : "Generate failed");
    } finally {
      setGenerating(false);
    }
  }, [authHeaders, loadDrafts]);

  return (
    <main className="shell">
      <header className="header">
        <div>
          <h1>MARKETING ENGINE</h1>
          <div className="sub">generate → review → publish · drafts never post without approval</div>
        </div>
        <input
          className="key-input"
          type="password"
          placeholder="MARKETING_API_KEY (blank on localhost)"
          value={marketingKey}
          onChange={(event) => setMarketingKey(event.target.value)}
        />
      </header>

      <div className="toolbar">
        {statusTabs.map((tab) => (
          <button key={tab} className={`tab ${tab === status ? "active" : ""}`} onClick={() => setStatusTab(tab)}>
            {tab}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={runGenerate} disabled={generating}>
          {generating ? "GENERATING…" : "RUN GENERATE NOW"}
        </button>
        <button className="btn" onClick={loadDrafts} disabled={loading}>
          {loading ? "LOADING…" : "REFRESH"}
        </button>
      </div>

      {error ? <div className="notice error">{error}</div> : null}

      {drafts.length === 0 && !loading ? (
        <div className="empty">
          No {status === "all" ? "" : `${status} `}drafts. Hit RUN GENERATE NOW to pull highlights from registered projects.
        </div>
      ) : (
        drafts.map((draft) => <DraftCard key={draft.id} draft={draft} authHeaders={authHeaders} onChanged={loadDrafts} />)
      )}
    </main>
  );
}
