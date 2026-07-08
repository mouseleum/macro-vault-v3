import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";
import { createMarketingStore } from "@/lib/marketing-store";
import { getProject } from "@/lib/registry";
import type { MarketingHighlightSeverity, SparklinePoint } from "@/types/marketing";

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

function truncate(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}

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

export async function GET(request: Request, context: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await context.params;
  const store = createMarketingStore();
  const draft = await store.getDraft(draftId);
  if (!draft) return NextResponse.json({ error: "Draft not found" }, { status: 404 });

  const profile = getProject(draft.project);
  const accent = profile?.brand.accent ?? "#2c78ff";
  const logoText = profile?.brand.logoText ?? draft.project.slice(0, 2).toUpperCase();
  const handle = profile?.brand.handle ?? "";
  const tagline = profile?.brand.tagline ?? "";
  const severity = severityColor[draft.severity];
  const metrics = draft.metrics.slice(0, 3);
  const spark = draft.sparkline && draft.sparkline.length >= 2 ? draft.sparkline : null;
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
        </div>

        <div style={{ display: "flex", fontSize: 52, fontWeight: 700, lineHeight: 1.15, marginTop: 40 }}>
          {truncate(draft.headline, 110)}
        </div>
        <div style={{ display: "flex", fontSize: 25, color: muted, lineHeight: 1.45, marginTop: 20, maxWidth: 1000 }}>
          {truncate(draft.narrative, 200)}
        </div>

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
