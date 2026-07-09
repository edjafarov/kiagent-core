import type {
  AppDb,
  AppDbParam,
  BatchParam,
  BatchStep,
  BatchStepResult,
} from './app-db';

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
  | { op: 'close' };
type Req = ReqBody & { id: number };

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
): void {
  port.on('message', async (raw: unknown) => {
    const req = raw as Req;
    if (!req || typeof req.id !== 'number') return;
    try {
      let value: unknown;
      if (req.op === 'exec') {
        await db.exec(req.sql);
      } else if (req.op === 'all') {
        value = await db.all(req.sql, req.params.map(toBuffer) as AppDbParam[]);
      } else if (req.op === 'run') {
        await db.run(req.sql, req.params.map(toBuffer) as AppDbParam[]);
      } else if (req.op === 'batch') {
        value = await db.batch(
          req.steps.map((s) => ({
            sql: s.sql,
            params: s.params.map((p) =>
              isFromStepRef(p) ? p : (toBuffer(p) as AppDbParam),
            ) as BatchParam[],
          })),
        );
      } else if (req.op === 'close') {
        await db.close();
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
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  port.on('message', (raw: unknown) => {
    const res = raw as Res;
    if (!res || typeof res.id !== 'number') return;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.ok) {
      p.resolve(res.value);
    } else {
      const err = new Error(res.error.message) as Error & { code?: string };
      if (res.error.code) err.code = res.error.code;
      p.reject(err);
    }
  });

  function request(msg: ReqBody): Promise<unknown> {
    if (dead) return Promise.reject(dead);
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port.postMessage({ ...msg, id });
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
    isOpen: () => !closed && !dead,
    close: async () => {
      if (closed || dead) return;
      closed = true;
      await request({ op: 'close' });
    },
    _markDead: (err: Error) => {
      dead = err;
      closed = true;
      for (const [, p] of pending) p.reject(err);
      pending.clear();
    },
  };
}
