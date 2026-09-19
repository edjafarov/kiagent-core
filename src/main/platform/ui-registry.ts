/**
 * B1 (host-owned renderer eventing) — the main-side registry behind
 * `host.ui.handle/unhandle/broadcast`. One instance is shared across every
 * extension (constructed once by createExtensionPlatform, same lifetime as
 * `createEventBus`); each extension incarnation binds its own handle here
 * and that handle is the only thing host-surfaces.ts's `ui` surface talks
 * to.
 *
 * "Incarnation" identity: NOT `Date.now()` (host-process.ts's `DbOwner`
 * uses that for a coarse cross-boundary staleness comparison, tolerant of
 * collisions — see coordinator.ts's `sameOwner`). This registry needs an
 * identity that is unique per spawn() call even under a synchronous
 * respawn (spawn -> immediate exit -> respawn inside the same millisecond,
 * exactly what a crash-loop test drives), so it is keyed on
 * `DbOwner.handle` (`${extensionId}:${randomUUID()}`), which host-process.ts
 * already mints fresh per incarnation.
 */
import type { ManifestTier } from './manifest';

export interface UiRegistrationOwner {
  incarnation: string;
  tier: ManifestTier;
}

export interface UiBroadcastEvent {
  extensionId: string;
  name: string;
  payload: unknown;
}

/** Bound to ONE extension incarnation — returned by `UiRegistry.bind()`.
 *  Every method is synchronous: registration acknowledgement is "this call
 *  returned without throwing," which is what lets host-surfaces.ts's async
 *  RPC dispatch (`router.dispatch` always wraps a handler's return in a
 *  promise) make `host.ui.handle()` resolve ONLY once this has run — never
 *  optimistically, since the child's promise IS the RPC round trip. */
export interface UiIncarnation {
  /** Registers `name` for this incarnation. Throws if this incarnation's
   *  registration channel is already closed (a stale incarnation trying to
   *  call into what is now a live successor), or if `name` is already
   *  registered by ANY live incarnation of this extension (duplicate). */
  handle(name: string): void;
  /** Removes `name` — but ONLY if this incarnation still owns it. A no-op
   *  for an unknown name or one a newer incarnation has since re-claimed
   *  (this incarnation's stale unhandle must never rip out a live one's
   *  registration). Never throws. */
  unhandle(name: string): void;
  /** Emits a `UiBroadcastEvent` to every `onBroadcast` subscriber. Throws
   *  if this incarnation's registration channel is closed — a dead
   *  incarnation's push must not reach a live renderer. Broadcasting does
   *  NOT require a prior `handle()` for `name` (ui.notify's precedent:
   *  fire-and-forget, no registration concept). */
  broadcast(name: string, payload: unknown): void;
  /** Closes this incarnation's registration channel and synchronously
   *  drops every name it owns. Idempotent — safe to call from both the
   *  lifecycle-signal abort listener (the synchronous, load-bearing path)
   *  and buildSurfaces()'s own async `close()` (the explicit backstop). */
  close(): void;
}

export interface UiRegistry {
  bind(
    extensionId: string,
    incarnation: string,
    tier: ManifestTier,
  ): UiIncarnation;
  /** Who currently owns (extensionId, name) — undefined when nobody does
   *  (a live extension that never called handle(), an extension that isn't
   *  running, or one whose incarnation has since closed). This is the ONE
   *  read path `ext:invoke` dispatch consults; it can never return a
   *  closed incarnation's entry because `close()` deletes synchronously. */
  resolve(extensionId: string, name: string): UiRegistrationOwner | undefined;
  /** Every name currently registered for `extensionId`, across whichever
   *  incarnation is live. Exists so a test (or an operator surface) can
   *  assert ZERO table entries after a failed activation / a
   *  stop-during-activate, rather than inferring it indirectly. */
  namesFor(extensionId: string): string[];
  /** Fired on every successful `broadcast()` — createExtensionPlatform
   *  relays this to `ext:push`. */
  onBroadcast(cb: (evt: UiBroadcastEvent) => void): () => void;
}

interface Registration {
  incarnation: string;
  tier: ManifestTier;
}

interface ExtState {
  /** name -> who owns it right now. */
  handlers: Map<string, Registration>;
  /** Incarnations whose registration channel has been closed — checked by
   *  `handle()`/`broadcast()` so a stale incarnation can never write into
   *  (or push through) what is now a live successor's state, even for an
   *  RPC call that was already in flight when teardown started. */
  closed: Set<string>;
}

export function createUiRegistry(): UiRegistry {
  const byExtension = new Map<string, ExtState>();
  const subs = new Set<(evt: UiBroadcastEvent) => void>();

  function stateFor(extensionId: string): ExtState {
    let s = byExtension.get(extensionId);
    if (!s) {
      s = { handlers: new Map(), closed: new Set() };
      byExtension.set(extensionId, s);
    }
    return s;
  }

  return {
    bind(extensionId, incarnation, tier) {
      const state = stateFor(extensionId);
      return {
        handle(name) {
          if (state.closed.has(incarnation)) {
            throw new Error(
              `cannot register ui handler '${name}': this extension incarnation has already been torn down`,
            );
          }
          if (state.handlers.has(name)) {
            throw new Error(`ui handler '${name}' is already registered`);
          }
          state.handlers.set(name, { incarnation, tier });
        },
        unhandle(name) {
          if (state.handlers.get(name)?.incarnation === incarnation) {
            state.handlers.delete(name);
          }
        },
        broadcast(name, payload) {
          if (state.closed.has(incarnation)) {
            throw new Error(
              'cannot broadcast: this extension incarnation has already been torn down',
            );
          }
          subs.forEach((cb) => cb({ extensionId, name, payload }));
        },
        close() {
          if (state.closed.has(incarnation)) return;
          state.closed.add(incarnation);
          for (const [name, owner] of state.handlers) {
            if (owner.incarnation === incarnation) state.handlers.delete(name);
          }
        },
      };
    },
    resolve(extensionId, name) {
      return byExtension.get(extensionId)?.handlers.get(name);
    },
    namesFor(extensionId) {
      const state = byExtension.get(extensionId);
      return state ? [...state.handlers.keys()] : [];
    },
    onBroadcast(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}
