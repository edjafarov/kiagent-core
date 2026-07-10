import { describeImage, transcribeAudio } from '../api';

// Finding 5a: the source mime must be threaded into the VLM request's data
// URL rather than hardcoded to image/png — otherwise the contract's `mime`
// field is silently dropped once it reaches the provider.
describe('describeImage mime threading', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function stubFetch(): jest.Mock {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'a description' } }],
      }),
    })) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function dataUrlFrom(fetchMock: jest.Mock): string {
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body);
    return body.messages[0].content[1].image_url.url as string;
  }

  it('labels the data URL with the provided mime', async () => {
    const fetchMock = stubFetch();
    await describeImage('http://x', new Uint8Array([1, 2, 3]), 'describe', {
      mime: 'image/jpeg',
    });
    expect(dataUrlFrom(fetchMock)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('falls back to image/png when mime is absent (rasterized PDF pages)', async () => {
    const fetchMock = stubFetch();
    await describeImage('http://x', new Uint8Array([1, 2, 3]), 'describe');
    expect(dataUrlFrom(fetchMock)).toMatch(/^data:image\/png;base64,/);
  });
});

describe('transcribeAudio', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function stubFetch(content: string | null): jest.Mock {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    })) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('sends an input_audio content part with the base64 data and format', async () => {
    const fetchMock = stubFetch('hello world');
    const out = await transcribeAudio(
      'http://x',
      new Uint8Array([1, 2, 3]),
      'wav',
    );
    expect(out).toBe('hello world');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const part = body.messages[0].content.find(
      (c: { type: string }) => c.type === 'input_audio',
    );
    expect(part.input_audio.format).toBe('wav');
    expect(part.input_audio.data).toBe(
      Buffer.from([1, 2, 3]).toString('base64'),
    );
  });

  it('returns "" on an empty result rather than throwing (silence is legitimate)', async () => {
    stubFetch(null);
    await expect(
      transcribeAudio('http://x', new Uint8Array([1]), 'mp3'),
    ).resolves.toBe('');
  });

  it('attaches the HTTP status on a non-ok response (so the worker can 4xx→skip)', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'exceed_context' } }),
    })) as unknown as typeof fetch;
    const err = await transcribeAudio(
      'http://x',
      new Uint8Array([1]),
      'wav',
    ).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: Error & { status?: number }) => e,
    );
    expect(err.status).toBe(400);
  });
});
