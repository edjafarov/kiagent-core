/**
 * Small formatting helpers shared across the Sources screens — ported
 * verbatim (wording + thresholds) from the legacy renderer's
 * `components/relative-time.ts` so the copy reads identically, adapted only
 * where the new `AppState` shape genuinely has no equivalent field.
 */

import type { Account, Cadence } from '@shared/contracts';
import { folderRoots } from './folder-roots';

/** A time ahead, in the words `ago` uses ("in 5 min"); a past one reads
 *  "soon". */
export function formatUntil(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const min = Math.round((t - now) / 60_000);
  if (min < 1) return 'soon';
  if (min < 60) return `in ${min} min`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr} h`;
  const day = Math.round(hr / 24);
  return `in ${day} d`;
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

const UNITS: Record<string, [string, string]> = {
  s: ['second', 'seconds'],
  m: ['minute', 'minutes'],
  h: ['hour', 'hours'],
  d: ['day', 'days'],
};

/** Human copy for a `Cadence` value ('{every:"15m"}' -> 'Every 15 minutes',
 *  '{every:"1h"}' -> 'Every hour'). */
export function describeCadence(cadence: Cadence | undefined | null): string {
  if (cadence == null) return '—';
  if (cadence === 'manual') return 'Manual only';
  if ('cron' in cadence) return `Custom (cron: ${cadence.cron})`;
  const m = /^(\d+)\s*([smhd])$/.exec(cadence.every.trim());
  if (!m) return `Every ${cadence.every}`;
  const n = Number(m[1]);
  const [one, many] = UNITS[m[2]];
  return n === 1 ? `Every ${one}` : `Every ${n} ${many}`;
}

/** What names an account in a row: its identifier, or for local folders
 *  (one machine-wide account) how many folders it tracks. */
export function accountLabel(a: Account): string {
  if (a.source !== 'local-folder') return a.identifier;
  const n = folderRoots(a).length;
  return `${n} ${n === 1 ? 'folder' : 'folders'}`;
}
