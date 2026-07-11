/**
 * Source-error taxonomy (source-errors.ts): an 'auth'-coded failure lands the
 * account on status 'needsReauth' after ONE attempt (no retry storm against a
 * revoked credential), a 'permanent'-coded failure lands on 'error' after one
 * attempt, and un-coded failures keep the transient retry path. Also pins the
 * makeSession rule: an auth-coded token-refresh failure PROPAGATES, while a
 * transient refresh failure degrades to warn-and-return-stale.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Account, Batch, Credentials, Source } from '@shared/contracts';
import { SourceAuthError, SourcePermanentError } from '@shared/source-errors';

import { openDb } from '../../../db/app-db';
import { openStore } from '../../store/store';
import type { CoreStore } from '../../store/store';
import { createEngine } from '../engine';

jest.setTimeout(20_000);

const noopLogs = { log: () => {} };

const inference = {
  complete: async () => '',
  see: async () => '',
  read: async () => '',
  hear: async () => '',
};

async function waitUntil(
  cond: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function throwingSource(err: () => Error, onPull?: () => void): Source {
  return {
    descriptor: {
      id: 'throwy',
      name: 'Throwy',
      documentTypes: ['note'],
      auth: 'none',
    },
    async connect() {
      return { identifier: 'throwy@test' };
    },
    // eslint-disable-next-line require-yield
    async *pull() {
      onPull?.();
      throw err();
    },
    toDocument: () => null,
  };
}

describe('source error taxonomy', () => {
  let dir: string;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-reauth-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
    });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeEngine(
    source: Source,
    refreshers?: Map<string, (c: Credentials) => Promise<Credentials | null>>,
  ) {
    return createEngine({
      store,
      sources: {
        get: (id) => (id === source.descriptor.id ? source : undefined),
      },
      inference,
      convert: async (input) => input,
      logs: noopLogs,
      refreshers,
    });
  }

  async function makeAccount(source: Source): Promise<Account> {
    return store.createAccount({
      source: source.descriptor.id,
      identifier: 'me@test',
    });
  }

  it("an 'auth'-coded pull failure commits needsReauth after ONE attempt", async () => {
    let pulls = 0;
    const source = throwingSource(
      () => new SourceAuthError('gmail 401 token revoked'),
      () => {
        pulls += 1;
      },
    );
    const engine = makeEngine(source);
    const account = await makeAccount(source);

    const handle = engine.run(account) as ReturnType<typeof engine.run> & {
      active(): boolean;
    };
    await waitUntil(() => !handle.active()); // settled on its own — no abort
    const fresh = await store.account(account.id);
    expect(fresh?.status).toBe('needsReauth');
    expect(fresh?.lastError).toContain('token revoked');
    expect(pulls).toBe(1); // no retry storm against a revoked credential
  });

  it('updateConfig does NOT restart a resting needsReauth account', async () => {
    // The loop finishes on needsReauth but its running-map entry lingers until
    // stop(); updateConfig must apply the same resting-state gate as boot's
    // cadence tick, or saving a config change would re-hammer the revoked
    // credential once and recommit needsReauth.
    let pulls = 0;
    const source = throwingSource(
      () => new SourceAuthError('gmail 401 token revoked'),
      () => {
        pulls += 1;
      },
    );
    const engine = makeEngine(source);
    const account = await makeAccount(source);

    const handle = engine.run(account) as ReturnType<typeof engine.run> & {
      active(): boolean;
    };
    await waitUntil(() => !handle.active());
    expect((await store.account(account.id))?.status).toBe('needsReauth');
    expect(pulls).toBe(1);

    await engine.updateConfig(account.id, { foo: 'bar' });
    await new Promise((r) => setTimeout(r, 150));
    expect(pulls).toBe(1); // no doomed re-pull against the revoked credential
    expect((await store.account(account.id))?.status).toBe('needsReauth');
  });

  it("a 'permanent'-coded pull failure commits error after ONE attempt", async () => {
    let pulls = 0;
    const source = throwingSource(
      () => new SourcePermanentError('legacy config — re-add the folder'),
      () => {
        pulls += 1;
      },
    );
    const engine = makeEngine(source);
    const account = await makeAccount(source);

    const handle = engine.run(account) as ReturnType<typeof engine.run> & {
      active(): boolean;
    };
    await waitUntil(() => !handle.active());
    const fresh = await store.account(account.id);
    expect(fresh?.status).toBe('error');
    expect(pulls).toBe(1);
  });

  it('a rehydrated plain Error carrying code=auth classifies identically (wire shape)', async () => {
    // What source-proxy rehydrates for extension sources: NOT instanceof
    // SourceAuthError, just a plain Error with the code property.
    const source = throwingSource(() => {
      const e = new Error('proxied 401') as Error & { code: string };
      e.code = 'auth';
      return e;
    });
    const engine = makeEngine(source);
    const account = await makeAccount(source);

    const handle = engine.run(account) as ReturnType<typeof engine.run> & {
      active(): boolean;
    };
    await waitUntil(() => !handle.active());
    expect((await store.account(account.id))?.status).toBe('needsReauth');
  });

  it('an auth-coded token-refresh failure propagates to needsReauth', async () => {
    // The source itself never throws — the failure comes from the refresher
    // via session.credentials(). Without the makeSession rethrow rule this
    // would degrade to a stale token and an untyped downstream failure.
    const source: Source = {
      descriptor: {
        id: 'oauthy',
        name: 'OAuthy',
        documentTypes: ['note'],
        auth: 'oauth',
      },
      async connect() {
        return { identifier: 'oauthy@test' };
      },
      async *pull(session) {
        await session.credentials();
        yield {
          phase: 'live',
          items: [],
          cursor: 1,
        } as Batch<unknown, unknown>;
      },
      toDocument: () => null,
    };
    const refreshers = new Map([
      [
        'oauthy',
        async () => {
          throw new SourceAuthError('invalid_grant — token revoked');
        },
      ],
    ]);
    const engine = makeEngine(source, refreshers);
    const account = await makeAccount(source);
    await store.vault.save(account.id, {
      accessToken: 'stale',
      refreshToken: 'revoked',
      expiresAt: new Date(Date.now() - 1000).toISOString(), // forces refresh
    });

    const handle = engine.run(account) as ReturnType<typeof engine.run> & {
      active(): boolean;
    };
    await waitUntil(() => !handle.active());
    const fresh = await store.account(account.id);
    expect(fresh?.status).toBe('needsReauth');
    expect(fresh?.lastError).toContain('invalid_grant');
  });

  it('a transient (un-coded) refresh failure degrades to the stale token', async () => {
    const seenTokens: Array<string | undefined> = [];
    const source: Source = {
      descriptor: {
        id: 'oauthy',
        name: 'OAuthy',
        documentTypes: ['note'],
        auth: 'oauth',
      },
      async connect() {
        return { identifier: 'oauthy@test' };
      },
      async *pull(session) {
        seenTokens.push((await session.credentials())?.accessToken);
        yield {
          phase: 'live',
          items: [],
          cursor: 1,
        } as Batch<unknown, unknown>;
      },
      toDocument: () => null,
    };
    const refreshers = new Map([
      [
        'oauthy',
        async () => {
          throw new Error('network is down'); // transient — NOT auth-coded
        },
      ],
    ]);
    const engine = makeEngine(source, refreshers);
    const account = await makeAccount(source);
    await store.vault.save(account.id, {
      accessToken: 'stale-but-usable',
      refreshToken: 'fine',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const handle = engine.run(account) as ReturnType<typeof engine.run> & {
      active(): boolean;
    };
    await waitUntil(() => !handle.active());
    expect(seenTokens).toEqual(['stale-but-usable']);
    expect((await store.account(account.id))?.status).toBe('live');
  });
});
