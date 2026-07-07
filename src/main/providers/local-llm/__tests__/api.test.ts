import { describeImage } from '../api';

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
      json: async () => ({ choices: [{ message: { content: 'a description' } }] }),
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
