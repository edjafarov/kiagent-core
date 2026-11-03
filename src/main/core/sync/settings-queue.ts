/** The offline settings queue's vocabulary (alpha-cent spec 6c): which
 *  forwarded channels may wait for a leader, the key under which a queued
 *  setting coalesces, and the request builders. No I/O. */
import type { UserPrefKey } from '../prefs';
import { FORWARDED_CHANNELS, type ForwardedChannel } from './forward-core';
import type { ForwardRequest } from './service';

/** One queued setting as the overlay and the status see it. `key` is the
 *  coalesce key. */
export interface QueuedSetting {
  rowId: number;
  key: string;
  value: unknown;
}

export const userPrefKey = (k: string): string => `core.${k}`;
export const extensionEnabledKey = (id: string): string => `core.extensions.${id}`;

export function userPrefRequest(k: UserPrefKey, value: unknown): ForwardRequest {
  return { kind: 'core', name: 'prefs:patch', payload: { [k]: value } };
}

export function extPrefRequest(key: string, value: unknown): ForwardRequest {
  return { kind: 'core', name: 'prefs:set-ext', payload: { key, value } };
}

export function extensionEnabledRequest(id: string, enabled: boolean): ForwardRequest {
  return { kind: 'core', name: 'extension:set-enabled', payload: { id, enabled } };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** The value the overlay shows for a queued row; undefined when the row is not
 *  one of the three shapes, or does not match its key. */
export function queuedValueOf(coalesceKey: string, req: ForwardRequest): unknown | undefined {
  if (!req || req.kind !== 'core' || !isObj(req.payload)) return undefined;
  const p = req.payload;
  if (req.name === 'prefs:patch') {
    if (!coalesceKey.startsWith('core.')) return undefined;
    const k = coalesceKey.slice('core.'.length);
    return Object.keys(p).length === 1 && k in p ? p[k] : undefined;
  }
  if (req.name === 'prefs:set-ext') {
    return typeof p.key === 'string' && p.key === coalesceKey && 'value' in p ? p.value : undefined;
  }
  if (req.name === 'extension:set-enabled') {
    return typeof p.id === 'string' &&
      coalesceKey === extensionEnabledKey(p.id) &&
      typeof p.enabled === 'boolean'
      ? p.enabled
      : undefined;
  }
  return undefined;
}

/** Settings: applied here and delivered later when no leader is reachable. */
export const QUEUEABLE_CHANNELS: readonly ForwardedChannel[] = [
  'prefs:patch',
  'prefs:set-ext',
  'extension:set-enabled',
];

/** Everything else a follower forwards: with no leader these still throw. */
export const REFUSED_WHEN_OFFLINE: readonly ForwardedChannel[] = FORWARDED_CHANNELS.filter(
  (c) => !QUEUEABLE_CHANNELS.includes(c),
);

/** The listing of `sync_outbound` rows that carry a key: one per key (the
 *  unique index guarantees it), in id order. A row whose payload cannot be read
 *  is left out, so the overlay never shows a value nobody can deliver. */
export function queuedSettingsOf(
  rows: { id: number; coalesce_key: string | null; payload: Uint8Array }[],
): QueuedSetting[] {
  const out: QueuedSetting[] = [];
  for (const r of rows) {
    if (r.coalesce_key === null) continue;
    let value: unknown;
    try {
      value = queuedValueOf(r.coalesce_key, JSON.parse(Buffer.from(r.payload).toString('utf8')) as ForwardRequest);
    } catch {
      value = undefined;
    }
    if (value !== undefined) out.push({ rowId: Number(r.id), key: r.coalesce_key, value });
  }
  return out;
}

export const QUEUED_SETTINGS_SQL = `SELECT id, coalesce_key, payload FROM sync_outbound WHERE coalesce_key IS NOT NULL ORDER BY id`;
