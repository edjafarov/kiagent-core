import { embedTexts } from '../api';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});
const respond = (status: number, body: unknown) => {
  global.fetch = jest.fn(
    async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }),
  ) as any;
};

describe('embedTexts', () => {
  it('posts input[] and returns vectors in input order', async () => {
    respond(200, {
      data: [
        { index: 1, embedding: [3, 4] },
        { index: 0, embedding: [1, 2] },
      ],
    });
    const v = await embedTexts('http://h', ['a', 'b']);
    expect(v.map((x) => Array.from(x))).toEqual([
      [1, 2],
      [3, 4],
    ]);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://h/v1/embeddings');
    expect(JSON.parse(init.body)).toEqual({ input: ['a', 'b'] });
  });

  it('an oversize input becomes ContextOverflowError', async () => {
    respond(500, {
      error: {
        message:
          'input (3000 tokens) is too large to process. increase the physical batch size',
      },
    });
    await expect(embedTexts('http://h', ['x'])).rejects.toMatchObject({
      name: 'ContextOverflowError',
    });
  });

  it('other failures are plain errors', async () => {
    respond(503, {});
    await expect(embedTexts('http://h', ['x'])).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringContaining('HTTP 503'),
    });
  });
});
