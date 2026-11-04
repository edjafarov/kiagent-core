/** @jest-environment node */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAX_FETCH_BYTES } from '@shared/file-indexability';
import {
  assertPublicHostname,
  classifyAddress,
  createNetFetch,
  MAX_NET_FETCH_BYTES,
  normalizeAddress,
  NetDestinationError,
  pinnedDispatcher,
  testNetAllow,
  type LookupFn,
} from '../net-guard';
import { scopedTestNetFetch } from '../network-service';

/** Resolves every name to fixed answers; no DNS in these tests. */
function stubLookup(map: Record<string, string[]>): LookupFn {
  return async (hostname) => {
    const hit = map[hostname];
    if (!hit) throw new Error(`no stub for ${hostname}`);
    return hit;
  };
}

function res(
  status: number,
  headers: Record<string, string> = {},
  body = '',
): Response {
  return new Response(status === 204 || status >= 300 ? null : body, {
    status,
    headers,
  });
}

describe('classifyAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['169.254.169.254', 'link-local'],
    ['fe80::1', 'link-local'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['fd00::1', 'private'],
    ['100.64.0.1', 'carrier-grade'],
    ['239.1.1.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
  ])('refuses %s', (ip, fragment) => {
    expect(classifyAddress(ip)).toContain(fragment);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '172.15.0.1', // just below the private /12
    '172.32.0.1', // just above it
    '2606:4700:4700::1111',
  ])('allows the public address %s', (ip) => {
    expect(classifyAddress(ip)).toBeNull();
  });

  it('refuses anything it cannot parse rather than waving it through', () => {
    expect(classifyAddress('not-an-ip')).toBe('not a valid IP address');
  });

  it('collapses IPv4-mapped forms so they are judged as IPv4', () => {
    expect(normalizeAddress('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeAddress('[::ffff:7f00:1]')).toBe('127.0.0.1');
    expect(normalizeAddress('fe80::1')).toBe('fe80::1');
  });
});

describe('assertPublicHostname', () => {
  it('accepts a name resolving only to public addresses', async () => {
    await expect(
      assertPublicHostname(
        'api.example.com',
        stubLookup({ 'api.example.com': ['93.184.216.34'] }),
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a name resolving to loopback', async () => {
    await expect(
      assertPublicHostname(
        'evil.example.com',
        stubLookup({ 'evil.example.com': ['127.0.0.1'] }),
      ),
    ).rejects.toThrow(/resolves to 127\.0\.0\.1.*loopback/s);
  });

  it('refuses when only one of several answers is private — a rebinding attempt is not a partial pass', async () => {
    await expect(
      assertPublicHostname(
        'mixed.example.com',
        stubLookup({ 'mixed.example.com': ['93.184.216.34', '10.0.0.5'] }),
      ),
    ).rejects.toThrow(/10\.0\.0\.5/);
  });

  it('refuses an IP literal without consulting DNS at all', async () => {
    const lookup = jest.fn(async () => ['93.184.216.34']);
    await expect(assertPublicHostname('127.0.0.1', lookup)).rejects.toThrow(
      /loopback/,
    );
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('createNetFetch', () => {
  const publicLookup = stubLookup({
    'api.example.com': ['93.184.216.34'],
    'other.example.com': ['198.41.0.4'],
    'evil.example.com': ['127.0.0.1'],
    'ipv6.example.com': ['2606:4700:4700::1111'],
  });

  it('refuses a loopback URL before issuing any request', async () => {
    const fetchImpl = jest.fn();
    const netFetch = createNetFetch({
      lookup: publicLookup,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(netFetch('http://127.0.0.1:7421/mcp')).rejects.toThrow(
      /loopback/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses non-http(s) schemes', async () => {
    const netFetch = createNetFetch({ lookup: publicLookup });
    await expect(netFetch('file:///etc/passwd')).rejects.toThrow(/http\(s\)/);
  });

  it('restores NetDestinationError for malformed URLs', async () => {
    const netFetch = createNetFetch({ lookup: publicLookup });
    await expect(netFetch('not a URL')).rejects.toBeInstanceOf(
      NetDestinationError,
    );
  });

  it('returns status, headers and bounded bytes on a plain success', async () => {
    const netFetch = createNetFetch({
      lookup: publicLookup,
      fetchImpl: (async () =>
        res(201, { 'x-kia': 'yes' }, 'body!')) as unknown as typeof fetch,
    });
    const out = await netFetch('https://api.example.com/thing');
    expect(out.status).toBe(201);
    expect(out.headers['x-kia']).toBe('yes');
    expect(Buffer.from(out.body).toString()).toBe('body!');
  });

  it('passes the validated address pin to the connection dispatcher', async () => {
    let pinned: string[] | undefined;
    const netFetch = createNetFetch({
      lookup: publicLookup,
      dispatcherFactory: (_hostname, addresses) => {
        pinned = [...addresses];
        return { close: async () => undefined };
      },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        expect(
          (init as RequestInit & { dispatcher?: unknown }).dispatcher,
        ).toBeDefined();
        return res(200, {}, 'pinned');
      }) as unknown as typeof fetch,
    });
    await netFetch('https://api.example.com/pinned');
    expect(pinned).toEqual(['93.184.216.34']);
  });

  it('passes the URL hostname as the actual TLS server name', async () => {
    let dispatcher: unknown;
    const netFetch = createNetFetch({
      lookup: publicLookup,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        dispatcher = (init as RequestInit & { dispatcher?: unknown })
          .dispatcher;
        return res(200, {}, 'ok');
      }) as unknown as typeof fetch,
    });

    await netFetch('https://api.example.com/pinned');
    const optionsSymbol = Object.getOwnPropertySymbols(dispatcher!).find(
      (symbol) => String(symbol) === 'Symbol(options)',
    );
    const options = (dispatcher as Record<symbol, { connect?: unknown }>)[
      optionsSymbol!
    ];
    expect((options.connect as { servername?: string }).servername).toBe(
      'api.example.com',
    );
  });

  it('re-pins every redirect hop, including a validated IPv6 destination', async () => {
    const connections: Array<{ hostname: string; addresses: string[] }> = [];
    const seen: string[] = [];
    const netFetch = createNetFetch({
      lookup: publicLookup,
      dispatcherFactory: (hostname, addresses) => {
        connections.push({ hostname, addresses });
        return { close: async () => undefined };
      },
      fetchImpl: (async (url: string) => {
        seen.push(url);
        return seen.length === 1
          ? res(302, { location: 'https://ipv6.example.com/next' })
          : res(200, {}, 'landed');
      }) as unknown as typeof fetch,
    });

    await expect(
      netFetch('https://api.example.com/start'),
    ).resolves.toMatchObject({
      status: 200,
    });
    expect(connections).toEqual([
      { hostname: 'api.example.com', addresses: ['93.184.216.34'] },
      { hostname: 'ipv6.example.com', addresses: ['2606:4700:4700::1111'] },
    ]);
  });

  it('destroys the dispatcher when the response body read fails', async () => {
    const close = jest.fn(async () => undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('body failed'));
      },
    });
    const netFetch = createNetFetch({
      lookup: publicLookup,
      dispatcherFactory: () => ({ close }),
      fetchImpl: (async () =>
        new Response(body, { status: 200 })) as unknown as typeof fetch,
    });

    await expect(netFetch('https://api.example.com/body')).rejects.toThrow(
      'body failed',
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect to another public host', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return seen.length === 1
        ? res(302, { location: 'https://other.example.com/next' })
        : res(200, {}, 'landed');
    }) as unknown as typeof fetch;
    const netFetch = createNetFetch({ lookup: publicLookup, fetchImpl });
    const out = await netFetch('https://api.example.com/start');
    expect(Buffer.from(out.body).toString()).toBe('landed');
    expect(seen).toEqual([
      'https://api.example.com/start',
      'https://other.example.com/next',
    ]);
  });

  it('re-validates each hop, so a public URL cannot redirect into loopback', async () => {
    const fetchImpl = jest.fn(
      async () =>
        res(302, { location: 'http://127.0.0.1:7421/mcp' }) as Response,
    );
    const netFetch = createNetFetch({
      lookup: publicLookup,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(netFetch('https://api.example.com/start')).rejects.toThrow(
      /loopback/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('strips credentials when a redirect crosses origins', async () => {
    const sent: Array<Record<string, string>> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ ...(init.headers as Record<string, string>) });
      return url.includes('other')
        ? res(200, {}, 'ok')
        : res(302, { location: 'https://other.example.com/next' });
    }) as unknown as typeof fetch;
    const netFetch = createNetFetch({ lookup: publicLookup, fetchImpl });
    await netFetch('https://api.example.com/start', {
      headers: { authorization: 'Bearer secret', 'x-keep': 'yes' },
    });
    expect(sent[0].authorization).toBe('Bearer secret');
    expect(sent[1].authorization).toBeUndefined();
    expect(sent[1]['x-keep']).toBe('yes');
  });

  it('gives up after the redirect cap instead of looping', async () => {
    const fetchImpl = (async () =>
      res(302, {
        location: 'https://api.example.com/again',
      })) as unknown as typeof fetch;
    const netFetch = createNetFetch({
      lookup: publicLookup,
      fetchImpl,
      maxRedirects: 2,
    });
    await expect(netFetch('https://api.example.com/start')).rejects.toThrow(
      /too many redirects/,
    );
  });

  it('rejects a response whose declared content-length exceeds the cap, without buffering the (tiny, lying) body', async () => {
    const netFetch = createNetFetch({
      lookup: publicLookup,
      fetchImpl: (async () =>
        new Response('tiny-body', {
          status: 200,
          headers: { 'content-length': String(MAX_FETCH_BYTES + 1) },
        })) as unknown as typeof fetch,
    });
    await expect(netFetch('https://api.example.com/big')).rejects.toThrow(
      /100 MiB/,
    );
  });

  it('the download cap equals the worker fetch cap, so a deferred 100 MiB PDF is reachable', () => {
    expect(MAX_NET_FETCH_BYTES).toBe(MAX_FETCH_BYTES);
  });
});

describe('pinnedDispatcher', () => {
  // A connect the OS refuses on the spot (no network: ENETUNREACH; here a
  // broadcast address: EAFNOSUPPORT/EACCES). With the pinned lookup answering
  // synchronously, the TLS socket was destroyed inside tls.connect, its error
  // had no listener yet, and the main process died on an uncaught exception
  // (dev app 2026-10-22, network drop).
  it('a connect refused at once fails the request, never the process', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    const dispatcher = pinnedDispatcher('example.com', [
      '255.255.255.255',
      '255.255.255.255',
    ]);
    try {
      await expect(
        fetch('https://example.com:4999/', {
          dispatcher,
        } as RequestInit),
      ).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      await dispatcher.close();
    }
  });
});

describe('test loopback allowance (compiled gate)', () => {
  const servers: http.Server[] = [];
  const seen: string[] = [];
  async function listen(
    handler?: http.RequestListener,
  ): Promise<{ port: number }> {
    const server = http.createServer(
      handler ??
        ((req, res) => {
          seen.push(`${req.headers.host}${req.url}`);
          res.end('ok');
        }),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    return { port: (server.address() as AddressInfo).port };
  }
  afterEach(async () => {
    seen.length = 0;
    await Promise.all(
      servers.splice(0).map((s) => new Promise((r) => s.close(r))),
    );
  });
  const noLookup: LookupFn = async (h) => {
    throw new Error(`unexpected lookup for ${h}`);
  };
  const text = (b: Uint8Array) => Buffer.from(b).toString();

  it('refuses 127.0.0.1:<port> by default', async () => {
    const { port } = await listen();
    const f = createNetFetch({ lookup: noLookup });
    await expect(f(`http://127.0.0.1:${port}/`)).rejects.toThrow(
      NetDestinationError,
    );
    expect(seen).toEqual([]);
  });

  it('allows exactly 127.0.0.1:<port> when the allowance is on', async () => {
    const { port } = await listen();
    const f = createNetFetch({ lookup: noLookup, allowLoopbackPort: port });
    const r = await f(`http://127.0.0.1:${port}/x`);
    expect(r.status).toBe(200);
    expect(text(r.body)).toBe('ok');
    expect(seen).toEqual([`127.0.0.1:${port}/x`]);
  });

  it.each([
    ['localhost', (p: number) => `http://localhost:${p}/`],
    ['0.0.0.0', (p: number) => `http://0.0.0.0:${p}/`],
    ['::1', (p: number) => `http://[::1]:${p}/`],
    ['127.0.0.2', (p: number) => `http://127.0.0.2:${p}/`],
  ])('refuses %s even when 127.0.0.1:<port> is allowed', async (_n, mk) => {
    const { port } = await listen();
    const f = createNetFetch({
      lookup: stubLookup({ localhost: ['127.0.0.1'] }),
      allowLoopbackPort: port,
    });
    await expect(f(mk(port))).rejects.toThrow(NetDestinationError);
    expect(seen).toEqual([]);
  });

  it('refuses another loopback port', async () => {
    const a = await listen();
    const b = await listen();
    const f = createNetFetch({ lookup: noLookup, allowLoopbackPort: a.port });
    await expect(f(`http://127.0.0.1:${b.port}/`)).rejects.toThrow(
      NetDestinationError,
    );
    expect(seen).toEqual([]);
  });

  it('refuses 169.254.169.254 and 10.0.0.1 with the allowance on', async () => {
    const { port } = await listen();
    const f = createNetFetch({ lookup: noLookup, allowLoopbackPort: port });
    await expect(f(`http://169.254.169.254:${port}/`)).rejects.toThrow(
      NetDestinationError,
    );
    await expect(f(`http://10.0.0.1:${port}/`)).rejects.toThrow(
      NetDestinationError,
    );
  });

  it('a redirect from the allowed port to another loopback port is refused', async () => {
    const other = await listen();
    const a = await listen((req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${other.port}/` });
      res.end();
    });
    const f = createNetFetch({ lookup: noLookup, allowLoopbackPort: a.port });
    await expect(f(`http://127.0.0.1:${a.port}/`)).rejects.toThrow(
      NetDestinationError,
    );
    expect(seen).toEqual([]);
  });

  it('a redirect from the allowed port to a private address is refused', async () => {
    const a = await listen((req, res) => {
      res.writeHead(302, { location: 'http://10.0.0.1/' });
      res.end();
    });
    const f = createNetFetch({ lookup: noLookup, allowLoopbackPort: a.port });
    await expect(f(`http://127.0.0.1:${a.port}/`)).rejects.toThrow(
      NetDestinationError,
    );
  });

  it('a redirect on the allowed origin itself is followed', async () => {
    const a = await listen((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/end' });
        res.end();
      } else res.end('landed');
    });
    const f = createNetFetch({ lookup: noLookup, allowLoopbackPort: a.port });
    const r = await f(`http://127.0.0.1:${a.port}/start`);
    expect(text(r.body)).toBe('landed');
  });

  it.each([
    ['127.1', (p: number) => `http://127.1:${p}/`],
    ['2130706433', (p: number) => `http://2130706433:${p}/`],
    ['0x7f000001', (p: number) => `http://0x7f000001:${p}/`],
    ['127.000.000.001', (p: number) => `http://127.000.000.001:${p}/`],
    ['[::ffff:127.0.0.1]', (p: number) => `http://[::ffff:127.0.0.1]:${p}/`],
    ['userinfo', (p: number) => `http://127.0.0.1:${p}@127.0.0.1:1/`],
  ])(
    'refuses the non-literal spelling %s of the allowed host',
    async (_n, mk) => {
      const { port } = await listen();
      const f = createNetFetch({ lookup: noLookup, allowLoopbackPort: port });
      await expect(f(mk(port))).rejects.toThrow(NetDestinationError);
      expect(seen).toEqual([]);
    },
  );

  it.each(['127.1', '2130706433', '0x7f000001', '127.000.000.001'])(
    'a redirect Location spelling the allowed host as %s is refused',
    async (spelling) => {
      const a = await listen();
      const start = await listen((req, res) => {
        res.writeHead(302, { location: `http://${spelling}:${a.port}/x` });
        res.end();
      });
      const f = createNetFetch({
        lookup: noLookup,
        allowLoopbackPort: start.port,
      });
      await expect(f(`http://127.0.0.1:${start.port}/`)).rejects.toThrow(
        NetDestinationError,
      );
      expect(seen).toEqual([]);
    },
  );

  it('the allowance is revoked for good once a hop leaves the allowed origin', async () => {
    // allowed loopback -> public.example -> allowed loopback must be refused.
    const a = await listen((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: 'http://public.example/hop' });
        res.end();
      } else {
        seen.push(`landed${req.url}`);
        res.end('landed');
      }
    });
    const fetchImpl = jest.fn(
      async (target: string, init?: RequestInit): Promise<Response> => {
        if (target.startsWith('http://public.example'))
          return res(302, { location: `http://127.0.0.1:${a.port}/back` });
        return fetch(target, init);
      },
    );
    const f = createNetFetch({
      lookup: stubLookup({ 'public.example': ['93.184.216.34'] }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      allowLoopbackPort: a.port,
    });
    await expect(f(`http://127.0.0.1:${a.port}/start`)).rejects.toThrow(
      NetDestinationError,
    );
    expect(seen).not.toContain('landed/back');
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      `http://127.0.0.1:${a.port}/start`,
      'http://public.example/hop',
    ]);
  });

  it('a redirect from a public stub to the allowed port is refused', async () => {
    const a = await listen();
    const fetchImpl = jest.fn(async () =>
      res(302, { location: `http://127.0.0.1:${a.port}/` }),
    );
    const f = createNetFetch({
      lookup: stubLookup({ 'pub.example': ['93.184.216.34'] }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      allowLoopbackPort: a.port,
    });
    await expect(f('http://pub.example/')).rejects.toThrow(NetDestinationError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });

  it('the request is made through the pinned dispatcher', async () => {
    const { port } = await listen();
    const calls: Array<[string, string[]]> = [];
    const f = createNetFetch({
      lookup: noLookup,
      allowLoopbackPort: port,
      dispatcherFactory: (hostname, addresses) => {
        calls.push([hostname, addresses]);
        return pinnedDispatcher(hostname, addresses);
      },
    });
    await f(`http://127.0.0.1:${port}/`);
    expect(calls).toEqual([['127.0.0.1', ['127.0.0.1']]]);
  });

  describe('testNetAllow', () => {
    const env = { KIA_TEST_SYNC: '1', KIA_TEST_NET_ALLOW: '127.0.0.1:4242' };
    it('is undefined when the gate is false, whatever the env says', () => {
      expect(testNetAllow(env, false)).toBeUndefined();
    });
    it('needs KIA_TEST_SYNC=1 as well', () => {
      expect(
        testNetAllow({ KIA_TEST_NET_ALLOW: '127.0.0.1:4242' }, true),
      ).toBeUndefined();
    });
    it('parses only the literal 127.0.0.1:<port>', () => {
      expect(testNetAllow(env, true)).toBe(4242);
      for (const v of [
        'localhost:4242',
        '127.0.0.2:4242',
        '0.0.0.0:4242',
        '127.0.0.1',
        '127.0.0.1:0',
        '127.0.0.1:99999',
        '127.0.0.1:42x',
        '',
      ])
        expect(
          testNetAllow({ KIA_TEST_SYNC: '1', KIA_TEST_NET_ALLOW: v }, true),
        ).toBeUndefined();
    });
  });

  describe('scopedTestNetFetch', () => {
    const env = { KIA_TEST_SYNC: '1', KIA_TEST_NET_ALLOW: '127.0.0.1:4242' };
    it('applies to kiagent.remote-mcp only', () => {
      expect(scopedTestNetFetch('kiagent.remote-mcp', env, true)).toBeDefined();
      expect(
        scopedTestNetFetch('kiagent.documents', env, true),
      ).toBeUndefined();
      expect(
        scopedTestNetFetch('kiagent.remote-mcp', env, false),
      ).toBeUndefined();
    });
    it('an extension other than remote-mcp is still refused', async () => {
      const { port } = await listen();
      const e = { KIA_TEST_SYNC: '1', KIA_TEST_NET_ALLOW: `127.0.0.1:${port}` };
      const ok = scopedTestNetFetch('kiagent.remote-mcp', e, true)!;
      expect((await ok(`http://127.0.0.1:${port}/`)).status).toBe(200);
      expect(scopedTestNetFetch('kiagent.people', e, true)).toBeUndefined();
    });
  });
});
