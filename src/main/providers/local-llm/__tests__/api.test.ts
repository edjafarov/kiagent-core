import { chatText, describeImage } from '../api';

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

// Thinking-enabled chat templates (gemma's peg-gemma4 with thinking=1) spend
// the whole max_tokens budget on reasoning_content before any visible
// content: a real 154-row meeting-summary call burned all 512 tokens
// thinking and threw 'chat returned empty content' (2026-08-17). Both entry
// points must pin thinking OFF per request — verified against the vendored
// llama-server that chat_template_kwargs.enable_thinking=false yields zero
// reasoning tokens (reasoning_effort / reasoning_budget do NOT work).
describe('thinking disabled on every request', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function stubFetch(): jest.Mock {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'text' } }],
      }),
    })) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function requestBody(fetchMock: jest.Mock): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[0];
    return JSON.parse((init as { body: string }).body);
  }

  it('chatText sends chat_template_kwargs.enable_thinking=false', async () => {
    const fetchMock = stubFetch();
    await chatText('http://x', 'summarize');
    expect(requestBody(fetchMock).chat_template_kwargs).toEqual({
      enable_thinking: false,
    });
  });

  it('describeImage sends chat_template_kwargs.enable_thinking=false', async () => {
    const fetchMock = stubFetch();
    await describeImage('http://x', new Uint8Array([1]), 'describe');
    expect(requestBody(fetchMock).chat_template_kwargs).toEqual({
      enable_thinking: false,
    });
  });
});
