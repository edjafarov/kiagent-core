/**
 * Destination policy for the extension `net` capability.
 *
 * `net` is the one capability every connector must declare — it exists so a
 * source can talk to the service it syncs. Before this guard, its only check
 * was that the URL started with `http`, which also let `http://127.0.0.1:7421`
 * through: the loopback MCP server, which authenticates callers by Host header
 * alone (a real loopback caller satisfies that by construction) and registers
 * `query_sql` against the whole corpus. So the minimum capability was a
 * corpus-read-and-exfiltrate capability, and `query`/`db` were decorative.
 *
 * Policy: extensions may reach public internet destinations only. Loopback,
 * RFC1918 LAN, link-local (which covers the 169.254.169.254 cloud metadata
 * endpoint), CGNAT, IPv6 unique-local, multicast and reserved space are all
 * refused. Nothing that ships today needs a private address, and relaxing this
 * later — via a separately consented capability — is far easier than tightening
 * it once an ecosystem depends on the freedom.
 *
 * Two limits worth stating plainly. This does not make an extension harmless:
 * it runs unsandboxed and can open a socket directly (see the platform
 * threat-model issue) — what this makes true is that the capability boundary
 * means what the consent dialog says it means. And the check is resolve-then-
 * connect, so a hostile resolver could in principle answer differently for the
 * connection than for the check; closing that needs the connection pinned to
 * the validated address, which Node's global fetch gives no hook for.
 */
import dns from 'dns';
import net from 'net';

/**
 * `net.fetch` is reachable by semi-trusted third-party connector
 * extensions — a huge or malicious endpoint must not be able to buffer an
 * unbounded response in the main process. 50 MiB comfortably covers
 * ordinary API/webhook payloads.
 */
export const MAX_NET_FETCH_BYTES = 50 * 1024 * 1024; // 50 MiB

/** Redirect hops followed before giving up. Each hop is re-validated. */
export const MAX_NET_FETCH_REDIRECTS = 5;

/** Headers dropped when a redirect crosses to a different origin, so a
 *  redirect can't be used to hand an API token to a third party. */
const CROSS_ORIGIN_STRIPPED = [
  'authorization',
  'cookie',
  'proxy-authorization',
];

interface Rule {
  reason: string;
  v4?: Array<[string, number]>;
  v6?: Array<[string, number]>;
}

/** Ordered most-specific-intent first so the message names the real reason
 *  (loopback rather than the /8 it happens to sit in). */
const RULES: Rule[] = [
  {
    reason: 'a loopback address',
    v4: [['127.0.0.0', 8]],
    v6: [['::1', 128]],
  },
  {
    reason: 'an unspecified address',
    v4: [['0.0.0.0', 8]],
    v6: [['::', 128]],
  },
  {
    reason: 'a link-local address (this range holds cloud metadata endpoints)',
    v4: [['169.254.0.0', 16]],
    v6: [['fe80::', 10]],
  },
  {
    reason: 'a private network address',
    v4: [
      ['10.0.0.0', 8],
      ['172.16.0.0', 12],
      ['192.168.0.0', 16],
    ],
    v6: [['fc00::', 7]],
  },
  {
    reason: 'a carrier-grade NAT address',
    v4: [['100.64.0.0', 10]],
  },
  {
    reason: 'a multicast address',
    v4: [['224.0.0.0', 4]],
    v6: [['ff00::', 8]],
  },
  {
    reason: 'a reserved address',
    v4: [
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['240.0.0.0', 4],
    ],
  },
];

const blockLists = RULES.map((rule) => {
  const list = new net.BlockList();
  rule.v4?.forEach(([addr, prefix]) => list.addSubnet(addr, prefix, 'ipv4'));
  rule.v6?.forEach(([addr, prefix]) => list.addSubnet(addr, prefix, 'ipv6'));
  return { reason: rule.reason, list };
});

/**
 * Collapses an IPv4-mapped/compatible IPv6 address to its IPv4 form, so
 * `::ffff:127.0.0.1` and `::ffff:7f00:1` are judged as `127.0.0.1` rather than
 * sliding past the IPv4 rules on a technicality.
 */
export function normalizeAddress(ip: string): string {
  const bare = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (net.isIPv4(bare)) return bare;
  const lower = bare.toLowerCase();
  const mapped = /^::(?:ffff:)?(?:0:)?(.+)$/.exec(lower);
  if (!mapped) return bare;
  const tail = mapped[1];
  if (net.isIPv4(tail)) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!hex) return bare;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  const v4 = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  // `::2` and friends are not IPv4-compatible addresses worth rewriting; only
  // treat it as one when the high half is non-zero, matching ::a.b.c.d usage.
  return hi === 0 ? bare : v4;
}

/**
 * Returns a human reason when `ip` is outside the public internet, or `null`
 * when it is a permitted destination. Unparseable input is refused rather than
 * waved through.
 */
export function classifyAddress(ip: string): string | null {
  const addr = normalizeAddress(ip);
  const family = net.isIP(addr);
  if (family === 0) return 'not a valid IP address';
  const type = family === 4 ? 'ipv4' : 'ipv6';
  const hit = blockLists.find((b) => b.list.check(addr, type));
  return hit ? hit.reason : null;
}

export class NetDestinationError extends Error {}

export type LookupFn = (hostname: string) => Promise<string[]>;

const defaultLookup: LookupFn = async (hostname) => {
  const results = await dns.promises.lookup(hostname, {
    all: true,
    verbatim: true,
  });
  return results.map((r) => r.address);
};

/**
 * Resolves `hostname` and refuses if *any* address it answers with is
 * non-public — a name with one public and one loopback answer is a rebinding
 * attempt, not a partially-valid destination.
 */
export async function assertPublicHostname(
  hostname: string,
  lookup: LookupFn = defaultLookup,
): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare) !== 0) {
    const reason = classifyAddress(bare);
    if (reason) {
      throw new NetDestinationError(
        `net.fetch: refusing to connect to ${hostname} — that is ${reason}. Extensions may only reach public internet destinations.`,
      );
    }
    return;
  }

  let addresses: string[];
  try {
    addresses = await lookup(bare);
  } catch (err) {
    throw new NetDestinationError(
      `net.fetch: cannot resolve ${hostname}: ${(err as Error).message}`,
    );
  }
  if (addresses.length === 0) {
    throw new NetDestinationError(
      `net.fetch: cannot resolve ${hostname}: no addresses returned`,
    );
  }
  const blocked = addresses
    .map((a) => ({ a, reason: classifyAddress(a) }))
    .find((r) => r.reason);
  if (blocked) {
    throw new NetDestinationError(
      `net.fetch: refusing to connect to ${hostname} — it resolves to ${blocked.a}, which is ${blocked.reason}. Extensions may only reach public internet destinations.`,
    );
  }
}

/** Validates scheme and destination, returning the parsed URL. */
export async function assertAllowedUrl(
  url: string,
  lookup: LookupFn = defaultLookup,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NetDestinationError(`net.fetch: not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NetDestinationError('net.fetch only supports http(s) URLs');
  }
  await assertPublicHostname(parsed.hostname, lookup);
  return parsed;
}

/**
 * Reads `res`'s body up to `maxBytes`, throwing a descriptive error the
 * moment that's exceeded. Checked against `content-length` up front (fail
 * fast, no need to read anything), then again against the running total
 * while streaming — a `content-length` header can lie or be absent, so it
 * can't be trusted alone.
 */
export async function readBoundedBody(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const limit = `${Math.floor(maxBytes / (1024 * 1024))} MiB`;
  const declared = res.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    throw new Error(`net.fetch: response exceeds the ${limit} limit`);
  }
  if (!res.body) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new Error(`net.fetch: response exceeds the ${limit} limit`);
    }
    return new Uint8Array(buf);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop the transfer too — without cancel() the stream keeps
        // pulling bytes until GC even though we've already given up.
        await reader.cancel();
        throw new Error(`net.fetch: response exceeds the ${limit} limit`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export interface NetFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface NetFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface NetFetchOptions {
  lookup?: LookupFn;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  maxRedirects?: number;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Builds the guarded `net.fetch` implementation.
 *
 * Redirects are followed manually so every hop is re-validated — otherwise a
 * public URL could 302 straight to loopback and the guard would only ever have
 * inspected the first address. Credentials are stripped when a hop changes
 * origin.
 */
export function createNetFetch(options: NetFetchOptions = {}) {
  const {
    lookup = defaultLookup,
    fetchImpl = fetch,
    maxBytes = MAX_NET_FETCH_BYTES,
    maxRedirects = MAX_NET_FETCH_REDIRECTS,
  } = options;

  return async function netFetch(
    url: unknown,
    init?: unknown,
  ): Promise<NetFetchResult> {
    const i = (init ?? {}) as NetFetchInit;
    let target = String(url);
    let { method, body } = i;
    let headers = { ...(i.headers ?? {}) };
    const { origin } = await assertAllowedUrl(target, lookup);

    for (let hop = 0; ; hop += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetchImpl(target, {
        method,
        headers,
        body: body as BodyInit | undefined,
        redirect: 'manual',
      });

      const location = res.headers.get('location');
      if (!REDIRECT_STATUS.has(res.status) || !location) {
        return {
          status: res.status,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers.entries()),
          // eslint-disable-next-line no-await-in-loop
          body: await readBoundedBody(res, maxBytes),
        };
      }

      if (hop >= maxRedirects) {
        // eslint-disable-next-line no-await-in-loop
        await res.body?.cancel();
        throw new NetDestinationError(
          `net.fetch: too many redirects (over ${maxRedirects}) starting at ${origin}`,
        );
      }

      const next = new URL(location, target);
      // eslint-disable-next-line no-await-in-loop
      const parsed = await assertAllowedUrl(next.toString(), lookup);
      if (parsed.origin !== origin) {
        headers = Object.fromEntries(
          Object.entries(headers).filter(
            ([k]) => !CROSS_ORIGIN_STRIPPED.includes(k.toLowerCase()),
          ),
        );
      }
      if (
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) &&
          (method ?? 'GET').toUpperCase() === 'POST')
      ) {
        method = 'GET';
        body = undefined;
      }
      target = parsed.toString();
      // eslint-disable-next-line no-await-in-loop
      await res.body?.cancel();
    }
  };
}
