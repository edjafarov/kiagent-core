/**
 * Small formatting helpers shared across the Sources screens — ported
 * verbatim (wording + thresholds) from the legacy renderer's
 * `components/relative-time.ts` so the copy reads identically, adapted only
 * where the new `AppState` shape genuinely has no equivalent field.
 */

import type { Cadence } from '@shared/contracts';

export function formatRelative(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const deltaSec = Math.max(0, Math.round((now - t) / 1000));
  if (deltaSec < 5) return 'now';
  if (deltaSec < 60) return `${deltaSec} seconds ago`;
  const min = Math.round(deltaSec / 60);
  if (min < 60) return `${min} ${min === 1 ? 'minute' : 'minutes'} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? 'hour' : 'hours'} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} ${day === 1 ? 'day' : 'days'} ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** Compact form for dense table cells ("12s ago", "4h ago"). */
export function formatRelativeCompact(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const delta = now - t;
  if (delta < 0) return 'now';
  const sec = Math.round(delta / 1000);
  if (sec < 5) return 'now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}

/** "2026-05-27T10:55:57.286Z" -> "2026-05-27 10:55:57" (local time). */
export function formatActivityTs(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Best-effort humanization of a free-form document `type` string
 *  ('email.thread' -> 'email thread', 'file' -> 'file') — the new Source
 *  contract has no fixed per-connector label map (sources are extensible),
 *  so this is generic rather than a hardcoded connector table. */
export function humanizeDocType(type: string): string {
  return type.replace(/[._-]+/g, ' ').trim() || 'document';
}

/** Human copy for a `Cadence` value ('{every:"15m"}' -> 'Every 15m'). */
export function describeCadence(cadence: Cadence | undefined | null): string {
  if (cadence == null) return '—';
  if (cadence === 'manual') return 'Manual only';
  if ('cron' in cadence) return `Custom (cron: ${cadence.cron})`;
  return `Every ${cadence.every}`;
}
