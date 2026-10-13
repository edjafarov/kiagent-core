import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Batch, DocumentInput, Source } from '@shared/contracts';
import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../store/store';
import { createEngine } from '../engine';
import { OptionConfigError } from '../flow-errors';

let dir: string;
let store: CoreStore;
let pulls: Array<Record<string, unknown>>;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-engopt-'));
  store = openStore(await openDb(path.join(dir, 'test.db')), {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => [],
  });
  pulls = [];
});
afterEach(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function source(): Source<number, DocumentInput> {
  return {
    descriptor: {
      id: 'opt',
      name: 'Opt',
      documentTypes: ['note'],
      auth: 'none',
      options: [{ key: 'skip', label: 'Skip', type: 'boolean', default: true }],
    },
    async connect() {
      return { identifier: 'me' };
    },
    async *pull(session, cursor): AsyncGenerator<Batch<number, DocumentInput>> {
      pulls.push(session.account.config);
      yield { phase: 'live', items: [], cursor: (cursor ?? 0) + 1 };
    },
    toDocument: (i) => i,
  };
}
const flow = {
  oauth: async () => ({}),
  showQr: () => {},
  prompt: async () => ({}),
  status: () => {},
  pickFolders: async () => [],
};
function makeEngine(src: Source) {
  return createEngine({
    store,
    sources: { get: (id) => (id === src.descriptor.id ? src : undefined) },
    inference: {
      complete: async () => '',
      see: async () => '',
      read: async () => '',
      hear: async () => '',
    },
    convert: async (i) => i,
    logs: { log: () => {} },
  });
}
const waitFor = async (f: () => Promise<boolean> | boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await new Promise((r) => {
      setTimeout(r, 20);
    });
  }
  throw new Error('timeout');
};
const sleep = (ms: number) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

it('setOption persists options.<key> and keeps other config', async () => {
  const src = source();
  const engine = makeEngine(src);
  const acc = await engine.connect(src, flow);
  await store.setAccountConfig(acc.id, { keep: 1 });
  await engine.setOption(acc.id, 'skip', false);
  expect((await store.account(acc.id))?.config).toEqual({
    keep: 1,
    options: { skip: false },
  });
});

it('setOption rejects an undeclared key and a non-boolean', async () => {
  const src = source();
  const engine = makeEngine(src);
  const acc = await engine.connect(src, flow);
  await expect(engine.setOption(acc.id, 'nope', true)).rejects.toBeInstanceOf(
    OptionConfigError,
  );
  await expect(
    engine.setOption(acc.id, 'skip', 'x' as unknown as boolean),
  ).rejects.toBeInstanceOf(OptionConfigError);
});

it('setOption restarts a running loop with the new config; a no-op does not restart', async () => {
  const src = source();
  const engine = makeEngine(src);
  const acc = await engine.connect(src, flow);
  const h = engine.run(acc);
  await waitFor(() => pulls.length === 1);
  await engine.setOption(acc.id, 'skip', true); // equals the default → no-op
  await sleep(200);
  expect(pulls).toHaveLength(1);
  await engine.setOption(acc.id, 'skip', false);
  await waitFor(() => pulls.length === 2);
  expect(pulls[1]).toEqual({ options: { skip: false } });
  await h.stop();
});

it('setOption leaves a paused account paused', async () => {
  const src = source();
  const engine = makeEngine(src);
  const acc = await engine.connect(src, flow);
  const h = engine.run(acc);
  await waitFor(() => pulls.length === 1);
  await store.setAccountStatus(acc.id, { status: 'paused' });
  await engine.setOption(acc.id, 'skip', false);
  await sleep(200);
  expect((await store.account(acc.id))?.status).toBe('paused');
  expect(pulls).toHaveLength(1);
  await h.stop();
});

it('updateConfig refuses an options key', async () => {
  const src = source();
  const engine = makeEngine(src);
  const acc = await engine.connect(src, flow);
  await expect(
    engine.updateConfig(acc.id, { options: { skip: false } }),
  ).rejects.toBeInstanceOf(OptionConfigError);
});
