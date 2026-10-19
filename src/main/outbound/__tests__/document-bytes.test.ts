/** @jest-environment node */
import { createDocumentBytes, DOCUMENT_BYTES_MAX } from '../document-bytes';

const doc = (over: Record<string, unknown> = {}) =>
  ({
    id: 'd1',
    accountId: 'a1',
    title: 'Vertrag.docx',
    metadata: {},
    archivedAt: null,
    ...over,
  }) as never;

function setup(
  o: { document?: unknown; bytes?: Uint8Array | null; noFetch?: boolean } = {},
) {
  const fetchBytes = jest.fn(async () =>
    o.bytes === undefined ? new Uint8Array([7]) : o.bytes,
  );
  const api = createDocumentBytes({
    document: async (id) =>
      id === 'd1' ? ((o.document ?? doc()) as never) : null,
    account: async () => ({ id: 'a1', source: 'gmail' }) as never,
    sources: { get: () => (o.noFetch ? {} : { fetchBytes }) as never },
    session: () => ({}) as never,
  });
  return { api, fetchBytes };
}

test('returns original bytes via the doc source fetchBytes', async () => {
  const { api, fetchBytes } = setup({
    document: doc({
      metadata: { filename: 'MG Vertrag.docx', mime: 'application/x-test' },
    }),
  });
  expect(await api.fetchBytes('d1')).toEqual({
    bytes: new Uint8Array([7]),
    filename: 'MG Vertrag.docx',
    mime: 'application/x-test',
  });
  expect(fetchBytes).toHaveBeenCalled();
});

test('falls back to the title and an extension mime', async () => {
  const { api } = setup();
  expect(await api.fetchBytes('d1')).toMatchObject({
    filename: 'Vertrag.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
});

test('null for unknown, archived or byte-less docs', async () => {
  expect(await setup().api.fetchBytes('nope')).toBeNull();
  expect(
    await setup({ document: doc({ archivedAt: 'x' }) }).api.fetchBytes('d1'),
  ).toBeNull();
  expect(await setup({ bytes: null }).api.fetchBytes('d1')).toBeNull();
  expect(await setup({ noFetch: true }).api.fetchBytes('d1')).toBeNull();
});

test('throws over 50 MB', async () => {
  const big = new Uint8Array(DOCUMENT_BYTES_MAX + 1);
  await expect(setup({ bytes: big }).api.fetchBytes('d1')).rejects.toThrow(
    'too large',
  );
});

test('rejects non-byte source output', async () => {
  const { api } = setup({
    bytes: new ArrayBuffer(DOCUMENT_BYTES_MAX + 1) as never,
  });
  await expect(api.fetchBytes('d1')).rejects.toThrow('no bytes');
});

test('refuses before downloading when the recorded size is over the cap', async () => {
  const { api, fetchBytes } = setup({
    document: doc({ metadata: { size: DOCUMENT_BYTES_MAX + 1 } }),
  });
  await expect(api.fetchBytes('d1')).rejects.toThrow('too large');
  expect(fetchBytes).not.toHaveBeenCalled();
});
