import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";
import { createMarketingStore, isMissingMarketingTable, marketingSetupMessage } from "@/lib/marketing-store";
import { getProject } from "@/lib/registry";
import { truncate } from "@/lib/text";
import type { MarketingDraft, MarketingHighlightSeverity, SparklinePoint } from "@/types/marketing";

export const runtime = "nodejs";

const WIDTH = 1200;
const HEIGHT = 675;

// Card surface + ink tokens (dark, matches the vault aesthetic). Severity is
// never color-alone: the chip always carries the severity word.
const surface = "#0a0b0d";
const panel = "#111318";
const line = "#292b31";
const ink = "#eceef4";
const muted = "#969aa5";
const faint = "#656a76";

const severityColor: Record<MarketingHighlightSeverity, string> = {
  low: "#969aa5",
  medium: "#2c78ff",
  high: "#ffad18",
  extreme: "#ff4f64"
};

function sparklinePath(points: SparklinePoint[], width: number, height: number) {
  const values = points.map((point) => point.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 6;

  return points
    .map((point, index) => {
      const x = pad + (index / (points.length - 1)) * (width - pad * 2);
      const y = pad + (1 - (point.v - min) / range) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

// Downsample a waveform to a fixed bar count so any input density renders
// cleanly at card width.
function waveformBars(waveform: number[], bars = 56) {
  if (waveform.length <= bars) return waveform;
  const bucket = waveform.length / bars;
  return Array.from({ length: bars }, (_, index) => {
    const slice = waveform.slice(Math.floor(index * bucket), Math.max(Math.floor((index + 1) * bucket), Math.floor(index * bucket) + 1));
    return slice.reduce((sum, value) => sum + value, 0) / slice.length;
  });
}

export async function GET(request: Request, context: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await context.params;
  const store = createMarketingStore();
  // This route is public: never leak raw database errors through it.
  let draft: MarketingDraft | null;
  try {
    draft = await store.getDraft(draftId);
  } catch (error) {
    if (error && typeof error === "object" && isMissingMarketingTable(error as { code?: string; message?: string })) {
      return NextResponse.json({ setupRequired: true, message: marketingSetupMessage }, { status: 503 });
    }
    console.error(`[render] failed to load draft ${draftId}`, error);
    return NextResponse.json({ error: "Card unavailable" }, { status: 500 });
  }
  if (!draft) return NextResponse.json({ error: "Draft not found" }, { status: 404 });

  const profile = getProject(draft.project);
  const accent = profile?.brand.accent ?? "#2c78ff";
  const accentSoft = profile?.brand.accentSoft ?? "#0b2147";
  const logoText = profile?.brand.logoText ?? draft.project.slice(0, 2).toUpperCase();
  const handle = profile?.brand.handle ?? "";
  const tagline = profile?.brand.tagline ?? "";
  const severity = severityColor[draft.severity];
  const metrics = draft.metrics.slice(0, 3);
  const media = draft.media ?? null;
  const cover = media?.coverImageUrl ?? null;
  const waveform = media?.waveform && media.waveform.length >= 8 ? waveformBars(media.waveform) : null;
  const spark = !waveform && draft.sparkline && draft.sparkline.length >= 2 ? draft.sparkline : null;
  // A release announcement isn't an alarm — milestones drop the severity chip.
  const showSeverity = draft.type !== "milestone";
  // The cover layout is for visual media only; links-only or empty media
  // objects (valid per the contract) keep the standard wide layout.
  const hasCoverLayout = Boolean(cover || waveform);
  const sparkWidth = 380;
  const sparkHeight = 140;
  const dateLabel = draft.created_at.slice(0, 10);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: surface,
          color: ink,
          padding: "48px 56px 40px",
          fontSize: 24
        }}
      >
        <div style={{ position: "absolute", top: 0, left: 0, width: WIDTH, height: 8, display: "flex", backgroundColor: accent }} />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 52,
                height: 52,
                borderRadius: 10,
                backgroundColor: accent,
                color: surface,
                fontSize: 24,
                fontWeight: 700
              }}
            >
              {logoText}
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", fontSize: 26, fontWeight: 700 }}>{profile?.name ?? draft.project}</div>
              <div style={{ display: "flex", fontSize: 19, color: faint }}>{handle}</div>
            </div>
          </div>
          {showSeverity ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 18px",
                borderRadius: 999,
                border: `2px solid ${line}`,
                backgroundColor: panel
              }}
            >
              <div style={{ display: "flex", width: 12, height: 12, borderRadius: 999, backgroundColor: severity }} />
              <div style={{ display: "flex", fontSize: 19, color: muted, textTransform: "uppercase", letterSpacing: 2 }}>
                {draft.severity}
              </div>
            </div>
          ) : null}
        </div>

        {hasCoverLayout ? (
          <div style={{ display: "flex", alignItems: "center", gap: 40, marginTop: 40 }}>
            {cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={cover}
                width={240}
                height={240}
                style={{ borderRadius: 16, border: `1px solid ${line}`, objectFit: "cover" }}
              />
            ) : (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 240,
                  height: 240,
                  borderRadius: 16,
                  border: `1px solid ${line}`,
                  backgroundImage: `linear-gradient(135deg, ${accent}, ${accentSoft})`,
                  color: surface,
                  fontSize: 96,
                  fontWeight: 700
                }}
              >
                {logoText}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
              <div style={{ display: "flex", fontSize: 48, fontWeight: 700, lineHeight: 1.15 }}>
                {truncate(draft.headline, 90)}
              </div>
              <div style={{ display: "flex", fontSize: 24, color: muted, lineHeight: 1.45, marginTop: 18 }}>
                {truncate(draft.narrative, 170)}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 52, fontWeight: 700, lineHeight: 1.15, marginTop: 40 }}>
              {truncate(draft.headline, 110)}
            </div>
            <div style={{ display: "flex", fontSize: 25, color: muted, lineHeight: 1.45, marginTop: 20, maxWidth: 1000 }}>
              {truncate(draft.narrative, 200)}
            </div>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: "auto" }}>
          <div style={{ display: "flex", gap: 18 }}>
            {metrics.map((metric) => (
              <div
                key={metric.label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  padding: "18px 24px",
                  borderRadius: 12,
                  backgroundColor: panel,
                  border: `1px solid ${line}`,
                  minWidth: 160
                }}
              >
                <div style={{ display: "flex", fontSize: 18, color: faint }}>{truncate(metric.label, 24)}</div>
                <div style={{ display: "flex", fontSize: 34, fontWeight: 600, marginTop: 6 }}>{truncate(metric.value, 14)}</div>
                {metric.delta ? (
                  <div style={{ display: "flex", fontSize: 17, color: muted, marginTop: 4 }}>{truncate(metric.delta, 28)}</div>
                ) : null}
              </div>
            ))}
          </div>
          {spark ? (
            <svg width={sparkWidth} height={sparkHeight} viewBox={`0 0 ${sparkWidth} ${sparkHeight}`}>
              <polyline
                points={sparklinePath(spark, sparkWidth, sparkHeight)}
                fill="none"
                stroke={accent}
                strokeWidth={3}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          ) : null}
        </div>

        {waveform ? (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 96, marginTop: 26 }}>
            {waveform.map((value, index) => (
              <div
                key={index}
                style={{
                  display: "flex",
                  flex: 1,
                  height: Math.max(6, Math.round(value * 96)),
                  borderRadius: 3,
                  backgroundColor: accent
                }}
              />
            ))}
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 28,
            paddingTop: 20,
            borderTop: `1px solid ${line}`
          }}
        >
          <div style={{ display: "flex", fontSize: 19, color: faint }}>{tagline}</div>
          <div style={{ display: "flex", fontSize: 19, color: faint }}>{dateLabel}</div>
        </div>
      </div>
    ),
    { width: WIDTH, height: HEIGHT }
  );
}
