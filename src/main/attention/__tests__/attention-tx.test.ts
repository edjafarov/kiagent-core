import Database from 'better-sqlite3';

import type { AttentionItemWire } from '@shared/attention';

import { migrate } from '../../core/store/schema';
import { ATTENTION_ACTION_POLICY } from '../action-policy';
import { createAttentionTx, type AttentionTx } from '../attention-tx';

const DAY = 24 * 60 * 60 * 1000;
const openDatabases = new Set<Database.Database>();

afterEach(() => {
  for (const db of openDatabases) {
    if (db.open) db.close();
  }
  openDatabases.clear();
});

function makeItem(
  id: string,
  producer = 'kiagent.expenses',
  overrides: Partial<AttentionItemWire> = {},
): AttentionItemWire {
  return {
    id: `${producer}:${id}`,
    producer,
    kind: 'waiting',
    title: `Item ${id}`,
    detail: null,
    priority: 2,
    dueAt: null,
    expiresAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    revision: 1,
    state: 'open',
    resolvedBy: null,
    actions: [],
    ...overrides,
  };
}

function openTx(now = 1_000): {
  db: Database.Database;
  tx: AttentionTx;
  setNow(value: number): void;
} {
  const db = new Database(':memory:');
  openDatabases.add(db);
  migrate(db);
  let clock = now;
  return {
    db,
    tx: createAttentionTx(db, {
      policy: ATTENTION_ACTION_POLICY,
      now: () => clock,
    }),
    setNow(value: number) {
      clock = value;
    },
  };
}

function openTxWithPolicy(
  policy: Parameters<typeof createAttentionTx>[1]['policy'],
  now = 1_000,
): {
  db: Database.Database;
  tx: AttentionTx;
  setNow(value: number): void;
} {
  const db = new Database(':memory:');
  openDatabases.add(db);
  migrate(db);
  let clock = now;
  return {
    db,
    tx: createAttentionTx(db, { policy, now: () => clock }),
    setNow(value: number) {
      clock = value;
    },
  };
}

function insertCorrupt(
  db: Database.Database,
  id: string,
  payload: string,
  ledger: Partial<{
    rowProducer: string;
    rowRevision: number;
    rowState: AttentionItemWire['state'];
    producer: string;
    revision: number;
    state: AttentionItemWire['state'];
    resolvedBy: AttentionItemWire['resolvedBy'];
    transitionAt: number;
  }> = {},
): void {
  const producer = ledger.producer ?? 'kiagent.expenses';
  const revision = ledger.revision ?? 1;
  const state = ledger.state ?? 'open';
  const transitionAt = ledger.transitionAt ?? 0;
  const rowProducer = ledger.rowProducer ?? 'kiagent.expenses';
  const rowRevision = ledger.rowRevision ?? revision;
  const rowState = ledger.rowState ?? 'open';
  db.prepare(
    `INSERT INTO attention_items
      (id, producer, payload_json, state, revision, transition_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, rowProducer, payload, rowState, rowRevision, transitionAt);
  if (ledger !== undefined && Object.keys(ledger).length > 0) {
    db.prepare(
      `INSERT INTO attention_revisions
        (id, producer, revision, state, resolved_by, transition_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      producer,
      revision,
      state,
      ledger.resolvedBy ?? null,
      transitionAt,
    );
  }
}

function rows(db: Database.Database): unknown[] {
  return db
    .prepare(
      'SELECT id, producer, payload_json, state, revision, transition_at FROM attention_items ORDER BY id',
    )
    .all();
}

function ledgers(db: Database.Database): unknown[] {
  return db
    .prepare(
      'SELECT id, producer, revision, state, resolved_by, transition_at FROM attention_revisions ORDER BY id',
    )
    .all();
}

describe('attention transaction module', () => {
  it('C1 rolls back both tables after a write failure and returns collected row failures', () => {
    const h = openTx();
    h.db
      .prepare(
        `INSERT INTO attention_items
          (id, producer, payload_json, state, revision, transition_at)
         VALUES (?, ?, ?, 'open', 1, 0)`,
      )
      .run('kiagent.expenses:poison', 'kiagent.expenses', '{oops');
    const beforeRows = rows(h.db);
    const beforeLedgers = ledgers(h.db);
    h.db.exec(`
      CREATE TRIGGER fail_attention_insert
      AFTER INSERT ON attention_items
      WHEN NEW.id = 'kiagent.expenses:fail'
      BEGIN SELECT RAISE(ABORT, 'forced attention failure'); END
    `);

    const result = h.tx.publish({
      producer: 'kiagent.expenses',
      items: [makeItem('good'), makeItem('fail')],
      availableProducers: ['kiagent.expenses'],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { message: 'forced attention failure' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rowFailures).toEqual([
        expect.objectContaining({
          id: 'kiagent.expenses:poison',
          producer: 'kiagent.expenses',
        }),
      ]);
    }
    expect(rows(h.db)).toEqual(beforeRows);
    expect(ledgers(h.db)).toEqual(beforeLedgers);
  });

  it('C2 reports exact changed values for insert, unchanged republication, omission, repair, terminalisation, and expiry', () => {
    const h = openTx();
    const item = makeItem('changed');
    expect(
      h.tx.publish({
        producer: item.producer,
        items: [item],
        availableProducers: [item.producer],
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      h.tx.publish({
        producer: item.producer,
        items: [item],
        availableProducers: [item.producer],
      }),
    ).toMatchObject({ ok: true, changed: false });

    expect(
      h.tx.publish({
        producer: item.producer,
        items: [],
        availableProducers: [item.producer],
      }),
    ).toMatchObject({ ok: true, changed: true });

    const repair = makeItem('repair');
    h.tx.publish({
      producer: repair.producer,
      items: [repair],
      availableProducers: [repair.producer],
    });
    h.db
      .prepare('UPDATE attention_items SET payload_json = ? WHERE id = ?')
      .run('null', repair.id);
    expect(
      h.tx.publish({
        producer: repair.producer,
        items: [repair],
        availableProducers: [repair.producer],
      }),
    ).toMatchObject({ ok: true, changed: true });

    const terminal = makeItem('terminal');
    h.tx.publish({
      producer: terminal.producer,
      items: [terminal],
      availableProducers: [terminal.producer],
    });
    h.db
      .prepare('UPDATE attention_items SET payload_json = ? WHERE id = ?')
      .run('{oops', terminal.id);
    expect(
      h.tx.dismiss({
        id: terminal.id,
        availableProducers: [terminal.producer],
      }),
    ).toMatchObject({ ok: true, changed: true });

    const expiring = makeItem('expiring', 'kiagent.other', {
      expiresAt: 2_000,
    });
    h.tx.publish({
      producer: expiring.producer,
      items: [expiring],
      availableProducers: [expiring.producer],
    });
    h.setNow(2_001);
    expect(
      h.tx.tick({ availableProducers: [expiring.producer] }),
    ).toMatchObject({ ok: true, changed: true });
  });

  it('C2 gates every mutation notification by the row producer availability, including cross-producer expiry', () => {
    const h = openTx();
    const a = makeItem('a', 'kiagent.expenses');
    const b = makeItem('b', 'kiagent.other', { expiresAt: 2_000 });
    h.tx.publish({
      producer: a.producer,
      items: [a],
      availableProducers: [a.producer, b.producer],
    });
    h.tx.publish({
      producer: b.producer,
      items: [b],
      availableProducers: [a.producer, b.producer],
    });
    h.setNow(2_001);
    expect(
      h.tx.publish({
        producer: a.producer,
        items: [a],
        availableProducers: [b.producer],
      }),
    ).toMatchObject({ ok: true, changed: true });

    const c = makeItem('c', 'kiagent.other', { expiresAt: 3_000 });
    h.tx.publish({
      producer: c.producer,
      items: [c],
      availableProducers: [a.producer, c.producer],
    });
    h.setNow(3_001);
    expect(
      h.tx.publish({
        producer: a.producer,
        items: [a],
        availableProducers: [a.producer, c.producer],
      }),
    ).toMatchObject({ ok: true, changed: true });
  });

  it('C2 reports false for every visible-change shape when its producer is unavailable', () => {
    const h = openTx();
    const producer = 'kiagent.expenses';
    const inserted = makeItem('unavailable-insert', producer);
    expect(
      h.tx.publish({
        producer,
        items: [inserted],
        availableProducers: [],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.tx.publish({
        producer,
        items: [inserted],
        availableProducers: [],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.tx.publish({
        producer,
        items: [],
        availableProducers: [],
      }),
    ).toMatchObject({ ok: true, changed: false });

    const repair = makeItem('unavailable-repair', producer);
    h.tx.publish({ producer, items: [repair], availableProducers: [] });
    h.db
      .prepare('UPDATE attention_items SET payload_json = ? WHERE id = ?')
      .run('{oops', repair.id);
    expect(
      h.tx.publish({
        producer,
        items: [repair],
        availableProducers: [],
      }),
    ).toMatchObject({ ok: true, changed: false });

    const terminal = makeItem('unavailable-terminal', producer);
    h.tx.publish({ producer, items: [terminal], availableProducers: [] });
    h.db
      .prepare('UPDATE attention_items SET payload_json = ? WHERE id = ?')
      .run('null', terminal.id);
    expect(
      h.tx.dismiss({ id: terminal.id, availableProducers: [] }),
    ).toMatchObject({ ok: true, changed: false });

    const expiry = makeItem('unavailable-expiry', producer, {
      expiresAt: 2_000,
    });
    h.tx.publish({ producer, items: [expiry], availableProducers: [] });
    h.setNow(2_001);
    expect(h.tx.tick({ availableProducers: [] })).toMatchObject({
      ok: true,
      changed: false,
    });
  });

  it('C3 and C12 keep terminal and healthy equal revisions immutable, ignore lower revisions, and accept higher revisions', () => {
    const h = openTx();
    const item = makeItem('revision');
    h.tx.publish({
      producer: item.producer,
      items: [item],
      availableProducers: [item.producer],
    });
    const changedTitle = { ...item, title: 'must stay original' };
    expect(
      h.tx.publish({
        producer: item.producer,
        items: [changedTitle],
        availableProducers: [item.producer],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(h.tx.list({ availableProducers: [item.producer] })).toMatchObject({
      items: [item],
    });

    h.tx.dismiss({ id: item.id, availableProducers: [item.producer] });
    expect(
      h.tx.publish({
        producer: item.producer,
        items: [{ ...item, title: 'same', revision: 1 }],
        availableProducers: [item.producer],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.tx.publish({
        producer: item.producer,
        items: [{ ...item, title: 'older', revision: 1 }],
        availableProducers: [item.producer],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.tx.publish({
        producer: item.producer,
        items: [{ ...item, title: 'newer', revision: 2 }],
        availableProducers: [item.producer],
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(h.tx.list({ availableProducers: [item.producer] })).toMatchObject({
      items: [{ ...item, title: 'newer', revision: 2 }],
    });
  });

  it('C4 accepts an empty snapshot and reconciles omissions for only that producer', () => {
    const h = openTx();
    const a = makeItem('a', 'kiagent.expenses');
    const b = makeItem('b', 'kiagent.other');
    h.tx.publish({
      producer: a.producer,
      items: [a],
      availableProducers: [a.producer, b.producer],
    });
    h.tx.publish({
      producer: b.producer,
      items: [b],
      availableProducers: [a.producer, b.producer],
    });
    expect(
      h.tx.publish({
        producer: a.producer,
        items: [],
        availableProducers: [a.producer, b.producer],
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      h.tx.list({ availableProducers: [a.producer, b.producer] }),
    ).toMatchObject({
      items: [b],
    });
  });

  it('C5 isolates both malformed JSON forms and terminalises only tracked corrupt rows', () => {
    const h = openTx();
    const healthy = makeItem('healthy');
    h.tx.publish({
      producer: healthy.producer,
      items: [healthy],
      availableProducers: [healthy.producer],
    });
    for (const [index, payload] of ['{oops', 'null'].entries()) {
      const id = `kiagent.expenses:corrupt-${index}`;
      h.db
        .prepare(
          `INSERT INTO attention_items
            (id, producer, payload_json, state, revision, transition_at)
           VALUES (?, ?, ?, 'open', 1, 0)`,
        )
        .run(id, 'kiagent.expenses', payload);
      h.db
        .prepare(
          `INSERT INTO attention_revisions
            (id, producer, revision, state, resolved_by, transition_at)
           VALUES (?, ?, 1, 'open', NULL, 0)`,
        )
        .run(id, 'kiagent.expenses');
    }
    const listed = h.tx.list({ availableProducers: ['kiagent.expenses'] });
    expect(listed).toMatchObject({
      ok: true,
      items: [healthy],
      rowFailures: expect.arrayContaining([
        expect.objectContaining({ id: 'kiagent.expenses:corrupt-0' }),
        expect.objectContaining({ id: 'kiagent.expenses:corrupt-1' }),
      ]),
    });
    expect(
      h.tx.tick({ availableProducers: ['kiagent.expenses'] }),
    ).toMatchObject({
      ok: true,
      changed: false,
    });
    expect(
      h.tx.dismiss({
        id: 'kiagent.expenses:corrupt-0',
        availableProducers: ['kiagent.expenses'],
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      h.tx.resolve({
        producer: 'kiagent.expenses',
        id: 'kiagent.expenses:corrupt-1',
        availableProducers: ['kiagent.expenses'],
      }),
    ).toMatchObject({ ok: true, changed: true });
    const untracked = 'kiagent.expenses:untracked';
    h.db
      .prepare(
        `INSERT INTO attention_items
          (id, producer, payload_json, state, revision, transition_at)
         VALUES (?, ?, '{oops', 'open', 1, 0)`,
      )
      .run(untracked, 'kiagent.expenses');
    h.tx.publish({
      producer: 'kiagent.expenses',
      items: [],
      availableProducers: ['kiagent.expenses'],
    });
    expect(
      h.db
        .prepare('SELECT state FROM attention_items WHERE id = ?')
        .get(untracked),
    ).toEqual({ state: 'open' });
    expect(
      h.db
        .prepare(
          'SELECT COUNT(*) AS count FROM attention_revisions WHERE id = ?',
        )
        .get(untracked),
    ).toEqual({ count: 0 });
  });

  it('C9 reads the mutable clock at execution and uses strict expiry', () => {
    const h = openTx(100);
    const args = {
      producer: 'kiagent.expenses',
      items: [makeItem('late', 'kiagent.expenses', { expiresAt: 100 })],
      availableProducers: ['kiagent.expenses'],
    };
    h.setNow(101);
    expect(h.tx.publish(args)).toMatchObject({ ok: true, changed: false });
    expect(
      h.db
        .prepare('SELECT state FROM attention_items WHERE id = ?')
        .get('kiagent.expenses:late'),
    ).toEqual({ state: 'expired' });

    const exact = makeItem('exact', 'kiagent.expenses', { expiresAt: 101 });
    h.tx.publish({
      producer: exact.producer,
      items: [exact],
      availableProducers: [exact.producer],
    });
    expect(h.tx.list({ availableProducers: [exact.producer] })).toMatchObject({
      items: [exact],
    });
  });

  it('C14 resolves only the targeted owner and exact optional revision, with distinct stamps', () => {
    const h = openTx();
    const item = makeItem('target');
    h.tx.publish({
      producer: item.producer,
      items: [item],
      availableProducers: [item.producer],
    });
    expect(
      h.tx.resolve({
        producer: 'kiagent.other',
        id: item.id,
        revision: 1,
        availableProducers: [item.producer],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.tx.resolve({
        producer: item.producer,
        id: item.id,
        revision: 2,
        availableProducers: [item.producer],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.tx.resolve({
        producer: item.producer,
        id: item.id,
        revision: 1,
        availableProducers: [item.producer],
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      h.db
        .prepare('SELECT resolved_by FROM attention_revisions WHERE id = ?')
        .get(item.id),
    ).toEqual({ resolved_by: 'producer' });

    const user = makeItem('user');
    h.tx.publish({
      producer: user.producer,
      items: [user],
      availableProducers: [user.producer],
    });
    h.tx.dismiss({ id: user.id, availableProducers: [user.producer] });
    expect(
      h.db
        .prepare('SELECT resolved_by FROM attention_revisions WHERE id = ?')
        .get(user.id),
    ).toEqual({ resolved_by: 'user' });
  });

  it('C15 filters, orders, isolates corrupt siblings, and returns independent copies', () => {
    const h = openTx();
    const items = [
      makeItem('late', 'kiagent.expenses', { priority: 2, dueAt: 20 }),
      makeItem('urgent', 'kiagent.expenses', { priority: 1, dueAt: null }),
      makeItem('soon', 'kiagent.expenses', { priority: 1, dueAt: 10 }),
      makeItem('other', 'kiagent.other', { kind: 'happening', priority: 1 }),
    ];
    h.tx.publish({
      producer: 'kiagent.expenses',
      items: items.filter((current) => current.producer === 'kiagent.expenses'),
      availableProducers: ['kiagent.expenses', 'kiagent.other'],
    });
    h.tx.publish({
      producer: 'kiagent.other',
      items: items.filter((current) => current.producer === 'kiagent.other'),
      availableProducers: ['kiagent.expenses', 'kiagent.other'],
    });
    h.db
      .prepare(
        `INSERT INTO attention_items
          (id, producer, payload_json, state, revision, transition_at)
         VALUES ('kiagent.expenses:poison', 'kiagent.expenses', '{oops', 'open', 1, 0)`,
      )
      .run();
    const first = h.tx.list({
      kinds: ['waiting'],
      availableProducers: ['kiagent.expenses'],
    });
    expect(first).toMatchObject({
      ok: true,
      items: [items[2], items[1], items[0]],
    });
    if (first.ok && first.items) first.items[0].title = 'mutated copy';
    expect(
      h.tx.list({ availableProducers: ['kiagent.expenses'] }),
    ).toMatchObject({
      items: [items[2], items[1], items[0]],
    });
  });

  it('B1 accepts 501 items and resolves exactly the one omitted by a 500-item snapshot', () => {
    const h = openTx();
    const items = Array.from({ length: 501 }, (_, index) =>
      makeItem(`bulk-${String(index).padStart(3, '0')}`),
    );
    expect(
      h.tx.publish({
        producer: 'kiagent.expenses',
        items,
        availableProducers: ['kiagent.expenses'],
      }),
    ).toMatchObject({ ok: true });
    expect(
      h.tx.list({ availableProducers: ['kiagent.expenses'] }),
    ).toMatchObject({
      items,
    });
    expect(
      h.tx.publish({
        producer: 'kiagent.expenses',
        items: items.slice(0, 500),
        availableProducers: ['kiagent.expenses'],
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      h.db
        .prepare(
          `SELECT state FROM attention_items WHERE id = 'kiagent.expenses:bulk-500'`,
        )
        .get(),
    ).toEqual({ state: 'resolved' });
    expect(
      h.tx.list({ availableProducers: ['kiagent.expenses'] }),
    ).toMatchObject({
      items: items.slice(0, 500),
    });
  });

  it('C5 keeps ledger tombstones after seven-day terminal payload pruning and rejects stale replay', () => {
    const h = openTx();
    const item = makeItem('prune', 'kiagent.expenses', { revision: 7 });
    h.tx.publish({
      producer: item.producer,
      items: [item],
      availableProducers: [item.producer],
    });
    h.tx.dismiss({ id: item.id, availableProducers: [item.producer] });
    h.setNow(1_000 + 7 * DAY + 1);
    h.tx.tick({ availableProducers: [item.producer] });
    expect(
      h.db
        .prepare('SELECT COUNT(*) AS count FROM attention_items WHERE id = ?')
        .get(item.id),
    ).toEqual({ count: 0 });
    expect(
      h.db
        .prepare('SELECT revision, state FROM attention_revisions WHERE id = ?')
        .get(item.id),
    ).toEqual({ revision: 7, state: 'resolved' });
    h.tx.publish({
      producer: item.producer,
      items: [{ ...item, revision: 7 }],
      availableProducers: [item.producer],
    });
    expect(h.tx.list({ availableProducers: [item.producer] })).toMatchObject({
      items: [],
    });
  });

  it('C13 keeps producer, revision, or state-mismatched corrupt rows isolated without fabricating a ledger', () => {
    const h = openTx();
    const id = 'kiagent.expenses:mismatched';
    h.db
      .prepare(
        `INSERT INTO attention_items
          (id, producer, payload_json, state, revision, transition_at)
         VALUES (?, 'kiagent.expenses', '{oops', 'open', 1, 0)`,
      )
      .run(id);
    h.db
      .prepare(
        `INSERT INTO attention_revisions
          (id, producer, revision, state, resolved_by, transition_at)
         VALUES (?, 'kiagent.other', 2, 'resolved', 'user', 10)`,
      )
      .run(id);

    expect(
      h.tx.publish({
        producer: 'kiagent.expenses',
        items: [],
        availableProducers: ['kiagent.expenses'],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.tx.dismiss({ id, availableProducers: ['kiagent.expenses'] }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.tx.resolve({
        producer: 'kiagent.expenses',
        id,
        availableProducers: ['kiagent.expenses'],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.tx.list({ availableProducers: ['kiagent.expenses'] }),
    ).toMatchObject({
      ok: true,
      items: [],
    });
    expect(
      h.db.prepare('SELECT state FROM attention_items WHERE id = ?').get(id),
    ).toEqual({ state: 'open' });
    expect(
      h.db
        .prepare(
          'SELECT producer, revision, state FROM attention_revisions WHERE id = ?',
        )
        .get(id),
    ).toEqual({ producer: 'kiagent.other', revision: 2, state: 'resolved' });
  });

  it('C17 rejects a producer or id mismatch as a transaction failure without writing', () => {
    const h = openTx();
    const result = h.tx.publish({
      producer: 'kiagent.expenses',
      items: [makeItem('wrong', 'kiagent.other')],
      availableProducers: ['kiagent.expenses'],
    });
    expect(result).toMatchObject({ ok: false });
    expect(rows(h.db)).toEqual([]);
    expect(ledgers(h.db)).toEqual([]);
  });

  it('a: corrupt dismiss, targeted resolve, and multiple omissions terminalise with trusted metadata', () => {
    const h = openTx();
    const producer = 'kiagent.expenses';
    const rowsToResolve = [
      ['dismissed', '{oops', 'user'],
      ['targeted', 'null', 'producer'],
      ['omitted-a', '{oops', 'producer'],
      ['omitted-b', 'null', 'producer'],
    ] as const;
    for (const [suffix, payload] of rowsToResolve) {
      insertCorrupt(h.db, `${producer}:${suffix}`, payload, { state: 'open' });
    }

    expect(
      h.tx.dismiss({
        id: `${producer}:dismissed`,
        availableProducers: [producer],
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      h.tx.resolve({
        producer,
        id: `${producer}:targeted`,
        revision: 1,
        availableProducers: [producer],
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      h.tx.publish({ producer, items: [], availableProducers: [producer] }),
    ).toMatchObject({ ok: true, changed: true });

    for (const [suffix, payload, resolvedBy] of rowsToResolve) {
      expect(
        h.db
          .prepare(
            'SELECT state, payload_json, transition_at FROM attention_items WHERE id = ?',
          )
          .get(`${producer}:${suffix}`),
      ).toEqual({
        state: 'resolved',
        payload_json: payload,
        transition_at: 1_000,
      });
      expect(
        h.db
          .prepare(
            'SELECT producer, revision, state, resolved_by, transition_at FROM attention_revisions WHERE id = ?',
          )
          .get(`${producer}:${suffix}`),
      ).toEqual({
        producer,
        revision: 1,
        state: 'resolved',
        resolved_by: resolvedBy,
        transition_at: 1_000,
      });
    }

    h.setNow(1_000 + 7 * DAY + 1);
    h.tx.tick({ availableProducers: [producer] });
    expect(
      h.db.prepare('SELECT COUNT(*) AS count FROM attention_items').get(),
    ).toEqual({ count: 0 });
    expect(
      h.db.prepare('SELECT COUNT(*) AS count FROM attention_revisions').get(),
    ).toEqual({ count: 4 });
  });

  it('b-producer: a corrupt row with a producer-mismatched ledger stays isolated', () => {
    const h = openTx();
    const id = 'kiagent.expenses:producer-guard';
    insertCorrupt(h.db, id, '{oops', {
      producer: 'kiagent.other',
      revision: 1,
      state: 'open',
      rowProducer: 'kiagent.expenses',
    });
    expect(
      h.tx.resolve({
        producer: 'kiagent.expenses',
        id,
        availableProducers: ['kiagent.expenses'],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.db.prepare('SELECT state FROM attention_items WHERE id = ?').get(id),
    ).toEqual({ state: 'open' });
  });

  it('b-revision: a corrupt row with a revision-mismatched ledger stays isolated', () => {
    const h = openTx();
    const id = 'kiagent.expenses:revision-guard';
    insertCorrupt(h.db, id, 'null', {
      revision: 2,
      rowRevision: 1,
      state: 'open',
    });
    expect(
      h.tx.resolve({
        producer: 'kiagent.expenses',
        id,
        availableProducers: ['kiagent.expenses'],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.db.prepare('SELECT state FROM attention_items WHERE id = ?').get(id),
    ).toEqual({ state: 'open' });
  });

  it('b-state: a corrupt row with a state-mismatched ledger stays isolated', () => {
    const h = openTx();
    const id = 'kiagent.expenses:state-guard';
    insertCorrupt(h.db, id, '{oops', {
      state: 'resolved',
      rowState: 'open',
      resolvedBy: 'user',
    });
    expect(
      h.tx.resolve({
        producer: 'kiagent.expenses',
        id,
        availableProducers: ['kiagent.expenses'],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.db.prepare('SELECT state FROM attention_items WHERE id = ?').get(id),
    ).toEqual({ state: 'open' });
  });

  it('c: list, tick, publish, dismiss, and resolve report both corrupt JSON poisons', () => {
    const operations: Array<
      [string, (tx: AttentionTx) => ReturnType<AttentionTx['list']>]
    > = [
      ['list', (tx) => tx.list({ availableProducers: ['kiagent.expenses'] })],
      ['tick', (tx) => tx.tick({ availableProducers: ['kiagent.expenses'] })],
      [
        'publish',
        (tx) =>
          tx.publish({
            producer: 'kiagent.expenses',
            items: [],
            availableProducers: ['kiagent.expenses'],
          }) as ReturnType<AttentionTx['list']>,
      ],
      [
        'dismiss',
        (tx) =>
          tx.dismiss({
            id: 'kiagent.expenses:poison-oops',
            availableProducers: ['kiagent.expenses'],
          }) as ReturnType<AttentionTx['list']>,
      ],
      [
        'resolve',
        (tx) =>
          tx.resolve({
            producer: 'kiagent.expenses',
            id: 'kiagent.expenses:poison-null',
            availableProducers: ['kiagent.expenses'],
          }) as ReturnType<AttentionTx['list']>,
      ],
    ];
    for (const [name, operation] of operations) {
      const h = openTx();
      insertCorrupt(h.db, 'kiagent.expenses:poison-oops', '{oops', {
        state: 'open',
      });
      insertCorrupt(h.db, 'kiagent.expenses:poison-null', 'null', {
        state: 'open',
      });
      const result = operation(h.tx);
      expect(result.ok).toBe(true);
      const expectedFailures =
        name === 'dismiss'
          ? ['kiagent.expenses:poison-oops']
          : name === 'resolve'
            ? ['kiagent.expenses:poison-null']
            : ['kiagent.expenses:poison-oops', 'kiagent.expenses:poison-null'];
      expect(result.rowFailures).toEqual(
        expect.arrayContaining(
          expectedFailures.map((id) =>
            expect.objectContaining({
              id,
              producer: 'kiagent.expenses',
              message: expect.any(String),
            }),
          ),
        ),
      );
    }
  });

  it('d: one snapshot expires a healthy row, resolves a valid omission, and isolates a malformed sibling', () => {
    const h = openTx();
    const expiring = makeItem('expiring-together', 'kiagent.expenses', {
      expiresAt: 1_500,
    });
    const omitted = makeItem('omitted-together');
    h.tx.publish({
      producer: 'kiagent.expenses',
      items: [expiring, omitted],
      availableProducers: ['kiagent.expenses'],
    });
    insertCorrupt(h.db, 'kiagent.expenses:malformed-together', '{oops');
    h.setNow(2_000);
    const result = h.tx.publish({
      producer: 'kiagent.expenses',
      items: [],
      availableProducers: ['kiagent.expenses'],
    });
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(result.rowFailures).toEqual([
      expect.objectContaining({ id: 'kiagent.expenses:malformed-together' }),
      expect.objectContaining({ id: 'kiagent.expenses:malformed-together' }),
    ]);
    expect(
      h.db
        .prepare('SELECT state, payload_json FROM attention_items WHERE id = ?')
        .get(expiring.id),
    ).toEqual({
      state: 'expired',
      payload_json: JSON.stringify({
        ...expiring,
        state: 'expired',
        resolvedBy: null,
        updatedAt: 2_000,
      }),
    });
    expect(
      h.db
        .prepare('SELECT state, payload_json FROM attention_items WHERE id = ?')
        .get(omitted.id),
    ).toEqual({
      state: 'resolved',
      payload_json: JSON.stringify({
        ...omitted,
        state: 'resolved',
        resolvedBy: 'producer',
        updatedAt: 2_000,
      }),
    });
    expect(
      h.db
        .prepare('SELECT state, payload_json FROM attention_items WHERE id = ?')
        .get('kiagent.expenses:malformed-together'),
    ).toEqual({ state: 'open', payload_json: '{oops' });
  });

  it('g: terminal publication, list expiry, unavailable resolve, and equal repair preserve changed semantics and writes', () => {
    const h = openTx();
    const terminal = makeItem('terminal-input', 'kiagent.expenses', {
      state: 'resolved',
      resolvedBy: 'user',
      revision: 3,
    });
    expect(
      h.tx.publish({
        producer: terminal.producer,
        items: [terminal],
        availableProducers: [terminal.producer],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.db
        .prepare('SELECT payload_json, state FROM attention_items WHERE id = ?')
        .get(terminal.id),
    ).toEqual({ payload_json: JSON.stringify(terminal), state: 'resolved' });

    const expiring = makeItem('list-expiry', 'kiagent.expenses', {
      expiresAt: 1_500,
    });
    h.tx.publish({
      producer: expiring.producer,
      items: [expiring],
      availableProducers: [expiring.producer],
    });
    h.setNow(2_000);
    expect(
      h.tx.list({ availableProducers: [expiring.producer] }),
    ).toMatchObject({
      ok: true,
      changed: true,
      items: [],
    });

    const unavailable = makeItem('unavailable-resolve');
    h.tx.publish({
      producer: unavailable.producer,
      items: [unavailable],
      availableProducers: [unavailable.producer],
    });
    expect(
      h.tx.resolve({
        id: unavailable.id,
        producer: unavailable.producer,
        availableProducers: [],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.db
        .prepare('SELECT state FROM attention_items WHERE id = ?')
        .get(unavailable.id),
    ).toEqual({ state: 'resolved' });

    const repair = makeItem('equal-repair');
    h.tx.publish({
      producer: repair.producer,
      items: [repair],
      availableProducers: [repair.producer],
    });
    h.db
      .prepare('UPDATE attention_items SET payload_json = ? WHERE id = ?')
      .run('{oops', repair.id);
    expect(
      h.tx.publish({
        producer: repair.producer,
        items: [repair],
        availableProducers: [repair.producer],
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      h.db
        .prepare('SELECT payload_json, state FROM attention_items WHERE id = ?')
        .get(repair.id),
    ).toEqual({ payload_json: JSON.stringify(repair), state: 'open' });
  });

  it('h: past-expiry corrupt repair terminalises, while healthy equal replay stays terminal', () => {
    const h = openTx();
    const corrupt = makeItem('past-corrupt', 'kiagent.expenses', {
      expiresAt: 1_500,
    });
    h.tx.publish({
      producer: corrupt.producer,
      items: [corrupt],
      availableProducers: [corrupt.producer],
    });
    h.db
      .prepare('UPDATE attention_items SET payload_json = ? WHERE id = ?')
      .run('{oops', corrupt.id);
    h.setNow(2_000);
    const repaired = h.tx.publish({
      producer: corrupt.producer,
      items: [corrupt],
      availableProducers: [corrupt.producer],
    });
    expect(repaired).toMatchObject({ ok: true, changed: true });
    expect(
      h.db
        .prepare('SELECT state, payload_json FROM attention_items WHERE id = ?')
        .get(corrupt.id),
    ).toEqual({
      state: 'expired',
      payload_json: JSON.stringify({
        ...corrupt,
        state: 'expired',
        resolvedBy: null,
        updatedAt: 2_000,
      }),
    });

    const healthy = makeItem('past-healthy', 'kiagent.expenses', {
      expiresAt: 1_500,
    });
    h.setNow(1_000);
    h.tx.publish({
      producer: healthy.producer,
      items: [healthy],
      availableProducers: [healthy.producer],
    });
    h.setNow(2_000);
    h.tx.tick({ availableProducers: [healthy.producer] });
    expect(
      h.tx.publish({
        producer: healthy.producer,
        items: [healthy],
        availableProducers: [healthy.producer],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.db
        .prepare('SELECT state FROM attention_items WHERE id = ?')
        .get(healthy.id),
    ).toEqual({ state: 'expired' });
  });

  it('i: terminal input is stored without open-only expiry normalisation', () => {
    const h = openTx(2_000);
    const terminal = makeItem('terminal-unchanged', 'kiagent.expenses', {
      state: 'expired',
      resolvedBy: null,
      expiresAt: 1_000,
      revision: 4,
    });
    h.tx.publish({
      producer: terminal.producer,
      items: [terminal],
      availableProducers: [terminal.producer],
    });
    expect(
      h.db
        .prepare(
          'SELECT payload_json, state, revision FROM attention_items WHERE id = ?',
        )
        .get(terminal.id),
    ).toEqual({
      payload_json: JSON.stringify(terminal),
      state: 'expired',
      revision: 4,
    });
  });

  it('j: each operation reads now exactly once while already inside its transaction', () => {
    const operations: Array<(tx: AttentionTx) => unknown> = [
      (tx) =>
        tx.publish({
          producer: 'kiagent.expenses',
          items: [],
          availableProducers: [],
        }),
      (tx) =>
        tx.resolve({
          producer: 'kiagent.expenses',
          id: 'missing',
          availableProducers: [],
        }),
      (tx) => tx.dismiss({ id: 'missing', availableProducers: [] }),
      (tx) => tx.tick({ availableProducers: [] }),
      (tx) => tx.list({ availableProducers: [] }),
    ];
    for (const operation of operations) {
      const db = new Database(':memory:');
      openDatabases.add(db);
      migrate(db);
      let calls = 0;
      let inTransaction = false;
      const tx = createAttentionTx(db, {
        policy: ATTENTION_ACTION_POLICY,
        now: () => {
          calls += 1;
          inTransaction = db.inTransaction;
          return 1_000;
        },
      });
      expect(operation(tx)).toMatchObject({ ok: true });
      expect(calls).toBe(1);
      expect(inTransaction).toBe(true);
    }
  });

  it('k: valid lower, expired equal, corrupt lower, and equal action/state replays preserve stored state', () => {
    const h = openTx();
    const item = makeItem('valid-revisions', 'kiagent.expenses', {
      revision: 2,
    });
    h.tx.publish({
      producer: item.producer,
      items: [item],
      availableProducers: [item.producer],
    });
    expect(
      h.tx.publish({
        producer: item.producer,
        items: [{ ...item, revision: 1, title: 'older' }],
        availableProducers: [item.producer],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.db
        .prepare(
          'SELECT state, revision, payload_json FROM attention_items WHERE id = ?',
        )
        .get(item.id),
    ).toEqual({
      state: 'open',
      revision: 2,
      payload_json: JSON.stringify(item),
    });

    const corrupt = makeItem('corrupt-older', 'kiagent.expenses', {
      revision: 2,
    });
    h.tx.publish({
      producer: corrupt.producer,
      items: [corrupt],
      availableProducers: [corrupt.producer],
    });
    h.db
      .prepare('UPDATE attention_items SET payload_json = ? WHERE id = ?')
      .run('{oops', corrupt.id);
    expect(
      h.tx.publish({
        producer: corrupt.producer,
        items: [{ ...corrupt, revision: 1, title: 'ignored' }],
        availableProducers: [corrupt.producer],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.db
        .prepare(
          'SELECT state, revision, payload_json FROM attention_items WHERE id = ?',
        )
        .get(corrupt.id),
    ).toEqual({ state: 'open', revision: 2, payload_json: '{oops' });

    const expired = makeItem('expired-replay', 'kiagent.expenses', {
      revision: 3,
      expiresAt: 1_500,
    });
    h.setNow(1_000);
    h.tx.publish({
      producer: expired.producer,
      items: [expired],
      availableProducers: [expired.producer],
    });
    h.setNow(2_000);
    h.tx.tick({ availableProducers: [expired.producer] });
    expect(
      h.tx.publish({
        producer: expired.producer,
        items: [expired],
        availableProducers: [expired.producer],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.db
        .prepare('SELECT state, revision FROM attention_items WHERE id = ?')
        .get(expired.id),
    ).toEqual({ state: 'expired', revision: 3 });

    const equal = makeItem('equal-actions', 'kiagent.expenses', {
      revision: 4,
    });
    h.tx.publish({
      producer: equal.producer,
      items: [equal],
      availableProducers: [equal.producer],
    });
    const changed = {
      ...equal,
      title: 'ignored',
      state: 'resolved' as const,
      resolvedBy: 'user' as const,
    };
    expect(
      h.tx.publish({
        producer: equal.producer,
        items: [changed],
        availableProducers: [equal.producer],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.db
        .prepare(
          'SELECT state, revision, payload_json FROM attention_items WHERE id = ?',
        )
        .get(equal.id),
    ).toEqual({
      state: 'open',
      revision: 4,
      payload_json: JSON.stringify(equal),
    });
  });

  it('l: resolve requires a strictly equal revision and stamps producer resolution into the payload', () => {
    const h = openTx();
    const item = makeItem('resolve-revision', 'kiagent.expenses', {
      revision: 2,
    });
    h.tx.publish({
      producer: item.producer,
      items: [item],
      availableProducers: [item.producer],
    });
    expect(
      h.tx.resolve({
        producer: item.producer,
        id: item.id,
        revision: 1,
        availableProducers: [item.producer],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.db
        .prepare('SELECT state FROM attention_items WHERE id = ?')
        .get(item.id),
    ).toEqual({ state: 'open' });
    expect(
      h.tx.resolve({
        producer: item.producer,
        id: item.id,
        availableProducers: [item.producer],
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      h.db
        .prepare('SELECT payload_json FROM attention_items WHERE id = ?')
        .get(item.id),
    ).toEqual({
      payload_json: JSON.stringify({
        ...item,
        state: 'resolved',
        resolvedBy: 'producer',
        updatedAt: 1_000,
      }),
    });
  });

  it('m: omission resolution stamps producer in both payload and ledger', () => {
    const h = openTx();
    const item = makeItem('omission-stamp');
    h.tx.publish({
      producer: item.producer,
      items: [item],
      availableProducers: [item.producer],
    });
    h.tx.publish({
      producer: item.producer,
      items: [],
      availableProducers: [item.producer],
    });
    expect(
      h.db
        .prepare(
          "SELECT json_extract(payload_json, '$.resolvedBy') AS resolved_by FROM attention_items WHERE id = ?",
        )
        .get(item.id),
    ).toEqual({ resolved_by: 'producer' });
    expect(
      h.db
        .prepare('SELECT resolved_by FROM attention_revisions WHERE id = ?')
        .get(item.id),
    ).toEqual({ resolved_by: 'producer' });
  });

  it('n: kind filtering includes only matching items from every available producer', () => {
    const h = openTx();
    const waiting = makeItem('available-waiting', 'kiagent.expenses', {
      kind: 'waiting',
    });
    const happening = makeItem('available-happening', 'kiagent.other', {
      kind: 'happening',
    });
    h.tx.publish({
      producer: waiting.producer,
      items: [waiting],
      availableProducers: [waiting.producer, happening.producer],
    });
    h.tx.publish({
      producer: happening.producer,
      items: [happening],
      availableProducers: [waiting.producer, happening.producer],
    });
    expect(
      h.tx.list({
        kinds: ['waiting'],
        availableProducers: [waiting.producer, happening.producer],
      }),
    ).toMatchObject({ items: [waiting] });
  });

  it('o: list sorts numeric dueAt, createdAt, and id ties and deep-copies nested fields', () => {
    const policy = { views: ['outbox'], paramKeys: ['anchor'] } as const;
    const h = openTxWithPolicy(policy);
    const fixtures = [
      makeItem('id-b', 'kiagent.expenses', {
        priority: 1,
        dueAt: 10,
        createdAt: 20,
        actions: [
          {
            id: 'open',
            label: 'Open',
            target: { view: 'outbox', params: { anchor: 'b' } },
          },
        ],
      }),
      makeItem('id-a', 'kiagent.expenses', {
        priority: 1,
        dueAt: 10,
        createdAt: 20,
        actions: [
          {
            id: 'open',
            label: 'Open',
            target: { view: 'outbox', params: { anchor: 'a' } },
          },
        ],
      }),
      makeItem('created-early', 'kiagent.expenses', {
        priority: 1,
        dueAt: 10,
        createdAt: 10,
      }),
      makeItem('due-early', 'kiagent.expenses', {
        priority: 1,
        dueAt: 5,
        createdAt: 99,
      }),
    ];
    h.tx.publish({
      producer: 'kiagent.expenses',
      items: [...fixtures].reverse(),
      availableProducers: ['kiagent.expenses'],
    });
    const first = h.tx.list({ availableProducers: ['kiagent.expenses'] });
    expect(first).toMatchObject({
      items: [fixtures[3], fixtures[2], fixtures[1], fixtures[0]],
    });
    if (first.ok && first.items) {
      (
        first.items[3].actions[0].target.params as Record<string, string>
      ).anchor = 'mutated';
    }
    expect(
      h.tx.list({ availableProducers: ['kiagent.expenses'] }),
    ).toMatchObject({
      items: [fixtures[3], fixtures[2], fixtures[1], fixtures[0]],
    });
  });

  it('p-producer: publish rejects an item whose producer differs even when its id prefix matches', () => {
    const h = openTx();
    const item = makeItem('producer-only', 'kiagent.other', {
      id: 'kiagent.expenses:producer-only',
    });
    expect(
      h.tx.publish({
        producer: 'kiagent.expenses',
        items: [item],
        availableProducers: ['kiagent.expenses'],
      }),
    ).toMatchObject({ ok: false });
    expect(rows(h.db)).toEqual([]);
  });

  it('p-id-prefix: publish rejects an item whose id prefix differs even when its producer matches', () => {
    const h = openTx();
    const item = makeItem('id-only', 'kiagent.expenses', {
      id: 'kiagent.other:id-only',
    });
    expect(
      h.tx.publish({
        producer: 'kiagent.expenses',
        items: [item],
        availableProducers: ['kiagent.expenses'],
      }),
    ).toMatchObject({ ok: false });
    expect(rows(h.db)).toEqual([]);
  });

  it('q: the transaction policy reports an out-of-policy stored action and lists an in-policy sibling', () => {
    const h = openTxWithPolicy({ views: ['outbox'], paramKeys: [] });
    const allowed = makeItem('policy-allowed', 'kiagent.expenses', {
      actions: [{ id: 'open', label: 'Open', target: { view: 'outbox' } }],
    });
    const denied = makeItem('policy-denied', 'kiagent.expenses', {
      actions: [{ id: 'open', label: 'Open', target: { view: 'calendar' } }],
    });
    for (const item of [allowed, denied]) {
      h.db
        .prepare(
          'INSERT INTO attention_items (id, producer, payload_json, state, revision, transition_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          item.id,
          item.producer,
          JSON.stringify(item),
          item.state,
          item.revision,
          0,
        );
    }
    expect(
      h.tx.list({ availableProducers: ['kiagent.expenses'] }),
    ).toMatchObject({
      items: [allowed],
      rowFailures: expect.arrayContaining([
        expect.objectContaining({
          id: denied.id,
          producer: denied.producer,
          message: 'invalid attention action',
        }),
      ]),
    });
  });

  it('y: resolve, dismiss, tick, and list roll back both tables after a post-write failure', () => {
    const cases: Array<
      [
        string,
        (
          h: ReturnType<typeof openTx>,
          id: string,
        ) => ReturnType<AttentionTx['resolve']>,
        string,
      ]
    > = [
      [
        'resolve',
        (h, id) =>
          h.tx.resolve({
            producer: 'kiagent.expenses',
            id,
            availableProducers: ['kiagent.expenses'],
          }),
        'resolve',
      ],
      [
        'dismiss',
        (h, id) =>
          h.tx.dismiss({ id, availableProducers: ['kiagent.expenses'] }),
        'dismiss',
      ],
      [
        'tick',
        (h) => h.tx.tick({ availableProducers: ['kiagent.expenses'] }),
        'tick',
      ],
      [
        'list',
        (h) => h.tx.list({ availableProducers: ['kiagent.expenses'] }),
        'list',
      ],
    ];
    for (const [name, operation, suffix] of cases) {
      const h = openTx();
      const healthyId = `kiagent.expenses:failure-${suffix}`;
      const poisonId = `kiagent.expenses:failure-poison-${suffix}`;
      const item = makeItem(`failure-${suffix}`, 'kiagent.expenses', {
        expiresAt: suffix === 'tick' || suffix === 'list' ? 2_000 : null,
      });
      if (suffix === 'tick' || suffix === 'list')
        insertCorrupt(h.db, poisonId, '{oops');
      h.tx.publish({
        producer: item.producer,
        items: [item],
        availableProducers: [item.producer],
      });
      if (suffix !== 'tick' && suffix !== 'list')
        insertCorrupt(h.db, poisonId, '{oops', { state: 'open' });
      const beforeRows = rows(h.db);
      const beforeLedgers = ledgers(h.db);
      const triggerId =
        suffix === 'tick' || suffix === 'list' ? healthyId : poisonId;
      h.db.exec(
        `CREATE TRIGGER fail_${suffix} AFTER UPDATE ON attention_revisions WHEN NEW.id = '${triggerId}' BEGIN SELECT RAISE(ABORT, 'forced ${name} failure'); END`,
      );
      if (suffix === 'tick' || suffix === 'list') h.setNow(2_001);
      const result = operation(
        h,
        suffix === 'tick' || suffix === 'list' ? item.id : poisonId,
      );
      expect(result).toMatchObject({
        ok: false,
        error: { message: `forced ${name} failure` },
      });
      expect(rows(h.db)).toEqual(beforeRows);
      expect(ledgers(h.db)).toEqual(beforeLedgers);
      if (!result.ok && (suffix === 'tick' || suffix === 'list'))
        expect(result.rowFailures).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: poisonId })]),
        );
    }
  });

  it('v: mutating the caller object after publish does not change persisted content', () => {
    const h = openTx();
    const item = makeItem('published-copy');
    h.tx.publish({
      producer: item.producer,
      items: [item],
      availableProducers: [item.producer],
    });
    item.title = 'mutated after commit';
    item.actions.push({ id: 'new', label: 'New', target: { view: 'outbox' } });
    expect(
      h.db
        .prepare('SELECT payload_json FROM attention_items WHERE id = ?')
        .get(item.id),
    ).toEqual({ payload_json: JSON.stringify(makeItem('published-copy')) });
  });

  it('w: terminal payloads are retained before seven days, pruned at the boundary, and higher replay reopens after pruning', () => {
    const h = openTx();
    const resolved = makeItem('prune-resolved', 'kiagent.expenses', {
      revision: 2,
    });
    const expired = makeItem('prune-expired', 'kiagent.expenses', {
      revision: 3,
      expiresAt: 1_500,
    });
    h.tx.publish({
      producer: resolved.producer,
      items: [resolved],
      availableProducers: [resolved.producer],
    });
    h.tx.dismiss({ id: resolved.id, availableProducers: [resolved.producer] });
    h.tx.publish({
      producer: expired.producer,
      items: [expired],
      availableProducers: [expired.producer],
    });
    h.setNow(2_000);
    h.tx.tick({ availableProducers: [resolved.producer] });
    h.setNow(1_000 + 7 * DAY - 1);
    h.tx.tick({ availableProducers: [resolved.producer] });
    expect(
      h.db.prepare('SELECT COUNT(*) AS count FROM attention_items').get(),
    ).toEqual({ count: 2 });
    h.setNow(1_000 + 7 * DAY);
    h.tx.tick({ availableProducers: [resolved.producer] });
    expect(
      h.db.prepare('SELECT COUNT(*) AS count FROM attention_items').get(),
    ).toEqual({ count: 1 });
    expect(
      h.db.prepare('SELECT COUNT(*) AS count FROM attention_revisions').get(),
    ).toEqual({ count: 2 });
    expect(
      h.tx.publish({
        producer: resolved.producer,
        items: [{ ...resolved, revision: 2 }],
        availableProducers: [resolved.producer],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.tx.publish({
        producer: resolved.producer,
        items: [{ ...resolved, revision: 3, title: 'reopened' }],
        availableProducers: [resolved.producer],
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      h.db
        .prepare(
          'SELECT state, revision, payload_json FROM attention_items WHERE id = ?',
        )
        .get(resolved.id),
    ).toEqual({
      state: 'open',
      revision: 3,
      payload_json: JSON.stringify({
        ...resolved,
        revision: 3,
        title: 'reopened',
      }),
    });
  });

  it('R6: malformed operation arguments return failures instead of throwing', () => {
    const h = openTx();
    const calls = [
      () => h.tx.publish(undefined as never),
      () => h.tx.resolve(undefined as never),
      () => h.tx.dismiss(undefined as never),
      () => h.tx.tick(undefined as never),
      () => h.tx.list(undefined as never),
    ];
    for (const call of calls) {
      expect(call()).toMatchObject({
        ok: false,
        error: { message: expect.any(String) },
        rowFailures: [],
      });
    }
  });

  it('C13 publish repair falls through for an untracked corrupt row and creates authoritative metadata', () => {
    const h = openTx();
    const item = makeItem('wedged', 'kiagent.expenses', { revision: 5 });
    h.db
      .prepare(
        `INSERT INTO attention_items
        (id, producer, payload_json, state, revision, transition_at)
       VALUES (?, ?, ?, 'open', ?, 0)`,
      )
      .run(item.id, item.producer, '{oops', 1);
    expect(
      h.tx.publish({
        producer: item.producer,
        items: [item],
        availableProducers: [item.producer],
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      h.db
        .prepare(
          'SELECT payload_json, state, revision FROM attention_items WHERE id = ?',
        )
        .get(item.id),
    ).toEqual({
      payload_json: JSON.stringify(item),
      state: 'open',
      revision: 5,
    });
    expect(
      h.db
        .prepare(
          'SELECT producer, revision, state FROM attention_revisions WHERE id = ?',
        )
        .get(item.id),
    ).toEqual({
      producer: item.producer,
      revision: 5,
      state: 'open',
    });
    expect(h.tx.list({ availableProducers: [item.producer] })).toMatchObject({
      items: [item],
    });
  });

  it('R1 repairs a tracked corrupt row when publishing a higher revision', () => {
    const h = openTx();
    const revisionTwo = makeItem('tracked-higher', 'kiagent.expenses', {
      revision: 2,
    });
    h.tx.publish({
      producer: revisionTwo.producer,
      items: [revisionTwo],
      availableProducers: [revisionTwo.producer],
    });
    h.db
      .prepare('UPDATE attention_items SET payload_json = ? WHERE id = ?')
      .run('{oops', revisionTwo.id);

    const revisionThree = { ...revisionTwo, revision: 3, title: 'Repaired' };
    expect(
      h.tx.publish({
        producer: revisionThree.producer,
        items: [revisionThree],
        availableProducers: [revisionThree.producer],
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      h.db
        .prepare(
          'SELECT payload_json, state, revision FROM attention_items WHERE id = ?',
        )
        .get(revisionThree.id),
    ).toEqual({
      payload_json: JSON.stringify(revisionThree),
      state: 'open',
      revision: 3,
    });
    expect(
      h.db
        .prepare(
          'SELECT producer, revision, state FROM attention_revisions WHERE id = ?',
        )
        .get(revisionThree.id),
    ).toEqual({
      producer: revisionThree.producer,
      revision: 3,
      state: 'open',
    });
    expect(
      h.tx.list({ availableProducers: [revisionThree.producer] }),
    ).toMatchObject({
      items: [revisionThree],
    });
  });

  it('R2 rejects an older publication over a corrupt higher-revision row', () => {
    const h = openTx();
    const stored = makeItem('tracked-older', 'kiagent.expenses', {
      revision: 2,
    });
    insertCorrupt(h.db, stored.id, '{oops', {
      rowRevision: 2,
      revision: 2,
    });
    const older = { ...stored, revision: 1, title: 'Must be rejected' };

    expect(
      h.tx.publish({
        producer: older.producer,
        items: [older],
        availableProducers: [older.producer],
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      h.db
        .prepare(
          'SELECT payload_json, state, revision FROM attention_items WHERE id = ?',
        )
        .get(stored.id),
    ).toEqual({ payload_json: '{oops', state: 'open', revision: 2 });
  });

  it('R3 does not resurrect corrupt rows after omission or dismissal terminalises them', () => {
    for (const terminalise of ['omission', 'dismiss'] as const) {
      const h = openTx();
      const item = makeItem(`no-resurrection-${terminalise}`);
      h.tx.publish({
        producer: item.producer,
        items: [item],
        availableProducers: [item.producer],
      });
      h.db
        .prepare('UPDATE attention_items SET payload_json = ? WHERE id = ?')
        .run('{oops', item.id);

      if (terminalise === 'omission') {
        expect(
          h.tx.publish({
            producer: item.producer,
            items: [],
            availableProducers: [item.producer],
          }),
        ).toMatchObject({ ok: true, changed: true });
      } else {
        expect(
          h.tx.dismiss({
            id: item.id,
            availableProducers: [item.producer],
          }),
        ).toMatchObject({ ok: true, changed: true });
      }

      expect(
        h.tx.publish({
          producer: item.producer,
          items: [item],
          availableProducers: [item.producer],
        }),
      ).toMatchObject({ ok: true, changed: false });
      expect(
        h.db
          .prepare(
            'SELECT state, payload_json FROM attention_items WHERE id = ?',
          )
          .get(item.id),
      ).toEqual({ state: 'resolved', payload_json: '{oops' });
      expect(h.tx.list({ availableProducers: [item.producer] })).toMatchObject({
        items: [],
      });
    }
  });

  it('R4 refuses equal-revision repair when either row or ledger is terminal', () => {
    const cases = [
      {
        name: 'row-terminal',
        rowState: 'resolved' as const,
        ledgerState: 'open' as const,
      },
      {
        name: 'ledger-terminal',
        rowState: 'open' as const,
        ledgerState: 'resolved' as const,
      },
    ];
    for (const current of cases) {
      const h = openTx();
      const item = makeItem(`repair-guard-${current.name}`);
      insertCorrupt(h.db, item.id, '{oops', {
        rowState: current.rowState,
        state: current.ledgerState,
      });

      expect(
        h.tx.publish({
          producer: item.producer,
          items: [item],
          availableProducers: [item.producer],
        }),
      ).toMatchObject({ ok: true, changed: false });
      expect(
        h.db
          .prepare(
            'SELECT payload_json, state, revision FROM attention_items WHERE id = ?',
          )
          .get(item.id),
      ).toEqual({
        payload_json: '{oops',
        state: current.rowState,
        revision: 1,
      });
      expect(
        h.db
          .prepare(
            'SELECT state, revision FROM attention_revisions WHERE id = ?',
          )
          .get(item.id),
      ).toEqual({ state: current.ledgerState, revision: 1 });
    }
  });

  it('R5 uses createdAt then id to break priority and dueAt ties', () => {
    const h = openTx();
    const b = makeItem('b', 'kiagent.expenses', {
      priority: 1,
      dueAt: 10,
      createdAt: 20,
    });
    const a = makeItem('a', 'kiagent.expenses', {
      priority: 1,
      dueAt: 10,
      createdAt: 20,
    });
    const z = makeItem('z', 'kiagent.expenses', {
      priority: 1,
      dueAt: 10,
      createdAt: 10,
    });
    h.tx.publish({
      producer: b.producer,
      items: [b, a, z],
      availableProducers: [b.producer],
    });

    const listed = h.tx.list({ availableProducers: [b.producer] });
    expect(listed).toMatchObject({ items: [z, a, b] });
  });
});
