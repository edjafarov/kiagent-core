/**
 * @jest-environment node
 *
 * mailparser needs Node's `setImmediate`, which the default jsdom environment
 * does not provide. The converter only ever runs in the main process, so the
 * node environment is also the truthful one here.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  convertibleKind,
  createConverter,
  MAX_MARKDOWN_CHARS,
} from '../convert';

const logs = { log: jest.fn() };

function input(filename: string, mime: string, body: string) {
  return {
    externalId: filename,
    type: 'file',
    title: filename,
    markdown: null,
    binary: { bytes: new TextEncoder().encode(body), mime, filename },
    metadata: {},
  } as never;
}

const EML = [
  'From: Ada Lovelace <ada@example.com>',
  'To: Charles Babbage <charles@example.com>',
  'Subject: Notes on the Analytical Engine',
  'Date: Tue, 12 Aug 1843 09:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'The engine weaves algebraic patterns just as the Jacquard loom =',
  'weaves flowers and leaves.',
  '',
].join('\r\n');

describe('converter: email formats', () => {
  const convert = createConverter(logs as never);

  it('extracts headers and a decoded body from an .eml', async () => {
    const out = await convert(input('note.eml', 'message/rfc822', EML));
    expect(out.markdown).toContain('Notes on the Analytical Engine');
    expect(out.markdown).toContain('ada@example.com');
    expect(out.markdown).toContain('charles@example.com');
    // quoted-printable soft line break must be decoded, not indexed raw
    expect(out.markdown).toContain('Jacquard loom weaves flowers');
    expect(out.markdown).not.toContain('=\r\n');
    expect(out.binary).toBeUndefined();
  });

  it('does not index base64 attachment blobs as body text', async () => {
    const blob = Buffer.from('x'.repeat(4096)).toString('base64');
    const withAttachment = [
      'From: a@example.com',
      'Subject: Invoice',
      'Content-Type: multipart/mixed; boundary=BOUND',
      '',
      '--BOUND',
      'Content-Type: text/plain',
      '',
      'Invoice attached.',
      '--BOUND',
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      blob,
      '--BOUND--',
      '',
    ].join('\r\n');

    const out = await convert(
      input('inv.eml', 'message/rfc822', withAttachment),
    );
    expect(out.markdown).toContain('Invoice attached.');
    expect(out.markdown).not.toContain(blob.slice(0, 64));
    // the attachment is still worth knowing about, by name
    expect(out.markdown).toContain('invoice.pdf');
  });

  it("reads Apple Mail's .emlx byte-count prefix and plist trailer", async () => {
    const body = Buffer.from(EML, 'utf8');
    const emlx = `${body.length}\n${EML}<?xml version="1.0"?><plist><dict/></plist>`;
    const out = await convert(input('m.emlx', 'message/rfc822', emlx));
    expect(out.markdown).toContain('Notes on the Analytical Engine');
    expect(out.markdown).not.toContain('plist');
  });

  it('splits an mbox into its messages', async () => {
    const mbox = [
      'From ada@example.com Tue Aug 12 09:00:00 1843',
      'From: ada@example.com',
      'Subject: First',
      '',
      'One.',
      '',
      'From charles@example.com Tue Aug 12 10:00:00 1843',
      'From: charles@example.com',
      'Subject: Second',
      '',
      'Two.',
      '',
    ].join('\n');
    const out = await convert(input('a.mbox', 'application/mbox', mbox));
    expect(out.markdown).toContain('First');
    expect(out.markdown).toContain('Second');
    expect(out.markdown).toContain('One.');
    expect(out.markdown).toContain('Two.');
  });

  it('leaves a malformed message to the caller rather than throwing', async () => {
    const out = await convert(input('bad.eml', 'message/rfc822', ''));
    expect(out.binary).toBeUndefined();
  });
});

describe('converter: output cap', () => {
  const convert = createConverter(logs as never);

  it('the eager commit path applies the same 2 MiB output cap', async () => {
    const big = 'word '.repeat(600_000);
    const out = await convert(input('big.txt', 'text/plain', big));
    expect(out.markdown!.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHARS + 20);
    expect(out.markdown!.endsWith('[truncated]')).toBe(true);
  });
});

const FIX = path.join(__dirname, 'fixtures', 'msg');
const msg = (name: string) =>
  ({
    externalId: name,
    type: 'file',
    title: name,
    markdown: null,
    binary: {
      bytes: new Uint8Array(fs.readFileSync(path.join(FIX, name))),
      mime: 'application/vnd.ms-outlook',
      filename: name,
    },
    metadata: {},
  }) as never;

describe('converter: Outlook .msg', () => {
  const convert = createConverter(logs as never);

  it('routes .msg to the email kind by MIME or by extension alone', () => {
    expect(convertibleKind('application/vnd.ms-outlook', 'a.msg')).toBe(
      'email',
    );
    expect(convertibleKind('application/octet-stream', 'A.MSG')).toBe('email');
    expect(convertibleKind(null, 'a.msg')).toBe('email');
  });

  it('renders the same layout as .eml: subject heading, From, To, Date, body', async () => {
    const md = (await convert(msg('attachments.msg'))).markdown!;
    expect(md.startsWith('# attachmentFiles')).toBe(true);
    expect(md).toContain('**From:** hmailuser <hmailuser@hmailserver.test>');
    expect(md).toContain('**To:** hmailuser@hmailserver.test');
    expect(md).toMatch(/\*\*Date:\*\* 2023-11-01T00:48:31/);
    expect(md).toContain('**Attachments:** jpg.jpg, png.png, tif.tif');
  });

  it('lists To and Cc, never Bcc', async () => {
    const md = (await convert(msg('to-cc-bcc.msg'))).markdown!;
    expect(md).toContain('**To:** ToUser <to@example.com>');
    expect(md).toContain('**Cc:** ToCc <cc@example.com>');
    expect(md).not.toContain('bcc@example.com');
    expect(md).toContain('Message');
  });

  it('falls back to the HTML bytes when the plain body is empty (new Outlook)', async () => {
    const md = (await convert(msg('html-only.msg'))).markdown!;
    expect(md).toContain('# Microsoft Outlook テスト メッセージ');
    expect(md).toContain('この電子メール メッセージは');
    expect(md).not.toContain('<meta');
  });

  it('keeps Unicode and ANSI bodies intact', async () => {
    const cjk = (await convert(msg('unicode-cjk.msg'))).markdown!;
    expect(cjk).toContain('你好');
    expect(cjk).toContain('안녕하세요');
    expect((await convert(msg('ansi.msg'))).markdown).toContain(
      'Non Unicode mail body!',
    );
  });

  it('names an embedded-message attachment by its name and never prints undefined', async () => {
    const md = (await convert(msg('msg-in-msg.msg'))).markdown!;
    expect(md).toContain(
      '**Attachments:** Microsoft Outlook テスト メッセージ, green.png',
    );
    expect(md).not.toContain('undefined');
  });

  it('shows the display name, not an Exchange X.500 DN, for an EX sender', async () => {
    const md = (await convert(msg('sent2.msg'))).markdown!;
    expect(md).toContain('**From:** UnoKenji');
    expect(md).not.toContain('/O=EXCHANGELABS');
  });

  it('an extensionless attachment with the Outlook MIME is parsed by msgreader, not mailparser', async () => {
    const m = msg('plain.msg') as any;
    const out = await convert({
      ...m,
      title: 'attachment',
      binary: { ...m.binary, filename: 'attachment' },
    } as never);
    expect(out.markdown!.startsWith('# Simple')).toBe(true);
  });

  it('a file that is not a real .msg leaves markdown null (convert worker records failed)', async () => {
    const bad = {
      ...(msg('plain.msg') as any),
      binary: {
        bytes: new Uint8Array(64),
        mime: 'application/vnd.ms-outlook',
        filename: 'bad.msg',
      },
    };
    const out = await convert(bad as never);
    expect(out.markdown ?? null).toBeNull();
    expect(out.binary).toBeUndefined();
  });

  it('.eml output is unchanged apart from the new Cc line', async () => {
    const parts = (
      await convert(input('note.eml', 'message/rfc822', EML))
    ).markdown!.split('\n\n');
    expect(parts[0]).toBe('# Notes on the Analytical Engine');
    // mailparser 3.9 quotes display names ("Ada Lovelace"); pin layout + order, not its quoting
    expect(parts[1]).toMatch(
      /^\*\*From:\*\* "?Ada Lovelace"? <ada@example\.com>$/,
    );
    expect(parts[2]).toMatch(
      /^\*\*To:\*\* "?Charles Babbage"? <charles@example\.com>$/,
    );
    expect(parts[3]).toBe('**Date:** 1843-08-12T09:00:00.000Z');
  });
});
