/** @jest-environment node */
import {
  assertPublicHostname,
  classifyAddress,
  createNetFetch,
  normalizeAddress,
  type LookupFn,
} from '../net-guard';

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
          headers: { 'content-length': String(60 * 1024 * 1024) },
        })) as unknown as typeof fetch,
    });
    await expect(netFetch('https://api.example.com/big')).rejects.toThrow(
      /50 MiB/,
    );
  });
});
