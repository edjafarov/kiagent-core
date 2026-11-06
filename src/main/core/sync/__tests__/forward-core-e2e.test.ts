/** @jest-environment node */
/** Step 3 (r16 correction): a draft sent on a follower is sent by the leader.
 *  The follower's channel map is the one main wraps; the leader runs the real
 *  outbox handlers over a real store. The transport between the two is the
 *  forward route, tested in the app; here it is a direct call. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Prefs, Sender } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { outboundInvokeHandlers } from '../../../outbound/ipc';
import { createOutboundService } from '../../../outbound/service';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import { NO_MASTER_MESSAGE, SyncNoMaster, wrapForwardedChannels } from '../forward-core';
import { readGateSync } from '../role';
import { createSyncService, type SyncService } from '../service';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const prefs: Prefs = { get: () => ({}) as never, patch: async () => {}, onChange: () => () => {} };

interface Dev {
  dir: string;
  db: AppDb;
  store: CoreStore;
  svc: SyncService;
}
const devs: Dev[] = [];
async function device(follower: boolean): Promise<Dev> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-core-'));
  const db = await openDb(path.join(dir, 'a.db'));
  migrate(db._conn!);
  if (follower) db._conn!.prepare(`UPDATE sync_state SET role = 'follower'`).run();
  const store = openStore(db, deps as never);
  const svc = createSyncService({
    db,
    store,
    dbPath: path.join(dir, 'a.db'),
    workerFile: '',
    bootGate: readGateSync(db._conn!),
    log: () => undefined,
  });
  const d = { dir, db, store, svc };
  devs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of devs.splice(0)) {
    await d.store.close();
    fs.rmSync(d.dir, { recursive: true, force: true });
  }
});

type Table = Record<string, (req: unknown) => unknown>;

it('sending a draft on a follower queues it on the master', async () => {
  const master = await device(false);
  const follower = await device(true);

  // The master holds the account, the mail and the draft (they reach a
  // follower through the pull; the test places them where the pull would).
  const account = await master.store.createAccount({
    source: 'imap',
    identifier: 'me@example.com@imap.example.com',
    config: { host: 'imap.example.com', port: 993, secure: true, user: 'me@example.com' },
  });
  await master.store.commit({
    account: account.id,
    documents: [
      {
        externalId: 'INBOX:1:100',
        type: 'email.message',
        title: 'Numbers',
        markdown: 'body',
        metadata: { from: 'Alice <alice@example.com>', to: ['me@example.com'], date: '2026-07-01T00:00:00Z', mailbox: 'INBOX', uid: 100, messageId: 'orig@x' },
        createdAt: '2026-07-01T00:00:00Z',
      },
    ],
    cursor: null,
  });
  const docId = (await master.store.read.search({ limit: 10 }))[0].id as string;
  const masterSend = jest.fn(async () => ({ externalMessageId: '<sent@x>' }));
  const masterService = createOutboundService({
    store: master.store,
    prefs,
    senders: new Map<string, Sender>([['imap', { send: masterSend }]]),
    logSink: { log: () => {} },
  });
  masterService.setBaseUrl('http://127.0.0.1:7421');
  const draft = await masterService.draftReply({ documentId: docId, body: 'on my way' });
  const masterTable: Table = { ...outboundInvokeHandlers({ service: masterService, store: master.store, openExternal: async () => {} }) } as unknown as Table;
  const masterLocal = wrapForwardedChannels(masterTable, master.svc);
  master.svc.setRunners({
    ui: jest.fn(),
    core: async (name, req) => masterLocal.get(name)!(req),
    commit: jest.fn(),
  });

  // The follower's handler map: the same channel, wrapped. It has no handler
  // of its own to fall back on: a send there would be a bug.
  const followerSend = jest.fn(async () => ({ externalMessageId: '<wrong@x>' }));
  const followerService = createOutboundService({
    store: follower.store,
    prefs,
    senders: new Map<string, Sender>([['imap', { send: followerSend }]]),
    logSink: { log: () => {} },
  });
  const followerTable: Table = { ...outboundInvokeHandlers({ service: followerService, store: follower.store, openExternal: async () => {} }) } as unknown as Table;
  const refusals: string[] = [];
  wrapForwardedChannels(followerTable, follower.svc, (m) => refusals.push(m));

  // No leader reachable: the sentence, once; nothing sent, nothing changed.
  follower.svc.setForwarder(async () => ({ ok: false, code: 'no-master', message: 'x' }));
  const err = await Promise.resolve(followerTable['outbox:send']({ draftId: draft.draft_id, revision: 1 })).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SyncNoMaster);
  expect(refusals).toEqual([NO_MASTER_MESSAGE]);
  expect(masterSend).not.toHaveBeenCalled();
  expect((await master.store.outbox.get(draft.draft_id))?.status).toBe('draft');

  // The leader reachable: it sends, once, and the follower never does.
  follower.svc.setForwarder((r) => master.svc.runForwarded(r));
  const out = (await followerTable['outbox:send']({ draftId: draft.draft_id, revision: 1 })) as { outcome: string };
  expect(out.outcome).toBe('sent');
  expect(masterSend).toHaveBeenCalledTimes(1);
  expect(followerSend).not.toHaveBeenCalled();
  expect((await master.store.outbox.get(draft.draft_id))?.status).toBe('sent');
  expect(refusals).toHaveLength(1);
});
