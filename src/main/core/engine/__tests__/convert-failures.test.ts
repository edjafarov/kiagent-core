/** @jest-environment node */
import type { Document, DocumentInput } from '@shared/contracts';

import {
  ConverterCrashedError,
  ConverterTimeoutError,
  ConverterUnavailableError,
} from '../../converter/converter';
import { abortError } from '../../abort';
import { isConvertCandidate } from '../../../workers/convert/convert-worker';
import { pdfReadyForOcr } from '../../../workers/convert/outcome';
import { createConverter } from '../convert';

const input: DocumentInput = {
  externalId: 'f',
  type: 'file',
  title: 'a.pdf',
  markdown: null,
  metadata: { mime: 'application/pdf', filename: 'a.pdf' },
  createdAt: null,
  binary: {
    bytes: new Uint8Array([1, 2, 3]),
    mime: 'application/pdf',
    filename: 'a.pdf',
  },
};
const throwing = (err: Error) => ({
  parseDetailed: async () => {
    throw err;
  },
});

it('a converter crash commits a deterministic failed/crash marker and no bytes', async () => {
  const convert = createConverter(
    { log: () => {} },
    throwing(new ConverterCrashedError('x')),
  );
  const a = await convert(input);
  const b = await convert(input);
  expect(a).toEqual(b); // deterministic: contentHash covers metadata
  expect('binary' in a).toBe(false);
  expect(a.markdown).toBeNull();
  expect(a.metadata).toEqual({
    mime: 'application/pdf',
    filename: 'a.pdf',
    conversion: { status: 'failed', reason: 'crash' },
  });
  // The convert worker never re-admits it; a PDF still goes to OCR.
  const asDoc = {
    ...a,
    id: 'd',
    accountId: 'acc',
    archivedAt: null,
  } as unknown as Document;
  expect(isConvertCandidate(asDoc)).toBe(false);
  expect(pdfReadyForOcr(a.metadata.conversion)).toBe(true);
});

it.each([
  ['timeout', new ConverterTimeoutError('x')],
  ['unavailable', new ConverterUnavailableError('x')],
])(
  'a converter %s commits no marker (the convert worker retries later)',
  async (_n, err) => {
    const out = await createConverter({ log: () => {} }, throwing(err))(input);
    expect('binary' in out).toBe(false);
    expect(
      (out.metadata as { conversion?: unknown }).conversion,
    ).toBeUndefined();
  },
);

it('an abort propagates (the pull loop is stopping; nothing commits)', async () => {
  await expect(
    createConverter({ log: () => {} }, throwing(abortError()))(input),
  ).rejects.toHaveProperty('name', 'AbortError');
});

it('passes the caller’s signal to the converter', async () => {
  const seen: Array<AbortSignal | undefined> = [];
  const ac = new AbortController();
  await createConverter(
    { log: () => {} },
    {
      parseDetailed: async (_b, _m, _f, signal) => {
        seen.push(signal);
        return { markdown: 'text body long enough' };
      },
    },
  )(input, ac.signal);
  expect(seen).toEqual([ac.signal]);
});
