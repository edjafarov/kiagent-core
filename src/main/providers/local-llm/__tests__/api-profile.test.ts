import { chatText, DETERMINISTIC_MAX_TOKENS } from '../api';

// Issue #107 task 4: the deterministic decoding profile, a `system` message,
// and usage/finish-reason mapping — all resolved INSIDE chatText, never by a
// caller assembling a request body itself.
describe('chatText profiles', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function mockFetch(json: Record<string, unknown>): jest.Mock {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => json,
    })) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function requestBody(fetchMock: jest.Mock): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[0];
    return JSON.parse((init as { body: string }).body);
  }

  it('sends the exact deterministic body', async () => {
    const fetchMock = mockFetch({
      choices: [{ message: { content: 'A' }, finish_reason: 'stop' }],
    });
    await chatText('http://x', 'p', {
      maxTokens: 64,
      profile: 'deterministic',
      system: 'S',
    });
    const body = requestBody(fetchMock);
    // toEqual, not toMatchObject: "exact body" has to mean exact. A stray
    // `stop: [...]` is precisely what #107 forbids, and toMatchObject would
    // let one through.
    expect(body).toEqual({
      temperature: 0,
      top_k: 1,
      top_p: 1,
      seed: 0,
      n: 1,
      max_tokens: 64,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'S' }] },
        { role: 'user', content: [{ type: 'text', text: 'p' }] },
      ],
    });
  });

  it('refuses a deterministic request over the ceiling before calling out', async () => {
    const fetchMock = mockFetch({});
    await expect(
      chatText('http://x', 'p', { maxTokens: 513, profile: 'deterministic' }),
    ).rejects.toThrow(/maxTokens/);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('refuses a deterministic request with no maxTokens before calling out', async () => {
    const fetchMock = mockFetch({});
    await expect(
      chatText('http://x', 'p', { profile: 'deterministic' }),
    ).rejects.toThrow(/maxTokens/);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('leaves the default profile unchanged — exact body, no opts', async () => {
    const fetchMock = mockFetch({
      choices: [{ message: { content: 'A' }, finish_reason: 'stop' }],
    });
    await chatText('http://x', 'p');
    expect(requestBody(fetchMock)).toEqual({
      temperature: 0.1,
      max_tokens: 1500,
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'p' }] }],
    });
  });

  it('threads a system message under the default profile too', async () => {
    const fetchMock = mockFetch({
      choices: [{ message: { content: 'A' }, finish_reason: 'stop' }],
    });
    await chatText('http://x', 'p', { system: 'S' });
    expect(requestBody(fetchMock).messages).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'S' }] },
      { role: 'user', content: [{ type: 'text', text: 'p' }] },
    ]);
  });

  it('maps usage and a length finish to truncated', async () => {
    mockFetch({
      choices: [{ message: { content: 'A' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    });
    await expect(chatText('http://x', 'p', { maxTokens: 8 })).resolves.toEqual({
      text: 'A',
      promptTokens: 11,
      completionTokens: 3,
      truncated: true,
    });
  });

  it('maps a stop finish to truncated:false and missing usage to nulls', async () => {
    mockFetch({
      choices: [{ message: { content: 'A' }, finish_reason: 'stop' }],
    });
    await expect(chatText('http://x', 'p')).resolves.toEqual({
      text: 'A',
      promptTokens: null,
      completionTokens: null,
      truncated: false,
    });
  });

  it('exposes the deterministic ceiling as a named constant', () => {
    expect(DETERMINISTIC_MAX_TOKENS).toBe(512);
  });

  it('constrains the reply to a schema with response_format json_schema', async () => {
    const fetchMock = mockFetch({
      choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }],
    });
    const schema = { type: 'object', properties: { a: { type: 'integer' } } };
    await chatText('http://x', 'p', { schema });
    expect(requestBody(fetchMock).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'out', schema },
    });
  });

  it('sends no response_format without a schema', async () => {
    const fetchMock = mockFetch({
      choices: [{ message: { content: 'A' }, finish_reason: 'stop' }],
    });
    await chatText('http://x', 'p');
    expect(requestBody(fetchMock)).not.toHaveProperty('response_format');
  });

  function mockError(status: number, json: unknown): void {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status,
      json: async () => json,
    })) as unknown as typeof fetch;
  }

  it('maps a request larger than the context to ContextOverflowError', async () => {
    mockError(400, {
      error: {
        code: 400,
        type: 'exceed_context_size_error',
        message:
          'request (30000 tokens) exceeds the available context size (24576 tokens)',
      },
    });
    await expect(chatText('http://x', 'p')).rejects.toMatchObject({
      name: 'ContextOverflowError',
    });
  });

  it('maps an exhausted shared KV cache to ContextOverflowError', async () => {
    mockError(500, {
      error: {
        code: 500,
        type: 'server_error',
        message: 'Context size has been exceeded.',
      },
    });
    await expect(chatText('http://x', 'p')).rejects.toMatchObject({
      name: 'ContextOverflowError',
    });
  });

  it("keeps any other failure a plain error, with the server's message", async () => {
    mockError(500, { error: { type: 'server_error', message: 'boom' } });
    const err = await chatText('http://x', 'p').catch((e: Error) => e);
    expect((err as Error).name).toBe('Error');
    expect((err as Error).message).toBe('chat request failed: HTTP 500 (boom)');
  });

  it('survives an error body that is not JSON', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('not json');
      },
    })) as unknown as typeof fetch;
    await expect(chatText('http://x', 'p')).rejects.toThrow(
      'chat request failed: HTTP 502',
    );
  });
});
