// Platform copy limits. Defined here (dependency-free module) so client
// components can import them without dragging server SDKs into the bundle.
export const X_LIMIT = 280;
export const BLUESKY_LIMIT = 300;

const urlPattern = /https?:\/\/\S+/g;

// Plain hard truncation with an ellipsis — for display surfaces (cards) where
// cutting mid-word is acceptable and no URLs are involved.
export function truncate(value: string, limit: number) {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

// Truncation for post copy: never cuts through a URL. If the naive cut would
// land inside a URL, the cut moves to just before that URL; a URL that fits
// entirely within the limit is kept. When the straddling URL starts the
// string (nothing useful before it), fall back to a hard cut rather than
// degenerating to a bare ellipsis.
export function truncateCopy(value: string, limit: number) {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;

  const cutAt = limit - 1;
  for (const match of trimmed.matchAll(urlPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start < cutAt && end > cutAt) {
      const prefix = trimmed.slice(0, start).trimEnd();
      if (prefix.length === 0) break;
      return `${prefix}…`;
    }
  }

  return `${trimmed.slice(0, cutAt).trimEnd()}…`;
}
