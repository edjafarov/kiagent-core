import type { Document } from '@shared/contracts';
import { classifyDocument, isVlmDecodable } from '../classify';

const base = {
  id: 'd',
  accountId: 'a',
  externalId: 'x',
  type: 'attachment',
  title: 'scan.pdf',
  markdown: null,
  metadata: { mime: 'application/pdf', sizeBytes: 50_000 },
  createdAt: null,
  parentId: null,
  contentHash: 'h',
  seq: 1,
  archivedAt: null,
  languages: [],
  ingestedAt: '2026-01-01',
  updatedAt: '2026-01-01',
} as Document;

it.each([
  ['pdf attachment, no markdown', base, 'candidate'],
  [
    'already enriched',
    { ...base, metadata: { ...base.metadata, extraction: {} } },
    'skip',
  ],
  [
    'has real markdown',
    { ...base, markdown: 'plenty of extracted text here' },
    'skip',
  ],
  [
    'thin markdown still candidate',
    { ...base, markdown: 'short' },
    'candidate',
  ],
  ['archived', { ...base, archivedAt: '2026-01-01' }, 'skip'],
  ['wrong type', { ...base, type: 'email.thread' }, 'skip'],
  [
    'tiny image',
    { ...base, metadata: { mime: 'image/png', sizeBytes: 500 } },
    'skip',
  ],
  [
    'tiny local-folder image (legacy `size` key, no sizeBytes)',
    {
      ...base,
      type: 'file',
      title: 'icon.png',
      metadata: { ext: 'png', size: 500, absPath: '/x/icon.png' },
    },
    'skip',
  ],
  [
    'local-folder image with only ext metadata',
    {
      ...base,
      type: 'file',
      title: 'photo.jpg',
      metadata: { ext: 'jpg', size: 90_000, absPath: '/x/photo.jpg' },
    },
    'candidate',
  ],
  [
    'image by extension',
    {
      ...base,
      title: 'photo.HEIC',
      metadata: { filename: 'photo.HEIC', sizeBytes: 90_000 },
    },
    'candidate',
  ],
  [
    'non-visual mime',
    { ...base, metadata: { mime: 'application/zip', filename: 'a.zip' } },
    'skip',
  ],
])('%s → %s', (_n, doc, want) =>
  expect(classifyDocument(doc as Document)).toBe(want),
);

describe('non-string metadata (connector-supplied JSON) never throws', () => {
  // A throw out of matches() stops the vision feed loop permanently and
  // re-poisons it on every restart — non-string values classify as absent.
  it('non-string mime is treated as absent by classifyDocument', () => {
    expect(
      classifyDocument({
        ...base,
        title: 'photo.png',
        metadata: { mime: 42, sizeBytes: 90_000 },
      } as Document),
    ).toBe('candidate'); // extension fallback still classifies it
    expect(
      classifyDocument({
        ...base,
        title: 'notes.txt',
        metadata: { mime: 42 },
      } as Document),
    ).toBe('skip');
  });
  it('non-string mime is treated as absent by isVlmDecodable', () => {
    expect(
      isVlmDecodable({
        ...base,
        title: 'photo.webp',
        metadata: { mime: 42 },
      } as Document),
    ).toBe(false); // filename fallback: webp is VLM-undecodable
    expect(
      isVlmDecodable({
        ...base,
        title: 'photo.png',
        metadata: { mime: 42 },
      } as Document),
    ).toBe(true);
  });
});
