import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { AppState } from '@shared/contracts';
import { reconcile } from './reconcile';

/**
 * Subscription store for the single `push:app-state` projection channel.
 *
 * Mirrors the ergonomics of the legacy state/push-subscriptions.ts +
 * useAppStateSelector (pull-then-push, shallow-equal re-render bailout) with
 * much simpler internals: the whole contract is one push channel + one
 * get-state invoke, instead of reconciling many independent
 * push:*-updated channels.
 *
 * Race guard: `push:app-state` is subscribed *before* the initial
 * `app:get-state` call resolves, and a `gotPush` flag stops a slow
 * get-state response from clobbering a push that already landed — same
 * guard the legacy store used. Pushes are also seq-guarded so a
 * reordered/duplicate broadcast can never move the store backwards.
 */

let state: AppState | null = null;
let lastRev: number | null = null;
let attached = false;
let gotPush = false;
let unsubscribePush: (() => void) | null = null;
const listeners = new Set<() => void>();

// Bumped by detach(). A retry loop closes over the generation it was
// scheduled under, so a stale loop from a since-detached (or detached then
// re-attached) store recognizes itself as stale and stops touching module
// state instead of racing a fresh attachment.
let attachGen = 0;

const GET_STATE_RETRY_INITIAL_MS = 1000;
const GET_STATE_RETRY_MAX_MS = 10000;

function notify(): void {
  for (const listener of listeners) listener();
}

function apply(nextState: AppState, rev: number): void {
  // Guard on the broadcast counter, NOT the feed seq: non-feed slices
  // (identity, prefs, processing) re-push with the same seq but a higher rev.
  if (lastRev !== null && rev <= lastRev) return; // stale/out-of-order push
  lastRev = rev;
  // IPC structured-clones every push, so nothing in `nextState` is
  // reference-equal to the current snapshot even where nothing changed.
  // Reconciling restores sharing: unchanged sub-trees keep their previous
  // reference (shallow-equal selectors bail out), and a push equal to the
  // current snapshot is a no-op that notifies no one.
  const reconciled = reconcile(state, nextState);
  if (reconciled === state) return;
  state = reconciled;
  notify();
}

// Retries ONLY the one-shot `app:get-state` invoke after a rejection — the
// push subscription from attach() is untouched and stays live throughout.
// Stops permanently as soon as any of: a push wins (gotPush), a retry
// succeeds, or `gen` goes stale (detach()/re-attach() happened meanwhile).
function scheduleGetStateRetry(gen: number, delayMs: number): void {
  setTimeout(() => {
    if (gen !== attachGen || gotPush) return;
    const bridge = window.kiagent;
    if (!bridge) return; // bridge vanished; nothing left to retry against
    bridge.invoke('app:get-state', undefined).then(
      (payload) => {
        if (gen !== attachGen || gotPush) return;
        apply(payload.state, payload.rev);
      },
      () => {
        if (gen !== attachGen || gotPush) return;
        scheduleGetStateRetry(
          gen,
          Math.min(delayMs * 2, GET_STATE_RETRY_MAX_MS),
        );
      },
    );
  }, delayMs);
}

function attach(): void {
  if (attached) return;
  const bridge = window.kiagent;
  // Preload bridge missing (e.g. a sandboxed-preload hiccup during a dev
  // hot-restart). Don't latch `attached` — the next subscriber retries.
  if (!bridge) return;
  attached = true;
  // Stable id for this attachment; detach() bumps `attachGen` so a retry
  // loop started under this id can tell it's since gone stale.
  const gen = attachGen;
  unsubscribePush = bridge.on('push:app-state', (payload) => {
    gotPush = true;
    apply(payload.state, payload.rev);
  });
  bridge.invoke('app:get-state', undefined).then(
    (payload) => {
      if (gen !== attachGen) return; // detached (or re-attached) meanwhile
      if (!gotPush) apply(payload.state, payload.rev);
    },
    () => {
      // Transient rejection (e.g. main process still booting during a dev
      // hot-restart race). The push subscription above is healthy and
      // untouched — only the one-shot invoke needs a retry, so the App
      // shell's `state !== null` loading gate isn't stuck forever waiting
      // on an idle app's next unrelated broadcast.
      if (gen !== attachGen) return;
      console.warn('app-state: app:get-state rejected, retrying');
      scheduleGetStateRetry(gen, GET_STATE_RETRY_INITIAL_MS);
    },
  );
}

function detach(): void {
  if (unsubscribePush) {
    try {
      unsubscribePush();
    } catch {
      /* ignore */
    }
  }
  unsubscribePush = null;
  attached = false;
  gotPush = false;
  attachGen += 1; // invalidate any in-flight get-state retry loop
  // Drop the cached snapshot so a later re-attach refetches from the
  // *current* bridge rather than serving a stale one (relevant across
  // tests / dev hot-restarts, which replace window.kiagent).
  state = null;
  lastRev = null;
}

/**
 * Raw subscription primitives, for non-React callers and tests. React code
 * uses `useAppState` (inside the loaded tree) or `useAppGate` (the App
 * shells' loading/sign-in gates, which must see the `null` not-yet-loaded
 * moment).
 */
export function subscribeAppState(listener: () => void): () => void {
  attach();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) detach();
  };
}

export function getAppState(): AppState | null {
  return state;
}

/** One-level structural equality (own enumerable keys, Object.is per value)
 *  for both plain objects and arrays — arrays compare element-wise, so
 *  fresh arrays with identical elements are equal. Values one level down,
 *  including nested arrays/objects, compare by reference (Object.is). */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null
  ) {
    return false;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  if (keys.length !== Object.keys(rb).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(rb, key)) return false;
    if (!Object.is(ra[key], rb[key])) return false;
  }
  return true;
}

// The cache is load-bearing: useSyncExternalStore calls getSnapshot more
// than once per render and React 19 throws ("The result of getSnapshot
// should be cached") if a fresh-but-equal object comes back.
function useSelected<T>(selector: (s: AppState | null) => T): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cacheRef = useRef<{ has: boolean; value: T }>({
    has: false,
    value: undefined as unknown as T,
  });
  const getSnapshot = useCallback((): T => {
    const next = selectorRef.current(state);
    const cache = cacheRef.current;
    if (cache.has && shallowEqual(cache.value, next)) return cache.value;
    cacheRef.current = { has: true, value: next };
    return next;
  }, []);
  return useSyncExternalStore(subscribeAppState, getSnapshot);
}

/**
 * The primary consumption API. Selectors run against the loaded `AppState`
 * — components using this hook must only ever mount inside the tree gated
 * on `state !== null` by the App shell (`useAppGate`).
 *
 * Re-renders are skipped when the selected value is shallow-equal to the
 * previous one, so returning a fresh object each call (e.g.
 * `s => ({ live: s.accounts.length })`) is safe and still cheap. Pushes are
 * reconciled against the previous snapshot (see `apply`), so an unchanged
 * sub-tree such as `s.identity`, `s.extensions` or an untouched account
 * keeps its reference across pushes and selecting it directly bails out too.
 * Never select a value built of fresh arrays/objects nested below the top
 * level: the one-level cache misses on every call.
 */
export function useAppState<T>(selector: (s: AppState) => T): T {
  // Safe per the invariant documented above.
  return useSelected(selector as (s: AppState | null) => T);
}

/**
 * The App shells' gate selector: like `useAppState`, but the selector also
 * sees the `null` not-yet-loaded state. Select only what the shell renders
 * on (loaded, signed in, the extension list), so a feed push that changes
 * none of it does not re-render the shell.
 */
export function useAppGate<T>(select: (s: AppState | null) => T): T {
  return useSelected(select);
}
