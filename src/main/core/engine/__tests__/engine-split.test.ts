import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  Account,
  AuthChannel,
  DocumentInput,
  Source,
} from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore } from '../../store/store';
import type { CoreStore } from '../../store/store';
import { createEngine } from '../engine';

async function makeStore(dir: string): Promise<CoreStore> {
  return openStore(await openDb(path.join(dir, 'test.db')), {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => [],
  });
}

function source(
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
    async connect(auth) {
      await auth.oauth(['read']);
      return {
        identifier: 'me@example.com',
        config: { folderRoots: [{ id: 'a', name: 'Alpha' }] },
        credentials: { secret: 'x' },
      };
    },
    async reauthenticate(_account, auth) {
      await auth.oauth(['read']);
    },
    async *pull() {
      await new Promise<never>(() => {});
    },
    toDocument: (item) => item,
    ...extra,
  };
}

const auth = (token: string): AuthChannel => ({
  oauth: async () => ({ accessToken: token }),
  showQr: () => {},
  prompt: async () => ({}),
  status: () => {},
  pickFolders: async () => [],
});

describe('connect and reconnect in two halves', () => {
  let dir: string;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-split-'));
    store = await makeStore(dir);
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const make = (s: Source) =>
    createEngine({
      store,
      sources: { get: (id) => (id === s.descriptor.id ? s : undefined) },
      inference: {
        complete: async () => 's',
        see: async () => 's',
        read: async () => 's',
        hear: async () => 's',
      },
      convert: async (input) => input,
      logs: { log: () => {} },
    });

  it('the sign-in half returns the login and writes nothing', async () => {
    const engine = make(source() as Source);
    const c = await engine.connectAuth(source() as Source, auth('t1'));
    expect(c).toEqual({
      sourceId: 'scoped',
      identifier: 'me@example.com',
      config: { folderRoots: [{ id: 'a', name: 'Alpha' }] },
      credentials: { accessToken: 't1', secret: 'x' },
      usedPicker: false,
    });
    expect(await store.read.accounts()).toEqual([]);
  });

  it('the commit half creates the account and saves the login', async () => {
    const engine = make(source() as Source);
    const c = await engine.connectAuth(source() as Source, auth('t1'));
    const account = await engine.adopt(c);
    expect(account.identifier).toBe('me@example.com');
    expect(account.status).toBe('connecting');
    expect(await store.vault.load(account.id)).toEqual({
      accessToken: 't1',
      secret: 'x',
    });
  });

  it('adopting again keeps the folder scope a known account had', async () => {
    const engine = make(source() as Source);
    const first = await engine.adopt({
      sourceId: 'scoped',
      identifier: 'me@example.com',
      config: { folderRoots: [{ id: 'kept', name: 'Kept' }] },
      credentials: null,
      usedPicker: true,
    });
    const again = await engine.adopt({
      sourceId: 'scoped',
      identifier: 'me@example.com',
      config: { folderRoots: [{ id: 'a', name: 'Alpha' }] },
      credentials: null,
      usedPicker: false,
    });
    expect(again.id).toBe(first.id);
    expect((again.config as { folderRoots: unknown }).folderRoots).toEqual([
      { id: 'kept', name: 'Kept' },
    ]);
  });

  it('adopting for a source this device does not have is refused', async () => {
    const engine = make(source() as Source);
    await expect(
      engine.adopt({
        sourceId: 'nope',
        identifier: 'x',
        config: {},
        credentials: null,
        usedPicker: false,
      }),
    ).rejects.toThrow('unknown source: nope');
    expect(await store.read.accounts()).toEqual([]);
  });

  it('connect is both halves', async () => {
    const engine = make(source() as Source);
    const account = await engine.connect(source() as Source, auth('t1'));
    expect(await store.vault.load(account.id)).toEqual({
      accessToken: 't1',
      secret: 'x',
    });
  });

  describe('reconnect', () => {
    let account: Account;
    let engine: ReturnType<typeof make>;
    beforeEach(async () => {
      engine = make(source() as Source);
      account = await engine.connect(source() as Source, auth('t1'));
      await store.setAccountStatus(account.id, {
        status: 'needsReauth',
        error: 'signed out',
      });
    });

    it('the sign-in half returns the new login and writes nothing', async () => {
      const r = await engine.reauth(account.id, auth('t2'));
      expect(r).toEqual({
        accountId: account.id,
        credentials: { accessToken: 't2' },
      });
      expect(await store.vault.load(account.id)).toEqual({
        accessToken: 't1',
        secret: 'x',
      });
      expect((await store.account(account.id))?.status).toBe('needsReauth');
    });

    it('the sign-in half throws when it was cancelled', async () => {
      const ctl = new AbortController();
      ctl.abort();
      await expect(
        engine.reauth(account.id, auth('t2'), ctl.signal),
      ).rejects.toThrow('reconnect cancelled');
    });

    it('the commit half saves the login and clears the error', async () => {
      await engine.commitReauth({
        accountId: account.id,
        credentials: { accessToken: 't2' },
      });
      expect(await store.vault.load(account.id)).toEqual({ accessToken: 't2' });
      const now = await store.account(account.id);
      expect(now?.status).toBe('connecting');
      expect(now?.lastError ?? null).toBeNull();
    });

    it('the commit half refuses an unknown account', async () => {
      await expect(
        engine.commitReauth({
          accountId: 'missing' as Account['id'],
          credentials: null,
        }),
      ).rejects.toThrow('unknown account: missing');
    });
  });

  describe('a login for a copy that asked', () => {
    const SENTINEL = 'SENTINEL-refresh-9f3a';
    const soon = () => new Date(Date.now() + 10_000).toISOString();
    const makeWith = (
      refresh: () => Promise<{ accessToken: string } | null>,
      log: (...a: unknown[]) => void,
    ) => {
      const s = source() as Source;
      return createEngine({
        store,
        sources: { get: (id) => (id === s.descriptor.id ? s : undefined) },
        refreshers: new Map([['scoped', refresh]]),
        inference: {
          complete: async () => 's',
          see: async () => 's',
          read: async () => 's',
          hear: async () => 's',
        },
        convert: async (input) => input,
        logs: { log },
      });
    };

    it('a failed refresh logs no error text', async () => {
      const lines: unknown[][] = [];
      const engine = makeWith(
        async () => {
          throw new Error(`boom ${SENTINEL}`);
        },
        (...a) => lines.push(a),
      );
      const account = await engine.adopt({
        sourceId: 'scoped',
        identifier: 'me@example.com',
        config: {},
        credentials: { accessToken: 'old', expiresAt: soon() },
        usedPicker: false,
      });
      await expect(
        engine.freshCredentialsQuiet(account.id),
      ).resolves.toMatchObject({ accessToken: 'old' });
      expect(JSON.stringify(lines)).toContain('token refresh failed');
      expect(JSON.stringify(lines)).not.toContain(SENTINEL);
    });

    it("a session that goes through the leader never refreshes or saves here", async () => {
      const refresh = jest.fn(async () => ({ accessToken: 'local-refresh' }));
      const engine = makeWith(refresh, () => {});
      const account = await engine.adopt({
        sourceId: 'scoped',
        identifier: 'me@example.com',
        config: {},
        credentials: { accessToken: 'old', expiresAt: soon() },
        usedPicker: false,
      });
      const viaLeader = jest.fn(async () => ({ accessToken: 'from-leader' }));
      const session = engine.session(
        account,
        new AbortController().signal,
        'test',
        viaLeader,
      );
      await expect(session.credentials()).resolves.toEqual({
        accessToken: 'from-leader',
      });
      expect(refresh).not.toHaveBeenCalled();
      expect((await store.vault.load(account.id))?.accessToken).toBe('old');

      await store.vault.save(account.id, {
        accessToken: 'good',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await expect(session.credentials()).resolves.toMatchObject({
        accessToken: 'good',
      });
      expect(viaLeader).toHaveBeenCalledTimes(1);
    });
  });
});
