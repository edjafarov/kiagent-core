/**
 * @jest-environment node
 *
 * mailparser needs Node's `setImmediate`, which the default jsdom environment
 * does not provide. The converter only ever runs in the main process, so the
 * node environment is also the truthful one here.
 */
import { createConverter } from '../convert';

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
