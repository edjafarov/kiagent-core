import type {
  AppDb,
  AppDbParam,
  BatchParam,
  BatchStep,
  BatchStepResult,
} from './app-db';
import type { PluginDbRequest } from './plugin-operations';
import type { DbCoordinator, DbOwner } from './coordinator';

/**
 * Request/response protocol between the main process (client) and the worker
 * thread that owns the better-sqlite3 connection (host). Messages cross a
 * structured-clone boundary: bigint survives, Buffer arrives as Uint8Array on
 * the far side (rewrapped below), Date is coerced to ISO text BEFORE sending
 * so SQLite sees exactly what the in-process wrapper would have bound.
 */

type WireParam = Exclude<AppDbParam, Date | boolean> | Uint8Array;

type ReqBody =
  | { op: 'exec'; sql: string }
  | { op: 'all' | 'run'; sql: string; params: WireParam[] }
  | {
      op: 'batch';
      steps: { sql: string; params: (WireParam | FromStepRef)[] }[];
    }
  | { op: 'proc'; name: string; args: unknown }
  | { op: 'backup'; destination: string }
  | { op: 'close' };
type PluginReqBody = { op: 'plugin'; request: PluginDbRequest };
type CancelReqBody = { op: 'plugin-cancel'; requestId: number };
type Req = (ReqBody | PluginReqBody | CancelReqBody) & { id: number };

/** A host-registered procedure: runs synchronously inside the worker (it owns
 *  its own `db.transaction()`), receives the structured-clone-transferred args,
 *  and returns a structured-clone-able result. */
export type HostProcedure = (args: unknown) => unknown | Promise<unknown>;

interface FromStepRef {
  $fromStep: number;
  column: string;
}

type Res =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { message: string; code?: string } };

/** The subset of MessagePort/Worker both sides need. */
export interface PortLike {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (value: unknown) => void): this | void;
}

function isFromStepRef(p: unknown): p is FromStepRef {
  return (
    p !== null &&
    typeof p === 'object' &&
    !(p instanceof Date) &&
    !(p instanceof Uint8Array) &&
    '$fromStep' in (p as Record<string, unknown>)
  );
}

/** Date/boolean → SQLite-bindable, applied client-side (mirrors coerceParam). */
function toWire(p: AppDbParam): WireParam {
  if (p instanceof Date) return p.toISOString();
  if (typeof p === 'boolean') return p ? 1 : 0;
  return p;
}

/** Structured clone delivers Buffers as plain Uint8Array — rewrap. */
function toBuffer(v: unknown): unknown {
  if (v instanceof Uint8Array && !Buffer.isBuffer(v)) {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  }
  return v;
}

function rewrapRow(row: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(row)) {
    const wrapped = toBuffer(v);
    if (wrapped !== v) {
      if (!out) out = { ...row };
      out[k] = wrapped;
    }
  }
  return out ?? row;
}

/**
 * Attach the host side to a port: executes every request against `db` (the
 * in-process AppDb that owns the real connection) and replies with the result.
 * better-sqlite3 calls are synchronous under the hood, so requests are served
 * strictly in arrival order — concurrent in-flight client calls cannot
 * interleave inside SQLite.
 */
export function attachDbHost(
  port: PortLike,
  db: AppDb,
  onClosed?: () => void,
  procedures?: Record<string, HostProcedure>,
  options?: {
    plugin?: (
      request: PluginDbRequest,
      signal?: AbortSignal,
    ) => Promise<unknown> | unknown;
    coordinator?: DbCoordinator;
    coreOwner?: DbOwner;
  },
): void {
  const pluginControllers = new Map<number, AbortController>();
  const cancelledPluginRequests = new Set<number>();
  port.on('message', async (raw: unknown) => {
    const req = raw as Req;
    if (req.op === 'plugin-cancel') {
      const controller = pluginControllers.get(req.requestId);
      if (controller) controller.abort();
      else cancelledPluginRequests.add(req.requestId);
      return;
    }
    if (!req || typeof req.id !== 'number') return;
    try {
      let value: unknown;
      const core = options?.coreOwner ?? {
        kind: 'core' as const,
        handle: 'core',
      };
      const admit = <T>(work: () => Promise<T> | T, operation: string) =>
        options?.coordinator?.run(
          core,
          undefined,
          work,
          undefined,
          operation,
        ) ?? Promise.resolve(work());
      if (req.op === 'exec') {
        await admit(() => db.exec(req.sql), 'core.exec');
      } else if (req.op === 'all') {
        value = await admit(
          () => db.all(req.sql, req.params.map(toBuffer) as AppDbParam[]),
          'core.all',
        );
      } else if (req.op === 'run') {
        await admit(
          () => db.run(req.sql, req.params.map(toBuffer) as AppDbParam[]),
          'core.run',
        );
      } else if (req.op === 'batch') {
        value = await admit(
          () =>
            db.batch(
              req.steps.map((s) => ({
                sql: s.sql,
                params: s.params.map((p) =>
                  isFromStepRef(p) ? p : (toBuffer(p) as AppDbParam),
                ) as BatchParam[],
              })),
            ),
          'core.batch',
        );
      } else if (req.op === 'proc') {
        const proc = procedures?.[req.name];
        if (!proc) throw new Error(`unknown db procedure: ${req.name}`);
        value = await admit(() => proc(req.args), `core.proc:${req.name}`);
      } else if (req.op === 'backup') {
        if (!db._conn) throw new Error('worker backup is unavailable');
        await admit(() => db._conn!.backup(req.destination), 'core.backup');
      } else if (req.op === 'close') {
        await db.close();
      } else if (req.op === 'plugin') {
        if (!options?.plugin)
          throw new Error('plugin database service unavailable');
        const controller = new AbortController();
        pluginControllers.set(req.id, controller);
        if (cancelledPluginRequests.delete(req.id)) controller.abort();
        try {
          value = await options.plugin(
            (req as Req & PluginReqBody).request,
            controller.signal,
          );
        } finally {
          pluginControllers.delete(req.id);
        }
      }
      port.postMessage({ id: req.id, ok: true, value } satisfies Res);
      if (req.op === 'close') onClosed?.();
    } catch (e) {
      const err = e as Error & { code?: string };
      port.postMessage({
        id: req.id,
        ok: false,
        error: { message: err.message ?? String(e), code: err.code },
      } satisfies Res);
    }
  });
}

export interface DbClient extends AppDb {
  /** Fail every in-flight and future request — called when the worker dies. */
  _markDead(err: Error): void;
}

/** Create the client side: an AppDb whose every call is an RPC over `port`. */
export function createDbClient(port: PortLike): DbClient {
  let nextId = 1;
  let dead: Error | null = null;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      cleanup?: () => void;
    }
  >();

  port.on('message', (raw: unknown) => {
    const res = raw as Res;
    if (!res || typeof res.id !== 'number') return;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    p.cleanup?.();
    if (res.ok) {
      p.resolve(res.value);
    } else {
      const err = new Error(res.error.message) as Error & { code?: string };
      if (res.error.code) err.code = res.error.code;
      p.reject(err);
    }
  });

  function request(
    msg: ReqBody | PluginReqBody,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (dead) return Promise.reject(dead);
    if (signal?.aborted)
      return Promise.reject(
        Object.assign(new Error('database operation cancelled'), {
          code: 'DB_OPERATION_CANCELLED',
        }),
      );
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      let cleanup: (() => void) | undefined;
      pending.set(id, {
        resolve,
        reject,
        get cleanup() {
          return cleanup;
        },
        set cleanup(value) {
          cleanup = value;
        },
      });
      port.postMessage({ ...msg, id });
      if (signal) {
        const cancel = () => {
          port.postMessage({ op: 'plugin-cancel', requestId: id });
          const current = pending.get(id);
          if (current) {
            pending.delete(id);
            current.cleanup?.();
            current.reject(
              Object.assign(new Error('database operation cancelled'), {
                code: 'DB_OPERATION_CANCELLED',
              }),
            );
          }
        };
        signal.addEventListener('abort', cancel, { once: true });
        cleanup = () => signal.removeEventListener('abort', cancel);
      }
    });
  }

  return {
    exec: async (sql) => {
      await request({ op: 'exec', sql });
    },
    all: async (sql, params = []) => {
      const rows = (await request({
        op: 'all',
        sql,
        params: params.map(toWire),
      })) as Record<string, unknown>[];
      return rows.map(rewrapRow);
    },
    run: async (sql, params = []) => {
      await request({ op: 'run', sql, params: params.map(toWire) });
    },
    batch: async (steps: BatchStep[]) => {
      const results = (await request({
        op: 'batch',
        steps: steps.map((s) => ({
          sql: s.sql,
          params: (s.params ?? []).map((p) =>
            isFromStepRef(p) ? p : toWire(p as AppDbParam),
          ),
        })),
      })) as BatchStepResult[];
      return results.map((r) => (r.row ? { ...r, row: rewrapRow(r.row) } : r));
    },
    proc: async (name, args) => request({ op: 'proc', name, args }),
    backup: async (destination) => {
      await request({ op: 'backup', destination });
    },
    plugin: async (pluginRequest, options) =>
      request(
        { op: 'plugin', request: pluginRequest } as PluginReqBody,
        options?.signal,
      ),
    isOpen: () => !closed && !dead,
    close: async () => {
      if (closed || dead) return;
      closed = true;
      await request({ op: 'close' });
    },
    _markDead: (err: Error) => {
      dead = err;
      closed = true;
      for (const [, p] of pending) {
        p.cleanup?.();
        p.reject(err);
      }
      pending.clear();
    },
  };
}
