import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Import through the ROOT STUB (`http.js` -> `dist/http`), i.e. exactly the
// path plugins take with `require('@kiagent/connector-sdk/http')`.
const { requestWithRetry, retryAfterMs } = require(join(sdkRoot, 'http.js'));

/** Host-shaped response (header keys lowercase, as net.fetch resolves them). */
const res = (status, headers = {}) => ({
  status,
  statusText: String(status),
  headers,
  body: new Uint8Array(),
});

/** Instant sleep that records every ms argument it is called with. */
const recorder = () => {
  const slept = [];
  return {
    slept,
    sleep: async (ms) => {
      slept.push(ms);
    },
  };
};

/** attempt() replays `items` in order: a HostResponse is returned, an Error is
 *  thrown. A call past the end is a scripting bug and throws loudly. */
const scripted = (...items) => {
  const state = { calls: 0 };
  state.attempt = async () => {
    const i = state.calls;
    state.calls += 1;
    if (i >= items.length) throw new Error(`unscripted attempt #${i + 1}`);
    const item = items[i];
    if (item instanceof Error) throw item;
    return item;
  };
  return state;
};

// ---------------------------------------------------------------- transient

test('retries 5xx with 2s/4s backoff, then returns the success', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(res(500), res(503), res(200));

  const out = await requestWithRetry(s.attempt, { label: 'x', sleep });

  assert.equal(out.status, 200);
  assert.equal(s.calls, 3);
  assert.deepEqual(slept, [2000, 4000]);
});

test('default transient ladder: 4 retries, 2s/4s/8s/16s, then throws', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(res(503), res(503), res(503), res(503), res(503));

  await assert.rejects(requestWithRetry(s.attempt, { label: 'x', sleep }), {
    message: 'x: HTTP 503 (after 5 attempts)',
  });

  assert.equal(s.calls, 5);
  assert.deepEqual(slept, [2000, 4000, 8000, 16000]);
});

test('network throws retry on the same ladder, then throw the exact message', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(
    new Error('ECONNRESET'),
    new Error('ECONNRESET'),
    new Error('ECONNRESET'),
    new Error('ECONNRESET'),
    new Error('ECONNRESET'),
  );

  await assert.rejects(requestWithRetry(s.attempt, { label: 'x', sleep }), {
    message: 'x: network error after 5 attempts: ECONNRESET',
  });

  assert.equal(s.calls, 5);
  assert.deepEqual(slept, [2000, 4000, 8000, 16000]);
});

test('network-throw exhaustion at maxTransientRetries: 1', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(new Error('boom'), new Error('boom'));

  await assert.rejects(
    requestWithRetry(s.attempt, {
      label: 'x',
      maxTransientRetries: 1,
      sleep,
    }),
    { message: 'x: network error after 2 attempts: boom' },
  );

  assert.equal(s.calls, 2);
  assert.deepEqual(slept, [2000]);
});

test('a non-Error throw is stringified into the message', async () => {
  const { slept, sleep } = recorder();
  let calls = 0;
  // scripted() only throws Errors — throw a bare value directly here.
  const attempt = async () => {
    calls += 1;
    throw 'kaboom';
  };

  await assert.rejects(
    requestWithRetry(attempt, {
      label: 'x',
      maxTransientRetries: 0,
      sleep,
    }),
    { message: 'x: network error after 1 attempts: kaboom' },
  );

  assert.equal(calls, 1);
  assert.deepEqual(slept, []);
});

test('network throws and 5xx SHARE one transient budget', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(new Error('boom'), res(500), res(200));

  const out = await requestWithRetry(s.attempt, {
    label: 'x',
    maxTransientRetries: 2,
    sleep,
  });

  assert.equal(out.status, 200);
  assert.equal(s.calls, 3);
  assert.deepEqual(slept, [2000, 4000]);
});

test('a shared-budget mix exhausts on whichever failure comes last', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(new Error('boom'), res(500));

  await assert.rejects(
    requestWithRetry(s.attempt, {
      label: 'x',
      maxTransientRetries: 1,
      sleep,
    }),
    { message: 'x: HTTP 500 (after 2 attempts)' },
  );

  assert.equal(s.calls, 2);
  assert.deepEqual(slept, [2000]);
});

// maxTransientRetries: 0 is what senders pass — a non-idempotent write must
// never be retried. `?? 4` (not `|| 4`) is what keeps 0 meaningful.
test('maxTransientRetries: 0 throws on the first 5xx, no sleep', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(res(502));

  await assert.rejects(
    requestWithRetry(s.attempt, {
      label: 'x',
      maxTransientRetries: 0,
      sleep,
    }),
    { message: 'x: HTTP 502 (after 1 attempts)' },
  );

  assert.equal(s.calls, 1);
  assert.deepEqual(slept, []);
});

test('maxTransientRetries: 0 throws on the first network error, no sleep', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(new Error('ECONNRESET'));

  await assert.rejects(
    requestWithRetry(s.attempt, {
      label: 'x',
      maxTransientRetries: 0,
      sleep,
    }),
    { message: 'x: network error after 1 attempts: ECONNRESET' },
  );

  assert.equal(s.calls, 1);
  assert.deepEqual(slept, []);
});

test('transientBackoffMs overrides the 2s base', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(res(500), res(500), res(200));

  await requestWithRetry(s.attempt, {
    label: 'x',
    transientBackoffMs: 100,
    sleep,
  });

  assert.deepEqual(slept, [100, 200]);
});

test('transientBackoffMs: 0 is honored (?? not ||)', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(res(500), res(200));

  await requestWithRetry(s.attempt, {
    label: 'x',
    transientBackoffMs: 0,
    sleep,
  });

  assert.deepEqual(slept, [0]);
});

// --------------------------------------------------------------- rate limit

test('429 honors retry-after, then returns the success', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(res(429, { 'retry-after': '7' }), res(200));

  const out = await requestWithRetry(s.attempt, { label: 'x', sleep });

  assert.equal(out.status, 200);
  assert.equal(s.calls, 2);
  assert.deepEqual(slept, [7000]);
});

test('429 retry-after: missing / garbage → 5s, 999 → 60s, 0 → 1s', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(
    res(429, {}),
    res(429, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
    res(429, { 'retry-after': '999' }),
    res(429, { 'retry-after': '0' }),
    res(200),
  );

  await requestWithRetry(s.attempt, { label: 'x', sleep });

  assert.deepEqual(slept, [5000, 5000, 60000, 1000]);
});

test('429 retry-after header is read lowercase only', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(res(429, { 'Retry-After': '7' }), res(200));

  await requestWithRetry(s.attempt, { label: 'x', sleep });

  assert.deepEqual(slept, [5000]); // default — the capitalized key is not read
});

test('default 429 ladder: 5 retries, then the exact exhaustion message', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(...Array.from({ length: 6 }, () => res(429, { 'retry-after': '1' })));

  await assert.rejects(requestWithRetry(s.attempt, { label: 'x', sleep }), {
    message: 'x: HTTP 429 after 6 attempts',
  });

  assert.equal(s.calls, 6);
  assert.deepEqual(slept, [1000, 1000, 1000, 1000, 1000]);
});

test('maxRateLimitRetries: 0 throws on the first 429, no sleep', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(res(429, {}));

  await assert.rejects(
    requestWithRetry(s.attempt, {
      label: 'x',
      maxRateLimitRetries: 0,
      sleep,
    }),
    { message: 'x: HTTP 429 after 1 attempts' },
  );

  assert.equal(s.calls, 1);
  assert.deepEqual(slept, []);
});

test('maxRateLimitRetries: 1 exhausts on the second 429', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(res(429, {}), res(429, {}));

  await assert.rejects(
    requestWithRetry(s.attempt, {
      label: 'x',
      maxRateLimitRetries: 1,
      sleep,
    }),
    { message: 'x: HTTP 429 after 2 attempts' },
  );

  assert.equal(s.calls, 2);
  assert.deepEqual(slept, [5000]);
});

// The 429 ladder is independent of the transient one: a rate-limited call was
// rejected before processing, so retrying it cannot duplicate a write.
// Counters are PER-LADDER (verbatim port), so the 500 below reports "1 attempts"
// even though two requests were made.
test('the 429 budget is independent of maxTransientRetries: 0', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(res(429, { 'retry-after': '2' }), res(500));

  await assert.rejects(
    requestWithRetry(s.attempt, {
      label: 'x',
      maxTransientRetries: 0,
      sleep,
    }),
    { message: 'x: HTTP 500 (after 1 attempts)' },
  );

  assert.equal(s.calls, 2);
  assert.deepEqual(slept, [2000]);
});

// ------------------------------------------------------------- pass-through

test('any status that is neither 429 nor >=500 returns immediately', async () => {
  for (const status of [200, 204, 302, 400, 404, 499]) {
    const { slept, sleep } = recorder();
    const s = scripted(res(status));

    const out = await requestWithRetry(s.attempt, { label: 'x', sleep });

    assert.equal(out.status, status, `status ${status} should pass through`);
    assert.equal(s.calls, 1);
    assert.deepEqual(slept, []);
  }
});

test('the label prefixes every thrown message', async () => {
  const { sleep } = recorder();
  const s = scripted(res(500));

  await assert.rejects(
    requestWithRetry(s.attempt, {
      label: 'notion /v1/search',
      maxTransientRetries: 0,
      sleep,
    }),
    { message: 'notion /v1/search: HTTP 500 (after 1 attempts)' },
  );
});

test('attempt() is re-invoked fresh on every try', async () => {
  const { sleep } = recorder();
  const seen = [];
  let call = 0;
  const attempt = async () => {
    call += 1;
    seen.push(call);
    return call < 3 ? res(503) : res(200);
  };

  const out = await requestWithRetry(attempt, { label: 'x', sleep });

  assert.equal(out.status, 200);
  assert.deepEqual(seen, [1, 2, 3]);
});

test('sleep defaults to a real timer when the policy omits one', async () => {
  const s = scripted(res(503), res(200));

  const out = await requestWithRetry(s.attempt, {
    label: 'x',
    transientBackoffMs: 1, // 1ms real setTimeout
  });

  assert.equal(out.status, 200);
  assert.equal(s.calls, 2);
});

// ------------------------------------------------------------- retryAfterMs

test('retryAfterMs: defaults (5s), clamp floor 1s, cap 60s', () => {
  assert.equal(retryAfterMs({}), 5000);
  assert.equal(retryAfterMs({ 'retry-after': '7' }), 7000);
  assert.equal(retryAfterMs({ 'retry-after': '999' }), 60000);
  assert.equal(retryAfterMs({ 'retry-after': '0' }), 1000);
  assert.equal(retryAfterMs({ 'retry-after': '-5' }), 1000);
  assert.equal(retryAfterMs({ 'retry-after': '1.5' }), 1500);
  assert.equal(retryAfterMs({ 'retry-after': 'garbage' }), 5000);
  assert.equal(retryAfterMs({ 'retry-after': 'Infinity' }), 5000);
  assert.equal(retryAfterMs({ 'retry-after': '' }), 1000); // Number('') === 0
  assert.equal(retryAfterMs({ 'Retry-After': '7' }), 5000); // wrong case
});

test('retryAfterMs: policy overrides default/min/max', () => {
  const policy = {
    label: 'x',
    retryAfterDefaultSec: 2,
    retryAfterMinSec: 3,
    retryAfterMaxSec: 10,
  };
  assert.equal(retryAfterMs({}, policy), 2000);
  assert.equal(retryAfterMs({ 'retry-after': '1' }, policy), 3000);
  assert.equal(retryAfterMs({ 'retry-after': '5' }, policy), 5000);
  assert.equal(retryAfterMs({ 'retry-after': '99' }, policy), 10000);
});

test('retryAfterMs: zero-valued overrides are honored (?? not ||)', () => {
  const policy = { label: 'x', retryAfterDefaultSec: 0, retryAfterMinSec: 0 };
  assert.equal(retryAfterMs({}, policy), 0);
  assert.equal(retryAfterMs({ 'retry-after': '0' }, policy), 0);
  assert.equal(
    retryAfterMs(
      { 'retry-after': '7' },
      { label: 'x', retryAfterMinSec: 0, retryAfterMaxSec: 0 },
    ),
    0,
  );
});

test('requestWithRetry sleeps the clamped retry-after from the policy', async () => {
  const { slept, sleep } = recorder();
  const s = scripted(res(429, { 'retry-after': '99' }), res(429, {}), res(200));

  await requestWithRetry(s.attempt, {
    label: 'x',
    retryAfterDefaultSec: 2,
    retryAfterMaxSec: 10,
    sleep,
  });

  assert.deepEqual(slept, [10000, 2000]);
});
