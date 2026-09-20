import type BetterSqlite3 from 'better-sqlite3';

import type { AttentionItemWire } from '@shared/attention';

import type { AttentionActionPolicy } from './action-policy';
import { validateAttentionItem } from './validate';

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

interface StoredRow {
  id: string;
  producer: string;
  payload_json: string;
  state: AttentionItemWire['state'];
  revision: number;
  transition_at: number;
}

interface RevisionRow {
  id: string;
  producer: string;
  revision: number;
  state: AttentionItemWire['state'];
  resolved_by: AttentionItemWire['resolvedBy'];
  transition_at: number;
}

export interface AttentionRowFailure {
  id: string;
  producer: string;
  message: string;
}

export interface AttentionTxSuccess {
  ok: true;
  changed: boolean;
  rowFailures: AttentionRowFailure[];
  items?: AttentionItemWire[];
}

export interface AttentionTxFailure {
  ok: false;
  error: { message: string; name?: string };
  rowFailures: AttentionRowFailure[];
}

export type AttentionTxResult = AttentionTxSuccess | AttentionTxFailure;

export interface AttentionTx {
  publish(args: {
    producer: string;
    items: AttentionItemWire[];
    availableProducers: string[];
  }): AttentionTxResult;
  resolve(args: {
    producer: string;
    id: string;
    revision?: number;
    availableProducers: string[];
  }): AttentionTxResult;
  dismiss(args: {
    id: string;
    availableProducers: string[];
  }): AttentionTxResult;
  tick(args: { availableProducers: string[] }): AttentionTxResult;
  list(args: {
    kinds?: AttentionItemWire['kind'][];
    availableProducers: string[];
  }): AttentionTxResult;
}

export interface AttentionTxOptions {
  policy: AttentionActionPolicy;
  now: () => number;
}

function errorDetails(error: unknown): { message: string; name?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      ...(error.name ? { name: error.name } : {}),
    };
  }
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { message?: unknown; name?: unknown };
    if (typeof candidate.message === 'string') {
      return {
        message: candidate.message,
        ...(typeof candidate.name === 'string' && candidate.name
          ? { name: candidate.name }
          : {}),
      };
    }
  }
  return { message: String(error) };
}

function rowFailure(
  row: Pick<StoredRow, 'id' | 'producer'>,
  error: unknown,
): AttentionRowFailure {
  return {
    id: row.id,
    producer: row.producer,
    message: error instanceof Error ? error.message : String(error),
  };
}

function isPastExpiry(item: AttentionItemWire, now: number): boolean {
  return item.expiresAt !== null && item.expiresAt < now;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createAttentionTx(
  conn: BetterSqlite3.Database,
  options: AttentionTxOptions,
): AttentionTx {
  const getRowStatement = conn.prepare(
    'SELECT * FROM attention_items WHERE id = ?',
  );
  const getRevisionStatement = conn.prepare(
    'SELECT * FROM attention_revisions WHERE id = ?',
  );
  const upsertRevisionStatement = conn.prepare(
    `INSERT INTO attention_revisions
       (id, producer, revision, state, resolved_by, transition_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       producer = excluded.producer,
       revision = excluded.revision,
       state = excluded.state,
       resolved_by = excluded.resolved_by,
       transition_at = excluded.transition_at`,
  );
  const selectOpenRowsStatement = conn.prepare(
    "SELECT * FROM attention_items WHERE state = 'open'",
  );
  const updateExpiredRowStatement = conn.prepare(
    `UPDATE attention_items
       SET payload_json = ?, state = ?, transition_at = ?
     WHERE id = ?`,
  );
  const pruneRowsStatement = conn.prepare(
    `DELETE FROM attention_items
      WHERE state IN ('resolved', 'expired') AND transition_at <= ?`,
  );
  const updateCorruptResolvedStatement = conn.prepare(
    'UPDATE attention_items SET state = ?, transition_at = ? WHERE id = ?',
  );
  const updateResolvedRowStatement = conn.prepare(
    `UPDATE attention_items
        SET payload_json = ?, state = ?, transition_at = ?
      WHERE id = ?`,
  );
  const upsertItemStatement = conn.prepare(
    `INSERT INTO attention_items
       (id, producer, payload_json, state, revision, transition_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       producer = excluded.producer,
       payload_json = excluded.payload_json,
       state = excluded.state,
       revision = excluded.revision,
       transition_at = excluded.transition_at`,
  );
  const selectProducerOpenRowsStatement = conn.prepare(
    "SELECT * FROM attention_items WHERE producer = ? AND state = 'open'",
  );

  const getRow = (id: string): StoredRow | undefined =>
    getRowStatement.get(id) as StoredRow | undefined;

  const getRevision = (id: string): RevisionRow | undefined =>
    getRevisionStatement.get(id) as RevisionRow | undefined;

  const upsertRevision = (
    row: Pick<StoredRow, 'id' | 'producer' | 'revision'>,
    state: AttentionItemWire['state'],
    resolvedBy: AttentionItemWire['resolvedBy'],
    transitionAt: number,
  ): void => {
    upsertRevisionStatement.run(
      row.id,
      row.producer,
      row.revision,
      state,
      resolvedBy,
      transitionAt,
    );
  };

  const parseRow = (
    row: StoredRow,
    failures: AttentionRowFailure[],
  ): AttentionItemWire | undefined => {
    try {
      const item = validateAttentionItem(
        JSON.parse(row.payload_json) as unknown,
        options.policy,
      );
      if (
        item.id !== row.id ||
        item.producer !== row.producer ||
        item.revision !== row.revision ||
        item.state !== row.state
      ) {
        throw new Error('attention row metadata mismatch');
      }
      return item;
    } catch (error) {
      failures.push(rowFailure(row, error));
      return undefined;
    }
  };

  const expireAndPrune = (
    now: number,
    available: Set<string>,
    failures: AttentionRowFailure[],
  ): boolean => {
    let changed = false;
    const openRows = selectOpenRowsStatement.all() as StoredRow[];
    for (const row of openRows) {
      const item = parseRow(row, failures);
      if (!item || !isPastExpiry(item, now)) continue;
      const expired: AttentionItemWire = {
        ...item,
        state: 'expired',
        resolvedBy: null,
        updatedAt: now,
      };
      updateExpiredRowStatement.run(
        JSON.stringify(expired),
        'expired',
        now,
        row.id,
      );
      upsertRevision(expired, 'expired', null, now);
      if (available.has(row.producer)) changed = true;
    }
    pruneRowsStatement.run(now - SEVEN_DAYS);
    return changed;
  };

  const resolveRow = (
    row: StoredRow,
    resolvedBy: 'producer' | 'user',
    now: number,
    failures: AttentionRowFailure[],
  ): boolean => {
    if (row.state !== 'open') return false;
    const payload = parseRow(row, failures);
    if (!payload) {
      const ledger = getRevision(row.id);
      if (
        !ledger ||
        ledger.producer !== row.producer ||
        ledger.revision !== row.revision ||
        ledger.state !== 'open'
      ) {
        return false;
      }
      updateCorruptResolvedStatement.run('resolved', now, row.id);
      upsertRevision(row, 'resolved', resolvedBy, now);
      return true;
    }
    const resolved: AttentionItemWire = {
      ...payload,
      state: 'resolved',
      resolvedBy,
      updatedAt: now,
    };
    updateResolvedRowStatement.run(
      JSON.stringify(resolved),
      'resolved',
      now,
      row.id,
    );
    upsertRevision(resolved, 'resolved', resolvedBy, now);
    return true;
  };

  const run = (
    body: (
      now: number,
      failures: AttentionRowFailure[],
    ) => { changed: boolean; items?: AttentionItemWire[] },
  ): AttentionTxResult => {
    const failures: AttentionRowFailure[] = [];
    try {
      const result = conn.transaction(() => {
        // design §6 R2: read once inside the executing transaction, after any
        // coordinator wait, so expiry uses execution time rather than build time.
        const now = options.now();
        return body(now, failures);
      })();
      return {
        ok: true,
        changed: result.changed,
        rowFailures: failures,
        ...(result.items ? { items: result.items } : {}),
      };
    } catch (error) {
      return { ok: false, error: errorDetails(error), rowFailures: failures };
    }
  };

  return {
    publish(args) {
      return run((now, failures) => {
        const { producer, items, availableProducers } = args;
        for (const item of items) {
          if (
            item.producer !== producer ||
            !item.id.startsWith(`${producer}:`)
          ) {
            throw new Error('attention item producer or id prefix mismatch');
          }
        }
        const available = new Set(availableProducers);
        let changed = expireAndPrune(now, available, failures);
        const present = new Set<string>();
        for (const item of items) {
          present.add(item.id);
          const existing = getRow(item.id);
          const ledger = getRevision(item.id);
          let stored: AttentionItemWire | undefined;
          let storedInvalid = false;
          if (existing) {
            stored = parseRow(existing, failures);
            storedInvalid = stored === undefined;
          }
          const equalRevisionRepair = Boolean(
            existing &&
              ledger &&
              storedInvalid &&
              item.revision === ledger.revision &&
              item.state === 'open' &&
              existing.state === 'open' &&
              existing.producer === producer &&
              ledger.state === 'open' &&
              ledger.producer === producer,
          );
          if (
            ledger &&
            item.revision <= ledger.revision &&
            !equalRevisionRepair
          ) {
            continue;
          }
          const toStore =
            item.state === 'open' && isPastExpiry(item, now)
              ? {
                  ...item,
                  state: 'expired' as const,
                  resolvedBy: null,
                  updatedAt: now,
                }
              : item;
          const transitionAt = toStore.state === 'open' ? 0 : now;
          upsertItemStatement.run(
            item.id,
            producer,
            JSON.stringify(toStore),
            toStore.state,
            toStore.revision,
            transitionAt,
          );
          upsertRevision(
            toStore,
            toStore.state,
            toStore.resolvedBy,
            transitionAt,
          );
          if (available.has(producer) && toStore.state === 'open') {
            const differs =
              !existing || storedInvalid || !jsonEqual(stored, toStore);
            if (differs) changed = true;
          }
          if (
            available.has(producer) &&
            existing?.state === 'open' &&
            toStore.state !== 'open'
          ) {
            changed = true;
          }
        }
        const currentRows = selectProducerOpenRowsStatement.all(
          producer,
        ) as StoredRow[];
        for (const row of currentRows) {
          if (
            !present.has(row.id) &&
            resolveRow(row, 'producer', now, failures)
          ) {
            if (available.has(producer)) changed = true;
          }
        }
        return { changed };
      });
    },

    resolve(args) {
      return run((now, failures) => {
        const { producer, id, revision, availableProducers } = args;
        const row = getRow(id);
        if (!row || row.producer !== producer) return { changed: false };
        if (revision !== undefined && revision !== row.revision) {
          return { changed: false };
        }
        const changed = resolveRow(row, 'producer', now, failures);
        return {
          changed: changed && availableProducers.includes(row.producer),
        };
      });
    },

    dismiss(args) {
      return run((now, failures) => {
        const { id, availableProducers } = args;
        const row = getRow(id);
        if (!row) return { changed: false };
        const changed = resolveRow(row, 'user', now, failures);
        return {
          changed: changed && availableProducers.includes(row.producer),
        };
      });
    },

    tick(args) {
      return run((now, failures) => {
        const { availableProducers } = args;
        return {
          changed: expireAndPrune(now, new Set(availableProducers), failures),
        };
      });
    },

    list(args) {
      return run((now, failures) => {
        const { kinds, availableProducers } = args;
        const available = new Set(availableProducers);
        const changed = expireAndPrune(now, available, failures);
        const kindSet = kinds ? new Set(kinds) : undefined;
        const items: AttentionItemWire[] = [];
        const openRows = selectOpenRowsStatement.all() as StoredRow[];
        for (const row of openRows) {
          if (!available.has(row.producer)) continue;
          const item = parseRow(row, failures);
          if (item && (!kindSet || kindSet.has(item.kind))) items.push(item);
        }
        items.sort((a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority;
          if (a.dueAt === null && b.dueAt !== null) return 1;
          if (a.dueAt !== null && b.dueAt === null) return -1;
          if (a.dueAt !== b.dueAt) return (a.dueAt ?? 0) - (b.dueAt ?? 0);
          if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        return { changed, items };
      });
    },
  };
}
