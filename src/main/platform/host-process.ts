/**
 * Per-extension process supervisor: fork → handshake → activate → register
 * proxies; on crash, clean teardown + restart behind a 3-in-60s breaker
 * (spec §3.3). Everything is written against HostTransport so jest drives
 * it over the in-memory pair with the real child runtime in-process.
 *
 * Incarnation ownership (race-condition fix): each spawn() call is one
 * "incarnation" of the extension process. Exactly one thing settles an
 * incarnation's outcome — either its transport.onExit handler (crash
 * restart, breaker give-up, or stop-completion) or its own handshake
 * try/catch (a genuine, non-crash failure) — never both. The `exited` flag
 * (local to each spawn() closure) is the arbiter: once the exit handler has
 * run for an incarnation, that incarnation's catch block becomes a no-op
 * for shared state and status emission — it can never null out a newer
 * `current` or fire a stale `errored` after that incarnation has already
 * been superseded. A pending handshake wait (waitNotify) is force-rejected
 * the instant its incarnation exits via a registered abort callback, so it
 * never dangles until its own timeout (and its timer is always cleared).
 * start() itself is decoupled from any single spawn() call's promise: a
 * first-settle-wins resolver pair lets ANY incarnation (initial or
 * crash-respawned) resolve it by activating, so an early crash can never
 * fail start() out from under a respawn that goes on to activate.
 */
import type { Cap, ExtensionStatus, Source } from '@shared/contracts';
import type { Contributions } from '@shared/extension-rpc';
import type { LogSink } from '@main/core/engine/engine';

import { createHostRouter } from './host-router';
import type { Surfaces } from './host-surfaces';
import { createSourceProxySet } from './source-proxy';
import { createRpcEndpoint, type HostTransport } from './transport';

const CRASH_LOOP_MAX = 3;
const CRASH_LOOP_WINDOW_MS = 60_000;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface HostDeps {
  extensionId: string;
  entryAbsPath: string;
  dataDir: string;
  caps: Cap[];
  transportFactory(): HostTransport;
  makeSurfaces(deliverEvent: (name: string, payload: unknown) => void): {
    surfaces: Surfaces;
    close(): void;
  };
  logSink: LogSink;
  onStatus(status: ExtensionStatus, error?: string): void;
  registerContributions(
    c: Contributions,
    makeSource: (e: Contributions['sources'][number]) => Source,
  ): () => void;
  now?(): number;
  killAfterMs?: number;
  readyTimeoutMs?: number;
  activateTimeoutMs?: number;
}

interface Incarnation {
  endpoint: ReturnType<typeof createRpcEndpoint>;
  transport: HostTransport;
  cleanup(): void;
}

export function createExtensionHost(deps: HostDeps): {
  start(): Promise<void>;
  stop(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
} {
  const now = deps.now ?? Date.now;
  const killAfterMs = deps.killAfterMs ?? 2000;
  const scope = `extension:${deps.extensionId}`;
  let stopping = false;
  let stopped = true;
  let current: Incarnation | null = null;
  const crashes: number[] = [];

  // First-settle-wins gate for the in-flight start() call. ANY incarnation
  // (initial or crash-respawned) resolves it by activating. Breaker
  // give-up, a live (non-exited) incarnation's genuine handshake failure,
  // or stop() arriving before activation reject it. Whichever fires first
  // wins — both refs are cleared together so later calls are no-ops.
  let startResolve: (() => void) | null = null;
  let startReject: ((e: Error) => void) | null = null;
  const resolveStart = () => {
    const r = startResolve;
    startResolve = null;
    startReject = null;
    r?.();
  };
  const rejectStart = (e: Error) => {
    const r = startReject;
    startResolve = null;
    startReject = null;
    r?.(e);
  };

  function waitNotify(
    endpoint: Incarnation['endpoint'],
    kinds: string[],
    timeoutMs: number,
    what: string,
    setAbort: (fn: ((e: Error) => void) | null) => void,
  ): Promise<{ kind: string } & Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        setAbort(null);
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
      const off = endpoint.onNotify((m) => {
        if (!kinds.includes(m.kind)) return;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        setAbort(null);
        resolve(m);
      });
      // Registered last so the exit handler can force this wait to settle
      // the instant this incarnation exits, instead of dangling until
      // `timer` fires (possibly long after a respawn has already won).
      setAbort((e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        reject(e);
      });
    });
  }

  async function spawn(): Promise<void> {
    deps.onStatus('activating');
    // Hoisted so the catch block (and the crash-handler closure below) can
    // reach them with appropriate null-safety even if setup itself threw
    // before some/all of them were assigned — see the try/catch note above:
    // the WHOLE body must be covered so a setup throw can never become an
    // unhandled rejection (spawn() must never reject).
    let transport: HostTransport | undefined;
    let endpoint: ReturnType<typeof createRpcEndpoint> | undefined;
    let unregister: (() => void) | null = null;
    let exited = false;
    let abortPending: ((e: Error) => void) | null = null;
    let cleanup: (() => void) | null = null;
    let incarnation: Incarnation | null = null;

    try {
      transport = deps.transportFactory();
      endpoint = createRpcEndpoint(transport);
      const proxySet = createSourceProxySet(endpoint);
      const surfacesHandle = deps.makeSurfaces((name, payload) =>
        endpoint!.post({ kind: 'event', name, payload }),
      );
      const router = createHostRouter({
        extensionId: deps.extensionId,
        granted: new Set(deps.caps),
        surfaces: surfacesHandle.surfaces,
        logSink: deps.logSink,
      });
      endpoint.onCall((ns, method, args) =>
        ns === 'auth' || ns === 'session'
          ? proxySet.handleCall(ns, method, args)
          : router.dispatch(ns, method, args),
      );

      cleanup = () => {
        proxySet.abortAll('extension process exited');
        proxySet.dispose();
        surfacesHandle.close();
        endpoint!.dispose('extension process exited');
        unregister?.();
        unregister = null;
      };
      incarnation = { endpoint, transport, cleanup };
      current = incarnation;

      transport.onExit((code) => {
        if (exited) return;
        exited = true;
        abortPending?.(new Error('extension process exited'));
        abortPending = null;
        cleanup?.();
        if (current === incarnation) current = null;
        if (stopping || stopped) return;
        // Crash path: this incarnation exited unexpectedly, on its own.
        crashes.push(now());
        while (crashes.length > 0 && now() - crashes[0] > CRASH_LOOP_WINDOW_MS) crashes.shift();
        deps.logSink.log(scope, 'warn', 'extension process exited unexpectedly', { code });
        if (crashes.length >= CRASH_LOOP_MAX) {
          stopped = true;
          const msg = `crash loop: ${CRASH_LOOP_MAX} crashes in ${CRASH_LOOP_WINDOW_MS / 1000}s`;
          deps.onStatus('errored', msg);
          rejectStart(new Error(msg));
          return;
        }
        void spawn();
      });

      const readyOrError = waitNotify(
        endpoint,
        ['ready', 'errored'],
        deps.readyTimeoutMs ?? 10_000,
        'ready',
        (fn) => {
          abortPending = fn;
        },
      );
      endpoint.post({
        kind: 'bootstrap',
        v: 1,
        extensionId: deps.extensionId,
        entryAbsPath: deps.entryAbsPath,
        dataDir: deps.dataDir,
        caps: deps.caps,
      });
      const first = await readyOrError;
      if (first.kind === 'errored') throw new Error(String(first.error));
      const outcome = await waitNotify(
        endpoint,
        ['activated', 'errored'],
        deps.activateTimeoutMs ?? 30_000,
        'activation',
        (fn) => {
          abortPending = fn;
        },
      );
      if (outcome.kind === 'errored') throw new Error(String(outcome.error));
      if (stopping || stopped || exited) {
        // stop() landed mid-handshake and already owns this incarnation's
        // outcome (it rejected start() and will kill/await-exit this child
        // itself) — or this incarnation's own exit handler already ran.
        // Do NOT register contributions, emit 'activated', or resolve the
        // start gate; that would resurrect an outcome stop() already
        // settled. Just return — the transport's own exit/kill path (via
        // stop() or the exit handler above) performs cleanup.
        return;
      }
      const contributions = outcome.contributions as Contributions;
      unregister = deps.registerContributions(contributions, proxySet.makeSource);
      deps.onStatus('activated');
      resolveStart();
    } catch (e) {
      if (exited) {
        // transport.onExit already fired for this incarnation and owns its
        // outcome (restart, breaker give-up, or stop-completion). This
        // catch only ran because the aborted wait rejected — it must not
        // touch shared state or emit a stale status.
        return;
      }
      // Genuine failure while this incarnation is still alive (it never
      // crashed) — either a handshake failure, or setup itself threw
      // (synchronously, before any transport/endpoint may even exist) — we
      // are the one killing/tearing down whatever got created, and this is
      // the sole path that settles this incarnation's outcome.
      exited = true;
      abortPending = null;
      cleanup?.();
      transport?.kill();
      if (incarnation && current === incarnation) current = null;
      if (stopping) {
        // stop() already owns this outcome and will emit 'disabled' once
        // its own exit listener observes the teardown — no stale errored.
        return;
      }
      stopped = true;
      deps.onStatus('errored', errMsg(e));
      rejectStart(e instanceof Error ? e : new Error(errMsg(e)));
    }
  }

  return {
    async start() {
      stopping = false;
      stopped = false;
      crashes.length = 0;
      return new Promise<void>((resolve, reject) => {
        startResolve = resolve;
        startReject = reject;
        void spawn();
      });
    },
    async stop() {
      if (stopped && !current) {
        stopping = false;
        deps.onStatus('disabled');
        return;
      }
      stopping = true;
      stopped = true;
      rejectStart(new Error('extension host stopped before activation'));
      const inc = current;
      if (inc) {
        const exited = new Promise<void>((resolve) => {
          inc.transport.onExit(() => resolve());
        });
        inc.endpoint.post({ kind: 'deactivate' });
        const timer = setTimeout(() => inc.transport.kill(), killAfterMs);
        await exited;
        clearTimeout(timer);
      }
      stopping = false;
      deps.onStatus('disabled');
    },
    callTool(name, args) {
      if (!current) return Promise.reject(new Error('extension is not running'));
      return current.endpoint.call('tool', name, [args]);
    },
  };
}
