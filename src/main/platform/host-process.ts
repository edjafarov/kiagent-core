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
import type {
  Cap,
  EventMeta,
  ExtensionStatus,
  SendIntent,
  SendResult,
  SenderContext,
  Source,
} from '@shared/contracts';
import type { Contributions, MainToChild } from '@shared/extension-rpc';
import type { FileChange } from '@shared/plugin-files';
import type { LogSink } from '@main/core/engine/engine';
import type { DbOwner } from '@main/db/coordinator';
import { randomUUID } from 'node:crypto';

import { createHostRouter } from './host-router';
import type { Surfaces } from './host-surfaces';
import { createSourceProxySet } from './source-proxy';
import {
  createRpcEndpoint,
  type HostTransport,
  type RpcCallOptions,
} from './transport';

const CRASH_LOOP_MAX = 3;
const CRASH_LOOP_WINDOW_MS = 60_000;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function stopError(): Error & { code: string } {
  return Object.assign(new Error('operation aborted'), {
    name: 'AbortError',
    code: 'RPC_ABORTED',
  });
}

export interface HostDeps {
  extensionId: string;
  entryAbsPath: string;
  dataDir: string;
  caps: Cap[];
  transportFactory(): HostTransport;
  makeSurfaces(
    deliverEvent: (name: string, payload: unknown, meta: EventMeta) => void,
    context?: { owner: DbOwner; signal: AbortSignal },
    deliverFileChange?: (watchId: number, event: FileChange) => void,
  ):
    | {
        surfaces: Surfaces;
        close(): void | Promise<void>;
      }
    | Promise<{
        surfaces: Surfaces;
        close(): void | Promise<void>;
      }>;
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
  cleanup(): Promise<void>;
  cleanupDone?: Promise<void>;
  owner: DbOwner;
}

export function createExtensionHost(deps: HostDeps): {
  start(): Promise<void>;
  stop(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** B1: invokes a name the extension registered via `host.ui.handle()`.
   *  Mirrors `callTool` exactly — same `current`-not-null guard, same
   *  single-argument call shape — just over the 'ui' namespace instead of
   *  'tool'. The caller (extension-platform.ts's `callUi`) is responsible
   *  for checking the ui-registry BEFORE calling this, so a name this
   *  incarnation never registered surfaces as the child's own "unknown ui
   *  handler" rejection, not a platform-level unknown-destination case. */
  callUi(
    name: string,
    payload: unknown,
    options?: Pick<RpcCallOptions, 'timeoutMs'>,
  ): Promise<unknown>;
  callSender(
    sourceId: string,
    intent: SendIntent,
    ctx: SenderContext,
  ): Promise<SendResult>;
} {
  const now = deps.now ?? Date.now;
  const killAfterMs = deps.killAfterMs ?? 2000;
  const scope = `extension:${deps.extensionId}`;
  let stopping = false;
  let stopped = true;
  let current: Incarnation | null = null;
  const crashes: number[] = [];
  let pendingSpawn: Promise<void> | null = null;
  let pendingSpawnAbort: (() => void) | null = null;

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
    let offExit: (() => void) | null = null;
    let proxySet: ReturnType<typeof createSourceProxySet> | null = null;
    let surfacesHandle: {
      surfaces: Surfaces;
      close(): void | Promise<void>;
    } | null = null;
    let exited = false;
    let abortPending: ((e: Error) => void) | null = null;
    let cleanup: (() => Promise<void>) | null = null;
    let incarnation: Incarnation | null = null;
    const lifecycle = new AbortController();
    const abortSpawn = () => {
      lifecycle.abort();
      transport?.kill();
    };
    pendingSpawnAbort = abortSpawn;
    const owner: DbOwner = {
      kind: 'plugin',
      extensionId: deps.extensionId,
      handle: `${deps.extensionId}:${randomUUID()}`,
      incarnation: Date.now(),
    };

    try {
      transport = deps.transportFactory();
      endpoint = createRpcEndpoint(transport);
      proxySet = createSourceProxySet(endpoint);
      let cleanupPromise: Promise<void> | undefined;
      cleanup = () => {
        cleanupPromise ??= (async () => {
          const teardownError = stopping
            ? stopError()
            : new Error('extension process exited');
          lifecycle.abort();
          proxySet?.abortAll(teardownError);
          proxySet?.dispose();
          await surfacesHandle?.close();
          endpoint?.dispose(teardownError);
          offExit?.();
          offExit = null;
          unregister?.();
          unregister = null;
        })();
        return cleanupPromise;
      };
      const onExit = (code: number | null) => {
        if (exited) return;
        exited = true;
        lifecycle.abort();
        abortPending?.(
          stopping ? stopError() : new Error('extension process exited'),
        );
        abortPending = null;
        const disposed = cleanup?.() ?? Promise.resolve();
        if (incarnation) incarnation.cleanupDone = disposed;
        if (current === incarnation) current = null;
        if (stopping || stopped) return;
        crashes.push(now());
        while (crashes.length > 0 && now() - crashes[0] > CRASH_LOOP_WINDOW_MS)
          crashes.shift();
        deps.logSink.log(
          scope,
          'warn',
          'extension process exited unexpectedly',
          { code },
        );
        if (crashes.length >= CRASH_LOOP_MAX) {
          stopped = true;
          const msg = `crash loop: ${CRASH_LOOP_MAX} crashes in ${CRASH_LOOP_WINDOW_MS / 1000}s`;
          deps.onStatus('errored', msg);
          rejectStart(new Error(msg));
          return;
        }
        launchSpawn();
      };
      offExit = transport.onExit(onExit);
      const preparedSurfaces = deps.makeSurfaces(
        (name, payload, meta) =>
          endpoint!.post({
            kind: 'event',
            name,
            payload,
            meta,
          } satisfies MainToChild),
        { owner, signal: lifecycle.signal },
        (watchId, event) =>
          endpoint!.post({ kind: 'file-change', watchId, event }),
      );
      surfacesHandle =
        preparedSurfaces instanceof Promise
          ? await preparedSurfaces
          : preparedSurfaces;
      if (exited) {
        await surfacesHandle.close();
        return;
      }
      const router = createHostRouter({
        extensionId: deps.extensionId,
        granted: new Set(deps.caps),
        surfaces: surfacesHandle!.surfaces,
        logSink: deps.logSink,
      });
      endpoint.onCall((ns, method, args, context) =>
        ns === 'auth' || ns === 'session'
          ? proxySet!.handleCall(ns, method, args)
          : router.dispatch(ns, method, args, context),
      );

      incarnation = { endpoint, transport, cleanup, owner };
      current = incarnation;

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
      } satisfies MainToChild);
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
      unregister = deps.registerContributions(
        contributions,
        proxySet!.makeSource,
      );
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
      lifecycle.abort();
      abortPending = null;
      await cleanup?.();
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
    } finally {
      if (pendingSpawnAbort === abortSpawn) pendingSpawnAbort = null;
    }
  }

  function launchSpawn(): void {
    const run = spawn();
    pendingSpawn = run;
    void run.finally(() => {
      if (pendingSpawn === run) pendingSpawn = null;
    });
  }

  return {
    async start() {
      stopping = false;
      stopped = false;
      crashes.length = 0;
      return new Promise<void>((resolve, reject) => {
        startResolve = resolve;
        startReject = reject;
        launchSpawn();
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
      pendingSpawnAbort?.();
      const inc = current;
      if (inc) {
        const exited = new Promise<void>((resolve) => {
          inc.transport.onExit(() => resolve());
        });
        inc.endpoint.post({ kind: 'deactivate' } satisfies MainToChild);
        // The BACKSTOP, not the stop path. `await exited` below is normally
        // resolved by the child's own exit(0), posted after its deactivate()
        // returns — so a well-behaved extension is fully awaited. This timer
        // exists only for one that never gets there.
        //
        // It is not free: firing it resolves `exited` and lets stop() return,
        // after which the platform may activate a successor while the
        // predecessor's teardown is STILL RUNNING. For a forked child that is
        // an acceptable trade (kill() really does reclaim the process). For
        // the in-process tier kill() is simulateExit() and reclaims nothing,
        // so firing early buys no resources and only creates that race —
        // which is why the in-process tier is given a far more generous
        // budget (see extension-platform.ts's transportFactory).
        //
        // Either way, an overrun is a real event and must not be silent.
        const timer = setTimeout(() => {
          deps.logSink.log(scope, 'warn', 'deactivate-overran-kill-backstop', {
            killAfterMs,
          });
          inc.transport.kill();
        }, killAfterMs);
        await exited;
        await inc.cleanupDone;
        clearTimeout(timer);
      }
      const pending = pendingSpawn;
      if (pending) await pending;
      stopping = false;
      deps.onStatus('disabled');
    },
    callTool(name, args) {
      if (!current)
        return Promise.reject(new Error('extension is not running'));
      return current.endpoint.call('tool', name, [args]);
    },
    callUi(name, payload, options) {
      if (!current)
        return Promise.reject(new Error('extension is not running'));
      return current.endpoint.call('ui', name, [payload], options);
    },
    // Reachable only from the send pipeline, i.e. only past a confirmation
    // gate. A child that has no sender for `sourceId` — including a pre-1.2
    // child with no 'send' namespace at all — rejects cleanly; callers must
    // read that as "no sender", never crash on it.
    callSender(sourceId, intent, ctx) {
      if (!current)
        return Promise.reject(new Error('extension is not running'));
      return current.endpoint.call('send', sourceId, [
        intent,
        ctx,
      ]) as Promise<SendResult>;
    },
  };
}
