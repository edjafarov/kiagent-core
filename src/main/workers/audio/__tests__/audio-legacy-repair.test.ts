/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Document, DocumentInput, Source } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { createEngine } from '../../../core/engine/engine';
import { openStore } from '../../../core/store/store';
import type { CoreStore } from '../../../core/store/store';
import { createAudioWorker } from '../audio-worker';

// Spec 2026-10-14 §3.4: the v3 consumer's seed re-admits a v2 local-asr
// transcript whose body is degenerate, replaces it ONCE, and the rev-3
// enrich's own re-emitted change never re-admits it. A clean v2 transcript
// is never touched.

const JUNK = `Thank you. ${'I’m. '.repeat(790)}`.trim();
const GOOD =
  'Wir haben sieben Kinder, die geblieben sind und vier Kinder, die neu angefangen haben.';

const legacyFile = (externalId: string, markdown: string): DocumentInput => ({
  externalId,
  type: 'file',
  title: `${externalId}.m4a`,
  markdown,
  metadata: {
    mime: 'audio/mp4',
    filename: `${externalId}.m4a`,
    sizeBytes: 1000,
    extraction: { engine: 'local-asr', at: '2026-10-13T19:47:00Z' },
  },
  createdAt: null,
});

const folderSource = (): Source => ({
  descriptor: {
    id: 'folder',
    name: 'Folder',
    documentTypes: ['file'],
    auth: 'none',
  },
  async connect() {
    return { identifier: 'me' };
  },
  // eslint-disable-next-line require-yield
  async *pull() {},
  toDocument: (item) => item as DocumentInput,
  fetchBytes: async () => new Uint8Array([1, 2, 3]),
});

async function waitFor(cond: () => Promise<boolean>, ms = 5000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('audio v3 legacy repair (real store + engine)', () => {
  let dir: string;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-audio-v3-'));
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

  it('re-transcribes a v2 junk body once and never re-admits it; a clean v2 body is untouched', async () => {
    const engine = createEngine({
      store,
      sources: { get: () => folderSource() },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (d) => d,
      logs: { log: () => {} },
    });
    const account = await store.createAccount({
      source: 'folder',
      identifier: 'x',
    });
    await store.commit({
      account: account.id,
      documents: [legacyFile('junk', JUNK), legacyFile('good', GOOD)],
      cursor: 1,
    });

    const transcribeFile = jest.fn(async () => ({
      text: GOOD,
      speechSegments: 9,
    }));
    const worker = createAudioWorker({
      laneOpen: () => true,
      requestAsr: () => {},
      hearReady: () => true,
      transcribeFile,
      prepareFile: async () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-audio-v3-p-'));
        const p = path.join(d, 'a.wav');
        fs.writeFileSync(p, Buffer.alloc(4));
        return { path: p, dir: d, format: 'wav', sizeBytes: 4 };
      },
      mp3Duration: () => null,
      totalMemBytes: 32 * 1024 ** 3,
    });
    // A brand-new consumer (worker:audio:v3) is seeded from `documents`.
    const handle = engine.attach(worker);

    const read = async (externalId: string) =>
      (await store.read.byExternalId(
        account.id,
        externalId,
        'file',
      )) as Document;
    const extraction = (d: Document) =>
      (d.metadata as { extraction?: { rev?: number } }).extraction;

    await waitFor(async () => extraction(await read('junk'))?.rev === 3);
    expect((await read('junk')).markdown).toBe(GOOD);

    const good = await read('good');
    expect(good.markdown).toBe(GOOD);
    expect(extraction(good)?.rev).toBeUndefined();

    // The rev-3 enrich re-emitted 'junk' into the feed; let it drain.
    await new Promise((r) => setTimeout(r, 400));
    expect(transcribeFile).toHaveBeenCalledTimes(1);
    await handle.stop();
  });

  it('a re-transcription that is still degenerate clears the junk body (empty markdown) and is final', async () => {
    const engine = createEngine({
      store,
      sources: { get: () => folderSource() },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (d) => d,
      logs: { log: () => {} },
    });
    const account = await store.createAccount({
      source: 'folder',
      identifier: 'x',
    });
    await store.commit({
      account: account.id,
      documents: [legacyFile('junk', JUNK)],
      cursor: 1,
    });

    const transcribeFile = jest.fn(async () => ({
      text: JUNK,
      speechSegments: 300,
    }));
    const worker = createAudioWorker({
      laneOpen: () => true,
      requestAsr: () => {},
      hearReady: () => true,
      transcribeFile,
      prepareFile: async () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-audio-v3-p-'));
        const p = path.join(d, 'a.wav');
        fs.writeFileSync(p, Buffer.alloc(4));
        return { path: p, dir: d, format: 'wav', sizeBytes: 4 };
      },
      mp3Duration: () => null,
      totalMemBytes: 32 * 1024 ** 3,
    });
    const handle = engine.attach(worker);

    const read = async () =>
      (await store.read.byExternalId(account.id, 'junk', 'file')) as Document;
    await waitFor(async () =>
      (read().then((d) => d.metadata) as Promise<any>).then(
        (m) => m.extraction?.rev === 3,
      ),
    );
    const d = await read();
    expect(d.markdown).toBe('');
    expect((d.metadata as any).extraction).toMatchObject({
      engine: 'local-asr',
      rev: 3,
      quality: 'degenerate',
    });
    const hits = await store.read.search({ text: 'thank' } as never);
    expect(JSON.stringify(hits)).not.toContain(d.id);

    await new Promise((r) => setTimeout(r, 400));
    expect(transcribeFile).toHaveBeenCalledTimes(1);
    await handle.stop();
  });
});
