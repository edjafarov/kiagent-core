/**
 * The shared connector test kit — generalized from the ms365 connector's
 * harness (`src/testing/harness.ts`), which is the most developed of the nine:
 * scripted host-shaped fetch responses, fakes for Session / AuthChannel, and
 * the dist-bundle smoke every repo hand-rolled a copy of.
 *
 * Two deliberate exclusions:
 *
 *  - NO domain routing. ms365's harness also knew Graph paths (`/v1.0/me`,
 *    conversation pagination, …). That stays in the connector — this module
 *    routes by exact URL only, so it serves Slack, Notion, IMAP and the rest
 *    equally.
 *  - NO test framework. Assertions use `node:assert/strict`, so the kit works
 *    under jest, node:test, or vitest alike.
 *
 * NEVER re-exported from `index.ts`: plugins bundle their entry with esbuild,
 * and this module pulls in `node:child_process` + `node:assert`. It is
 * reachable only as `@kiagent/connector-sdk/testing` — a devDependency-shaped
 * import that never reaches a shipped bundle.
 */
import { execSync } from 'node:child_process';
// Named import, not `import assert from 'node:assert/strict'` — the package
// compiles without esModuleInterop, so only the named form resolves.
import { strict as assert } from 'node:assert';
import { join } from 'node:path';

import type {
  Account,
  AuthChannel,
  Credentials,
  LogLevel,
  Session,
} from './generated/contracts';
import type { HostResponse, NetFetch } from './http';

/** A host-shaped JSON response: lowercase headers, `body` as UTF-8 bytes —
 *  exactly what `host.net.fetch` resolves to (and what `requestWithRetry`
 *  from `/http` expects). `statusText` is empty; no connector reads it. */
export function jsonRes(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HostResponse {
  return {
    status,
    statusText: '',
    headers,
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

/** Structural guard: a `urls` value is either a ready-made HostResponse or a
 *  plain JSON body to wrap. Both `status` and a `Uint8Array` body must be
 *  present — a fixture that merely happens to have a numeric `status` field
 *  (an API envelope, say) is still treated as a body. */
function isHostResponse(v: unknown): v is HostResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as HostResponse).status === 'number' &&
    (v as HostResponse).body instanceof Uint8Array
  );
}

/** Instant clock + zero jitter for the client test seam: inject these where a
 *  client takes `sleep`/`random`, and a retry ladder that would idle for
 *  minutes of wall time runs in microseconds.
 *
 *  The annotation is load-bearing — an inferred `async () => {}` would emit
 *  `sleep: () => Promise<void>` into the .d.ts and reject every real
 *  `sleep(2000)` call site. */
export const instantClock: {
  sleep: (ms: number) => Promise<void>;
  random: () => number;
} = {
  sleep: async () => {},
  random: () => 0,
};

/** A fake upstream, keyed by EXACT request URL. Unhandled URLs throw rather
 *  than resolving empty: a missing fixture is a test bug, and a silent `[]`
 *  turns it into a passing test that asserts nothing. */
export function scriptedFetch(
  opts: {
    /** Exact-URL → response table. Plain values become `jsonRes(200, v)`; a
     *  HostResponse value is returned untouched (non-200 / custom headers). */
    urls?: Record<string, HostResponse | unknown>;
    /** Consulted FIRST for every request; return `undefined` to fall through
     *  to `urls`. `count` is the per-exact-URL call number (0-based) — the
     *  seam for "fails N times, then succeeds" retry fixtures. */
    custom?: (url: URL, count: number) => HostResponse | undefined;
  } = {},
): { fetchFn: NetFetch; calls: string[]; inits: unknown[] } {
  const calls: string[] = [];
  const inits: unknown[] = [];
  const counts = new Map<string, number>();

  const fetchFn: NetFetch = async (rawUrl, init) => {
    const urlStr = String(rawUrl);
    calls.push(urlStr);
    // Index-aligned with `calls` — `undefined` is pushed for an init-less GET
    // so `inits[i]` always describes `calls[i]`. Senders POST their payload in
    // here, so this is the only seam a send test can assert method/body on.
    inits.push(init);
    const count = counts.get(urlStr) ?? 0;
    counts.set(urlStr, count + 1);

    if (opts.custom) {
      // Parsed lazily: only `custom` needs a URL object, so a table-only
      // fixture may key off a relative path without tripping `new URL`.
      const res = opts.custom(new URL(urlStr), count);
      if (res) return res;
    }

    const v = opts.urls?.[urlStr];
    if (v !== undefined) return isHostResponse(v) ? v : jsonRes(200, v);
    throw new Error(`scriptedFetch: unhandled url ${urlStr}`);
  };

  return { fetchFn, calls, inits };
}

/** A Session for pull/backfill tests. `.logs` collects every `log()` call as a
 *  `[level, msg]` tuple, so a test can assert on what the source reported. */
export function fakeSession(
  overrides: {
    account?: Partial<Account>;
    credentials?: Credentials | null;
    signal?: AbortSignal;
  } = {},
): Session & { logs: [LogLevel, string][] } {
  const logs: [LogLevel, string][] = [];
  const account: Account = {
    id: 'acct-1',
    source: 'test',
    identifier: 'user@example.com',
    config: {},
    status: 'live',
    cursor: undefined,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides.account,
  };
  return {
    account,
    // A fresh controller's signal is never aborted and never garbage —
    // sources that pass it to fetch/abort checks see a live, open session.
    signal: overrides.signal ?? new AbortController().signal,
    credentials: async () => overrides.credentials ?? null,
    log: (level: LogLevel, msg: string) => {
      logs.push([level, msg]);
    },
    logs,
  };
}

/** An AuthChannel for connect() tests. Every interactive verb REJECTS until a
 *  test scripts it: a connect flow that unexpectedly reaches for OAuth or a
 *  folder picker fails loudly, naming the verb, instead of hanging or
 *  silently accepting a default. `showQr` is exempt — it is fire-and-forget
 *  display, never a decision point. */
export function fakeAuthChannel(
  overrides: {
    oauth?: (scopes: string[]) => Promise<Credentials>;
    prompt?: (schema: unknown) => Promise<Record<string, unknown>>;
    pickFolders?: AuthChannel['pickFolders'];
  } = {},
): AuthChannel & { statuses: string[] } {
  const statuses: string[] = [];
  const unscripted = (verb: string) => async (): Promise<never> => {
    throw new Error(`not scripted: ${verb}`);
  };
  return {
    oauth: overrides.oauth ?? unscripted('oauth'),
    prompt: overrides.prompt ?? unscripted('prompt'),
    pickFolders: overrides.pickFolders ?? unscripted('pickFolders'),
    showQr: () => {},
    status: (msg: string) => {
      statuses.push(msg);
    },
    statuses,
  };
}

/** What `activate()` resolves to, narrowed to the parts this smoke asserts.
 *  `senders` is a Record KEYED BY SOURCE ID (contracts: `senders?:
 *  Record<string, Sender>`) — a Sender itself carries no id. */
interface SmokeActivateResult {
  sources?: Array<{ descriptor: { id: string } }>;
  senders?: Record<string, unknown>;
}

/** Builds the plugin's real dist bundle and smoke-tests `activate()` against
 *  it. This is the ONLY test that exercises esbuild's actual output — the
 *  CJS/ESM interop in a connector's `src/index.ts` (`export default mod;
 *  module.exports = mod;`) is otherwise untested, and it is precisely what an
 *  esbuild major bump breaks silently.
 *
 *  Framework-agnostic (node:assert), so the caller can wrap it in `it(...)`,
 *  `test(...)`, or run it directly. Building is slow — give the wrapping test
 *  a generous timeout (the repos use 30s). */
export async function bundleLoadSmoke(opts: {
  /** Plugin repo root — the directory holding package.json and dist/. */
  root: string;
  /** `host.self.id`, i.e. the extension id the manifest declares. */
  selfId: string;
  /** Expected `result.sources[i].descriptor.id`, in order. */
  sourceIds?: string[];
  /** Expected `Object.keys(result.senders)` — compared order-insensitively:
   *  senders are a Record looked up BY KEY, so their declaration order carries
   *  no meaning and must never decide a test. */
  senderIds?: string[];
  /** Replaces the whole default host when a connector's activate() reads more
   *  than `net` (files, db, …). */
  host?: unknown;
  /** Default `npm run build`. */
  buildCommand?: string;
}): Promise<void> {
  const command = opts.buildCommand ?? 'npm run build';
  try {
    execSync(command, { cwd: opts.root, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // execSync's own message is a bare "Command failed"; the compiler
    // diagnostics that explain WHY sit on the error object, so surface them.
    const err = e as { stdout?: unknown; stderr?: unknown };
    const out = [err.stdout, err.stderr]
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .join('\n');
    throw new Error(
      `bundleLoadSmoke: \`${command}\` failed in ${opts.root}${out ? `\n${out}` : ''}`,
    );
  }

  const distPath = join(opts.root, 'dist', 'index.js');
  const mod = require(distPath) as { default?: unknown } & Record<
    string,
    unknown
  >;
  // Accepts either interop shape: a default export or the namespace itself.
  const entry = (mod.default ?? mod) as {
    activate(host: unknown): Promise<SmokeActivateResult>;
  };
  assert.equal(
    typeof entry.activate,
    'function',
    `bundleLoadSmoke: ${distPath} exports no activate()`,
  );

  const host = opts.host ?? {
    self: { id: opts.selfId, dataDir: '/tmp' },
    log: () => {},
    net: {
      fetch: async () => {
        throw new Error('unused in bundle smoke');
      },
    },
  };
  const result = await entry.activate(host);

  if (opts.sourceIds) {
    assert.deepEqual(
      (result.sources ?? []).map((s) => s.descriptor.id),
      opts.sourceIds,
      'bundleLoadSmoke: contributed source ids',
    );
  }
  if (opts.senderIds) {
    // Both sides sorted — key enumeration order can never flake the assertion.
    // `[...]` first: `.sort()` mutates, and opts belongs to the caller.
    assert.deepEqual(
      Object.keys(result.senders ?? {}).sort(),
      [...opts.senderIds].sort(),
      'bundleLoadSmoke: contributed sender ids',
    );
  }
}
