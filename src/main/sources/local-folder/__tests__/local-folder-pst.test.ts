/** @jest-environment node */
/**
 * Outlook PSTs through the local-folder source (phase 3): the sample store
 * expands into messages under the .pst, a recently written PST waits out the
 * quiet period, and a `.pst` that is no PST (Logic presets) never gets a row.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import type { Account, Batch, DocumentInput, Session } from '@shared/contracts';

import type { Expansion, LocalFolderCursor } from '../cursor';
import { PST_QUIET_MS } from '../expansion';
import { pull } from '../local-folder-source';
import { toAbsPosix } from '../scanner';
import type { LocalFolderItem } from '../to-document';

type B = Batch<LocalFolderCursor, LocalFolderItem>;

const SAMPLE = path.join(
  __dirname,
  '../../../core/converter/__tests__/fixtures/containers/outlook-sample.pst.gz',
);

function session(root: string): Session {
  const account: Account = {
    id: 'acct-lf',
    source: 'local-folder',
    identifier: 'this-machine',
    config: { folderRoots: [{ id: root, name: 'r' }], watch: false },
    status: 'connecting',
    cursor: null,
    createdAt: new Date().toISOString(),
  };
  return {
    account,
    signal: new AbortController().signal,
    credentials: async () => null,
    log: () => {},
  };
}
async function collect(it: AsyncIterable<B>): Promise<B[]> {
  const out: B[] = [];
  for await (const b of it) out.push(b);
  return out;
}
const docs = (batches: B[]): DocumentInput[] =>
  batches.flatMap((b) =>
    b.items.flatMap((i) => ('prebuilt' in i ? [i.prebuilt] : [])),
  );
const lastCursor = (batches: B[]) =>
  batches[batches.length - 1].cursor as NonNullable<LocalFolderCursor>;
const record = (batches: B[], abs: string): Expansion | undefined =>
  lastCursor(batches).expansions?.[toAbsPosix(abs)];

describe('local-folder PSTs', () => {
  let dir: string;
  let pst: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lf-pst-')));
    pst = path.join(dir, 'archive.pst');
    fs.writeFileSync(pst, zlib.gunzipSync(fs.readFileSync(SAMPLE)));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const age = (file: string, ms: number) => {
    const t = new Date(Date.now() - ms);
    fs.utimesSync(file, t, t);
  };

  it('expands a quiet PST into messages under it, with their folders', async () => {
    age(pst, PST_QUIET_MS + 60_000);
    const batches = await collect(pull(session(dir), null));
    const out = docs(batches);
    const mails = out.filter((d) => d.type === 'email.message');
    expect(mails).toHaveLength(11);
    for (const m of mails) {
      expect(m.parent).toEqual({ externalId: toAbsPosix(pst), type: 'file' });
      expect(m.externalId).toMatch(/#pst:\d+$/);
      expect(m.metadata?.extraction).toEqual({ container: 'pst' });
    }
    expect(mails.filter((m) => m.metadata?.folder === 'Inbox')).toHaveLength(7);
    const rows = out.filter((d) => d.externalId === toAbsPosix(pst));
    expect(rows[rows.length - 1].markdown).toMatch(
      /^# archive\.pst — 11 messages, 2021/,
    );
    expect(record(batches, pst)).toMatchObject({ state: 'done', kind: 'pst' });
  });

  it('a PST written just now waits out the quiet period', async () => {
    const batches = await collect(pull(session(dir), null)).catch(
      () => [] as B[],
    );
    // The drive loop stops once nothing is due (no watcher): no children yet.
    expect(docs(batches).filter((d) => d.parent)).toEqual([]);
    const rec = record(batches, pst) as Extract<
      Expansion,
      { state: 'pending' }
    >;
    expect(rec.state).toBe('pending');
    expect(rec.notBefore).toBe(
      Math.min(fs.statSync(pst).mtimeMs, Date.now()) + PST_QUIET_MS,
    );
  });

  it('a Logic preset named .pst gets no row and no work, now or later', async () => {
    const preset = path.join(dir, 'Slow Panning.pst');
    fs.writeFileSync(preset, Buffer.from('presetdata'.repeat(20)));
    age(preset, PST_QUIET_MS + 60_000);
    fs.rmSync(pst);
    const first = await collect(pull(session(dir), null));
    expect(
      docs(first).filter((d) => d.externalId.includes('Slow Panning')),
    ).toEqual([]);
    expect(record(first, preset)).toMatchObject({
      state: 'done',
      rejected: true,
    });
    const again = await collect(pull(session(dir), lastCursor(first)));
    expect(again.flatMap((b) => b.items)).toEqual([]);
    expect(again.flatMap((b) => b.deletions ?? [])).toEqual([]);
  });

  it('a pending PST replaced by a preset while the app was stopped is rejected, never "Could not read"', async () => {
    age(pst, PST_QUIET_MS + 60_000);
    const st = fs.statSync(pst);
    const cursor: LocalFolderCursor = {
      roots: {
        [dir]: { completedAt: new Date(Date.now() + 60_000).toISOString() },
      },
      policyVersion: 5,
      expansions: {
        [toAbsPosix(pst)]: {
          state: 'pending',
          kind: 'pst',
          v: 1,
          size: st.size,
          mtimeMs: st.mtimeMs,
          resume: {
            fi: 0,
            nid: 1,
            child: 3,
            count: 3,
            skipped: 0,
            first: null,
            last: null,
            byFolder: [],
          },
          cleared: true,
          attempts: 0,
        },
      },
    };
    fs.writeFileSync(pst, Buffer.from('presetdata'.repeat(20)));
    age(pst, PST_QUIET_MS + 60_000);
    const batches = await collect(pull(session(dir), cursor));
    expect(
      docs(batches).filter((d) => /Could not read/.test(d.markdown ?? '')),
    ).toEqual([]);
    expect(record(batches, pst)).toMatchObject({
      state: 'done',
      rejected: true,
    });
  });
});
