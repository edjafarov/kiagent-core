/** @jest-environment node */
import { createNetworkService } from '../network-service';
import { createNetFetch, type LookupFn } from '../net-guard';

const lookup: LookupFn = async () => ['93.184.216.34'];

function response(status: number, body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { status, statusText: 'OK' });
}

describe('createNetworkService', () => {
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
