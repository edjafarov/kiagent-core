/** @jest-environment node */
import { createNetworkService } from '../network-service';
import { createNetFetch, readBoundedBody, type LookupFn } from '../net-guard';

const lookup: LookupFn = async () => ['93.184.216.34'];

function response(status: number, body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { status, statusText: 'OK' });
}

describe('createNetworkService', () => {
  it('does not invoke the upstream fetch for a pre-aborted call', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = jest.fn(async () => new Response('late'));
    const service = createNetworkService({
      owner: 'plugin.example',
      log: jest.fn(),
      fetch: createNetFetch({ lookup, fetchImpl: fetchImpl as typeof fetch }),
    });

    await expect(
      service.fetch('https://example.com/pre-aborted', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
    service.dispose();
  });

  it('does not invoke the upstream fetch when the owner is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = jest.fn(async () => new Response('late'));
    const service = createNetworkService({
      owner: 'plugin.example',
      signal: controller.signal,
      log: jest.fn(),
      fetch: createNetFetch({ lookup, fetchImpl: fetchImpl as typeof fetch }),
    });

    await expect(service.fetch('https://example.com/owner-aborted')).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    service.dispose();
  });

  it('settles on timeout when the injected dependency ignores abort forever', async () => {
    const fetchImpl = jest.fn(
      async () => await new Promise<never>(() => {}),
    );
    const service = createNetworkService({
      owner: 'plugin.example',
      log: jest.fn(),
      fetch: fetchImpl,
    });

    await expect(service.fetch('https://example.com/uncancellable', { timeoutMs: 10 })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    service.dispose();
  });

  it('settles on dispose when an injected dependency ignores abort forever', async () => {
    const fetchImpl = jest.fn(
      async () => await new Promise<never>(() => {}),
    );
    const service = createNetworkService({
      owner: 'plugin.example',
      log: jest.fn(),
      fetch: fetchImpl,
    });
    const pending = service.fetch('https://example.com/disposed');
    service.dispose();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('ignores a late injected result after cancellation', async () => {
    let resolveFetch!: (result: {
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: Uint8Array;
    }) => void;
    const fetchImpl = jest.fn(
      async () => await new Promise<{
        status: number;
        statusText: string;
        headers: Record<string, string>;
        body: Uint8Array;
      }>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const service = createNetworkService({ owner: 'plugin.example', log: jest.fn(), fetch: fetchImpl });
    const pending = service.fetch('https://example.com/late');
    service.dispose();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    resolveFetch({ status: 200, statusText: 'OK', headers: {}, body: new Uint8Array() });
    await Promise.resolve();
    service.dispose();
  });

  it.each([0, -1, 0.5, 120000.5, Infinity, NaN])(
    'rejects invalid timeout %s before invoking upstream fetch',
    async (timeoutMs) => {
      const fetchImpl = jest.fn(async () => new Response('late'));
      const service = createNetworkService({
        owner: 'plugin.example',
        log: jest.fn(),
        fetch: createNetFetch({ lookup, fetchImpl: fetchImpl as typeof fetch }),
      });
      await expect(service.fetch('https://example.com/invalid', { timeoutMs })).rejects.toThrow(
        /timeoutMs/,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      service.dispose();
    },
  );

  it('aborts a pending fetch when its total deadline expires', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const pendingFetch = jest.fn(async (_url: string, init: RequestInit) => {
      upstreamSignal = init.signal ?? undefined;
      return await new Promise<Response>(() => {});
    });
    const service = createNetworkService({
      owner: 'plugin.example',
      log: jest.fn(),
      fetch: createNetFetch({
        lookup,
        fetchImpl: pendingFetch as typeof fetch,
      }),
    });

    await expect(
      service.fetch('https://example.com/pending', { timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(upstreamSignal?.aborted).toBe(true);
    service.dispose();
  });

  it('cancels a DNS wait and never starts fetch after caller cancellation', async () => {
    let resolveDns!: (addresses: string[]) => void;
    const dns = new Promise<string[]>((resolve) => {
      resolveDns = resolve;
    });
    const fetchImpl = jest.fn(async () => new Response('late'));
    const service = createNetworkService({
      owner: 'plugin.example',
      log: jest.fn(),
      fetch: createNetFetch({
        lookup: async () => dns,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    });
    const controller = new AbortController();
    const pending = service.fetch('https://example.com/dns', {
      signal: controller.signal,
    });

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    resolveDns(['93.184.216.34']);
    await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
    service.dispose();
  });

  it('aborts a response body reader when cancelled', async () => {
    let reading = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        reading = true;
        return new Promise<void>(() => {});
      },
      cancel() {},
    });
    const service = createNetworkService({
      owner: 'plugin.example',
      log: jest.fn(),
      fetch: createNetFetch({
        lookup,
        fetchImpl: (async () => {
          return response(200, body);
        }) as typeof fetch,
      }),
    });
    const controller = new AbortController();
    const pending = service.fetch('https://example.com/redirect', {
      signal: controller.signal,
    });
    for (let i = 0; i < 10 && !reading; i += 1) await Promise.resolve();
    expect(reading).toBe(true);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    service.dispose();
  });

  it('cancels and releases a stalled body reader on abort', async () => {
    let cancelCount = 0;
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelCount += 1;
      },
    });
    const pending = readBoundedBody(
      new Response(body),
      1024,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelCount).toBe(1);
    expect(body.locked).toBe(false);
  });

  it('cancels a redirect body when the redirect URL is invalid', async () => {
    let cancelCount = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCount += 1;
      },
    });
    const service = createNetworkService({
      owner: 'plugin.example',
      log: jest.fn(),
      fetch: createNetFetch({
        lookup,
        fetchImpl: (async () =>
          new Response(body, { status: 302, headers: { location: '::::' } })) as typeof fetch,
      }),
    });

    await expect(service.fetch('https://example.com/redirect')).rejects.toThrow();
    expect(cancelCount).toBe(1);
    service.dispose();
  });

  it('logs only safe operation diagnostics', async () => {
    const log = jest.fn();
    const service = createNetworkService({
      owner: 'plugin.example',
      log,
      fetch: createNetFetch({
        lookup,
        fetchImpl: (async () => new Response('body')) as typeof fetch,
      }),
    });
    await service.fetch('https://example.com/path?token=secret', {
      headers: { authorization: 'Bearer secret' },
      body: 'secret-body',
    });
    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).not.toContain('example.com/path');
    expect(serialized).not.toContain('secret');
    expect(serialized).toContain('plugin.example');
    expect(serialized).toContain('bytes');
    service.dispose();
  });
});
