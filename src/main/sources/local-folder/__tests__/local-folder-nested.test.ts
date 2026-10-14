/** @jest-environment node */
/**
 * Nested containers in a ZIP (phase 2b): the member is extracted to the
 * scratch directory in main, paged from there, and the copy never outlives
 * the record that is on it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

import type { Account, Batch, DocumentInput, Session } from '@shared/contracts';

import { createInlineConverter } from '../../../core/converter/converter';
import {
  DEFAULT_EXPAND_BUDGET,
  EXPANDER_VERSION,
} from '../../../core/converter/containers/types';
import { scratchName } from '../../../core/converter/containers/zip';
import type { Expansion, LocalFolderCursor, PendingExpansion } from '../cursor';
import {
  expansionStep,
  nestedOf,
  noteContainer,
  replaceRecord,
  sweepScratch,
} from '../expansion';
import { pull } from '../local-folder-source';
import { toAbsPosix } from '../scanner';
import type { LocalFolderItem } from '../to-document';

type B = Batch<LocalFolderCursor, LocalFolderItem>;

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lf-nested-')));
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms);
  });

const msg = (subject: string, day: number) =>
  `From - Mon, ${day} Jan 2024 10:00:00 +0000\n` +
  `From: Anna Weber <anna@example.de>\n` +
  `Subject: ${subject}\n` +
  `Date: Mon, ${day} Jan 2024 10:00:00 +0000\n` +
  `Message-ID: <${subject.toLowerCase()}@example.de>\n\n` +
  `Hello about ${subject}.\n\n`;
const mailbox = msg('Kickoff', 15) + msg('Budget', 16) + msg('Wrap', 17);

async function writeZip(
  p: string,
  entries: Record<string, string>,
): Promise<void> {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(entries)) zip.file(name, body);
  fs.writeFileSync(
    p,
    await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
  );
}

function session(paths: string[]): Session {
  const account: Account = {
    id: 'acct-lf',
    source: 'local-folder',
    identifier: 'this-machine',
    config: {
      folderRoots: paths.map((p) => ({ id: p, name: path.basename(p) })),
      watch: false,
    },
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

const docs = (batches: B[]): DocumentInput[] =>
  batches.flatMap((b) =>
    b.items.flatMap((i) => ('prebuilt' in i ? [i.prebuilt] : [])),
  );

async function collect(it: AsyncIterable<B>): Promise<B[]> {
  const out: B[] = [];
  for await (const b of it) out.push(b);
  return out;
}

describe('nested containers in a ZIP', () => {
  let dir: string;
  let scratch: string;
  let zipPath: string;
  const converter = createInlineConverter();
  beforeEach(async () => {
    dir = tmp();
    scratch = path.join(tmp(), 'expand-tmp');
    zipPath = path.join(dir, 'takeout.zip');
    await writeZip(zipPath, {
      'Takeout/Mail/All mail.mbox': mailbox,
      'Takeout/readme.txt': 'hello',
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(scratch), { recursive: true, force: true });
  });

  describe('through the source', () => {
    it('expands a mailbox inside a takeout zip and leaves no scratch copy', async () => {
      const batches = await collect(
        pull(session([dir]), null, { converter, scratchDir: scratch }),
      );
      const mails = docs(batches).filter((d) => d.type === 'email.message');
      expect(mails.map((m) => m.title).sort()).toEqual([
        'Budget',
        'Kickoff',
        'Wrap',
      ]);
      for (const m of mails)
        expect(m.parent).toEqual({
          externalId: toAbsPosix(zipPath),
          type: 'file',
        });
      // The copy is removed in the background as the record moves on.
      await sleep(50);
      expect(fs.readdirSync(scratch)).toEqual([]);
    });

    it('without a scratch directory a nested member is listed by name only', async () => {
      const batches = await collect(pull(session([dir]), null, { converter }));
      const out = docs(batches);
      expect(out.filter((d) => d.type === 'email.message')).toEqual([]);
      const row = out.filter((d) => d.externalId === toAbsPosix(zipPath));
      expect(row[row.length - 1].markdown).toContain('All mail.mbox');
    });

    it('a done zip of the previous expander version expands again', () => {
      const st = fs.statSync(zipPath);
      const old: Expansion = {
        state: 'done',
        kind: 'zip',
        v: 1,
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
      expect(EXPANDER_VERSION.zip).toBeGreaterThan(1);
      expect(
        noteContainer(old, 'zip', { size: st.size, mtimeMs: st.mtimeMs }),
      ).toMatchObject({ state: 'pending', resume: null, cleared: false });
    });
  });

  describe('step by step', () => {
    const id = () => toAbsPosix(zipPath);
    const step = (
      rec: PendingExpansion,
      extra: { signal?: AbortSignal } = {},
    ) =>
      expansionStep({
        absPath: zipPath,
        rec,
        scopeRootId: dir,
        converter,
        now: Date.now(),
        scratchDir: scratch,
        budget: { ...DEFAULT_EXPAND_BUDGET, items: 1 },
        ...extra,
      });

    /** Steps until the record is part-way through the nested mailbox. */
    async function midMember(
      exps: Record<string, Expansion>,
    ): Promise<PendingExpansion> {
      const st = fs.statSync(zipPath);
      exps[id()] = noteContainer(undefined, 'zip', {
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const out = await step(exps[id()] as PendingExpansion);
        replaceRecord(exps, id(), out.rec ?? null, scratch);
        const n = nestedOf(exps[id()]);
        if (n && n.items > 0) return exps[id()] as PendingExpansion;
      }
      throw new Error('never reached the nested member');
    }
    const copies = () =>
      fs.existsSync(scratch) ? fs.readdirSync(scratch) : [];

    it('a zip deleted mid-member is deleted and its copy removed', async () => {
      const exps: Record<string, Expansion> = {};
      await midMember(exps);
      expect(copies()).toHaveLength(1);
      fs.rmSync(zipPath);
      const out = await step(exps[id()] as PendingExpansion);
      expect(out.deletions).toEqual([{ externalId: id(), type: 'file' }]);
      replaceRecord(exps, id(), out.rec ?? null, scratch);
      await sleep(20);
      expect(copies()).toEqual([]);
    });

    it('a zip rewritten mid-member restarts the full path and drops the copy (no watcher event)', async () => {
      const exps: Record<string, Expansion> = {};
      await midMember(exps);
      await sleep(20);
      await writeZip(zipPath, { 'Takeout/Mail/All mail.mbox': msg('New', 1) });
      const out = await step(exps[id()] as PendingExpansion);
      expect(out.items).toEqual([]);
      expect(out.rec).toMatchObject({ resume: null, cleared: false });
      replaceRecord(exps, id(), out.rec ?? null, scratch);
      await sleep(20);
      expect(copies()).toEqual([]);
    });

    it('a copy lost after progress waits for room instead of going name-only', async () => {
      const exps: Record<string, Expansion> = {};
      const rec = await midMember(exps);
      for (const f of copies()) fs.rmSync(path.join(scratch, f));
      jest
        .spyOn(fs.promises, 'statfs')
        .mockResolvedValue({ bavail: 1, bsize: 1 } as never);
      const out = await step(rec);
      expect(out.items).toEqual([]);
      expect(out.rec).toMatchObject({ state: 'pending', attempts: 0 });
      expect((out.rec as PendingExpansion).notBefore).toBeGreaterThan(
        Date.now(),
      );
      expect(nestedOf(out.rec ?? undefined)?.skip).toBeUndefined();
    });

    it('an abort during extraction leaves the record and no partial copy', async () => {
      const exps: Record<string, Expansion> = {};
      const rec = await midMember(exps);
      for (const f of copies()) fs.rmSync(path.join(scratch, f));
      const ac = new AbortController();
      ac.abort();
      const out = await step(rec, { signal: ac.signal });
      expect(out.rec).toBe(rec);
      expect(out.items).toEqual([]);
      expect(copies()).toEqual([]);
    });
  });

  it('the sweep keeps the pending copy and deletes everything else', async () => {
    fs.mkdirSync(scratch, { recursive: true });
    const st = fs.statSync(zipPath);
    const exps: Record<string, Expansion> = {
      [toAbsPosix(zipPath)]: noteContainer(undefined, 'zip', {
        size: st.size,
        mtimeMs: st.mtimeMs,
      }),
    };
    // Full path, then the first page stops at the nested member.
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const out = await expansionStep({
        absPath: zipPath,
        rec: exps[toAbsPosix(zipPath)] as PendingExpansion,
        converter,
        now: Date.now(),
      });
      exps[toAbsPosix(zipPath)] = out.rec as Expansion;
    }
    const n = nestedOf(exps[toAbsPosix(zipPath)]);
    expect(n).not.toBeNull();
    const kept = scratchName(toAbsPosix(zipPath), n!);
    fs.writeFileSync(path.join(scratch, kept), 'copy');
    fs.writeFileSync(path.join(scratch, 'stale.mbox'), 'x');
    fs.writeFileSync(path.join(scratch, `${kept}.part`), 'x');
    await sweepScratch(scratch, exps);
    expect(fs.readdirSync(scratch)).toEqual([kept]);
  });
});
