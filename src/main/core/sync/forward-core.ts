/** Core writes a follower hands to the leader (alpha-cent spec 7.8, step 3 and
 *  its r16 correction): the attention action, the outbox channels and the
 *  calendar-out channels. Each is idempotent by id on the leader, so a retry
 *  after a lost reply changes nothing twice. */
import type { SyncService } from './service';

export type ForwardedChannel = (typeof FORWARDED_CHANNELS)[number];

export const FORWARDED_CHANNELS = [
  'attention:act',
  'outbox:send',
  'outbox:schedule',
  'outbox:discard',
  'outbox:redraft',
  'outbox:reopen',
  'calendar-out:confirm',
  'calendar-out:retry',
  'calendar-out:discard',
  'calendar-out:restore',
  'prefs:patch',
  'prefs:set-ext',
] as const;

/** Forwarded verbs that are not forwarded whole: the handler splits its own
 *  request and forwards only the part that belongs to the leader (a mixed
 *  `prefs:patch` applies its device keys here). They stay in the returned map,
 *  so the leader can still run them for a forwarded request. */
export const SELF_FORWARDING_CHANNELS: readonly ForwardedChannel[] = ['prefs:patch'];


export const isForwardedChannel = (c: string): c is ForwardedChannel =>
  (FORWARDED_CHANNELS as readonly string[]).includes(c);

/** The renderer push that carries the refusal sentence (`ext:push`). */
export const SYNC_REFUSED_PUSH = { extensionId: 'core.sync', name: 'refused' } as const;

/** What a user sees when a follower's edit finds no leader. */
export const NO_MASTER_MESSAGE =
  "Can't save this yet. No other device is reachable; try again in a minute.";

export class SyncNoMaster extends Error {
  readonly code = 'EXT_SYNC_NO_MASTER';
  constructor() {
    super(NO_MASTER_MESSAGE);
    this.name = 'SyncNoMaster';
  }
}

/** Runs `channel` on the leader. Rejects with the leader's own message when
 *  its handler refused, or with `SyncNoMaster` when none is reachable. */
export async function forwardCore(
  sync: Pick<SyncService, 'forward'>,
  channel: ForwardedChannel,
  req: unknown,
  /** Told the sentence when no leader is reachable, so the UI shows its one
   *  refused notice for a core channel as it does for an extension call. */
  onNoMaster?: (message: string) => void,
): Promise<unknown> {
  const r = await sync.forward({ kind: 'core', name: channel, payload: req });
  if (r.ok) return r.value;
  if (r.code === 'no-master') {
    const err = new SyncNoMaster();
    onNoMaster?.(err.message);
    throw err;
  }
  throw new Error(r.message);
}

/** Wraps the forwarded entries of the channel-handler map in place (the app
 *  overlay patches the text of `dispatch`, so the map is wrapped, not the
 *  dispatcher). On a follower the call runs on the leader, read now on every
 *  call; on the leader it runs here unchanged. Returns the unwrapped handlers,
 *  which the leader runs for a forwarded request. A channel an overlay handles
 *  is skipped: its owner wraps it. */
export function wrapForwardedChannels(
  table: Record<string, (req: unknown) => unknown>,
  sync: Pick<SyncService, 'forward' | 'readOnly'>,
  onNoMaster?: (message: string) => void,
): Map<string, (req: unknown) => unknown> {
  const local = new Map<string, (req: unknown) => unknown>();
  for (const channel of FORWARDED_CHANNELS) {
    const fn = table[channel];
    if (!fn) continue;
    local.set(channel, fn);
    if (SELF_FORWARDING_CHANNELS.includes(channel)) continue;
    table[channel] = (req) => (sync.readOnly() ? forwardCore(sync, channel, req, onNoMaster) : fn(req));
  }
  return local;
}
