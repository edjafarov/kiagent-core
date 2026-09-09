import fs from 'fs';
import os from 'os';
import path from 'path';

import type { DocumentInput, Source } from '@shared/contracts';
import type { MessageEvidenceV1 } from '@shared/message-evidence';
import { openDb } from '../../../db/app-db';
import { openStore } from '../../store/store';
import { createEngine } from '../engine';

describe('engine.readMessageEvidence', () => {
  let dir: string;
  let store: Awaited<ReturnType<typeof openStore>>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-evidence-'));
    store = await openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s) => Buffer.from(s),
      decrypt: (b) => b.toString(),
      detectLanguages: () => [],
    });
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects more than eight requested authors before source access', async () => {
    const source: Source = {
      descriptor: {
        id: 'fake',
        name: 'Fake',
        documentTypes: ['email.thread'],
        auth: 'none',
      },
      async connect() {
        return { identifier: 'fake@example.com' };
      },
      async *pull() {},
      toDocument(item) {
        return item as DocumentInput;
      },
      readMessageEvidence: async () => {
        throw new Error('must not call source');
      },
    };
    const engine = createEngine({
      store,
      sources: { get: (id) => (id === 'fake' ? source : undefined) },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (input) => input,
      logs: { log: () => {} },
    });
    await expect(
      engine.readMessageEvidence({
        documentId: 'missing' as never,
        expectedContentHash: 'x',
        authors: Array.from({ length: 9 }, (_, i) => `a${i}@example.com`),
      }),
    ).resolves.toEqual({ status: 'unavailable', messages: [] });
  });

  it('clips source results to three and returns stale after a document changes', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const messages = Array.from(
      { length: 4 },
      (_, i) =>
        ({
          version: 1 as const,
          messageKey: `m${i}`,
          author: 'alex@example.com',
          at: null,
          signature: `S${i}`,
          excerpt: 'Body',
          fingerprint: String(i).padStart(64, '0'),
        }) satisfies MessageEvidenceV1,
    );
    const source: Source = {
      descriptor: {
        id: 'mail',
        name: 'Mail',
        documentTypes: ['email.thread'],
        auth: 'none',
      },
      async connect() {
        return { identifier: 'mail@example.com' };
      },
      async *pull() {},
      toDocument(item) {
        return item as DocumentInput;
      },
      readMessageEvidence: async () => {
        await pending;
        return messages;
      },
    };
    const account = await store.createAccount({
      source: 'mail',
      identifier: 'mail@example.com',
    });
    await store.commit({
      account: account.id,
      documents: [
        {
          externalId: 'thread-1',
          type: 'email.thread',
          title: 'Thread',
          markdown: 'Body',
          metadata: {},
          createdAt: null,
        },
      ],
      cursor: null,
    });
    const doc = await store.read.byExternalId(
      account.id,
      'thread-1',
      'email.thread',
    );
    expect(doc).not.toBeNull();
    const engine = createEngine({
      store,
      sources: { get: (id) => (id === 'mail' ? source : undefined) },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (input) => input,
      logs: { log: () => {} },
    });
    const request = engine.readMessageEvidence({
      documentId: doc!.id,
      expectedContentHash: doc!.contentHash,
      authors: ['alex@example.com'],
    });
    await store.commit({
      account: account.id,
      documents: [
        {
          externalId: 'thread-1',
          type: 'email.thread',
          title: 'Thread',
          markdown: 'Changed',
          metadata: {},
          createdAt: null,
        },
      ],
      cursor: null,
    });
    release();
    expect(await request).toEqual({ status: 'stale', messages: [] });
  });

  it('maps malformed requests and source records to typed unavailable results', async () => {
    const source: Source = {
      descriptor: {
        id: 'bad',
        name: 'Bad',
        documentTypes: ['email.thread'],
        auth: 'none',
      },
      async connect() {
        return { identifier: 'bad@example.com' };
      },
      async *pull() {},
      toDocument(item) {
        return item as DocumentInput;
      },
      readMessageEvidence: async () => 'not-an-array' as never,
    };
    const account = await store.createAccount({
      source: 'bad',
      identifier: 'bad@example.com',
    });
    await store.commit({
      account: account.id,
      documents: [
        {
          externalId: 'bad-1',
          type: 'email.thread',
          title: 'Bad',
          markdown: 'Body',
          metadata: {},
          createdAt: null,
        },
      ],
      cursor: null,
    });
    const doc = await store.read.byExternalId(
      account.id,
      'bad-1',
      'email.thread',
    );
    const engine = createEngine({
      store,
      sources: { get: (id) => (id === 'bad' ? source : undefined) },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (input) => input,
      logs: { log: () => {} },
    });
    await expect(
      engine.readMessageEvidence({
        documentId: doc!.id,
        expectedContentHash: doc!.contentHash,
        authors: undefined as never,
      }),
    ).resolves.toEqual({ status: 'unavailable', messages: [] });
    await expect(
      engine.readMessageEvidence({
        documentId: doc!.id,
        expectedContentHash: doc!.contentHash,
        authors: ['alex@example.com'],
      }),
    ).resolves.toEqual({ status: 'unavailable', messages: [] });
  });

  it('aborts an in-flight read when stopAll is called', async () => {
    let signal!: AbortSignal;
    const source: Source = {
      descriptor: {
        id: 'slow',
        name: 'Slow',
        documentTypes: ['email.thread'],
        auth: 'none',
      },
      async connect() {
        return { identifier: 'slow@example.com' };
      },
      async *pull() {},
      toDocument(item) {
        return item as DocumentInput;
      },
      readMessageEvidence: async (session) => {
        signal = session.signal;
        await new Promise<void>((resolve) =>
          session.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        return [];
      },
    };
    const account = await store.createAccount({
      source: 'slow',
      identifier: 'slow@example.com',
    });
    await store.commit({
      account: account.id,
      documents: [
        {
          externalId: 'slow-1',
          type: 'email.thread',
          title: 'Slow',
          markdown: 'Body',
          metadata: {},
          createdAt: null,
        },
      ],
      cursor: null,
    });
    const doc = await store.read.byExternalId(
      account.id,
      'slow-1',
      'email.thread',
    );
    const engine = createEngine({
      store,
      sources: { get: (id) => (id === 'slow' ? source : undefined) },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (input) => input,
      logs: { log: () => {} },
    });
    const pending = engine.readMessageEvidence({
      documentId: doc!.id,
      expectedContentHash: doc!.contentHash,
      authors: ['alex@example.com'],
    });
    for (let i = 0; i < 20 && !signal; i++)
      await new Promise((r) => setTimeout(r, 1));
    await engine.stopAll();
    expect(signal.aborted).toBe(true);
    expect(await pending).toEqual({ status: 'stale', messages: [] });
  });
});
