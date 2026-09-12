/**
 * Process transports for extension hosts + the bidirectional call/reply
 * endpoint both sides speak. utilityProcess does not exist under jest, so
 * everything above the transport is written against WireChannel/HostTransport
 * and tested over the in-memory pair or child_process.fork.
 */
import { fork } from 'child_process';

import type { ChildToMain } from '@shared/extension-rpc';
import { wireErrorCode, type WireErrorCode } from '@shared/source-errors';

export interface WireChannel {
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): () => void;
  close(): void;
}

export interface HostTransport extends WireChannel {
  onExit(cb: (code: number | null) => void): () => void;
  kill(): void;
}

export function createInMemoryHostPair(): {
  main: HostTransport;
  child: WireChannel;
  simulateExit(code: number | null): void;
} {
  const toChild = new Set<(m: unknown) => void>();
  const toMain = new Set<(m: unknown) => void>();
  const exitCbs = new Set<(code: number | null) => void>();
  let closed = false;
  const deliver = (subs: Set<(m: unknown) => void>, msg: unknown) => {
    if (closed) return;
    queueMicrotask(() => {
      if (!closed) subs.forEach((cb) => cb(msg));
    });
  };
  const simulateExit = (code: number | null) => {
    if (closed) return;
    closed = true;
    exitCbs.forEach((cb) => cb(code));
  };
  return {
    main: {
      send: (m) => deliver(toChild, m),
      onMessage: (cb) => {
        toMain.add(cb);
        return () => toMain.delete(cb);
      },
      onExit: (cb) => {
        exitCbs.add(cb);
        return () => exitCbs.delete(cb);
      },
      kill: () => simulateExit(null),
      close: () => simulateExit(null),
    },
    child: {
      send: (m) => deliver(toMain, m),
      onMessage: (cb) => {
        toChild.add(cb);
        return () => toChild.delete(cb);
      },
      close: () => simulateExit(0),
    },
    simulateExit,
  };
}

export function nodeForkTransport(
  modulePath: string,
  opts?: { execArgv?: string[]; env?: NodeJS.ProcessEnv; cwd?: string },
): HostTransport {
  const cp = fork(modulePath, [], {
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    execArgv: opts?.execArgv ?? [],
    env: opts?.env ?? process.env,
    cwd: opts?.cwd,
  });
  cp.on('error', () => {
    /* The exit listener owns recovery; do not surface a raced IPC error. */
  });
  return {
    send: (m) => {
      try {
        cp.send(m as object, () => {
          /* A callback turns an asynchronous channel-close into a no-op. */
        });
      } catch {
        /* raced an exit — the onExit path owns recovery */
      }
    },
    onMessage: (cb) => {
      cp.on('message', cb);
      return () => cp.off('message', cb);
    },
    onExit: (cb) => {
      const h = (code: number | null) => cb(code);
      cp.on('exit', h);
      return () => cp.off('exit', h);
    },
    kill: () => cp.kill(),
    close: () => cp.kill(),
  };
}

/** Prod transport. The RPC plumbing above it is covered over the other two
 *  transports; the fork options and output piping are covered with a mocked
 *  electron. */
export function utilityProcessTransport(
  modulePath: string,
  serviceName: string,
  // With onOutput the child runs with piped stdio and every output line is
  // delivered here — without it a crashing child's '[ext-host] uncaught: …'
  // write (its ONLY trace) is discarded and the log shows just exit code 1.
  onOutput?: (stream: 'stdout' | 'stderr', line: string) => void,
): HostTransport {
  // Lazy-required so importing this module under jest (no electron) is safe.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { utilityProcess } = require('electron') as typeof import('electron');
  const child = utilityProcess.fork(modulePath, [], {
    serviceName,
    stdio: onOutput ? 'pipe' : 'ignore',
  });
  if (onOutput) {
    const MAX_LINE = 4096;
    const wire = (
      name: 'stdout' | 'stderr',
      stream: NodeJS.ReadableStream | null | undefined,
    ) => {
      if (!stream) return;
      let buf = '';
      const emit = (raw: string) => {
        const line = raw.trimEnd();
        if (line) onOutput(name, line.slice(0, MAX_LINE));
      };
      stream.on('data', (chunk: Buffer | string) => {
        buf += chunk.toString();
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          emit(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf('\n');
        }
      });
      // A dying process can leave a final unterminated line — flush it.
      stream.on('end', () => {
        emit(buf);
        buf = '';
      });
    };
    wire('stdout', child.stdout);
    wire('stderr', child.stderr);
  }
  return {
    send: (m) => {
      try {
        child.postMessage(m);
      } catch {
        /* raced an exit — the onExit path owns recovery */
      }
    },
    onMessage: (cb) => {
      // UtilityProcess's main-side 'message' event delivers the message
      // itself (unlike the child's parentPort, which wraps it in a
      // MessageEvent) — no .data unwrap here.
      const h = (message: unknown) => cb(message);
      child.on('message', h);
      return () => {
        child.off('message', h);
      };
    },
    onExit: (cb) => {
      const h = (code: number) => cb(code);
      child.on('exit', h);
      return () => {
        child.off('exit', h);
      };
    },
    kill: () => {
      child.kill();
    },
    close: () => {
      child.kill();
    },
  };
}

export interface RpcEndpoint {
  call(
    ns: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions,
  ): Promise<unknown>;
  onCall(
    h: (
      ns: string,
      method: string,
      args: unknown[],
      context: RpcCallContext,
    ) => Promise<unknown>,
  ): void;
  post(msg: Record<string, unknown>): void;
  onNotify(
    cb: (msg: { kind: string } & Record<string, unknown>) => void,
  ): () => void;
  dispose(reason: string | Error): void;
}

export interface RpcCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  transactionId?: string;
  transactionBoundary?: boolean;
}

export interface RpcCallContext {
  signal: AbortSignal;
  transactionId?: string;
  transactionBoundary?: boolean;
  deadline?: number;
}

// The call/reply shapes come FROM the declared protocol rather than being
// restated here, so extension-rpc.ts can't drift from what this endpoint
// actually puts on the wire. Both are taken from the ChildToMain side: it is
// the wider of the two (MainToChild narrows `ns` to 'source'|'tool'|'send',
// which only the dispatch end — extension-host-entry's onCall — needs), and
// ONE endpoint implementation serves both directions.
//
// ReplyMsg's `code` is the source-error taxonomy carried symmetrically with
// the src-error NOTIFY direction: a rejected handler (e.g. a main-side
// session.credentials() whose refresher threw SourceAuthError) keeps its
// 'auth'/'permanent' classification across the call/reply leg, so an
// extension-hosted source's auth failure lands on 'needsReauth' exactly like
// a bundled one. sourceErrorCode narrows on both ends, so unrelated Node
// error codes (ENOENT, …) never leak through as a taxonomy code.
type CallMsg = Extract<ChildToMain, { kind: 'call' }>;
type ReplyMsg = Extract<ChildToMain, { kind: 'reply' }>;

// A rejected handler's class identity never survives the fork (structured
// clone / advanced serialization carries plain data, not prototypes) — so a
// caller on the other side of a `call` has to discriminate the rejection by
// `Error.name` plus a few plain fields, never `instanceof`. This allow-list
// covers the fields a caller on the far side is expected to READ, not every
// own property an error might carry: `ModelChangedError`'s
// `{ expected, actual, modelId, source }` (`src/shared/contracts.ts`).
// `NoProviderError.kind` (`src/main/core/inference.ts`) is an own enumerable
// field that also crosses this endpoint and is deliberately NOT here — a
// caller already knows which kind it asked for, so echoing it back buys
// nothing. `LaneClosedError` and every ordinary `Error` have none of these as
// OWN properties, so they cross with `errorFields` simply absent. Extend this
// list (never widen it to "every own key") the next time a new error type
// needs a field preserved across the boundary.
//
// `code` is here for the errno a scoped `host.files` call raises (`ENOENT`,
// `EEXIST`, `EACCES`, …): an in-process bundled plugin crosses this same
// endpoint, and a store that must tell "no manifest yet" from a real failure
// can only do so by that code (remote-mcp's cert storage, Documents'
// `classifyFsError`). It never becomes a TAXONOMY code: the reply leg sets the
// taxonomy `code` AFTER the allow-listed fields, so `'auth'`/`'permanent'`
// always win, and every main-side consumer narrows through
// `sourceErrorCode`/`wireErrorCode`, which map a bare errno to `undefined`.
const ERROR_FIELD_ALLOWLIST = [
  'expected',
  'actual',
  'modelId',
  'source',
  'code',
] as const;

// Duck-typed on purpose: a rejection raised by a native fs call, or by code
// loaded in another realm (a jest vm context, a worker), is an Error whose
// prototype chain does not reach THIS realm's `Error`, and `instanceof` then
// says no. What the wire needs is the shape — a string message, a name, the
// allow-listed fields — never the constructor identity.
function isErrorLike(e: unknown): e is Error {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { message?: unknown }).message === 'string'
  );
}

function errorWireFields(e: unknown): Record<string, unknown> | undefined {
  if (!isErrorLike(e)) return undefined;
  let fields: Record<string, unknown> | undefined;
  for (const key of ERROR_FIELD_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(e, key)) {
      fields ??= {};
      fields[key] = (e as unknown as Record<string, unknown>)[key];
    }
  }
  return fields;
}

// The receiving end applies the SAME allow-list, never a raw
// `Object.assign(err, wireFields)` — `errorFields` on an incoming reply is
// data from the OTHER side of this endpoint, which in the child→main
// direction is the untrusted forked extension (see host-surfaces.ts's
// "LOAD-BEARING ARITY" comment for the standing threat model). A bare
// `Object.assign` uses `[[Set]]` per key, so a hostile child sending
// `errorFields: { __proto__: {...} }` would repoint `err`'s own prototype.
// Copying only the allow-listed keys, one at a time, never reaches a key
// outside that fixed set.
function applyErrorWireFields(
  err: Error,
  fields: Record<string, unknown> | undefined,
): void {
  if (!fields) return;
  for (const key of ERROR_FIELD_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      (err as unknown as Record<string, unknown>)[key] = fields[key];
    }
  }
}

export function createRpcEndpoint(channel: WireChannel): RpcEndpoint {
  let nextId = 1;
  let disposed = false;
  const pending = new Map<
    number,
    {
      resolve(v: unknown): void;
      reject(e: Error): void;
      cleanup(): void;
    }
  >();
  const owned = new Map<number, AbortController>();
  const notifySubs = new Set<
    (msg: { kind: string } & Record<string, unknown>) => void
  >();
  let handler:
    | ((
        ns: string,
        method: string,
        args: unknown[],
        context: RpcCallContext,
      ) => Promise<unknown>)
    | null = null;

  const offMessage = channel.onMessage((raw) => {
    const msg = raw as { kind?: string };
    if (!msg || typeof msg.kind !== 'string') return;
    if (msg.kind === 'call') {
      const c = msg as CallMsg;
      const controller = new AbortController();
      owned.set(c.id, controller);
      const context: RpcCallContext = {
        signal: controller.signal,
        transactionId: c.transactionId,
        transactionBoundary: c.transactionBoundary,
        deadline: c.deadline,
      };
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      if (c.deadline !== undefined) {
        const remaining = Math.max(0, c.deadline - Date.now());
        deadlineTimer = setTimeout(() => controller.abort(), remaining);
      }
      const h = handler;
      const reply = (
        ok: boolean,
        value?: unknown,
        error?: string,
        code?: WireErrorCode,
        errorName?: string,
        errorFields?: Record<string, unknown>,
      ) =>
        channel.send({
          kind: 'reply',
          id: c.id,
          ok,
          value,
          error,
          code,
          errorName,
          errorFields,
        } satisfies ReplyMsg);
      if (!h) {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        owned.delete(c.id);
        reply(false, undefined, 'no call handler installed');
        return;
      }
      h(c.ns, c.method, c.args, context)
        .then(
          (value) => reply(true, value),
          (e) =>
            reply(
              false,
              undefined,
              isErrorLike(e) ? e.message : String(e),
              context.signal.aborted &&
                isErrorLike(e) &&
                e.name === 'AbortError'
                ? 'RPC_ABORTED'
                : wireErrorCode(e),
              isErrorLike(e) ? e.name : undefined,
              errorWireFields(e),
            ),
        )
        .finally(() => {
          if (deadlineTimer) clearTimeout(deadlineTimer);
          owned.delete(c.id);
        });
      return;
    }
    if (msg.kind === 'cancel') {
      const cancel = msg as { kind: 'cancel'; id: number };
      owned.get(cancel.id)?.abort();
      return;
    }
    if (msg.kind === 'reply') {
      const r = msg as ReplyMsg;
      const p = pending.get(r.id);
      if (!p) return;
      pending.delete(r.id);
      p.cleanup();
      if (r.ok) p.resolve(r.value);
      else {
        const err = new Error(r.error ?? 'remote error') as Error & {
          code?: string;
        };
        if (typeof r.errorName === 'string') err.name = r.errorName;
        // Allow-listed fields first (a bare errno `code` among them), the
        // taxonomy `code` last so it can never be shadowed by a wire field.
        applyErrorWireFields(err, r.errorFields);
        if (r.code) err.code = r.code;
        p.reject(err);
      }
      return;
    }
    notifySubs.forEach((cb) =>
      cb(msg as { kind: string } & Record<string, unknown>),
    );
  });

  return {
    call(ns, method, args, options) {
      if (disposed) return Promise.reject(new Error('endpoint disposed'));
      if (options?.signal?.aborted) {
        return Promise.reject(
          Object.assign(new Error('operation aborted'), {
            name: 'AbortError',
            code: 'RPC_ABORTED',
          }),
        );
      }
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const deadline =
          options?.timeoutMs === undefined
            ? undefined
            : Date.now() + Math.max(0, options.timeoutMs);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let offAbort: (() => void) | undefined;
        const abort = (error: Error) => {
          if (!pending.has(id)) return;
          pending.delete(id);
          if (timer) clearTimeout(timer);
          offAbort?.();
          channel.send({ kind: 'cancel', id });
          reject(error);
        };
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          offAbort?.();
        };
        const record = { resolve, reject, cleanup };
        pending.set(id, record);
        if (options?.signal) {
          const onAbort = () =>
            abort(
              Object.assign(new Error('operation aborted'), {
                name: 'AbortError',
                code: 'RPC_ABORTED',
              }),
            );
          options.signal.addEventListener('abort', onAbort, { once: true });
          offAbort = () =>
            options.signal!.removeEventListener('abort', onAbort);
        }
        if (deadline !== undefined) {
          timer = setTimeout(
            () =>
              abort(
                Object.assign(new Error('RPC call timed out'), {
                  name: 'TimeoutError',
                  code: 'RPC_DEADLINE_EXCEEDED',
                }),
              ),
            Math.max(0, options!.timeoutMs!),
          );
        }
        channel.send({
          kind: 'call',
          id,
          ns,
          method,
          args,
          deadline,
          transactionId: options?.transactionId,
          transactionBoundary: options?.transactionBoundary,
        } satisfies CallMsg);
      });
    },
    onCall(h) {
      handler = h;
    },
    post(msg) {
      if (!disposed) channel.send(msg);
    },
    onNotify(cb) {
      notifySubs.add(cb);
      return () => notifySubs.delete(cb);
    },
    dispose(reason) {
      if (disposed) return;
      disposed = true;
      offMessage();
      const err = reason instanceof Error ? reason : new Error(reason);
      pending.forEach((p) => {
        p.cleanup();
        p.reject(err);
      });
      pending.forEach((_p, id) => channel.send({ kind: 'cancel', id }));
      owned.forEach((controller) => controller.abort());
      pending.clear();
      owned.clear();
      notifySubs.clear();
    },
  };
}
