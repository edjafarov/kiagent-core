import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Import through the ROOT STUB (`testing.js` -> `dist/testing`), i.e. exactly
// the path plugins take with `require('@kiagent/connector-sdk/testing')`.
const {
  bundleLoadSmoke,
  fakeAuthChannel,
  fakeSession,
  instantClock,
  jsonRes,
  scriptedFetch,
} = require(join(sdkRoot, 'testing.js'));

/** Decode a HostResponse body back into the value jsonRes was handed. */
const decode = (res) => JSON.parse(new TextDecoder().decode(res.body));

// ----------------------------------------------------------------- jsonRes

test('jsonRes: body round-trips through TextDecoder as JSON', () => {
  const res = jsonRes(200, { ok: true, items: [1, 'two'] });
  assert.ok(res.body instanceof Uint8Array);
  assert.deepEqual(decode(res), { ok: true, items: [1, 'two'] });
});

test('jsonRes: status passes through, statusText is empty, headers default {}', () => {
  const res = jsonRes(404, null);
  assert.equal(res.status, 404);
  assert.equal(res.statusText, '');
  assert.deepEqual(res.headers, {});
  assert.equal(decode(res), null);
});

test('jsonRes: explicit headers are carried verbatim', () => {
  const res = jsonRes(429, {}, { 'retry-after': '3' });
  assert.deepEqual(res.headers, { 'retry-after': '3' });
});

// ------------------------------------------------------------ instantClock

test('instantClock: sleep resolves immediately, random is zero jitter', async () => {
  await instantClock.sleep(60_000); // would hang for a minute on a real clock
  assert.equal(instantClock.random(), 0);
});

// ----------------------------------------------------------- scriptedFetch

test('scriptedFetch: a urls table hit becomes a 200 jsonRes', async () => {
  const { fetchFn } = scriptedFetch({ urls: { 'https://x.test/a': { hi: 1 } } });
  const res = await fetchFn('https://x.test/a');
  assert.equal(res.status, 200);
  assert.deepEqual(decode(res), { hi: 1 });
});

test('scriptedFetch: a HostResponse table value passes through untouched', async () => {
  const raw = jsonRes(503, { err: 'nope' }, { 'x-trace': 'abc' });
  const { fetchFn } = scriptedFetch({ urls: { 'https://x.test/a': raw } });
  const res = await fetchFn('https://x.test/a');
  assert.equal(res, raw); // identity — not re-wrapped
  assert.equal(res.status, 503);
  assert.deepEqual(res.headers, { 'x-trace': 'abc' });
});

test('scriptedFetch: custom() is consulted BEFORE the urls table', async () => {
  const { fetchFn } = scriptedFetch({
    urls: { 'https://x.test/a': { from: 'table' } },
    custom: () => jsonRes(200, { from: 'custom' }),
  });
  assert.deepEqual(decode(await fetchFn('https://x.test/a')), { from: 'custom' });
});

test('scriptedFetch: custom() returning undefined falls through to the table', async () => {
  const { fetchFn } = scriptedFetch({
    urls: { 'https://x.test/a': { from: 'table' } },
    custom: () => undefined,
  });
  assert.deepEqual(decode(await fetchFn('https://x.test/a')), { from: 'table' });
});

test('scriptedFetch: custom() receives a parsed URL', async () => {
  const seen = [];
  const { fetchFn } = scriptedFetch({
    urls: { 'https://x.test/a?q=1': {} },
    custom: (url) => {
      seen.push([url instanceof URL, url.pathname, url.searchParams.get('q')]);
      return undefined;
    },
  });
  await fetchFn('https://x.test/a?q=1');
  assert.deepEqual(seen, [[true, '/a', '1']]);
});

test('scriptedFetch: count is the per-exact-URL 0-based call number', async () => {
  const counts = [];
  const { fetchFn } = scriptedFetch({
    urls: { 'https://x.test/a': {}, 'https://x.test/b': {} },
    custom: (url, count) => {
      counts.push([url.pathname, count]);
      return undefined;
    },
  });
  await fetchFn('https://x.test/a');
  await fetchFn('https://x.test/a');
  await fetchFn('https://x.test/b');
  await fetchFn('https://x.test/a');
  assert.deepEqual(counts, [
    ['/a', 0],
    ['/a', 1],
    ['/b', 0],
    ['/a', 2],
  ]);
});

test('scriptedFetch: count drives a "fails twice then succeeds" fixture', async () => {
  const { fetchFn } = scriptedFetch({
    custom: (_url, count) => jsonRes(count < 2 ? 500 : 200, { count }),
  });
  const statuses = [];
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    statuses.push((await fetchFn('https://x.test/a')).status);
  }
  assert.deepEqual(statuses, [500, 500, 200]);
});

test('scriptedFetch: an unhandled url THROWS, naming the url', async () => {
  const { fetchFn } = scriptedFetch({ urls: { 'https://x.test/a': {} } });
  await assert.rejects(() => fetchFn('https://x.test/nope'), (e) => {
    assert.ok(e instanceof Error);
    assert.match(e.message, /https:\/\/x\.test\/nope/);
    return true;
  });
});

test('scriptedFetch: no options at all — every url throws', async () => {
  const { fetchFn } = scriptedFetch();
  await assert.rejects(() => fetchFn('https://x.test/a'), /https:\/\/x\.test\/a/);
});

test('scriptedFetch: calls records every url in order, including throwers', async () => {
  const { fetchFn, calls } = scriptedFetch({ urls: { 'https://x.test/a': {} } });
  await fetchFn('https://x.test/a');
  await fetchFn('https://x.test/a');
  await assert.rejects(() => fetchFn('https://x.test/z'));
  assert.deepEqual(calls, [
    'https://x.test/a',
    'https://x.test/a',
    'https://x.test/z',
  ]);
});

test('scriptedFetch: a non-absolute table key is served without URL parsing', async () => {
  const { fetchFn } = scriptedFetch({ urls: { '/v1/relative': { ok: 1 } } });
  assert.deepEqual(decode(await fetchFn('/v1/relative')), { ok: 1 });
});

// ------------------------------------------------------------- fakeSession

test('fakeSession: default account fields', () => {
  const s = fakeSession();
  assert.deepEqual(s.account, {
    id: 'acct-1',
    source: 'test',
    identifier: 'user@example.com',
    config: {},
    status: 'live',
    cursor: undefined,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
});

test('fakeSession: credentials() defaults to null', async () => {
  assert.equal(await fakeSession().credentials(), null);
});

test('fakeSession: credentials override is resolved', async () => {
  const creds = { accessToken: 'tok' };
  assert.deepEqual(await fakeSession({ credentials: creds }).credentials(), creds);
});

test('fakeSession: explicit null credentials stay null', async () => {
  assert.equal(await fakeSession({ credentials: null }).credentials(), null);
});

test('fakeSession: log() records [level, msg] tuples into .logs', () => {
  const s = fakeSession();
  assert.deepEqual(s.logs, []);
  s.log('info', 'started');
  s.log('error', 'boom');
  assert.deepEqual(s.logs, [
    ['info', 'started'],
    ['error', 'boom'],
  ]);
});

test('fakeSession: account overrides merge over the defaults', () => {
  const s = fakeSession({ account: { source: 'slack', config: { team: 'T1' } } });
  assert.equal(s.account.source, 'slack');
  assert.deepEqual(s.account.config, { team: 'T1' });
  assert.equal(s.account.id, 'acct-1'); // untouched default
});

test('fakeSession: signal defaults to a live, never-aborted AbortSignal', () => {
  const s = fakeSession();
  assert.ok(typeof s.signal === 'object' && s.signal !== null);
  assert.equal(s.signal.aborted, false);
});

test('fakeSession: an injected signal is used as-is', () => {
  const ac = new AbortController();
  const s = fakeSession({ signal: ac.signal });
  assert.equal(s.signal, ac.signal);
  ac.abort();
  assert.equal(s.signal.aborted, true);
});

// --------------------------------------------------------- fakeAuthChannel

test('fakeAuthChannel: unscripted oauth rejects with "not scripted: oauth"', async () => {
  await assert.rejects(() => fakeAuthChannel().oauth(['a.b']), /not scripted: oauth/);
});

test('fakeAuthChannel: unscripted prompt/pickFolders reject by verb name', async () => {
  const auth = fakeAuthChannel();
  await assert.rejects(() => auth.prompt({}), /not scripted: prompt/);
  await assert.rejects(() => auth.pickFolders({ modes: [] }), /not scripted: pickFolders/);
});

test('fakeAuthChannel: status(msg) records into .statuses', () => {
  const auth = fakeAuthChannel();
  assert.deepEqual(auth.statuses, []);
  auth.status('connecting');
  auth.status('done');
  assert.deepEqual(auth.statuses, ['connecting', 'done']);
});

test('fakeAuthChannel: showQr is a silent no-op', () => {
  assert.equal(fakeAuthChannel().showQr('otpauth://x'), undefined);
});

test('fakeAuthChannel: an oauth override receives the scopes and resolves', async () => {
  const seen = [];
  const auth = fakeAuthChannel({
    oauth: async (scopes) => {
      seen.push(scopes);
      return { accessToken: 'tok' };
    },
  });
  assert.deepEqual(await auth.oauth(['mail.read']), { accessToken: 'tok' });
  assert.deepEqual(seen, [['mail.read']]);
});

test('fakeAuthChannel: prompt/pickFolders overrides replace the rejecters', async () => {
  const auth = fakeAuthChannel({
    prompt: async () => ({ token: 'xoxp' }),
    pickFolders: async () => [{ id: 'f1', name: 'F1', hasChildren: false }],
  });
  assert.deepEqual(await auth.prompt({}), { token: 'xoxp' });
  assert.deepEqual(await auth.pickFolders({ modes: [] }), [
    { id: 'f1', name: 'F1', hasChildren: false },
  ]);
});

// ---------------------------------------------------------- bundleLoadSmoke

test('bundleLoadSmoke: exported as a function', () => {
  // Exercised for real by every plugin repo that adopts the kit; here we only
  // pin that the export exists and takes the opts object.
  assert.equal(typeof bundleLoadSmoke, 'function');
  assert.equal(bundleLoadSmoke.length, 1);
});

// ------------------------------------------------------------ bundle safety

test('the main entry does NOT re-export the testing kit', () => {
  // `src/index.ts` is what plugins bundle into dist. Pulling testing.ts in
  // would drag node:child_process + node:assert into every shipped bundle.
  const index = require(join(sdkRoot, 'dist', 'index.js'));
  for (const name of [
    'jsonRes',
    'instantClock',
    'scriptedFetch',
    'fakeSession',
    'fakeAuthChannel',
    'bundleLoadSmoke',
  ]) {
    assert.equal(index[name], undefined, `index must not export ${name}`);
  }
});
