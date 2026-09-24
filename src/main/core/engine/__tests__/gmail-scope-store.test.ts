/**
 * Spec §6 Gmail lines, through the real engine + store (the unit tests pin
 * each link separately): narrowing archives thread AND attachment rows by
 * stamp, a skipped thread never revives or rewrites a row, and a legacy
 * NULL-stamped row is re-stamped by a widening re-emit.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  Account,
  DocumentInput,
  FolderScopeUpdate,
  Source,
} from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { selectedBuckets } from '../../../sources/gmail/bucket';
import { descriptor } from '../../../sources/gmail/gmail-source';
import type { GmailApiMessage } from '../../../sources/gmail/parser';
import {
  toDocument as gmailToDocument,
  type GmailThreadItem,
} from '../../../sources/gmail/to-document';
import { openStore } from '../../store/store';
import type { CoreStore } from '../../store/store';
import { createEngine } from '../engine';

type Raw = { id: string; labels: string[][]; attachment?: boolean };
/** What the fake pull emits: a Gmail thread, or a pre-upgrade row as it
 *  was stored before scope buckets existed. */
type Emit = Raw | { legacy: DocumentInput };

function message(t: Raw, labelIds: string[], i: number): GmailApiMessage {
  const parts = t.attachment
    ? [
        {
          partId: '1',
          mimeType: 'text/plain',
          body: { data: 'SGk=', size: 2 },
        },
        {
          partId: '2',
          mimeType: 'application/pdf',
          filename: 'x.pdf',
          headers: [
            {
              name: 'Content-Disposition',
              value: 'attachment; filename="x.pdf"',
            },
          ],
          body: { attachmentId: `A-${t.id}`, size: 50_000 },
        },
      ]
    : undefined;
  return {
    id: `${t.id}-m${i}`,
    threadId: t.id,
    labelIds,
    internalDate: '1704106800000',
    payload: {
      mimeType: parts ? 'multipart/mixed' : 'text/plain',
      headers: [{ name: 'Subject', value: `thread ${t.id}` }],
      ...(parts ? { parts } : { body: { data: 'SGk=', size: 2 } }),
    },
  } as unknown as GmailApiMessage;
}

describe('gmail folder scope through engine + store (spec §6)', () => {
  let dir: string;
  let store: CoreStore;
  /** Mutated between runs: what the next pull emits. */
  let script: Emit[] = [];

  const source: Source<number, GmailThreadItem | { legacy: DocumentInput }> = {
    descriptor,
    async connect() {
      return { identifier: 'me@example.com' };
    },
    async *pull(session, cursor) {
      const stamp = {
        accountEmail: session.account.identifier,
        selectedBuckets: [...selectedBuckets(session.account.config ?? {})],
      };
      yield {
        phase: 'live',
        items: script.map((e) =>
          'legacy' in e
            ? e
            : {
                id: e.id,
                messages: e.labels.map((l, i) => message(e, l, i)),
                ...stamp,
              },
        ),
        cursor: (cursor ?? 0) + 1,
      };
    },
    toDocument: (item) =>
      'legacy' in item ? item.legacy : gmailToDocument(item),
  };

  const engine = () =>
    createEngine({
      store,
      sources: { get: (id) => (id === 'gmail' ? source : undefined) },
      inference: {
        complete: async () => 's',
        see: async () => 's',
        read: async () => 's',
        hear: async () => 's',
      },
      convert: async (input) => input,
      logs: { log: () => {} },
    });

  async function pullOnce(e: ReturnType<typeof engine>, acc: Account) {
    const before = (await store.account(acc.id))?.cursor ?? 0;
    const h = e.run((await store.account(acc.id))!);
    const t0 = Date.now();
    while (((await store.account(acc.id))?.cursor ?? 0) === before) {
      if (Date.now() - t0 > 4000) throw new Error('pull did not commit');
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    await h.stop();
  }

  const rows = async (acc: Account) =>
    Object.fromEntries(
      (
        await store.read.search({
          account: acc.id,
          includeArchived: true,
          limit: 100,
        })
      ).map((d) => [
        `${d.type}:${d.externalId}`,
        {
          live: d.archivedAt === null,
          stamp: d.scopeRootId,
          hash: d.contentHash,
        },
      ]),
    );

  const ROOTS = {
    mail: { id: 'mail', name: 'All mail' },
    TRASH: { id: 'TRASH', name: 'Trash' },
  };

  async function narrowToMail(e: ReturnType<typeof engine>, acc: Account) {
    const current = (await store.account(acc.id))!;
    const update: FolderScopeUpdate = {
      config: { folderRoots: [ROOTS.mail] },
      cursor: current.cursor,
      archiveScopeRootIds: ['TRASH'],
      reattributeScopeRoots: [],
    };
    script = []; // the restart applyScope triggers must not re-emit
    const res = await e.applyScope(
      acc.id,
      update,
      JSON.stringify(current.config),
    );
    await e.stopAll();
    return res;
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-gmail-scope-'));
    store = await openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
    });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('unticking Trash archives the trashed thread AND its attachment; mail stays; a later touch cannot revive it', async () => {
    const e = engine();
    const acc = await store.createAccount({
      source: 'gmail',
      identifier: 'me@example.com',
      config: { folderRoots: [ROOTS.mail, ROOTS.TRASH] },
      status: 'connecting',
    });
    script = [
      { id: 'N', labels: [['INBOX']] },
      { id: 'T', labels: [['TRASH']], attachment: true },
    ];
    await pullOnce(e, acc);
    const indexed = await rows(acc);
    expect(indexed['email.thread:T']).toMatchObject({
      live: true,
      stamp: 'TRASH',
    });
    const attKey = Object.keys(indexed).find((k) =>
      k.startsWith('attachment:'),
    );
    expect(indexed[attKey!]).toMatchObject({ live: true, stamp: 'TRASH' });

    expect((await narrowToMail(e, acc)).archived).toBe(2);
    const narrowed = await rows(acc);
    expect(narrowed['email.thread:T'].live).toBe(false);
    expect(narrowed[attKey!].live).toBe(false);
    expect(narrowed['email.thread:N']).toMatchObject({
      live: true,
      stamp: 'mail',
    });

    // A history touch of the trashed thread after the untick: skipped.
    script = [{ id: 'T', labels: [['TRASH'], ['TRASH']], attachment: true }];
    await pullOnce(e, acc);
    expect((await rows(acc))['email.thread:T']).toEqual(
      narrowed['email.thread:T'],
    );
  });

  it('an unselected-bucket thread is skipped: its existing row is neither rewritten nor deleted', async () => {
    const e = engine();
    const acc = await store.createAccount({
      source: 'gmail',
      identifier: 'me@example.com',
      config: { folderRoots: [ROOTS.mail, ROOTS.TRASH] },
      status: 'connecting',
    });
    script = [{ id: 'S', labels: [['INBOX']] }];
    await pullOnce(e, acc);
    const before = (await rows(acc))['email.thread:S'];
    // Moved to Spam upstream; Spam is not selected.
    script = [{ id: 'S', labels: [['SPAM']] }];
    await pullOnce(e, acc);
    expect((await rows(acc))['email.thread:S']).toEqual(before);
  });

  it('a legacy NULL-stamped trash row is re-stamped by a widening re-emit, so a later untick archives it', async () => {
    const e = engine();
    const acc = await store.createAccount({
      source: 'gmail',
      identifier: 'me@example.com',
      config: {},
      status: 'connecting',
    });
    // Indexed before scope buckets existed: no stamp, no scopeBucket.
    const legacy = gmailToDocument({
      id: 'T',
      messages: [message({ id: 'T', labels: [] }, ['INBOX'], 0)],
      accountEmail: 'me@example.com',
      selectedBuckets: ['mail'],
    }) as DocumentInput;
    const { scopeRootId: _s, ...unstamped } = legacy;
    const { scopeBucket: _b, ...meta } = unstamped.metadata as Record<
      string,
      unknown
    >;
    script = [{ legacy: { ...unstamped, metadata: meta } }];
    await pullOnce(e, acc);
    expect((await rows(acc))['email.thread:T']).toMatchObject({
      live: true,
      stamp: null,
    });

    // The user ticks Trash (widening) and the in:trash task re-emits T.
    await store.applyFolderScope({
      accountId: acc.id,
      expectedConfigJson: JSON.stringify({}),
      config: { folderRoots: [ROOTS.mail, ROOTS.TRASH] },
      cursor: (await store.account(acc.id))!.cursor,
      archiveScopeRootIds: [],
      reattributeScopeRoots: [],
      archiveRefs: [],
    } as never);
    script = [{ id: 'T', labels: [['TRASH']] }];
    await pullOnce(e, acc);
    expect((await rows(acc))['email.thread:T']).toMatchObject({
      live: true,
      stamp: 'TRASH',
    });

    await narrowToMail(e, acc);
    expect((await rows(acc))['email.thread:T'].live).toBe(false);
  });
});
