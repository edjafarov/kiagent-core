import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId } from '@shared/contracts';

import { openDb, type AppDb } from '../db/app-db';
import { openStore, type CoreStore } from '../core/store/store';
import type { OutboxDraftInput } from '../core/store/outbox';
import { wireOutboxPush } from '../outbox-push';

/** Minimal `OutboxStore.onChange` stub: records listeners so a test can
 *  fire a change synchronously, and returns a real unsubscribe closure
 *  mirroring the store's own contract. */
function stubOutboxStore(): {
  store: { outbox: { onChange: (cb: () => void) => () => void } };
  fireChange: () => void;
} {
  const listeners: Array<() => void> = [];
  return {
    store: {
      outbox: {
        onChange: (cb: () => void) => {
          listeners.push(cb);
          return () => {
            const i = listeners.indexOf(cb);
            if (i >= 0) listeners.splice(i, 1);
          };
        },
      },
    },
    fireChange: () => {
      for (const cb of listeners) cb();
    },
  };
}

describe('wireOutboxPush', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('broadcasts once for a burst and again for a later change', () => {
    jest.useFakeTimers();
    const { store, fireChange } = stubOutboxStore();
    const broadcast = jest.fn();
    wireOutboxPush(store, broadcast);

    fireChange();
    fireChange();
    fireChange();
    jest.advanceTimersByTime(50);
    expect(broadcast).toHaveBeenCalledTimes(1);

    fireChange();
    jest.advanceTimersByTime(50);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it('broadcasts push:outbox-changed with no payload', () => {
    jest.useFakeTimers();
    const { store, fireChange } = stubOutboxStore();
    const broadcast = jest.fn();
    wireOutboxPush(store, broadcast);

    fireChange();
    jest.advanceTimersByTime(50);
    expect(broadcast).toHaveBeenCalledWith('push:outbox-changed', undefined);
  });

  it('does not broadcast when nothing changed', () => {
    jest.useFakeTimers();
    const { store } = stubOutboxStore();
    const broadcast = jest.fn();
    wireOutboxPush(store, broadcast);

    jest.advanceTimersByTime(1000);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('a change mid-window does not reset the timer (leading-edge scheduled)', () => {
    jest.useFakeTimers();
    const { store, fireChange } = stubOutboxStore();
    const broadcast = jest.fn();
    wireOutboxPush(store, broadcast);

    fireChange();
    jest.advanceTimersByTime(30);
    fireChange(); // inside the same window — must not push the deadline out
    jest.advanceTimersByTime(20);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing stops future broadcasts', () => {
    jest.useFakeTimers();
    const { store, fireChange } = stubOutboxStore();
    const broadcast = jest.fn();
    const unsubscribe = wireOutboxPush(store, broadcast);

    unsubscribe();
    fireChange();
    jest.advanceTimersByTime(50);
    expect(broadcast).not.toHaveBeenCalled();
  });
});

/**
 * The two suites above prove the halves separately (task 8's outbox.test.ts
 * proves a real `transition()` fires `onChange` once per effective change;
 * the stub-driven suite above proves N onChange fires inside one window
 * coalesce to one broadcast) but never walk the real path end to end. That
 * seam — real store -> real transition() -> onChange -> coalescer ->
 * broadcast — is exactly where a wiring mistake would hide, so this suite
 * exercises it directly with no stub in the loop.
 */
describe('wireOutboxPush — real store integration', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;

  const draft = (): OutboxDraftInput => ({
    accountId,
    kind: 'new',
    recipientDisplay: 'bob@example.com',
    to: ['bob@example.com'],
    cc: [],
    subject: 'Hi',
    bodyMarkdown: 'Hello Bob',
    confirmMode: 'review',
    createdVia: 'mcp-local',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outbox-push-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
    const account = await store.createAccount({
      source: 'imap',
      identifier: 'me@example.com@imap.example.com',
    });
    accountId = account.id;
  });

  afterEach(async () => {
    jest.useRealTimers();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('coalesces a burst of three real transitions into one broadcast, and a fourth after the window into a second', async () => {
    jest.useFakeTimers();
    const broadcast = jest.fn();
    wireOutboxPush(store, broadcast);

    const rows = [];
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      rows.push(await store.outbox.create(draft()));
    }
    // create() also fires onChange (task 8) — flush and clear those
    // broadcasts first so the assertions below measure only the
    // transitions the issue's acceptance criterion names.
    jest.advanceTimersByTime(50);
    broadcast.mockClear();

    await store.outbox.transition(rows[0].id, ['draft'], 'sent');
    await store.outbox.transition(rows[1].id, ['draft'], 'sent');
    await store.outbox.transition(rows[2].id, ['draft'], 'sent');
    jest.advanceTimersByTime(50);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('push:outbox-changed', undefined);

    await store.outbox.transition(rows[3].id, ['draft'], 'sent');
    jest.advanceTimersByTime(50);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });
});
