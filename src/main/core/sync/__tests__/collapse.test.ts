/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Account } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { resumeAccounts, type CorePlatform } from '../../boot';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import {
  collapseFormerlyOwned,
  planCollapse,
  type CollapseRow,
} from '../collapse';

const r = (
  id: string,
  identifier: string,
  docs = 0,
  extra: Partial<CollapseRow> = {},
): CollapseRow => ({
  id,
  source: 'assistant',
  identifier,
  ownerDeviceId: identifier.includes('#') ? `${identifier.slice(-8)}-x` : null,
  createdAt: `2026-11-0${id.length}`,
  docs,
  ...extra,
});

describe('planCollapse', () => {
  it('ten device rows, one with documents: that one is renamed, nine go', () => {
    const rows = [
      r('keep', 'local#0533dbda', 173),
      ...Array.from({ length: 9 }, (_, i) => r(`e${i}`, `local#0000000${i}`)),
    ];
    const p = planCollapse(rows);
    expect(p.rename).toEqual([{ id: 'keep', identifier: 'local' }]);
    expect(p.remove.sort()).toEqual(
      rows
        .slice(1)
        .map((x) => x.id)
        .sort(),
    );
  });

  it('an empty fresh bare local loses to the row with documents', () => {
    const p = planCollapse([r('bare', 'local'), r('old', 'local#0533dbda', 5)]);
    expect(p).toEqual({
      remove: ['bare'],
      rename: [{ id: 'old', identifier: 'local' }],
    });
  });

  it('no documents anywhere: the bare row stays, the others go', () => {
    const p = planCollapse([r('s', 'local#aaaaaaaa'), r('bare', 'local')]);
    expect(p).toEqual({ remove: ['s'], rename: [] });
  });

  it('a documents tie goes to the oldest', () => {
    const p = planCollapse([
      r('b', 'local#bbbbbbbb', 3, { createdAt: '2026-11-09' }),
      r('a', 'local#aaaaaaaa', 3, { createdAt: '2026-10-01' }),
    ]);
    expect(p).toEqual({
      remove: ['b'],
      rename: [{ id: 'a', identifier: 'local' }],
    });
  });

  it('one clean row is an empty plan; a lone suffixed row is renamed', () => {
    expect(planCollapse([r('k', 'local')])).toEqual({ remove: [], rename: [] });
    expect(planCollapse([r('k', 'local#aaaaaaaa')])).toEqual({
      remove: [],
      rename: [{ id: 'k', identifier: 'local' }],
    });
  });

  it('other sources and non-suffix identifiers are untouched', () => {
    expect(
      planCollapse([
        r('m1', 'local#aaaaaaaa', 0, { source: 'meetings' }),
        r('m2', 'local#bbbbbbbb', 0, { source: 'meetings' }),
        r('x', 'a#xyz', 0, { ownerDeviceId: null }),
      ]),
    ).toEqual({ remove: [], rename: [] });
  });
});

describe('collapseFormerlyOwned on a store', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  const conn = () => db._conn!;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collapse-'));
    db = await openDb(path.join(dir, 'a.db'));
    migrate(conn());
    store = openStore(db, {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    } as never);
  });
  afterEach(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const add = (
    id: string,
    source: string,
    identifier: string,
    owner: string | null,
  ) =>
    conn()
      .prepare(
        `INSERT INTO accounts(id, source, identifier, status, created_at, owner_device_id) VALUES(?, ?, ?, 'idle', ?, ?)`,
      )
      .run(id, source, identifier, `2026-11-0${id.length}`, owner);
  const docs = async (account: string, ids: string[]) =>
    store.commit({
      account: account as never,
      documents: ids.map((externalId) => ({
        externalId,
        type: 'assistant.session',
        title: externalId,
        markdown: `body ${externalId}`,
        metadata: {},
        createdAt: '2026-11-01T00:00:00Z',
      })),
      cursor: null,
    } as never);
  const count = (sql: string, ...p: unknown[]) =>
    (
      conn()
        .prepare(sql)
        .get(...p) as { n: number }
    ).n;
  const remove = async (id: string) => {
    await store.commit({ removeAccount: id as never });
  };

  it('removes the leftovers with their documents, keeps and renames the keeper, then does nothing', async () => {
    add('keep', 'assistant', 'local#0533dbda', '0533dbda-x');
    add('two', 'assistant', 'local#aaaaaaaa', 'aaaaaaaa-x');
    add('three', 'assistant', 'local#bbbbbbbb', 'bbbbbbbb-x');
    add('m', 'meetings', 'local#bbbbbbbb', 'bbbbbbbb-x');
    await docs('keep', ['s1', 's2', 's3']);
    await docs('two', ['s1']);
    const r1 = await collapseFormerlyOwned({ db, store, remove });
    expect(r1).toEqual({ removed: 2, renamed: 1 });
    expect(
      conn()
        .prepare(
          `SELECT id, identifier, owner_device_id FROM accounts ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: 'keep', identifier: 'local', owner_device_id: null },
      { id: 'm', identifier: 'local#bbbbbbbb', owner_device_id: 'bbbbbbbb-x' },
    ]);
    expect(
      count(`SELECT count(*) n FROM documents WHERE account_id = 'keep'`),
    ).toBe(3);
    expect(
      count(`SELECT count(*) n FROM documents WHERE account_id = 'two'`),
    ).toBe(0);
    expect(count(`SELECT count(*) n FROM documents_fts`)).toBe(3);

    const changes = count(`SELECT count(*) n FROM changes`);
    expect(await collapseFormerlyOwned({ db, store, remove })).toEqual({
      removed: 0,
      renamed: 0,
    });
    expect(count(`SELECT count(*) n FROM changes`)).toBe(changes);
  });

  describe('resumeAccounts', () => {
    const platform = (readOnly: boolean, runs: string[]) =>
      ({
        db,
        store,
        readOnly: () => readOnly,
        sources: { get: (s: string) => ({ descriptor: { id: s } }) },
        logSink: { log: () => undefined },
        engine: {
          run: (a: Account) => {
            runs.push(a.id);
            return {};
          },
          remove: (id: string) => remove(id),
        },
        scheduler: {
          register: jest.fn(),
          jobs: async () => [],
          unregister: jest.fn(),
        },
      }) as unknown as CorePlatform;

    it('collapses on a writer before starting accounts', async () => {
      add('keep', 'assistant', 'local#0533dbda', '0533dbda-x');
      add('two', 'assistant', 'local#aaaaaaaa', 'aaaaaaaa-x');
      await docs('keep', ['s1']);
      const runs: string[] = [];
      await resumeAccounts(platform(false, runs));
      expect(runs).toEqual(['keep']);
      expect(count(`SELECT count(*) n FROM accounts`)).toBe(1);
    });

    it('never collapses on a read-only device', async () => {
      add('keep', 'assistant', 'local#0533dbda', '0533dbda-x');
      add('two', 'assistant', 'local#aaaaaaaa', 'aaaaaaaa-x');
      await resumeAccounts(platform(true, []));
      expect(count(`SELECT count(*) n FROM accounts`)).toBe(2);
    });

    it('after a failed collapse, unclean leftovers do not start', async () => {
      add('two', 'assistant', 'local#aaaaaaaa', 'aaaaaaaa-x');
      add('g', 'gmail', 'me@x', null);
      const runs: string[] = [];
      const p = platform(false, runs);
      (p as unknown as { db: unknown }).db = {
        all: async () => {
          throw new Error('boom');
        },
      };
      await resumeAccounts(p);
      expect(runs).toEqual(['g']);
    });
  });
});
