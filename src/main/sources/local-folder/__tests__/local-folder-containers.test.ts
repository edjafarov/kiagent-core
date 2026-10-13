/** @jest-environment node */
/**
 * Container expansion through the source (spec B3): real temp dirs, the
 * in-process converter (or a scripted one where timing matters).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Account, Batch, DocumentInput, Session } from '@shared/contracts';

import type { ExpandResult } from '../../../core/converter/containers/types';
import type { Expansion, LocalFolderCursor } from '../cursor';
import { pull } from '../local-folder-source';
import type { LocalFolderItem } from '../to-document';

type B = Batch<LocalFolderCursor, LocalFolderItem>;

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lf-containers-')));
const id = (abs: string) => abs.split(path.sep).join('/');
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms);
  });

function session(paths: string[], signal: AbortSignal, watch = false): Session {
  const account: Account = {
    id: 'acct-lf',
    source: 'local-folder',
    identifier: 'this-machine',
    config: {
      folderRoots: paths.map((p) => ({ id: p, name: path.basename(p) })),
      watch,
    },
    status: 'connecting',
    cursor: null,
    createdAt: new Date().toISOString(),
  };
  return { account, signal, credentials: async () => null, log: () => {} };
}

const msg = (subject: string, day: number) =>
  `From - Mon, ${day} Jan 2024 10:00:00 +0000\n` +
  `From: Anna Weber <anna@example.de>\n` +
  `To: Bob <bob@example.com>\n` +
  `Subject: ${subject}\n` +
  `Date: Mon, ${day} Jan 2024 10:00:00 +0000\n` +
  `Message-ID: <${subject.toLowerCase()}@example.de>\n\n` +
  `Hello about ${subject}.\n\n`;

const docs = (batches: B[]): DocumentInput[] =>
  batches.flatMap((b) =>
    b.items.flatMap((i) => ('prebuilt' in i ? [i.prebuilt] : [])),
  );
const files = (batches: B[]) =>
  batches.flatMap((b) =>
    b.items.flatMap((i) => ('prebuilt' in i ? [] : [i.externalId])),
  );
const deletions = (batches: B[]) =>
  batches.flatMap((b) => (b.deletions ?? []).map((d) => d.externalId));
const lastCursor = (batches: B[]) =>
  batches[batches.length - 1].cursor as NonNullable<LocalFolderCursor>;

async function collect(it: AsyncIterable<B>): Promise<B[]> {
  const out: B[] = [];
  for await (const b of it) out.push(b);
  return out;
}

describe('local-folder containers', () => {
  let dir: string;
  let mbox: string;
  beforeEach(() => {
    dir = tmp();
    mbox = path.join(dir, 'inbox.mbox');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'plain');
    fs.writeFileSync(
      mbox,
      msg('Kickoff', 15) + msg('Budget', 16) + msg('Wrap', 17),
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (cursor: LocalFolderCursor | null) =>
    collect(pull(session([dir], new AbortController().signal), cursor));

  it('backfill expands a mailbox into a summary row and child messages', async () => {
    const batches = await run(null);
    expect(files(batches)).toEqual([id(path.join(dir, 'a.txt'))]);
    const out = docs(batches);
    const rows = out.filter((d) => d.externalId === id(mbox));
    // Placeholder on the first page, summary on the last (one page here,
    // so the summary only).
    expect(rows[rows.length - 1].markdown).toMatch(
      /^# inbox\.mbox — 3 messages/,
    );
    const children = out.filter((d) => d.parent);
    expect(children).toHaveLength(3);
    for (const c of children) {
      expect(c.type).toBe('email.message');
      expect(c.parent).toEqual({ externalId: id(mbox), type: 'file' });
      expect(c.scopeRootId).toBe(dir);
      expect(c.metadata?.absPath).toBeUndefined();
      expect(c.metadata?.extraction).toEqual({ container: 'mbox' });
    }
    // Container docs come after the deletion batch of the full path.
    expect(deletions(batches)).toEqual([id(mbox)]);
    expect(lastCursor(batches).expansions?.[id(mbox)]).toMatchObject({
      state: 'done',
      kind: 'mbox',
    });
  });

  it('an unchanged container costs nothing on the next pull', async () => {
    const first = await run(null);
    const second = await run(lastCursor(first));
    expect(second.flatMap((b) => b.items)).toEqual([]);
    expect(deletions(second)).toEqual([]);
  });

  it('an appended message emits exactly one new child, no deletion', async () => {
    const first = await run(null);
    await sleep(20);
    fs.appendFileSync(mbox, msg('Later', 18));
    const second = await run(lastCursor(first));
    const children = docs(second).filter((d) => d.parent);
    expect(children.map((c) => c.title)).toEqual(['Later']);
    expect(deletions(second)).toEqual([]);
    const summary = docs(second).find((d) => d.externalId === id(mbox));
    expect(summary?.markdown).toMatch(/4 messages/);
  });

  it('a rewritten mailbox is cleared then re-emitted (removed message stays archived)', async () => {
    const first = await run(null);
    await sleep(20);
    fs.writeFileSync(mbox, msg('Kickoff', 15) + msg('Wrap', 17));
    const second = await run(lastCursor(first));
    const firstDeletion = second.findIndex((b) => (b.deletions ?? []).length);
    const firstChild = second.findIndex((b) =>
      b.items.some((i) => 'prebuilt' in i && i.prebuilt.parent),
    );
    expect(deletions(second)).toEqual([id(mbox)]);
    expect(firstDeletion).toBeLessThan(firstChild);
    expect(
      docs(second)
        .filter((d) => d.parent)
        .map((d) => d.title),
    ).toEqual(['Kickoff', 'Wrap']);
  });

  it('a restart after the deletion batch does not delete again', async () => {
    const st = fs.statSync(mbox);
    const pending: Expansion = {
      state: 'pending',
      kind: 'mbox',
      v: 1,
      size: st.size,
      mtimeMs: st.mtimeMs,
      resume: null,
      cleared: true,
      attempts: 0,
    };
    const cursor: LocalFolderCursor = {
      roots: {
        [dir]: { completedAt: new Date(Date.now() + 60_000).toISOString() },
      },
      policyVersion: 4,
      expansions: { [id(mbox)]: pending },
    };
    const batches = await run(cursor);
    expect(deletions(batches)).toEqual([]);
    expect(docs(batches).filter((d) => d.parent)).toHaveLength(3);
  });

  it('a deleted container is deleted and its record dropped on rescan', async () => {
    const first = await run(null);
    fs.rmSync(mbox);
    const second = await run(lastCursor(first));
    expect(deletions(second)).toEqual([id(mbox)]);
    expect(lastCursor(second).expansions).toBeUndefined();
  });

  it('an unreadable subfolder does not drop the containers it hides', async () => {
    const sub = path.join(dir, 'mail');
    fs.mkdirSync(sub);
    const inner = path.join(sub, 'old.mbox');
    fs.writeFileSync(inner, msg('Old', 14));
    const first = await run(null);
    expect(lastCursor(first).expansions?.[id(inner)]?.state).toBe('done');
    fs.chmodSync(sub, 0o000);
    try {
      const second = await run(lastCursor(first));
      expect(deletions(second)).toEqual([]);
    } finally {
      fs.chmodSync(sub, 0o755);
    }
  });

  it('records under a root that left the config are pruned', async () => {
    const first = await run(null);
    const other = tmp();
    try {
      const batches = await collect(
        pull(session([other], new AbortController().signal), lastCursor(first)),
      );
      expect(batches[0].cursor?.expansions).toBeUndefined();
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('admits a Thunderbird mailbox (extensionless + .msf) on backfill', async () => {
    const tb = path.join(dir, 'Inbox');
    fs.writeFileSync(tb, msg('Thunder', 19));
    fs.writeFileSync(`${tb}.msf`, '// mork');
    const batches = await run(null);
    const kids = docs(batches).filter((d) => d.parent?.externalId === id(tb));
    expect(kids.map((d) => d.title)).toEqual(['Thunder']);
  });

  it('drains a pending expansion on a quiet watched root, without any fs event', async () => {
    const ac = new AbortController();
    // A regression fails the expectation below instead of hanging jest.
    setTimeout(() => ac.abort(), 15_000).unref();
    const seen: B[] = [];
    for await (const b of pull(session([dir], ac.signal, true), null)) {
      seen.push(b);
      if (
        docs([b]).some(
          (d) =>
            d.externalId === id(mbox) && /3 messages/.test(d.markdown ?? ''),
        )
      )
        ac.abort();
    }
    expect(docs(seen).filter((d) => d.parent)).toHaveLength(3);
  }, 20_000);

  it('a file written during a long expansion is indexed while it runs', async () => {
    const pages = 400;
    let page = 0;
    const converter = {
      expandPage: async (): Promise<ExpandResult> => {
        await sleep(10);
        page += 1;
        return {
          items: [
            {
              key: `k${page}`,
              type: 'email.message',
              title: `m${page}`,
              markdown: `# m${page}`,
              metadata: {},
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          ],
          resume: page < pages ? { page } : null,
          ...(page < pages ? {} : { summary: '# done' }),
        };
      },
    };
    const ac = new AbortController();
    // A regression fails the expectation below instead of hanging jest.
    setTimeout(() => ac.abort(), 15_000).unref();
    const late = path.join(dir, 'late.txt');
    let lateAtPage: number | null = null;
    const pump = (async () => {
      for await (const b of pull(session([dir], ac.signal, true), null, {
        converter,
      })) {
        if (page === 30) fs.writeFileSync(late, 'arrived');
        if (files([b]).includes(id(late))) {
          lateAtPage = page;
          ac.abort();
        }
      }
    })();
    await pump;
    expect(lateAtPage).not.toBeNull();
    expect(lateAtPage!).toBeLessThan(pages);
  }, 30_000);

  it('a Thunderbird mailbox written before its .msf is admitted by the .msf', async () => {
    const ac = new AbortController();
    // A regression fails the expectation below instead of hanging jest.
    setTimeout(() => ac.abort(), 15_000).unref();
    const tb = path.join(dir, 'Sent');
    let started = false;
    let kids: DocumentInput[] = [];
    for await (const b of pull(session([dir], ac.signal, true), null)) {
      if (!started && b.cursor?.policyVersion) {
        started = true;
        await sleep(600);
        fs.writeFileSync(tb, msg('Early', 21));
        await sleep(400); // the mailbox's own event is filtered (no .msf yet)
        fs.writeFileSync(`${tb}.msf`, '// mork');
      }
      kids = kids.concat(
        docs([b]).filter((d) => d.parent?.externalId === id(tb)),
      );
      if (kids.length > 0) ac.abort();
    }
    expect(kids.map((d) => d.title)).toEqual(['Early']);
  }, 20_000);

  it('a Thunderbird mailbox created under a watched root is expanded', async () => {
    const ac = new AbortController();
    // A regression fails the expectation below instead of hanging jest.
    setTimeout(() => ac.abort(), 15_000).unref();
    const tb = path.join(dir, 'Archive');
    let started = false;
    let kids: DocumentInput[] = [];
    for await (const b of pull(session([dir], ac.signal, true), null)) {
      if (!started && b.cursor?.policyVersion) {
        started = true;
        // chokidar's initial walk; then the mailbox appears live.
        await sleep(600);
        fs.writeFileSync(`${tb}.msf`, '// mork');
        fs.writeFileSync(tb, msg('Live', 20));
      }
      kids = kids.concat(
        docs([b]).filter((d) => d.parent?.externalId === id(tb)),
      );
      if (kids.length > 0) ac.abort();
    }
    expect(kids.map((d) => d.title)).toEqual(['Live']);
  }, 20_000);
});
