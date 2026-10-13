/** @jest-environment node */
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { expandMbox, type MboxResume } from '../containers/mbox';
import { DEFAULT_EXPAND_BUDGET } from '../containers/types';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-mbox-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

const msg = (o: {
  from?: string;
  subject: string;
  date: string;
  id?: string;
  extra?: string;
  body: string;
}) =>
  `From - ${o.date}\n` +
  `From: ${o.from ?? 'Anna Weber <anna@example.de>'}\n` +
  `To: Bob <bob@example.com>, carl@example.com\n` +
  `Subject: ${o.subject}\n` +
  `Date: ${o.date}\n${o.id ? `Message-ID: <${o.id}>\n` : ''}${
    o.extra ?? ''
  }\n${o.body}\n\n`;

const THREE =
  msg({
    subject: 'Kickoff',
    date: 'Mon, 15 Jan 2024 10:00:00 +0000',
    id: 'a1@example.de',
    body: 'Let us meet on Monday.\n\nBest regards\nAnna',
  }) +
  msg({
    subject: 'No id here',
    date: 'Tue, 16 Jan 2025 10:00:00 +0000',
    body: 'Quoted line follows:\n>From the archive, nothing changed.',
  }) +
  msg({
    subject: 'Final',
    date: 'Wed, 17 Jan 2026 10:00:00 +0000',
    id: 'a3@example.de',
    body: 'Done.',
  });

const write = (name: string, content: string | Buffer) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};

const drain = async (p: string, items: number) => {
  const out = [];
  let resume: MboxResume | null = null;
  let last;
  do {
    // eslint-disable-next-line no-await-in-loop
    last = await expandMbox(p, resume, { ...DEFAULT_EXPAND_BUDGET, items });
    out.push(...last.items);
    resume = last.resume as MboxResume | null;
  } while (resume);
  return { items: out, last };
};

describe('expandMbox', () => {
  it('one child per message with IMAP-shaped metadata, summary and tail', async () => {
    const p = write('inbox.mbox', THREE);
    const r = await expandMbox(p, null, DEFAULT_EXPAND_BUDGET);
    expect(r.items.map((i) => i.title)).toEqual([
      'Kickoff',
      'No id here',
      'Final',
    ]);
    expect(r.items[0].key).toBe(`msg:${sha1('a1@example.de')}`);
    expect(r.items[1].key).toMatch(/^msg:[0-9a-f]{40}$/);
    expect(r.items[0]).toMatchObject({
      type: 'email.message',
      createdAt: '2024-01-15T10:00:00.000Z',
      metadata: {
        from: 'Anna Weber <anna@example.de>',
        to: ['Bob <bob@example.com>', 'carl@example.com'],
        cc: [],
        subject: 'Kickoff',
        messageId: 'a1@example.de',
        date: '2024-01-15T10:00:00.000Z',
      },
    });
    expect(
      (r.items[0].metadata.contactEvidence as { messages: unknown[] }).messages,
    ).toHaveLength(1);
    expect(r.items[0].markdown).toContain('**From:** Anna Weber');
    expect(r.items[1].markdown).toContain('From the archive, nothing changed.');
    expect(r.items[1].markdown).not.toContain('>From the archive');
    expect(r.resume).toBeNull();
    expect(r.summary).toBe('# inbox.mbox — 3 messages, 2024–2026');
    expect(r.tail).toMatchObject({
      offset: fs.statSync(p).size,
      count: 3,
      append: true,
    });
  });

  it('pages by the item budget with the same keys as one pass', async () => {
    const p = write('inbox.mbox', THREE);
    const one = await expandMbox(p, null, DEFAULT_EXPAND_BUDGET);
    const paged = await drain(p, 2);
    expect(paged.items.map((i) => i.key)).toEqual(one.items.map((i) => i.key));
    expect(paged.last.summary).toBe(one.summary);
  });

  it('skips automated mail', async () => {
    const p = write(
      'inbox.mbox',
      msg({
        subject: 'Weekly digest',
        date: 'Mon, 15 Jan 2024 10:00:00 +0000',
        extra: 'Precedence: bulk\n',
        body: 'news',
      }) + THREE,
    );
    const r = await expandMbox(p, null, DEFAULT_EXPAND_BUDGET);
    expect(r.items.map((i) => i.title)).not.toContain('Weekly digest');
    expect(r.summary).toBe('# inbox.mbox — 3 messages, 2024–2026');
  });

  it('Thunderbird: expunged messages are skipped; status flips keep the id', async () => {
    const base = {
      subject: 'Flags',
      date: 'Mon, 15 Jan 2024 10:00:00 +0000',
      body: 'x',
    };
    const p1 = write(
      'Inbox',
      msg({
        ...base,
        extra: 'X-Mozilla-Status: 0001\nX-Mozilla-Status2: 00000000\n',
      }),
    );
    const p2 = write(
      'Inbox2',
      msg({
        ...base,
        extra: 'X-Mozilla-Status: 0003\nX-Mozilla-Status2: 10000000\n',
      }),
    );
    const p3 = write(
      'Inbox3',
      msg({ ...base, extra: 'X-Mozilla-Status: 0009\n' }),
    );
    const [a, b, c] = await Promise.all(
      [p1, p2, p3].map((p) => expandMbox(p, null, DEFAULT_EXPAND_BUDGET)),
    );
    expect(a.items[0].key).toBe(b.items[0].key);
    expect(c.items).toHaveLength(0);
  });

  it('an oversized message keeps its head, is marked truncated, and the next one is intact', async () => {
    const huge =
      `From - Mon, 15 Jan 2024 10:00:00 +0000\nFrom: a@x.de\nSubject: Big one\n` +
      `Date: Mon, 15 Jan 2024 10:00:00 +0000\nContent-Type: text/plain\n\nhead text\n${`${'QUJD'.repeat(19)}\n`.repeat(
        150_000,
      )}`; // ~11 MB of base64-looking lines
    const p = write(
      'big.mbox',
      `${huge}\n${msg({
        subject: 'After',
        date: 'Tue, 16 Jan 2024 10:00:00 +0000',
        body: 'ok',
      })}`,
    );
    const r = await expandMbox(p, null, DEFAULT_EXPAND_BUDGET);
    expect(r.items.map((i) => i.title)).toEqual(['Big one', 'After']);
    expect(r.items[0].metadata.truncated).toBe(true);
    expect(r.items[0].markdown).toContain('head text');
    expect(r.items[1].markdown).toContain('ok');
  });

  it('append fast path: a tail resumes with only the new message and the whole-mailbox count', async () => {
    const p = write('inbox.mbox', THREE);
    const first = await expandMbox(p, null, DEFAULT_EXPAND_BUDGET);
    fs.appendFileSync(
      p,
      msg({
        subject: 'Fresh',
        date: 'Thu, 18 Jan 2026 10:00:00 +0000',
        id: 'a4@example.de',
        body: 'new',
      }),
    );
    const r = await expandMbox(
      p,
      first.tail as MboxResume,
      DEFAULT_EXPAND_BUDGET,
    );
    expect(r.items.map((i) => i.title)).toEqual(['Fresh']);
    expect(r.summary).toBe('# inbox.mbox — 4 messages, 2024–2026');
  });

  it('a tail that no longer lands on a message boundary asks for a restart', async () => {
    const p = write('inbox.mbox', THREE);
    const first = await expandMbox(p, null, DEFAULT_EXPAND_BUDGET);
    fs.writeFileSync(p, `X${THREE}${THREE}`); // rewritten, bigger, shifted
    const r = await expandMbox(
      p,
      first.tail as MboxResume,
      DEFAULT_EXPAND_BUDGET,
    );
    expect(r).toEqual({ items: [], resume: null, restart: true });
  });
});
