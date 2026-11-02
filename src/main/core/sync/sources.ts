/** Which sources move to another device, which stay, and what an offer holds
 *  (alpha-cent spec 7.7). Two lists, audited once, that every later step reads
 *  and none adds to. An unlisted source counts as unstable and not device-owned. */
import type { Credentials, ExportContext, Source } from '@shared/contracts';

import type { CoreStore } from '../store/store';

/** Run on their owner and no other device (spec section 11): they read this
 *  machine's folders, capture its audio or hold a session that can't move.
 *  The offer sends their account rows, never a login. Audited 2026-11-02:
 *  `local-folder` and `meetings` are core, `assistant` is the chat assistant,
 *  `claude-code` and `codex` are the agent-sessions connector (r16 ruling 5),
 *  `whatsapp` keeps keys that change with every message. */
export const DEVICE_OWNED_SOURCES: readonly string[] = [
  'local-folder',
  'meetings',
  'assistant',
  'whatsapp',
  'claude-code',
  'codex',
];

/** The identifier names the provider's own account (an address, a numeric id,
 *  a login), so two devices that connected the same account hold the same
 *  string. Audited against every connector 2026-11-02. Notion (workspace
 *  display name) and Slack (team name) are out on purpose: a display name can
 *  collide between two workspaces. Telegram is in because its identifier is
 *  the numeric user id; its session file moves into the vault at activation,
 *  before any offer (r16 ruling 9). */
export const STABLE_IDENTITY_SOURCES: readonly string[] = [
  'gmail',
  'imap',
  'ms365',
  'onedrive',
  'github',
  'google-calendar',
  'google-docs',
  'hubspot',
  'telegram',
  'instagram',
];

export const isDeviceOwned = (source: string): boolean =>
  DEVICE_OWNED_SOURCES.includes(source);

export const isStableIdentity = (source: string): boolean =>
  STABLE_IDENTITY_SOURCES.includes(source);

/** One account in an offer. `credentials` is set only for a moveable account
 *  that has a login; `owner_device_id` only for a device-owned one. */
export interface OfferedSource {
  source: string;
  identifier: string;
  config: string;
  cadence: string | null;
  credentials: unknown | null;
  owner_device_id: string | null;
}

/** First 8 characters of a device id, the suffix that keeps two devices'
 *  copies of one local identifier apart. */
export const deviceSuffix = (deviceId: string): string => deviceId.slice(0, 8);

/** What this device would offer another one. Reads only: the caller records
 *  `sync_moved`. `log` gets counts and source ids, never a login. */
export async function exportSources(
  store: Pick<CoreStore, 'read' | 'vault'>,
  me: string,
  log: (level: 'info' | 'warn', msg: string) => void = () => undefined,
  sources?: { get(id: string): Partial<Pick<Source, 'prepareExport'>> | undefined },
): Promise<OfferedSource[]> {
  const accounts = await store.read.accounts();
  const out: OfferedSource[] = [];
  for (const a of accounts) {
    if (a.source === 'worker') continue;
    const base = {
      source: a.source,
      config: JSON.stringify(a.config ?? {}),
      cadence: a.cadence ? JSON.stringify(a.cadence) : null,
    };
    if (isDeviceOwned(a.source)) {
      // Suffixed only while it has no owner: a second pass must not stack one.
      const owned = a.ownerDeviceId ?? null;
      out.push({
        ...base,
        identifier: owned ? a.identifier : `${a.identifier}#${deviceSuffix(me)}`,
        credentials: null,
        owner_device_id: owned ?? me,
      });
      continue;
    }
    // A connector may still have a login to move into the vault.
    const prepare = sources?.get(a.source)?.prepareExport;
    if (prepare) {
      try {
        await prepare.call(sources!.get(a.source), {
          account: a,
          credentials: () => store.vault.load(a.id) as Promise<Credentials | null>,
          save: (c) => store.vault.save(a.id, c),
          log: (level, msg) => log(level === 'error' ? 'warn' : 'info', `${a.source}: ${msg}`),
        } satisfies ExportContext);
      } catch {
        // The message could carry a login, so only the source is named.
        log('warn', `sync: ${a.source} could not prepare an account for export`);
      }
    }
    const login = (await store.vault.load(a.id)) as Credentials | null;
    // No vault row, nothing to move; the seed would hold a login-less copy.
    if (!login) continue;
    out.push({
      ...base,
      identifier: a.identifier,
      credentials: login,
      owner_device_id: null,
    });
  }
  const owned = out.filter((o) => o.owner_device_id !== null).length;
  log('info', `sync: ${out.length - owned} movable and ${owned} device-owned accounts to offer`);
  return out;
}

/** Accounts named in `sync_moved` rest, with the reason: the seed may be
 *  reading them now. Shared by the restore, `leaveJoin` and boot. */
export const PAUSE_MOVED_SQL = `
  UPDATE accounts
     SET status = 'paused',
         last_error = 'Moved to ' || (SELECT to_device FROM sync_moved WHERE account_id = accounts.id)
   WHERE id IN (SELECT account_id FROM sync_moved)`;

export function pauseMovedAccounts(conn: { exec(sql: string): unknown }): void {
  conn.exec(PAUSE_MOVED_SQL);
}
