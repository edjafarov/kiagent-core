/** @jest-environment node */
/**
 * The PST pager on an Outlook-written store (fixtures/containers/README.md):
 * messages only, resumable page by page in a fresh call, isolated from bad
 * rows and oversized properties, and pinned to the pst-extractor internals
 * pst-tables.ts reaches into.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { PSTFile, PSTFolder, PSTMessage } from 'pst-extractor';

import {
  expandPst,
  fromOf,
  PST_LIMITS,
  type PstResume,
} from '../containers/pst';
import * as tables from '../containers/pst-tables';
import type { ChildItem, ExpandBudget } from '../containers/types';

const ALL: ExpandBudget = { items: 100_000, bytes: 1e12, ms: 1e9 };

let dir: string;
let file: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-'));
  file = path.join(dir, 'sample.pst');
  fs.writeFileSync(
    file,
    zlib.gunzipSync(
      fs.readFileSync(
        path.join(__dirname, 'fixtures/containers/outlook-sample.pst.gz'),
      ),
    ),
  );
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  jest.restoreAllMocks();
  PST_LIMITS.folders = 2000;
});

/** Page by page, each page a fresh call with a JSON round-tripped resume. */
async function drainPaged(items: number): Promise<{
  children: ChildItem[];
  last: Awaited<ReturnType<typeof expandPst>>;
  pages: number;
}> {
  const children: ChildItem[] = [];
  let resume: PstResume | null = null;
  for (let pages = 1; pages < 500; pages++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await expandPst(file, resume, { ...ALL, items });
    children.push(...r.items);
    if (r.resume === null) return { children, last: r, pages };
    resume = JSON.parse(JSON.stringify(r.resume)) as PstResume;
  }
  throw new Error('never finished');
}

describe('expandPst', () => {
  it('yields the messages only, with folder labels and a summary', async () => {
    const r = await expandPst(file, null, ALL);
    expect(r.resume).toBeNull();
    const keys = r.items.map((c) => c.key);
    expect(keys.length).toBe(11);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of r.items) {
      expect(c.key).toMatch(/^pst:\d+$/);
      expect(c.type).toBe('email.message');
      expect(c.metadata.folder).not.toMatch(/Calendar/);
      expect(c.markdown).not.toMatch(/<html|<p>|\{\\rtf/i);
    }
    const inbox = r.items.filter((c) => c.metadata.folder === 'Inbox');
    expect(inbox.length).toBe(7);
    expect(
      inbox.find((c) => c.title === 'text file attachment')?.markdown,
    ).toContain('**Attachments:** text.txt');
    expect(r.summary).toMatch(
      /^# sample\.pst — 11 messages, 2021\n\n- Inbox — 7/,
    );
  });

  it('pages resume exactly in a fresh call (no duplicates, same order)', async () => {
    const one = (await expandPst(file, null, ALL)).items.map((c) => c.key);
    for (const size of [1, 4]) {
      // eslint-disable-next-line no-await-in-loop
      const { children, last, pages } = await drainPaged(size);
      expect(children.map((c) => c.key)).toEqual(one);
      expect(pages).toBeGreaterThan(1);
      expect(last.summary).toMatch(/— 11 messages/);
    }
  });

  it('a row that fails to load is skipped once, never re-emitted', async () => {
    const keys = (await expandPst(file, null, ALL)).items.map((c) => c.key);
    const bad = Number(keys[2].slice(4));
    const real = PSTFile.prototype.getDescriptorIndexNode;
    jest
      .spyOn(PSTFile.prototype, 'getDescriptorIndexNode')
      .mockImplementation(function (this: PSTFile, id) {
        if (id.toNumber() === bad) throw new Error('Descriptor not found');
        return real.call(this, id);
      });
    const { children } = await drainPaged(1);
    expect(children.map((c) => c.key)).toEqual(
      keys.filter((k) => k !== `pst:${bad}`),
    );
  });

  it('the fallback table path is isolated too', () => {
    const pst = new PSTFile(file);
    try {
      jest.spyOn(pst, 'getDescriptorIndexNode').mockImplementation(() => {
        throw new Error('Descriptor not found');
      });
      const fake = {
        contentCount: 1,
        initEmailsTable: () => {},
        emailsTable: null,
        fallbackEmailsTable: [{ descriptorIdentifier: 0x200004 }],
      } as unknown as PSTFolder;
      expect(tables.childAt(pst, fake, 0)).toEqual({
        end: false,
        message: null,
        skipped: true,
      });
      expect(tables.childAt(pst, fake, 1)).toEqual({ end: true });
    } finally {
      pst.close();
    }
  });

  it('an oversized body is never read: headers only, truncated', async () => {
    jest.spyOn(tables, 'propSize').mockReturnValue(64 * 1024 * 1024);
    const getters = (['body', 'bodyHTML', 'bodyRTF'] as const).map((g) =>
      jest.spyOn(PSTMessage.prototype, g, 'get'),
    );
    const r = await expandPst(file, null, ALL);
    expect(r.items.length).toBe(11);
    for (const g of getters) expect(g).not.toHaveBeenCalled();
    for (const c of r.items) {
      expect(c.metadata.truncated).toBe(true);
      expect(c.markdown).toMatch(/\[truncated\]$/);
    }
  });

  it('reads recipients from one table read, never getRecipient (quadratic)', async () => {
    const per = jest.spyOn(PSTMessage.prototype, 'getRecipient');
    const r = await expandPst(file, null, ALL);
    expect(per).not.toHaveBeenCalled();
    const sent = r.items.find((c) => c.title === 'Accepted: meeting from Ed');
    expect(sent?.metadata.to).toEqual(['epfromer@gmail.com']);
  });

  it('reads the attachment table once per message, names intact', async () => {
    const real = tables.attachmentNamesOf;
    const reads: number[] = [];
    jest.spyOn(tables, 'attachmentNamesOf').mockImplementation((m, max) => {
      const t = m as unknown as {
        attachmentTable: { getItems: unknown } | null;
      };
      void m.numberOfAttachments;
      let calls = 0;
      if (t.attachmentTable) {
        const tbl = t.attachmentTable as {
          getItems: (...a: number[]) => unknown;
        };
        const orig = tbl.getItems.bind(tbl);
        tbl.getItems = (...a: number[]) => {
          calls += 1;
          return orig(...a);
        };
      }
      const out = real(m, max);
      if (out.length > 0) reads.push(calls);
      return out;
    });
    const r = await expandPst(file, null, ALL);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((n) => n === 1)).toBe(true);
    const three = r.items.find((c) => c.title === 'text, jpg, pdf attachments');
    expect(three?.markdown).toMatch(/\*\*Attachments:\*\* .*text\.txt/);
  });

  it('a damaged hierarchy table hides only its subtree; a stale flag hides nothing', () => {
    const row = new Map([[0x67f2, { entryValueReference: 42, itemIndex: 0 }]]);
    const stale = {
      hasSubfolders: false,
      initSubfoldersTable: () => {},
      subfoldersTable: { getItems: () => [row] },
    } as unknown as PSTFolder;
    expect(tables.subfolderNids(stale, 0, 10)).toEqual([42]);
    const broken = {
      hasSubfolders: true,
      initSubfoldersTable: () => {
        throw new Error('Descriptor not found');
      },
    } as unknown as PSTFolder;
    expect(tables.subfolderNids(broken, 0, 10)).toEqual([]);
  });

  it('rows past an understated PR_CONTENT_COUNT are still read', () => {
    const pst = new PSTFile(file);
    try {
      jest.spyOn(pst, 'getDescriptorIndexNode').mockImplementation(() => {
        throw new Error('Descriptor not found');
      });
      const row = new Map([
        [0x67f2, { entryValueReference: 0x200004, itemIndex: 0 }],
      ]);
      const folder = {
        contentCount: 1,
        initEmailsTable: () => {},
        emailsTable: { rowCount: 3, getItems: () => [row] },
        fallbackEmailsTable: null,
      } as unknown as PSTFolder;
      expect(tables.childAt(pst, folder, 2)).toMatchObject({ end: false });
      expect(tables.childAt(pst, folder, 3)).toEqual({ end: true });
    } finally {
      pst.close();
    }
  });

  it('rowLimit sees the table on a freshly loaded folder (resume check == walk)', () => {
    const folder: Record<string, unknown> = {
      contentCount: 1,
      emailsTable: null,
    };
    folder.initEmailsTable = () => {
      folder.emailsTable = { rowCount: 3, getItems: () => [] };
    };
    expect(tables.rowLimit(folder as unknown as PSTFolder)).toBe(3);
  });

  it('a damaged body leaves the message headers-only, never drops it', async () => {
    jest.spyOn(tables, 'propSize').mockImplementation(() => {
      throw new Error('getOffsetIndexNode: not found');
    });
    const r = await expandPst(file, null, ALL);
    expect(r.items.length).toBe(11);
    expect(r.items.every((c) => c.title.length > 0)).toBe(true);
  });

  it('stops walking at the folder cap and says so', async () => {
    PST_LIMITS.folders = 3;
    const r = await expandPst(file, null, ALL);
    expect(r.summary).toMatch(/Only the first 3 folders were read\./);
  });

  it('restarts when the folder tree or a folder changed under a resume', async () => {
    const first = (await expandPst(file, null, { ...ALL, items: 2 }))
      .resume as PstResume;
    expect(
      await expandPst(file, { ...first, nid: first.nid + 32 }, ALL),
    ).toEqual({ items: [], resume: null, restart: true });
    expect(await expandPst(file, { ...first, child: 10_000 }, ALL)).toEqual({
      items: [],
      resume: null,
      restart: true,
    });
  });

  it('a file that is not a PST throws a plain error', async () => {
    const junk = path.join(dir, 'preset.pst');
    fs.writeFileSync(junk, Buffer.from('LogicPresetDataxxxxxxxxxxxxxxxx'));
    const err = await expandPst(junk, null, ALL).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/not a PST/);
    expect((err as Error).name).not.toBe('ContainerBusyError');
  });

  it('a locked file (EBUSY) is a ContainerBusyError', async () => {
    jest.spyOn(fs, 'openSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY: resource busy'), {
        code: 'EBUSY',
      });
    });
    const err = await expandPst(file, null, ALL).catch((e: Error) => e);
    expect((err as Error).name).toBe('ContainerBusyError');
  });
});

describe('fromOf', () => {
  const msg = (p: Partial<Record<string, string>>) =>
    ({
      transportMessageHeaders: '',
      sentRepresentingName: '',
      senderName: '',
      sentRepresentingEmailAddress: '',
      senderEmailAddress: '',
      ...p,
    }) as unknown as PSTMessage;

  it('an Exchange DN in the From header loses to an SMTP property', async () => {
    expect(
      await fromOf(
        msg({
          transportMessageHeaders:
            'From: "Enron Messaging" </O=ENRON/OU=NA/CN=RECIPIENTS/CN=X>\r\nTo: a@b.c\r\n\r\n',
          sentRepresentingName: 'Jeff Dasovich',
          sentRepresentingEmailAddress: 'jeff.dasovich@enron.com',
        }),
      ),
    ).toBe('Jeff Dasovich <jeff.dasovich@enron.com>');
  });

  it('a folded, encoded From header with an address wins', async () => {
    expect(
      await fromOf(
        msg({
          transportMessageHeaders:
            'From: =?UTF-8?B?SsO8cmdlbg==?=\r\n <juergen@example.de>\r\n\r\n',
          senderEmailAddress: 'other@example.de',
        }),
      ),
    ).toBe('Jürgen <juergen@example.de>');
  });

  it('a group alias is no address: the name alone', async () => {
    expect(
      await fromOf(
        msg({
          senderName: 'All Enron Worldwide',
          senderEmailAddress: 'All Enron Worldwide@ENRON',
        }),
      ),
    ).toBe('All Enron Worldwide');
  });
});

describe('pst-extractor internals (pinned 1.12.0)', () => {
  it('still has every member pst-tables.ts reaches into', () => {
    const pst = new PSTFile(file);
    try {
      const root = pst.getRootFolder() as unknown as Record<string, unknown>;
      expect(typeof root.initEmailsTable).toBe('function');
      expect(typeof root.initSubfoldersTable).toBe('function');
      expect(root).toHaveProperty('emailsTable');
      expect(root).toHaveProperty('fallbackEmailsTable');
      expect(root).toHaveProperty('subfoldersTable');
      expect(root.pstTableItems).toBeInstanceOf(Map);
      expect(root).toHaveProperty('localDescriptorItems');
      // A real message, reached the way the pager reaches one.
      const stack = [pst.getRootFolder()];
      let m: PSTMessage | null = null;
      while (!m && stack.length > 0) {
        const f = stack.pop() as PSTFolder;
        const at = f.contentCount > 0 ? tables.childAt(pst, f, 0) : null;
        if (at && !at.end) m = at.message;
        for (const nid of tables.subfolderNids(f, 0, 100)) {
          const sub = tables.loadFolder(pst, nid);
          if (sub) stack.push(sub);
        }
      }
      expect(m).not.toBeNull();
      void m!.numberOfRecipients;
      expect(m).toHaveProperty('recipientTable');
      expect(
        JSON.parse(
          fs.readFileSync(
            require.resolve('pst-extractor/package.json'),
            'utf8',
          ),
        ).version,
      ).toBe('1.12.0');
    } finally {
      pst.close();
    }
  });
});
