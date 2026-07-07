import type { Document } from '@shared/contracts';
import { classifyDocument } from '../classify';

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
