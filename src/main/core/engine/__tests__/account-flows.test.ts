import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  Account,
  AccountId,
  AuthChannel,
  Batch,
  DocumentInput,
  FolderScopeUpdate,
  Source,
} from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore } from '../../store/store';
import type { CoreStore } from '../../store/store';
import { createEngine } from '../engine';
import {
  AccountFlowBusyError,
  FolderScopeConfigError,
  FolderScopeStaleError,
} from '../flow-errors';

async function makeStore(dir: string): Promise<CoreStore> {
  return openStore(await openDb(path.join(dir, 'test.db')), {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => [],
  });
}

function doc(externalId: string, scopeRootId?: string): DocumentInput {
  return {
    externalId,
    type: 'note',
    title: externalId,
    markdown: `body ${externalId}`,
    metadata: {},
    createdAt: null,
    ...(scopeRootId === undefined ? {} : { scopeRootId }),
  };
}

/** Two pages then done, resumable from a numeric cursor — the same shape
 *  engine.test.ts's fakeSource uses, plus the two new optional verbs. Every
 *  document is stamped `scope_root_id = 'a'`, so an archive predicate that
 *  ignores `archiveScopeRootIds` or `account_id` is visible in row counts. */
function scopedSource(
  extra: Partial<Source<number, DocumentInput>> = {},
): Source<number, DocumentInput> {
  return {
    descriptor: {
      id: 'scoped',
      name: 'Scoped',
      documentTypes: ['note'],
      auth: 'oauth',
      folderScope: true,
    },
    async connect() {
      return {
        identifier: 'me@example.com',
        config: { folderRoots: [{ id: 'a', name: 'Alpha' }] },
      };
    },
    async *pull(_session, cursor) {
      const pages: Array<Batch<number, DocumentInput>> = [
        {
          phase: 'backfill',
          items: [doc('d1', 'a'), doc('d2', 'a')],
          cursor: 1,
        },
        { phase: 'live', items: [doc('d3', 'a')], cursor: 2 },
      ];
      for (const page of pages.slice(cursor ?? 0)) yield page;
    },
    toDocument: (item) => item,
    ...extra,
  };
}

/** Yields one page, then parks forever — a perpetual source sitting quietly
 *  between upstream events, which is the state an account is in when the user
 *  opens Manage folders. `abortable()` races `it.next()` against the abort
 *  wakeup (engine.ts:69-96), so `handle.stop()` still settles; the existing
 *  `hangingSource` in engine.test.ts relies on the same property. */
function liveHangingSource(): Source<number, DocumentInput> {
  return {
    ...scopedSource(),
    async *pull() {
      yield {
        phase: 'live',
        items: [doc('d1', 'a'), doc('d2', 'a'), doc('d3', 'a')],
        cursor: 2,
      };
      await new Promise<never>(() => {});
    },
  };
}

const noopAuth: AuthChannel = {
  oauth: async () => ({}),
  showQr: () => {},
  prompt: async () => ({}),
  status: () => {},
  pickFolders: async () => [],
};

async function waitFor(cond: () => Promise<boolean>, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Row order out of `search()` is rank/date driven; every byte-for-byte
 *  comparison below sorts first so a re-ordered result is not read as a
 *  changed corpus. */
const byExternalIdRows = <T extends { externalId: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => a.externalId.localeCompare(b.externalId));

describe('engine account flows', () => {
  let dir: string;
  let store: CoreStore;
  /** A real spy sink, not a no-op: Step 17's `archiveNullScoped` refusal
   *  (C-27) is asserted through it. Rebuilt per test so one test's lines can
   *  never be counted by the next. */
  let logs: { log: jest.Mock };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-flows-'));
    store = await makeStore(dir);
    logs = { log: jest.fn() };
  });

  afterEach(async () => {
    // Several tests below spy on `store.applyFolderScope`; jest is not
    // configured with `restoreMocks`, so a surviving mock would leak into the
    // next test's spy (jest.spyOn on an already-spied method hands back the
    // SAME spy, mock implementation included).
    jest.restoreAllMocks();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeEngine(source: Source) {
    return createEngine({
      store,
      sources: {
        get: (id) => (id === source.descriptor.id ? source : undefined),
      },
      inference: {
        complete: async () => 's',
        see: async () => 's',
        read: async () => 's',
        hear: async () => 's',
      },
      convert: async (input) => input,
      logs,
    });
  }

  describe('activeByAccount lock', () => {
    it('refuses a second flow on the same account and names the holder', () => {
      const engine = makeEngine(scopedSource());
      const acc = 'acc-1' as AccountId;
      engine.claimAccountFlow(acc, 'flow-1');

      let thrown: unknown;
      try {
        engine.claimAccountFlow(acc, 'flow-2');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AccountFlowBusyError);
      expect((thrown as AccountFlowBusyError).heldBy).toBe('flow-1');
      expect((thrown as Error).message).toBe(
        'another folder or reconnect flow is already running for this ' +
          'account — finish or cancel it first',
      );
    });

    it('re-claiming with the SAME flowId is idempotent, and release frees only the holder', () => {
      const engine = makeEngine(scopedSource());
      const acc = 'acc-1' as AccountId;
      engine.claimAccountFlow(acc, 'flow-1');
      expect(() => engine.claimAccountFlow(acc, 'flow-1')).not.toThrow();

      // A late release from a flow that no longer holds the slot must not
      // hand the account to nobody — that is how two flows end up live.
      engine.releaseAccountFlow(acc, 'flow-2');
      expect(() => engine.claimAccountFlow(acc, 'flow-3')).toThrow(
        AccountFlowBusyError,
      );

      engine.releaseAccountFlow(acc, 'flow-1');
      expect(() => engine.claimAccountFlow(acc, 'flow-3')).not.toThrow();
    });

    it('the lock is keyed by ACCOUNT, so two accounts of one provider never block each other', () => {
      const engine = makeEngine(scopedSource());
      engine.claimAccountFlow('acc-A' as AccountId, 'flow-1');
      expect(() =>
        engine.claimAccountFlow('acc-B' as AccountId, 'flow-2'),
      ).not.toThrow();
    });

    it('session(): builds a non-pull Session that reads the account vault', async () => {
      const source = scopedSource();
      const engine = makeEngine(source);
      const account = await engine.connect(source, noopAuth);
      await store.vault.save(account.id, { accessToken: 'tok-1' });

      const session = engine.session(
        account,
        new AbortController().signal,
        'source:scoped',
      );
      expect(session.account.id).toBe(account.id);
      expect(await session.credentials()).toEqual({ accessToken: 'tok-1' });
    });
  });

  describe('reconnect', () => {
    /** Bring an account to "synced, then revoked" — the state Reconnect is
     *  offered from (R4: needsReauth | error). Takes the SAME source instance
     *  the engine was built with, so spies on it stay meaningful. */
    async function parkNeedsReauth(
      engine: ReturnType<typeof makeEngine>,
      source: Source,
    ) {
      const account = await engine.connect(source, noopAuth);
      const handle = engine.run(account);
      await waitFor(
        async () => (await store.account(account.id))?.cursor === 2,
      );
      await handle.stop();
      await store.commit({
        account: account.id,
        documents: [],
        cursor: 2,
        status: 'needsReauth',
        error: 'token revoked',
      });
      return account;
    }

    /** The OTHER state R4 offers Reconnect from — `error` — with the loop
     *  still LIVE. Needed because the two post-point-of-no-return tests below
     *  assert that a failure PUTS THE LOOP BACK, and a needsReauth account has
     *  no loop to put back.
     *
     *  Its `pull` yields on its FIRST invocation only and parks WITHOUT
     *  yielding on every one after. That is load-bearing — do not "simplify"
     *  it back to `liveHangingSource`. `pull` is an async generator FUNCTION,
     *  so every `run()` builds a fresh generator from the top: the loop that
     *  `restoreLoopAfterFailure` puts back would replay the same `phase:'live'`
     *  page, and that batch's `store.commit` (engine.ts:717-735) writes
     *  `status: 'live'`, `error: null` — racing the status/lastError
     *  assertions below, which read the same row from the same worker. One
     *  yield in total means the restored loop is genuinely running (isRunning
     *  true, parked inside `abortable()`, still stoppable by afterEach) and
     *  commits nothing, so the committed 'error' status is stable. */
    async function liveErrored() {
      let pulls = 0;
      const source: Source<number, DocumentInput> = {
        ...scopedSource(),
        async *pull() {
          pulls += 1;
          if (pulls > 1) await new Promise<never>(() => {});
          yield {
            phase: 'live',
            items: [doc('d1', 'a'), doc('d2', 'a'), doc('d3', 'a')],
            cursor: 2,
          };
          await new Promise<never>(() => {});
        },
      };
      source.reauthenticate = async (_account: Account, auth: AuthChannel) => {
        await auth.oauth(['drive.readonly']);
      };
      const engine = makeEngine(source);
      const account = await engine.connect(source, noopAuth);
      engine.run(account);
      await waitFor(
        async () => (await store.account(account.id))?.cursor === 2,
      );
      await store.setAccountStatus(account.id, {
        status: 'error',
        error: 'drive said 500',
      });
      expect(engine.isRunning(account.id)).toBe(true);
      return { engine, account };
    }

    const allRows = (account: AccountId) =>
      store.read.search({ account, includeArchived: true, limit: 100 });

    it('preserves config, cursor and every document row byte-for-byte; saves the new credentials; clears the auth error', async () => {
      const pickFolders = jest.fn();
      const reauthenticate = jest.fn(
        async (_account: Account, auth: AuthChannel) => {
          await auth.oauth(['drive.readonly']);
        },
      );
      const source = scopedSource({ reauthenticate });
      const engine = makeEngine(source);
      const account = await parkNeedsReauth(engine, source);

      const before = await store.account(account.id);
      const docsBefore = byExternalIdRows(await allRows(account.id));

      await engine.reconnect(account.id, {
        ...noopAuth,
        oauth: async () => ({ accessToken: 'fresh-token' }),
        pickFolders,
      });

      const after = await store.account(account.id);
      expect(after?.config).toEqual(before?.config);
      expect(after?.cursor).toEqual(before?.cursor);
      expect(after?.status).toBe('connecting');
      expect(after?.lastError).toBeUndefined();
      // C-28.6. Reconnect is not a sync: it fetched no page and committed no
      // document, so the account's "last synced" timestamp must not move. The
      // only door to a status change before this task was `store.commit`, and
      // write-tx.ts:423-431 stamps `last_sync_at = ?` on EVERY commit — an
      // empty `store.commit({documents: [], …})` here would render in the
      // sidebar as a successful sync that never happened.
      expect(after?.lastSyncAt).toBe(before?.lastSyncAt);
      expect(byExternalIdRows(await allRows(account.id))).toEqual(docsBefore);
      expect(await store.vault.load(account.id)).toEqual({
        accessToken: 'fresh-token',
      });
      // Invariant 2: reconnect never changes scope, so it never opens a picker.
      expect(pickFolders).not.toHaveBeenCalled();
      expect(reauthenticate.mock.calls[0][0].id).toBe(account.id);
    });

    it('two accounts of the SAME provider: reconnecting B leaves A byte-identical (A-10)', async () => {
      // The acceptance case R2's per-flow oauthClient and assertAccountIdentity
      // exist to protect. Both accounts are the same source instance, so any
      // keying by SOURCE rather than by ACCOUNT — the vault write, the
      // running-map key, the status commit — shows up here.
      const reauthenticate = jest.fn(
        async (_account: Account, auth: AuthChannel) => {
          await auth.oauth(['drive.readonly']);
        },
      );
      const source = scopedSource({ reauthenticate });
      const engine = makeEngine(source);

      const a = await store.createAccount({
        source: 'scoped',
        identifier: 'a@example.com',
        config: { folderRoots: [{ id: 'a', name: 'Alpha' }] },
        status: 'connecting',
      });
      const b = await store.createAccount({
        source: 'scoped',
        identifier: 'b@example.com',
        config: { folderRoots: [{ id: 'a', name: 'Alpha' }] },
        status: 'connecting',
      });
      for (const acc of [a, b]) {
        const h = engine.run(acc);
        await waitFor(async () => (await store.account(acc.id))?.cursor === 2);
        await h.stop();
      }
      await store.vault.save(a.id, { accessToken: 'A-token' });
      await store.vault.save(b.id, { accessToken: 'B-token' });

      const aBefore = await store.account(a.id);
      const aDocsBefore = byExternalIdRows(await allRows(a.id));

      await engine.reconnect(b.id, {
        ...noopAuth,
        oauth: async () => ({ accessToken: 'B-token-2' }),
      });

      const aAfter = await store.account(a.id);
      expect(aAfter?.config).toEqual(aBefore?.config);
      expect(aAfter?.cursor).toEqual(aBefore?.cursor);
      expect(aAfter?.status).toBe(aBefore?.status);
      expect(aAfter?.lastSyncAt).toBe(aBefore?.lastSyncAt);
      expect(byExternalIdRows(await allRows(a.id))).toEqual(aDocsBefore);
      expect(await store.vault.load(a.id)).toEqual({ accessToken: 'A-token' });
      // …and B really did reconnect, so the assertions above are not vacuous.
      expect(await store.vault.load(b.id)).toEqual({
        accessToken: 'B-token-2',
      });
      expect((await store.account(b.id))?.status).toBe('connecting');
    });

    it('a reauthenticate() that throws saves NO credentials and leaves the account needsReauth', async () => {
      const reauthenticate = jest.fn(
        async (_account: Account, auth: AuthChannel) => {
          await auth.oauth(['drive.readonly']);
          throw new Error('this reconnect signed in as other@example.com');
        },
      );
      const source = scopedSource({ reauthenticate });
      const engine = makeEngine(source);
      const account = await parkNeedsReauth(engine, source);
      await store.vault.save(account.id, { accessToken: 'old-token' });

      await expect(
        engine.reconnect(account.id, {
          ...noopAuth,
          oauth: async () => ({ accessToken: 'someone-elses-token' }),
        }),
      ).rejects.toThrow('signed in as other@example.com');

      expect(await store.vault.load(account.id)).toEqual({
        accessToken: 'old-token',
      });
      const after = await store.account(account.id);
      expect(after?.status).toBe('needsReauth');
      expect(after?.lastError).toBe('token revoked');
    });

    it('refuses a source with no reauthenticate() instead of falling back to connect()', async () => {
      const source = scopedSource();
      const connectSpy = jest.spyOn(source, 'connect');
      const engine = makeEngine(source);
      const account = await parkNeedsReauth(engine, source);
      connectSpy.mockClear();

      await expect(engine.reconnect(account.id, noopAuth)).rejects.toThrow(
        'scoped cannot be reconnected — remove this source and add it again',
      );
      expect(connectSpy).not.toHaveBeenCalled();
    });

    it('the wrapped channel refuses pickFolders even if the source asks for it', async () => {
      const reauthenticate = jest.fn(
        async (_account: Account, auth: AuthChannel) => {
          await auth.pickFolders({
            modes: [],
            roots: async () => [],
            children: async () => [],
          });
        },
      );
      const source = scopedSource({ reauthenticate });
      const engine = makeEngine(source);
      const account = await parkNeedsReauth(engine, source);

      await expect(engine.reconnect(account.id, noopAuth)).rejects.toThrow(
        'reconnect must not change folder scope',
      );
    });

    it('a cancel landing AFTER the point of no return is ignored: the reconnect completes and the account is not left stopped (C-28.3)', async () => {
      // The pre-commit half is Step 13's test — a cancel before the first
      // durable write throws and writes nothing. THIS is the post-commit half:
      // once reconnect has stopped the loop it is committed, and honouring a
      // cancel from there would leave the account with new credentials, a
      // half-written status and NO LOOP, while the UI said "cancelled".
      const { engine, account } = await liveErrored();
      const before = await store.account(account.id);
      const abort = new AbortController();
      const realSave = store.vault.save.bind(store.vault);
      jest.spyOn(store.vault, 'save').mockImplementation(async (id, creds) => {
        // The user hits Cancel exactly here: after stop(), inside the very
        // first durable write.
        abort.abort();
        await realSave(id, creds);
      });

      await expect(
        engine.reconnect(
          account.id,
          { ...noopAuth, oauth: async () => ({ accessToken: 'fresh' }) },
          abort.signal,
        ),
      ).resolves.toBeUndefined();

      expect(await store.vault.load(account.id)).toEqual({
        accessToken: 'fresh',
      });
      const after = await store.account(account.id);
      expect(after?.status).toBe('connecting');
      expect(after?.lastError).toBeUndefined();
      expect(after?.lastSyncAt).toBe(before?.lastSyncAt);
      // The caller (the broker) restarts a RESOLVED reconnect, so the account
      // is not left stopped — proven end-to-end by Step 25's
      // "cancel that lands after the engine committed" broker test.
    });

    it('a status write that fails after the credentials landed keeps the credentials, leaves the old status, and PUTS THE LOOP BACK (C-28.3 / C-28.4)', async () => {
      // Credentials and status are two separate durable writes and there is no
      // transaction spanning them, so the window is real. It is made SAFE by
      // ordering, not by locking: the vault write goes first, so a failure
      // costs the user nothing they cannot redo by pressing Reconnect again
      // (the newer credentials are strictly better than the ones they
      // replaced, and the account still reads as needing a reconnect, so the
      // UI still offers one). The reverse order would leave a healthy-looking
      // account holding a revoked token and hammering the provider with 401s.
      const { engine, account } = await liveErrored();
      jest
        .spyOn(store, 'setAccountStatus')
        .mockRejectedValue(new Error('db worker died'));

      await expect(
        engine.reconnect(account.id, {
          ...noopAuth,
          oauth: async () => ({ accessToken: 'fresh' }),
        }),
      ).rejects.toThrow('db worker died');

      expect(await store.vault.load(account.id)).toEqual({
        accessToken: 'fresh',
      });
      const after = await store.account(account.id);
      expect(after?.status).toBe('error');
      expect(after?.lastError).toBe('drive said 500');
      // …and the account is SYNCING again. Without the restore it would sit
      // stopped: reconnect's contract is that the CALLER restarts, and the
      // caller only restarts on success.
      await waitFor(async () => engine.isRunning(account.id));
      await engine.stopAll();
    });

    it('run() is refused while the transition intent is held, so nothing can install a replacement loop mid-transition (C-28.1)', async () => {
      const { engine, account } = await liveErrored();
      const observed: boolean[] = [];
      jest.spyOn(store, 'setAccountStatus').mockImplementation(async () => {
        // A cadence tick's start-if-idle supervisor (boot.ts:180-205) or a
        // sync-now landing inside the stop→commit window. Both call
        // engine.run, and both read isRunning() === false here because
        // stop() already dropped the map entry.
        engine.run(account);
        observed.push(engine.isRunning(account.id));
      });

      await engine.reconnect(account.id, {
        ...noopAuth,
        oauth: async () => ({ accessToken: 'fresh' }),
      });

      // Refused, so no entry went into `running` and no second loop exists.
      expect(observed).toEqual([false]);
      await engine.stopAll();
    });

    it('a cancel landing after reauthenticate() resolves writes NOTHING — no vault, no status, no removal', async () => {
      const abort = new AbortController();
      const reauthenticate = jest.fn(
        async (_account: Account, auth: AuthChannel) => {
          await auth.oauth(['drive.readonly']);
          // The impatient user: cancel lands while the token exchange is in
          // flight, so the OAuth loopback's own abort rejection missed it.
          abort.abort();
        },
      );
      const source = scopedSource({ reauthenticate });
      const engine = makeEngine(source);
      const account = await parkNeedsReauth(engine, source);
      await store.vault.save(account.id, { accessToken: 'old-token' });

      await expect(
        engine.reconnect(
          account.id,
          { ...noopAuth, oauth: async () => ({ accessToken: 'new-token' }) },
          abort.signal,
        ),
      ).rejects.toThrow('reconnect cancelled');

      expect(await store.vault.load(account.id)).toEqual({
        accessToken: 'old-token',
      });
      const after = await store.account(account.id);
      expect(after?.status).toBe('needsReauth');
      expect(after?.config).toEqual({
        folderRoots: [{ id: 'a', name: 'Alpha' }],
      });
      expect(await store.read.count({ account: account.id })).toBe(3);
    });
  });

  describe('applyScope', () => {
    /** A folder-scoped account whose pull loop is genuinely LIVE when the
     *  scope edit arrives — the case the stop-ordering exists for. */
    async function liveAccount(source: Source) {
      const engine = makeEngine(source);
      const account = await engine.connect(source, noopAuth);
      const handle = engine.run(account);
      await waitFor(
        async () => (await store.account(account.id))?.cursor === 2,
      );
      expect(engine.isRunning(account.id)).toBe(true);
      return { engine, account, handle };
    }

    /** The source computed this, core does not second-guess it. Note that
     *  'a' is being REMOVED from folderRoots and yet is NOT in
     *  archiveScopeRootIds — the Drive-with-catch-all / OneDrive-overlap
     *  happy path (R8). Core must forward, not re-derive. */
    const UPDATE: FolderScopeUpdate = {
      config: {
        folderRoots: [
          { id: 'b', name: 'Beta' },
          { id: 'c', name: 'Gamma' },
        ],
      },
      cursor: { page_token: 'p9', backfill_done: false },
      archiveScopeRootIds: [],
    };

    /** The CAS baseline (**C-28.2**): the account's config exactly as the FLOW
     *  snapshotted it when it opened the picker. `scopedSource().connect()`
     *  returns this object, so it is what `createAccount` stored. It is passed
     *  in as `applyScope`'s third argument and must arrive at the store
     *  unchanged — `applyScope` re-reading the config for itself is the whole
     *  defect C-28.2 names. */
    const CONFIG_AT_OPEN = JSON.stringify({
      folderRoots: [{ id: 'a', name: 'Alpha' }],
    });

    it('stops the loop first, then forwards archiveScopeRootIds VERBATIM with the post-stop config snapshot', async () => {
      const { engine, account } = await liveAccount(liveHangingSource());
      const stillRunning: boolean[] = [];
      const spy = jest
        .spyOn(store, 'applyFolderScope')
        .mockImplementation(async () => {
          stillRunning.push(engine.isRunning(account.id));
          return { archived: 0, remaining: 3, stale: false };
        });

      const res = await engine.applyScope(account.id, UPDATE, CONFIG_AT_OPEN);

      expect(res).toEqual({ archived: 0 });
      // The whole point of the ordering: nothing may be pulling when the
      // scope transaction runs, or the loop's next commit rewrites the
      // cursor we just transformed (engine-accounts map §7.1-7.2).
      expect(stillRunning).toEqual([false]);
      // R8/A-1: the engine passes the SOURCE's array through. It must never
      // appear as ['b','c'] (a set-difference over folderRoots), which on the
      // real production account archives 314 of 316 live rows.
      // C-34: exactly five keys. `archiveNullScoped` is not among them — the
      // store's input type does not declare it in this train, and
      // `toHaveBeenCalledWith` is an exact deep-equality match, so an extra
      // key would fail here as well as at compile time.
      expect(spy).toHaveBeenCalledWith({
        accountId: account.id,
        config: UPDATE.config,
        cursor: UPDATE.cursor,
        archiveScopeRootIds: [],
        expectedConfigJson: CONFIG_AT_OPEN,
      });
      expect(spy.mock.calls[0][0].archiveScopeRootIds).toBe(
        UPDATE.archiveScopeRootIds,
      );
      // applyScope restarted the account, so a NEW handle is live and the
      // liveHangingSource parks forever — tear it down before afterEach
      // closes the store under it.
      await engine.stopAll();
    });

    it('forwards a NON-empty archive set verbatim, but REFUSES archiveNullScoped:true (C-27)', async () => {
      const { engine, account } = await liveAccount(liveHangingSource());
      const spy = jest
        .spyOn(store, 'applyFolderScope')
        .mockResolvedValue({ archived: 7, remaining: 1, stale: false });

      const res = await engine.applyScope(
        account.id,
        {
          config: { folderRoots: [{ id: 'b', name: 'Beta' }] },
          cursor: { page_token: 'p1', backfill_done: false },
          archiveScopeRootIds: ['a', 'zz'],
          // A source may still ASK for this — A-3 lets it — and core still
          // refuses. C-27 made the v3 migration attribution-only, so a row it
          // could not attribute is LIVE with scope_root_id NULL; and a
          // re-walk does not re-stamp it, because both cloud connectors'
          // hashSkip is query-first and emits NOTHING for an unchanged, live,
          // extraction_status:'ok' row (google-docs src/source.ts:463-488,
          // onedrive src/source.ts:293-300). Honouring the flag would archive
          // exactly the rows the migration was forbidden to touch.
          archiveNullScoped: true,
        },
        CONFIG_AT_OPEN,
      );

      expect(res).toEqual({ archived: 7 });
      // The source's array crosses untouched…
      expect(spy.mock.calls[0][0].archiveScopeRootIds).toEqual(['a', 'zz']);
      // …and the flag does not cross at all. C-34: it is not forwarded as
      // `false` either — the store's input type has no such property, so the
      // key is ABSENT. `not.toHaveProperty` is the assertion that says that
      // and still compiles against a type that lacks the field (a
      // `.archiveNullScoped` member access here would be TS2339).
      expect(spy.mock.calls[0][0]).not.toHaveProperty('archiveNullScoped');
      expect(
        logs.log.mock.calls.filter(
          (c) => c[2] === 'archiveNullScoped refused (C-27)',
        ),
      ).toHaveLength(1);
      const refusal = logs.log.mock.calls.find(
        (c) => c[2] === 'archiveNullScoped refused (C-27)',
      );
      expect(refusal?.[0]).toBe('folder-scope');
      expect(refusal?.[1]).toBe('warn');
      expect(refusal?.[3]).toEqual({ accountId: account.id });
      await engine.stopAll();
    });

    it('rejects an EMPTY folderRoots set without touching the store', async () => {
      // Invariant 6 / R3 — an account must keep at least one root. Distinct
      // from an empty archiveScopeRootIds, which is legal and is the common
      // case above; this is about the SCOPE going empty, not the archive set.
      const { engine, account, handle } =
        await liveAccount(liveHangingSource());
      const spy = jest.spyOn(store, 'applyFolderScope');

      await expect(
        engine.applyScope(
          account.id,
          {
            config: { folderRoots: [] },
            cursor: null,
            archiveScopeRootIds: [],
          },
          CONFIG_AT_OPEN,
        ),
      ).rejects.toBeInstanceOf(FolderScopeConfigError);
      expect(spy).not.toHaveBeenCalled();
      // Refused before quiescing: a bad update must not cost the account its
      // running loop.
      expect(engine.isRunning(account.id)).toBe(true);
      await handle.stop();
    });

    it('a stale store result throws FolderScopeStaleError, leaves the config alone, and PUTS THE LOOP BACK (C-28.4)', async () => {
      const { engine, account } = await liveAccount(liveHangingSource());
      jest
        .spyOn(store, 'applyFolderScope')
        .mockResolvedValue({ archived: 0, remaining: 3, stale: true });

      await expect(
        engine.applyScope(account.id, UPDATE, CONFIG_AT_OPEN),
      ).rejects.toBeInstanceOf(FolderScopeStaleError);
      expect((await store.account(account.id))?.config).toEqual({
        folderRoots: [{ id: 'a', name: 'Alpha' }],
      });
      // C-28.4 — this expectation used to read `.toBe(false)`, and that was
      // the defect, not the guarantee. applyScope quiesces the account before
      // it can know whether the write will succeed; if it then throws and
      // walks away, a previously-syncing account is left stopped. Nothing
      // restarts it: the caller is failing, boot's resumeAccounts already ran,
      // and a source with no `descriptor.cadence` gets no scheduler job at all
      // (boot.ts:180-183). "Failure changes no state" has to include the LOOP.
      await waitFor(async () => engine.isRunning(account.id));
      await engine.stopAll();
    });

    it('a store failure after the stop ALSO puts the loop back — the C-29 commit-before-ack window', async () => {
      // C-29: the DB worker commits and then dies before posting its reply
      // (bridge.ts commits, worker-client.ts rejects the in-flight call). The
      // archive is DURABLE and the caller sees a rejection, so the
      // compensating backfill for the newly-added roots would never start.
      // Calling through to the real applyFolderScope first, then rejecting, is
      // what makes this the real window rather than a mock of it.
      const { engine, account } = await liveAccount(liveHangingSource());
      const realApply = store.applyFolderScope.bind(store);
      jest
        .spyOn(store, 'applyFolderScope')
        .mockImplementation(async (input) => {
          await realApply(input);
          throw new Error('db worker died');
        });

      await expect(
        engine.applyScope(account.id, UPDATE, CONFIG_AT_OPEN),
      ).rejects.toThrow('db worker died');

      // The write really landed — this is not a rollback test.
      expect((await store.account(account.id))?.config).toEqual(UPDATE.config);
      // …and the loop is back, re-reading the COMMITTED config, so the added
      // roots get their backfill.
      await waitFor(async () => engine.isRunning(account.id));
      await engine.stopAll();
    });

    it('uses the CALLER’s picker-open snapshot as the CAS baseline, never a fresher re-read (C-28.2)', async () => {
      const { engine, account } = await liveAccount(liveHangingSource());
      // A NON-folder config update lands after the flow snapshotted and before
      // applyScope runs — an outbound-settings save, a cadence override. With
      // the old two-argument applyScope this newer config became the CAS
      // baseline, the guard matched itself, and `UPDATE ... SET config = ?`
      // silently threw the change away.
      await store.setAccountConfig(account.id, {
        folderRoots: [{ id: 'a', name: 'Alpha' }],
        outbound: { confirm: 'never' },
      });
      const spy = jest
        .spyOn(store, 'applyFolderScope')
        .mockResolvedValue({ archived: 0, remaining: 3, stale: false });

      await engine.applyScope(account.id, UPDATE, CONFIG_AT_OPEN);

      expect(spy.mock.calls[0][0].expectedConfigJson).toBe(CONFIG_AT_OPEN);
      await engine.stopAll();
    });

    it('drives the REAL store with a stale snapshot: nothing is written and the loop comes back', async () => {
      // No spy — Task 3's actual CAS decides. This is the assertion that the
      // threading in the previous test is worth something: a lost update is
      // now a refusal the user is told about, not a silent overwrite.
      const { engine, account } = await liveAccount(liveHangingSource());
      await store.setAccountConfig(account.id, {
        folderRoots: [{ id: 'a', name: 'Alpha' }],
        outbound: { confirm: 'never' },
      });

      await expect(
        engine.applyScope(account.id, UPDATE, CONFIG_AT_OPEN),
      ).rejects.toBeInstanceOf(FolderScopeStaleError);

      expect((await store.account(account.id))?.config).toEqual({
        folderRoots: [{ id: 'a', name: 'Alpha' }],
        outbound: { confirm: 'never' },
      });
      expect(await store.read.count({ account: account.id })).toBe(3);
      await waitFor(async () => engine.isRunning(account.id));
      await engine.stopAll();
    });

    it('two accounts of the SAME provider: B’s real archival never touches A (A-10)', async () => {
      // No spy here — this drives Task 3's REAL applyFolderScope, so the
      // `account_id = ?` half of the predicate and the IN-list half are both
      // under test on live rows.
      const source = scopedSource();
      const engine = makeEngine(source);
      const a = await store.createAccount({
        source: 'scoped',
        identifier: 'a@example.com',
        config: { folderRoots: [{ id: 'a', name: 'Alpha' }] },
        status: 'connecting',
      });
      const b = await store.createAccount({
        source: 'scoped',
        identifier: 'b@example.com',
        config: { folderRoots: [{ id: 'a', name: 'Alpha' }] },
        status: 'connecting',
      });
      for (const acc of [a, b]) {
        const h = engine.run(acc);
        await waitFor(async () => (await store.account(acc.id))?.cursor === 2);
        await h.stop();
      }

      const aBefore = await store.account(a.id);
      const aDocsBefore = byExternalIdRows(
        await store.read.search({
          account: a.id,
          includeArchived: true,
          limit: 100,
        }),
      );

      const res = await engine.applyScope(
        b.id,
        {
          config: { folderRoots: [{ id: 'b', name: 'Beta' }] },
          // Cursor 2 is past the fake source's last page, so applyScope's
          // restart pulls nothing and cannot re-commit rows underneath the
          // assertions below. A real connector would reset it for the new root.
          cursor: 2,
          archiveScopeRootIds: ['a'],
        },
        CONFIG_AT_OPEN,
      );
      await engine.stopAll();

      expect(res.archived).toBe(3);
      expect(await store.read.count({ account: b.id })).toBe(0);
      // …and A is untouched: config, cursor, and every row byte-for-byte.
      const aAfter = await store.account(a.id);
      expect(aAfter?.config).toEqual(aBefore?.config);
      expect(aAfter?.cursor).toEqual(aBefore?.cursor);
      expect(await store.read.count({ account: a.id })).toBe(3);
      expect(
        byExternalIdRows(
          await store.read.search({
            account: a.id,
            includeArchived: true,
            limit: 100,
          }),
        ),
      ).toEqual(aDocsBefore);
    });

    /** **C-35 fixtures.** A source whose `pull` never yields — so nothing
     *  races the account's `error` field, the same reason engine.test.ts's
     *  whole reconcile suite uses a hanging pull (`:1500-1529`) — and whose
     *  `reconcile` lists NOTHING. Over a non-empty corpus that is the
     *  zero-false-positive case `engine.ts:303` refuses outright… unless a
     *  mass-archive allowance is in hand, in which case it archives the whole
     *  account. That is exactly what makes the allowance observable from
     *  outside `createEngine`, where `reconcileAllowances` is a private Set. */
    function emptyListingSource(): Source<number, DocumentInput> {
      return {
        ...scopedSource(),
        // eslint-disable-next-line require-yield
        async *pull() {
          await new Promise<never>(() => {});
        },
        async *reconcile() {
          yield [];
        },
      };
    }

    /** Seed WITHOUT `engine.connect`. **This is load-bearing, not style:**
     *  `connect` grants an allowance of its own (`engine.ts:555`
     *  `reconcileAllowances.add(account.id)` — a re-connect legitimately
     *  re-scopes an account), so an account built through `connect` arrives at
     *  `applyScope` already holding one: the widening test below would go RED
     *  with the C-35 guard correctly in place (the connect-time grant archives
     *  the corpus regardless), and its control would be vacuous — the pair
     *  would be measuring `connect`, not `applyScope`. engine.test.ts's own
     *  breaker tests bypass `connect` for the same reason and say so
     *  (`seedDocsDirect`, doc comment at `:1747-1749`). The config matches
     *  CONFIG_AT_OPEN, so the store's CAS is satisfied on any path that does
     *  not mock it. */
    async function seededNoAllowance(source: Source) {
      const engine = makeEngine(source);
      const account = await store.createAccount({
        source: source.descriptor.id,
        identifier: 'breaker@example.com',
        config: { folderRoots: [{ id: 'a', name: 'Alpha' }] },
        status: 'connecting',
      });
      await store.commit({
        account: account.id,
        documents: [doc('d1', 'a'), doc('d2', 'a'), doc('d3', 'a')],
        cursor: 1,
      });
      return { engine, account };
    }

    /** The restarted account's reconcile pass settles one of two ways: it
     *  REFUSES (writing lastError) or it ARCHIVES (live count → 0). Waiting on
     *  the disjunction means a mutation fails on an assertion diff rather than
     *  on a 4-second `waitFor timeout`. */
    const reconcileSettled = (accountId: AccountId) => async () =>
      !!(await store.account(accountId))?.lastError ||
      (await store.read.count({ account: accountId })) === 0;

    it('a WIDENING Save that archived nothing grants NO mass-archive allowance (C-35)', async () => {
      // The user added a folder and removed none: archiveScopeRootIds is
      // empty and the store archives nothing. There is no mass-archive to
      // authorise — and the allowance does not merely relax the ≥100/≥50%
      // ratio, it bypasses the "the listing came back empty" refusal too
      // (engine.ts:284-313 — ONE `if (!allowMassArchive)` wraps both arms).
      // Granting it here would let the very next reconcile archive the whole
      // corpus off a broken listing.
      const { engine, account } = await seededNoAllowance(emptyListingSource());
      jest
        .spyOn(store, 'applyFolderScope')
        .mockResolvedValue({ archived: 0, remaining: 3, stale: false });

      await engine.applyScope(
        account.id,
        {
          config: {
            folderRoots: [
              { id: 'a', name: 'Alpha' },
              { id: 'b', name: 'Beta' },
            ],
          },
          cursor: { page_token: 'p1', backfill_done: false },
          archiveScopeRootIds: [],
        },
        CONFIG_AT_OPEN,
      );

      // applyScope restarted the account, so its reconcile pass runs now and
      // consumes whatever allowance was granted.
      await waitFor(reconcileSettled(account.id));
      await engine.stopAll();

      const acc = await store.account(account.id);
      expect(acc?.lastError).toMatch(/refusing to archive 3 of 3/);
      expect(acc?.lastError).toMatch(/listing came back empty/);
      expect(await store.read.count({ account: account.id })).toBe(3);
    });

    it('a Save that DID archive keeps its allowance, so the next pass may mass-archive (C-35 control)', async () => {
      // The other half, and it is not optional: without it `res.archived > 0`
      // could be replaced by `false` — or the `reconcileAllowances.add` line
      // deleted outright — and the test above would still be green. A removed
      // root IS the case the allowance exists for (a re-scope legitimately
      // archives a big fraction of the corpus), so it must survive.
      const { engine, account } = await seededNoAllowance(emptyListingSource());
      jest
        .spyOn(store, 'applyFolderScope')
        .mockResolvedValue({ archived: 2, remaining: 1, stale: false });

      await engine.applyScope(
        account.id,
        {
          config: { folderRoots: [{ id: 'b', name: 'Beta' }] },
          cursor: { page_token: 'p1', backfill_done: false },
          archiveScopeRootIds: ['a'],
        },
        CONFIG_AT_OPEN,
      );

      await waitFor(reconcileSettled(account.id));
      await engine.stopAll();

      expect((await store.account(account.id))?.lastError).toBeFalsy();
      expect(await store.read.count({ account: account.id })).toBe(0);
      // Archived, never purged — the store spy stood in for the Save's own
      // archival, so all three rows here were archived by the reconcile pass
      // the allowance let through.
      expect(
        await store.read.count({ account: account.id, includeArchived: true }),
      ).toBe(3);
    });

    // Belt-and-braces: `run()` re-reads the committed status and refuses a
    // paused account on its own (engine.ts:638-651), so this test passes even
    // with applyScope's gate deleted (see Step 20). It is kept because it
    // pins the COMPOSED invariant — a Save on a paused account leaves it
    // paused — rather than one line of one function.
    it('a paused account stays paused and is NOT restarted', async () => {
      const { engine, account, handle } =
        await liveAccount(liveHangingSource());
      await handle.stop();
      await store.commit({
        account: account.id,
        documents: [],
        cursor: 2,
        status: 'paused',
      });
      jest
        .spyOn(store, 'applyFolderScope')
        .mockResolvedValue({ archived: 0, remaining: 3, stale: false });

      await engine.applyScope(account.id, UPDATE, CONFIG_AT_OPEN);
      await new Promise((r) => {
        setTimeout(r, 300);
      });

      expect((await store.account(account.id))?.status).toBe('paused');
      expect(engine.isRunning(account.id)).toBe(false);
    });

    it('a needsReauth account is NOT restarted — the scope change is durable, the loop stays parked', async () => {
      const { engine, account, handle } =
        await liveAccount(liveHangingSource());
      await handle.stop();
      await store.commit({
        account: account.id,
        documents: [],
        cursor: 2,
        status: 'needsReauth',
        error: 'token revoked',
      });
      jest
        .spyOn(store, 'applyFolderScope')
        .mockResolvedValue({ archived: 0, remaining: 3, stale: false });

      await engine.applyScope(account.id, UPDATE, CONFIG_AT_OPEN);
      await new Promise((r) => {
        setTimeout(r, 300);
      });

      expect((await store.account(account.id))?.status).toBe('needsReauth');
      expect(engine.isRunning(account.id)).toBe(false);
    });
  });

  describe('updateConfig is closed to folder scope and to accounts in transition', () => {
    it('rejects a payload that CARRIES folderRoots', async () => {
      const engine = makeEngine(scopedSource());
      const account = await store.createAccount({
        source: 'scoped',
        identifier: 'me@example.com',
        config: { folderRoots: [{ id: 'a', name: 'Alpha' }] },
      });

      await expect(
        engine.updateConfig(account.id, {
          folderRoots: [{ id: 'b', name: 'Beta' }],
        }),
      ).rejects.toBeInstanceOf(FolderScopeConfigError);
      expect((await store.account(account.id))?.config).toEqual({
        folderRoots: [{ id: 'a', name: 'Alpha' }],
      });
    });

    it('preserves the stored scope (and R1’s legacy mirror) when the payload OMITS it', async () => {
      // setAccountConfig is a whole-column overwrite (store.ts:1131-1143), so
      // an omission deletes the scope just as surely as a rewrite would —
      // while `accounts:update-config` must stay usable for non-folder keys.
      // The mirror keys ride along because A-2 makes CORE their owner: they
      // are written by the v3 migration and by applyFolderScope, so losing
      // them here would silently end the R1 train for this account.
      const engine = makeEngine(scopedSource());
      const account = await store.createAccount({
        source: 'scoped',
        identifier: 'me@example.com',
        config: {
          folderRoots: [{ id: 'a', name: 'Alpha' }],
          roots: [{ rootFolderId: 'a', rootName: 'Alpha' }],
          outbound: { confirm: 'always' },
        },
      });

      await engine.updateConfig(account.id, {
        outbound: { confirm: 'never' },
      });

      expect((await store.account(account.id))?.config).toEqual({
        folderRoots: [{ id: 'a', name: 'Alpha' }],
        roots: [{ rootFolderId: 'a', rootName: 'Alpha' }],
        outbound: { confirm: 'never' },
      });
    });

    it('leaves a non-folder-scoped account’s config write untouched', async () => {
      const engine = makeEngine(scopedSource());
      const account = await store.createAccount({
        source: 'scoped',
        identifier: 'plain@example.com',
        config: { mailbox: 'INBOX' },
      });

      await engine.updateConfig(account.id, { mailbox: 'Archive' });

      expect((await store.account(account.id))?.config).toEqual({
        mailbox: 'Archive',
      });
    });

    it('refuses while an account TRANSITION is in flight — the scope Save survives, the config write does not (C-28.1)', async () => {
      // Codex's finding, reproduced: applyScope has quiesced the account and
      // is inside the store transaction when an `accounts:update-config`
      // lands. `updateConfig` never consulted any per-account state, so it
      // wrote the config column out from under the transaction — and the
      // config CAS could not defend the account, because an ordinary pull
      // commit does not change config, so nobody upstream had any reason to
      // think config was contended. The visible consequence is not subtle:
      // the user's folder Save comes back "this account changed while the
      // folder picker was open", every time, for a write they did not make.
      const source = liveHangingSource();
      const engine = makeEngine(source);
      const account = await engine.connect(source, noopAuth);
      engine.run(account);
      await waitFor(
        async () => (await store.account(account.id))?.cursor === 2,
      );

      const SNAPSHOT = JSON.stringify({
        folderRoots: [{ id: 'a', name: 'Alpha' }],
      });
      let refusal: unknown = 'never ran';
      const realApply = store.applyFolderScope.bind(store);
      jest
        .spyOn(store, 'applyFolderScope')
        .mockImplementation(async (input) => {
          refusal = await engine
            .updateConfig(account.id, { outbound: { confirm: 'never' } })
            .then(() => null)
            .catch((err: unknown) => err);
          return realApply(input);
        });

      // Resolves. Without the guard this REJECTS with FolderScopeStaleError:
      // updateConfig's setAccountConfig moves the stored config, and the CAS
      // — correctly — refuses to write over it.
      const res = await engine.applyScope(
        account.id,
        {
          config: { folderRoots: [{ id: 'b', name: 'Beta' }] },
          cursor: null,
          archiveScopeRootIds: [],
        },
        SNAPSHOT,
      );

      expect(res.archived).toBe(0);
      expect(refusal).toBeInstanceOf(AccountFlowBusyError);
      const cfg = (await store.account(account.id))?.config as Record<
        string,
        unknown
      >;
      expect(cfg.folderRoots).toEqual([{ id: 'b', name: 'Beta' }]);
      expect(cfg.outbound).toBeUndefined();
      await engine.stopAll();
    });

    it('refuses while a broker FLOW holds the account slot, and accepts once it is released', async () => {
      const engine = makeEngine(scopedSource());
      const account = await store.createAccount({
        source: 'scoped',
        identifier: 'plain2@example.com',
        config: { mailbox: 'INBOX' },
      });
      engine.claimAccountFlow(account.id, 'flow-1');

      await expect(
        engine.updateConfig(account.id, { mailbox: 'Archive' }),
      ).rejects.toBeInstanceOf(AccountFlowBusyError);
      expect((await store.account(account.id))?.config).toEqual({
        mailbox: 'INBOX',
      });

      engine.releaseAccountFlow(account.id, 'flow-1');
      await engine.updateConfig(account.id, { mailbox: 'Archive' });
      expect((await store.account(account.id))?.config).toEqual({
        mailbox: 'Archive',
      });
    });
  });
});
