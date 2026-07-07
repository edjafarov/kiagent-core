/**
 * Process transports for extension hosts + the bidirectional call/reply
 * endpoint both sides speak. utilityProcess does not exist under jest, so
 * everything above the transport is written against WireChannel/HostTransport
 * and tested over the in-memory pair or child_process.fork.
 */
import { fork } from 'child_process';

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
  return {
    send: (m) => {
      try {
        cp.send(m as object);
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
    const wire = (name: 'stdout' | 'stderr', stream: NodeJS.ReadableStream | null | undefined) => {
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
  call(ns: string, method: string, args: unknown[]): Promise<unknown>;
  onCall(h: (ns: string, method: string, args: unknown[]) => Promise<unknown>): void;
  post(msg: Record<string, unknown>): void;
  onNotify(cb: (msg: { kind: string } & Record<string, unknown>) => void): () => void;
  dispose(reason: string): void;
}

interface CallMsg { kind: 'call'; id: number; ns: string; method: string; args: unknown[] }
interface ReplyMsg { kind: 'reply'; id: number; ok: boolean; value?: unknown; error?: string }

export function createRpcEndpoint(channel: WireChannel): RpcEndpoint {
  let nextId = 1;
  let disposed = false;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const notifySubs = new Set<(msg: { kind: string } & Record<string, unknown>) => void>();
  let handler: ((ns: string, method: string, args: unknown[]) => Promise<unknown>) | null = null;

  const offMessage = channel.onMessage((raw) => {
    const msg = raw as { kind?: string };
    if (!msg || typeof msg.kind !== 'string') return;
    if (msg.kind === 'call') {
      const c = msg as CallMsg;
      const h = handler;
      const reply = (ok: boolean, value?: unknown, error?: string) =>
        channel.send({ kind: 'reply', id: c.id, ok, value, error } satisfies ReplyMsg);
      if (!h) {
        reply(false, undefined, 'no call handler installed');
        return;
      }
      h(c.ns, c.method, c.args).then(
        (value) => reply(true, value),
        (e) => reply(false, undefined, e instanceof Error ? e.message : String(e)),
      );
      return;
    }
    if (msg.kind === 'reply') {
      const r = msg as ReplyMsg;
      const p = pending.get(r.id);
      if (!p) return;
      pending.delete(r.id);
      if (r.ok) p.resolve(r.value);
      else p.reject(new Error(r.error ?? 'remote error'));
      return;
    }
    notifySubs.forEach((cb) => cb(msg as { kind: string } & Record<string, unknown>));
  });

  return {
    call(ns, method, args) {
      if (disposed) return Promise.reject(new Error('endpoint disposed'));
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        channel.send({ kind: 'call', id, ns, method, args } satisfies CallMsg);
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
      const err = new Error(reason);
      pending.forEach((p) => p.reject(err));
      pending.clear();
      notifySubs.clear();
    },
  };
}
