import { deserialize, serialize } from 'node:v8';
import { reconcile } from '../reconcile';

/** What IPC does to every push. jest 29 / jsdom 20 has no structuredClone. */
const clone = <T>(v: T): T => deserialize(serialize(v)) as T;

const base = () => ({
  identity: { name: 'Alice', emails: ['a@example.com'] },
  accounts: [
    {
      account: { id: 'a', status: 'live' },
      docCount: 1,
      recent: [{ id: 'x' }],
    },
    {
      account: { id: 'b', status: 'backfilling' },
      docCount: 2,
      progress: { done: 5 },
      recent: [],
    },
  ],
  extensions: [{ id: 'ext.a', ui: [] }],
  ready: true,
});

test('a structurally equal clone returns prev itself', () => {
  const prev = base();
  expect(reconcile(prev, clone(prev))).toBe(prev);
});

test('a changed leaf gives new references on its path only', () => {
  const prev = base();
  const next = clone(prev);
  next.accounts[1].docCount = 3;
  const out = reconcile(prev, next);
  expect(out).not.toBe(prev);
  expect(out.accounts).not.toBe(prev.accounts);
  expect(out.accounts[1]).not.toBe(prev.accounts[1]);
  expect(out.accounts[1].docCount).toBe(3);
  expect(out.accounts[0]).toBe(prev.accounts[0]);
  expect(out.accounts[1].account).toBe(prev.accounts[1].account);
  expect(out.accounts[1].recent).toBe(prev.accounts[1].recent);
  expect(out.identity).toBe(prev.identity);
  expect(out.extensions).toBe(prev.extensions);
  expect(out).toEqual(next);
});

test('a key that disappears is gone from the result', () => {
  const prev = base();
  const next = clone(prev) as ReturnType<typeof base>;
  delete (next.accounts[1] as { progress?: unknown }).progress;
  const out = reconcile(prev, next);
  expect(out.accounts[1]).not.toBe(prev.accounts[1]);
  expect('progress' in out.accounts[1]).toBe(false);
  expect(out.accounts[1].account).toBe(prev.accounts[1].account);
  expect(out).toEqual(next);
});

test('an added key gives a new object that keeps the old values', () => {
  const prev = base();
  const next = clone(prev) as ReturnType<typeof base> & { extra?: number };
  next.extra = 1;
  const out = reconcile(prev, next);
  expect(out).not.toBe(prev);
  expect(out.accounts).toBe(prev.accounts);
  expect(out).toEqual(next);
});

test('a removed account shortens the list and keeps the survivors', () => {
  const prev = base();
  const next = clone(prev);
  next.accounts = next.accounts.slice(0, 1);
  const out = reconcile(prev, next);
  expect(out.accounts).not.toBe(prev.accounts);
  expect(out.accounts).toHaveLength(1);
  expect(out.accounts[0]).toBe(prev.accounts[0]);
});

test('a reorder yields exactly the pushed order', () => {
  const prev = base();
  const next = clone(prev);
  next.accounts.reverse();
  const out = reconcile(prev, next);
  expect(out.accounts.map((a) => a.account.id)).toEqual(['b', 'a']);
  expect(out).toEqual(next);
});

test('null and primitives: equal keeps prev, different takes next', () => {
  expect(reconcile(null, { a: 1 })).toEqual({ a: 1 });
  expect(reconcile({ a: 1 }, null)).toBeNull();
  expect(reconcile(NaN, NaN)).toBeNaN();
  expect(reconcile([1, 2], [1, 2, 3])).toEqual([1, 2, 3]);
  const arr = [1, 2];
  expect(reconcile(arr, [1, 2])).toBe(arr);
});
