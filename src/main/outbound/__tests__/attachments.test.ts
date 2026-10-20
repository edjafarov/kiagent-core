/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ATTACHMENTS_MAX_BYTES,
  checkAttachments,
  createAttachments,
} from '../attachments';

describe('attachments', () => {
  let home: string;
  let outside: string;
  const docs = {
    fetchBytes: jest.fn(async (id: string) =>
      id === 'doc1'
        ? {
            bytes: new Uint8Array([1, 2, 3]),
            filename: 'Vertrag.pdf',
            mime: 'application/pdf',
          }
        : null,
    ),
  };
  const api = () =>
    createAttachments({
      documentBytes: docs,
      home,
      blocked: [path.join(home, 'KIAgent')],
    });
  const local = { transport: 'local' as const };

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kia-home-')));
    outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'kia-out-')),
    );
    fs.mkdirSync(path.join(home, 'Documents'));
    fs.mkdirSync(path.join(home, 'Library'));
    fs.writeFileSync(path.join(home, 'Documents', 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(home, 'Library', 'secret.db'), 'x');
    fs.writeFileSync(path.join(outside, 'other.txt'), 'x');
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('a document gives its name, type, size and bytes', async () => {
    const r = await api().resolve({ document_id: 'doc1' }, local);
    expect(r.attachment).toEqual({
      filename: 'Vertrag.pdf',
      mime: 'application/pdf',
      size: 3,
      from: { kind: 'document', documentId: 'doc1' },
    });
    expect(Buffer.from(r.bytes.contentBase64, 'base64')).toEqual(
      Buffer.from([1, 2, 3]),
    );
  });

  it('a document with no file is refused', async () => {
    await expect(api().resolve({ document_id: 'nope' }, local)).rejects.toThrow(
      /has no file to attach/,
    );
  });

  it('a file in the home folder is attached by path', async () => {
    const p = path.join(home, 'Documents', 'notes.txt');
    const r = await api().resolve({ path: p }, local);
    expect(r.attachment).toEqual({
      filename: 'notes.txt',
      mime: 'text/plain',
      size: 5,
      from: { kind: 'file', path: p },
    });
  });

  it.each([
    ['a relative path', () => 'Documents/notes.txt', /must be absolute/],
    [
      'a dot-segment',
      () => `${home}/Documents/../Documents/notes.txt`,
      /\. or \.\. segments/,
    ],
    ['~/Library', () => path.join(home, 'Library', 'secret.db'), /Library/],
    ['a dotfile', () => path.join(home, '.netrc'), /hidden files/],
    [
      'a dot-folder',
      () => path.join(home, '.ssh', 'id_ed25519'),
      /hidden files/,
    ],
    ['~/AppData', () => path.join(home, 'AppData', 'x.db'), /AppData/],
    [
      'the app data folder',
      () => path.join(home, 'KIAgent', 'kia.db'),
      /app's own data/,
    ],
    ['outside home', () => path.join(outside, 'other.txt'), /home folder/],
    ['a folder', () => path.join(home, 'Documents'), /not a file/],
    ['a missing file', () => path.join(home, 'nope.txt'), /no such file/],
  ])('refuses %s', async (_name, p, why) => {
    await expect(api().resolve({ path: p() }, local)).rejects.toThrow(why);
  });

  it('refuses a symlink in home that points outside it', async () => {
    const link = path.join(home, 'Documents', 'link.txt');
    fs.symlinkSync(path.join(outside, 'other.txt'), link);
    await expect(api().resolve({ path: link }, local)).rejects.toThrow(
      /home folder/,
    );
  });

  it('the remote transport can never attach by path', async () => {
    await expect(
      api().resolve(
        { path: path.join(home, 'Documents', 'notes.txt') },
        { transport: 'remote' },
      ),
    ).rejects.toThrow(/document_id/);
  });

  it('a file the user picked skips the path rule', async () => {
    const r = await api().resolve(
      { path: path.join(outside, 'other.txt') },
      { transport: 'remote', userPicked: true },
    );
    expect(r.attachment.filename).toBe('other.txt');
  });

  it('refuses a duplicate name and more than 18 MB in total', () => {
    const a = { filename: 'a.pdf', mime: 'x', size: 1 };
    expect(() => checkAttachments([a, a])).toThrow(/already on this draft/);
    expect(() =>
      checkAttachments([
        { ...a, size: ATTACHMENTS_MAX_BYTES },
        { filename: 'b', mime: 'x', size: 1 },
      ]),
    ).toThrow(/attachments are 18\.0 MB — the limit is 18\.0 MB/);
  });

  it('a picked file is marked so a later read keeps it', async () => {
    const r = await api().resolve(
      { path: path.join(outside, 'other.txt') },
      { transport: 'local', userPicked: true },
    );
    expect(r.attachment.from).toEqual({
      kind: 'file',
      path: path.join(outside, 'other.txt'),
      picked: true,
    });
    await expect(api().read(r.attachment)).resolves.toMatchObject({
      filename: 'other.txt',
    });
  });

  it('read applies the rule again to what the path points at now', async () => {
    const p = path.join(home, 'Documents', 'notes.txt');
    const { attachment } = await api().resolve({ path: p }, local);
    fs.rmSync(p);
    fs.symlinkSync(path.join(outside, 'other.txt'), p);
    await expect(api().read(attachment)).rejects.toThrow(
      /can no longer be attached \(~\/Documents\/notes.txt\): only files inside your home folder/,
    );
  });

  it('read names a file that has gone missing', async () => {
    const p = path.join(home, 'Documents', 'notes.txt');
    const { attachment } = await api().resolve({ path: p }, local);
    fs.rmSync(p);
    await expect(api().read(attachment)).rejects.toThrow(
      'attachment "notes.txt" is no longer available (~/Documents/notes.txt)',
    );
  });
});
