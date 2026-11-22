/** Account changes made on a read-only copy and run on the leader.
 *
 *  A copy does the person's part of a connect or a reconnect (the browser
 *  sign-in, a QR, the folder picker) and writes nothing. What that produced
 *  crosses here to the leader, which commits it and runs the source. The plain
 *  account verbs (pause, resume, remove, options) cross as their whole
 *  handler.
 *
 *  Everything the leader runs goes through one queue per account and carries
 *  an operation id, so a transport retry runs nothing twice (`account-ops`).
 *  A login is never logged and never part of an error: the runners that carry
 *  one answer a failure with a fixed sentence. */
import type {
  Account,
  AccountId,
  Connected,
  Credentials,
  FolderScopeUpdate,
} from '@shared/contracts';

import { AccountFlowBusyError } from '../engine/flow-errors';

import { accountKey, accountKeyOf, type AccountOps } from './account-ops';
import { LeadsNow, SyncReadOnly } from './role';
import type { AccountRelay, RelayContext } from './role';
import type { SyncService } from './service';

/** Verbs only a copy sends; they are not renderer channels. */
export const RELAY_VERBS = [
  'accounts:probe',
  'accounts:adopt',
  'accounts:commit-reauth',
  'accounts:apply-scope',
  'accounts:fresh-credentials',
] as const;
export type RelayVerb = (typeof RELAY_VERBS)[number];

/** Renderer channels that run on the leader for an account it runs. */
export const ACCOUNT_CHANNELS = [
  'accounts:remove',
  'accounts:pause',
  'accounts:resume',
  'accounts:sync-now',
  'accounts:set-cadence',
  'accounts:update-config',
  'accounts:set-option',
  'accounts:update-outbound',
] as const;
export type AccountChannel = (typeof ACCOUNT_CHANNELS)[number];

export const KEEP_EVERY_MS = 5_000;
export const KEEP_FOR_MS = 3 * 60_000;

export const BUSY_SENTENCE =
  'Another change to this source is in progress. Try again in a minute.';
export const NOT_SAVED_SENTENCE = 'the leader could not save this';
export const UNKNOWN_SOURCE_SENTENCE =
  'the leader does not have this connector';
export const UNKNOWN_ACCOUNT_SENTENCE = 'the leader does not have this source';
export const BAD_REQUEST_SENTENCE = 'the leader could not read this request';
export const LEADER_CHANGED_SENTENCE =
  'The device that leads changed. Try again.';

const leaderOf = (sync: Pick<SyncService, 'masterName'>): string =>
  sync.masterName() ?? 'the device that leads';

export const cantReach = (leader: string): string =>
  `Can't reach ${leader}. Try again when it is online.`;
export const needsUpdate = (leader: string): string =>
  `${leader} needs an update before sources can be connected from this device.`;
export const noConnector = (leader: string): string =>
  `${leader} does not have this connector yet. Try again in a minute.`;
export const waitingFor = (leader: string): string => `Waiting for ${leader}…`;
export const signInAgain = (leader: string): string =>
  `Couldn't reach ${leader}. Sign in again when it is online.`;

export interface CopyRelay extends AccountRelay {
  /** Before any sign-in: throws the sentence to show when the leader cannot
   *  take the result (unreachable, an older build, or no such connector). */
  probe(sourceId?: string): Promise<void>;
}

export function createCopyRelay(d: {
  sync: Pick<SyncService, 'forward' | 'masterName'>;
  newId(): string;
  now(): number;
  /** Resolves after `ms`, or earlier when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}): CopyRelay {
  const once = async (name: RelayVerb, payload: unknown): Promise<unknown> => {
    const r = await d.sync.forward({ kind: 'core', name, payload });
    if (r.ok) return r.value;
    throw new Error(
      r.code === 'no-master' ? cantReach(leaderOf(d.sync)) : r.message,
    );
  };
  /** A finished sign-in is kept until the leader has it: the same operation
   *  id on every attempt, so the leader runs it once. */
  const kept = async (
    name: RelayVerb,
    payload: Record<string, unknown>,
    ctx?: RelayContext,
  ): Promise<unknown> => {
    // A cancel that landed while the source was still finishing its sign-in
    // sends nothing; once the leader took it, a cancel changes nothing.
    if (ctx?.signal?.aborted) throw new Error('cancelled');
    const body = { ...payload, opId: d.newId() };
    const started = d.now();
    for (;;) {
      // This device leads by now: the gate commits the result here.
      if (ctx?.stillCopy && !ctx.stillCopy()) throw new LeadsNow();
      const r = await d.sync.forward({ kind: 'core', name, payload: body });
      if (r.ok) return r.value;
      // A device that stopped leading before the commit's turn came saved
      // nothing: the next attempt finds whoever leads now.
      if (r.code !== 'no-master' && r.message !== LEADER_CHANGED_SENTENCE)
        throw new Error(r.message);
      const leader = leaderOf(d.sync);
      if (ctx?.signal?.aborted) throw new Error('cancelled');
      if (d.now() - started >= KEEP_FOR_MS)
        throw new Error(signInAgain(leader));
      ctx?.status?.(waitingFor(leader));
      await d.sleep(KEEP_EVERY_MS, ctx?.signal);
      if (ctx?.signal?.aborted) throw new Error('cancelled');
    }
  };
  return {
    async probe(sourceId) {
      const r = await d.sync.forward({
        kind: 'core',
        name: 'accounts:probe',
        payload: { sourceId },
      });
      const leader = leaderOf(d.sync);
      if (!r.ok) {
        if (r.code === 'no-master') throw new Error(cantReach(leader));
        // An older leader has no such verb; any other refusal is its own.
        throw new Error(
          /not a forwarded channel/.test(r.message)
            ? needsUpdate(leader)
            : r.message,
        );
      }
      if ((r.value as { hasSource?: boolean } | null)?.hasSource === false)
        throw new Error(noConnector(leader));
    },
    adopt: (connected, ctx) =>
      kept('accounts:adopt', { connected }, ctx) as Promise<Account>,
    commitReauth: async (r, ctx) => {
      await kept(
        'accounts:commit-reauth',
        { accountId: r.accountId, credentials: r.credentials },
        ctx,
      );
    },
    applyScope: (accountId, update, configAtOpen) =>
      once('accounts:apply-scope', {
        opId: d.newId(),
        accountId,
        update,
        configAtOpen,
      }) as Promise<{ archived: number }>,
    credentials: (accountId) =>
      once('accounts:fresh-credentials', {
        accountId,
      }) as Promise<Credentials | null>,
  };
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';

const className = (err: unknown): string => {
  if (!(err instanceof Error)) return typeof err;
  return err.constructor?.name || err.name || 'Error';
};

export interface LeaderRunnerDeps {
  engine: {
    adopt(c: Connected, started?: (account: Account) => void): Promise<Account>;
    commitReauth(
      r: { accountId: AccountId; credentials: Credentials | null },
      started?: (account: Account) => void,
    ): Promise<void>;
    applyScope(
      accountId: AccountId,
      update: FolderScopeUpdate,
      configAtOpen: string,
    ): Promise<{ archived: number }>;
    claimAccountFlow(accountId: AccountId, flowId: string): void;
    releaseAccountFlow(accountId: AccountId, flowId: string): void;
    freshCredentialsQuiet(accountId: AccountId): Promise<Credentials | null>;
  };
  account(id: AccountId): Promise<Account | null>;
  hasSource(sourceId: string): boolean;
  /** This device may write now. */
  writable(): boolean;
  ops: AccountOps;
  runAccount(account: Account): void;
  log(line: string): void;
}

/** What the leader runs for the verbs a copy relays. */
export function createLeaderRunners(
  d: LeaderRunnerDeps,
): Record<RelayVerb, (req: unknown) => Promise<unknown>> {
  /** Runs a step that holds a login: whatever it throws is logged by class
   *  and answered with a fixed sentence. */
  const guarded = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      const name = className(err);
      d.log(`${what} failed (${name})`);
      if (err instanceof AccountFlowBusyError) throw new Error(BUSY_SENTENCE);
      if (err instanceof SyncReadOnly) throw new Error(LEADER_CHANGED_SENTENCE);
      const msg = err instanceof Error ? err.message : '';
      if (/^unknown source: /.test(msg))
        throw new Error(UNKNOWN_SOURCE_SENTENCE);
      if (/^unknown account: /.test(msg))
        throw new Error(UNKNOWN_ACCOUNT_SENTENCE);
      throw new Error(NOT_SAVED_SENTENCE);
    }
  };
  /** The leader's own UI and a copy exclude each other for the commit. */
  const claimed = async <T>(
    accountId: AccountId,
    opId: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const flowId = `relay:${opId}`;
    d.engine.claimAccountFlow(accountId, flowId);
    try {
      return await fn();
    } finally {
      d.engine.releaseAccountFlow(accountId, flowId);
    }
  };
  /** Relayed commits to one account run one after the other, each holding
   *  the account's flow claim; the engine's commit then takes its place in
   *  the account's own queue (the gate), behind any plain handler. Two
   *  queues, two keys: nothing waits on itself. */
  const relayed = <T>(
    opId: string,
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> =>
    d.ops
      .once(opId, () => d.ops.serial(`relay:${key}`, fn))
      .catch((err: unknown) => {
        // This device stopped leading before the commit's turn came, so
        // nothing ran: the same operation may run when it comes again (here,
        // if this device leads again, or on the new leader).
        if (err instanceof Error && err.message === LEADER_CHANGED_SENTENCE)
          d.ops.forget(opId);
        throw err;
      });
  return {
    'accounts:probe': async (req) => {
      const sourceId = isPlain(req) ? req.sourceId : undefined;
      return {
        ok: true,
        hasSource: isText(sourceId) ? d.hasSource(sourceId) : true,
      };
    },

    'accounts:adopt': async (req) => {
      const c = isPlain(req) ? req.connected : undefined;
      if (
        !isPlain(req) ||
        !isText(req.opId) ||
        !isPlain(c) ||
        !isText(c.sourceId) ||
        !isText(c.identifier) ||
        !(c.config === undefined || isPlain(c.config)) ||
        !(c.credentials === null || isPlain(c.credentials)) ||
        typeof c.usedPicker !== 'boolean'
      )
        throw new Error(BAD_REQUEST_SENTENCE);
      const connected = c as unknown as Connected;
      const key = accountKey(connected.sourceId, connected.identifier);
      return relayed(req.opId, key, () =>
        // The restart happens inside the engine's commit step, so a Remove
        // queued behind it cannot run between the commit and the restart.
        guarded('adopt', () =>
          d.engine.adopt(connected, (account) => d.runAccount(account)),
        ),
      );
    },

    'accounts:commit-reauth': async (req) => {
      if (
        !isPlain(req) ||
        !isText(req.opId) ||
        !isText(req.accountId) ||
        !(req.credentials === null || isPlain(req.credentials))
      )
        throw new Error(BAD_REQUEST_SENTENCE);
      const accountId = req.accountId as AccountId;
      const credentials = req.credentials as Credentials | null;
      const { opId } = req;
      const key = await accountKeyOf(d.account, accountId);
      return relayed(opId, key, () =>
        guarded('commit-reauth', () =>
          claimed(accountId, opId, () =>
            d.engine.commitReauth({ accountId, credentials }, (account) =>
              d.runAccount(account),
            ),
          ),
        ),
      );
    },

    // No login in this one: the engine's own sentences (a stale or an empty
    // selection) are what the person needs to read.
    'accounts:apply-scope': async (req) => {
      if (
        !isPlain(req) ||
        !isText(req.opId) ||
        !isText(req.accountId) ||
        !isPlain(req.update) ||
        !isPlain(req.update.config) ||
        typeof req.configAtOpen !== 'string'
      )
        throw new Error(BAD_REQUEST_SENTENCE);
      const accountId = req.accountId as AccountId;
      const update = req.update as unknown as FolderScopeUpdate;
      const { configAtOpen, opId } = req as {
        configAtOpen: string;
        opId: string;
      };
      const key = await accountKeyOf(d.account, accountId);
      return relayed(opId, key, async () => {
        try {
          return await claimed(accountId, opId, () =>
            d.engine.applyScope(accountId, update, configAtOpen),
          );
        } catch (err) {
          if (err instanceof AccountFlowBusyError)
            throw new Error(BUSY_SENTENCE);
          if (err instanceof SyncReadOnly)
            throw new Error(LEADER_CHANGED_SENTENCE);
          throw err;
        }
      });
    },

    'accounts:fresh-credentials': async (req) => {
      if (!isPlain(req) || !isText(req.accountId))
        throw new Error(BAD_REQUEST_SENTENCE);
      const accountId = req.accountId as AccountId;
      const key = await accountKeyOf(d.account, accountId);
      return d.ops.serial(key, () =>
        guarded('fresh-credentials', async () => {
          // Asked when its turn comes: a device that stopped leading while
          // this waited refreshes and saves nothing.
          if (!d.writable()) throw new SyncReadOnly('fresh-credentials');
          return d.engine.freshCredentialsQuiet(accountId);
        }),
      );
    },
  };
}

/** Wraps the account channels of the handler table in place. On a copy, a
 *  request for an account the leader runs goes to the leader with a fresh
 *  operation id; anywhere else it runs here, in the account's queue. Returns
 *  what the leader runs for a forwarded request. */
export function wrapAccountChannels(
  table: Record<string, ((req: never) => unknown) | undefined>,
  d: {
    sync: Pick<
      SyncService,
      'forward' | 'readOnly' | 'ownsAccount' | 'masterName'
    >;
    ops: AccountOps;
    account(
      id: string,
    ): Promise<{ source: string; identifier: string } | null>;
    newId(): string;
  },
): Map<string, (req: unknown) => Promise<unknown>> {
  const runners = new Map<string, (req: unknown) => Promise<unknown>>();
  for (const channel of ACCOUNT_CHANNELS) {
    const fn = table[channel] as ((req: unknown) => unknown) | undefined;
    if (!fn) continue;
    const idOf = (req: unknown): string =>
      isPlain(req) && isText(req.accountId) ? req.accountId : '';
    const here = async (opId: string | null, req: unknown): Promise<unknown> => {
      const id = idOf(req);
      const key = id ? await accountKeyOf(d.account, id) : channel;
      return d.ops.run(opId, key, async () => fn(req));
    };
    runners.set(channel, async (body) => {
      if (!isPlain(body) || !isText(body.opId) || !idOf(body.req))
        throw new Error(BAD_REQUEST_SENTENCE);
      return here(body.opId, body.req);
    });
    table[channel] = (async (req: unknown) => {
      const id = idOf(req);
      if (!d.sync.readOnly() || !id || d.sync.ownsAccount(id))
        return here(null, req);
      const r = await d.sync.forward({
        kind: 'core',
        name: channel,
        payload: { opId: d.newId(), req },
      });
      if (r.ok) return r.value;
      const leader = leaderOf(d.sync);
      if (r.code === 'no-master') throw new Error(cantReach(leader));
      throw new Error(
        /not a forwarded channel/.test(r.message)
          ? `${leader} needs an update before this can be changed from this device.`
          : r.message,
      );
    }) as (req: never) => unknown;
  }
  return runners;
}
