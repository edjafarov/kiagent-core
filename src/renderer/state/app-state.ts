import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { AppState } from '@shared/contracts';

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

function notify(): void {
  for (const listener of listeners) listener();
}

function apply(nextState: AppState, rev: number): void {
  // Guard on the broadcast counter, NOT the feed seq: non-feed slices
  // (identity, prefs, processing) re-push with the same seq but a higher rev.
  if (lastRev !== null && rev <= lastRev) return; // stale/out-of-order push
  state = nextState;
  lastRev = rev;
  notify();
}

function attach(): void {
  if (attached) return;
  const bridge = window.kiagent;
  // Preload bridge missing (e.g. a sandboxed-preload hiccup during a dev
  // hot-restart). Don't latch `attached` — the next subscriber retries.
  if (!bridge) return;
  attached = true;
  unsubscribePush = bridge.on('push:app-state', (payload) => {
    gotPush = true;
    apply(payload.state, payload.rev);
  });
  void bridge.invoke('app:get-state', undefined).then((payload) => {
    if (!gotPush) apply(payload.state, payload.rev);
  });
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
  // Drop the cached snapshot so a later re-attach refetches from the
  // *current* bridge rather than serving a stale one (relevant across
  // tests / dev hot-restarts, which replace window.kiagent).
  state = null;
  lastRev = null;
}

/**
 * Raw subscription primitives — used only by the App shell's loading /
 * sign-in gate, which must observe the `state === null` (not-yet-loaded)
 * moment directly. Every other consumer should use `useAppState` below,
 * which assumes that gate has already passed.
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

/** One-level structural equality (own enumerable keys, Object.is per value).
 *  Arrays compare by reference. */
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

/**
 * The primary consumption API. Selectors run against the loaded `AppState`
 * — components using this hook must only ever mount inside the tree gated
 * on `state !== null` (App.tsx's loading/sign-in gates use the lower-level
 * `subscribeAppState`/`getAppState` pair precisely because they run
 * *before* that invariant holds; every screen and shared component below
 * that gate can rely on it).
 *
 * Re-renders are skipped when the selected value is shallow-equal to the
 * previous one, so returning a fresh object each call (e.g.
 * `s => ({ live: s.accounts.length })`) is safe and still cheap — this is
 * the mechanism that stops (say) a Logs-only backend push from repainting
 * TopBar.
 */
export function useAppState<T>(selector: (s: AppState) => T): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cacheRef = useRef<{ has: boolean; value: T }>({
    has: false,
    value: undefined as unknown as T,
  });
  const getSnapshot = useCallback((): T => {
    // Safe per the invariant documented above.
    const next = selectorRef.current(state as AppState);
    const cache = cacheRef.current;
    if (cache.has && shallowEqual(cache.value, next)) return cache.value;
    cacheRef.current = { has: true, value: next };
    return next;
  }, []);
  return useSyncExternalStore(subscribeAppState, getSnapshot);
}
