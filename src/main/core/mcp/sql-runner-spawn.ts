/**
 * Spawn adapters for the SQL runner (NOT the extension transport: the runner
 * needs `pid` and a SIGKILL force step, and it is not demoted — query_sql is
 * interactive work). The dbPath travels in `env.KIA_SQL_RUNNER_DB`, which both
 * child_process.fork and utilityProcess.fork support.
 */
import { fork } from 'child_process';

import type { RunnerChild } from './sql-runner';

/** child_process adapter — jest, and anything that is not Electron. */
export function forkRunnerChild(
  modulePath: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    execArgv?: string[];
    cwd?: string;
    serialization?: 'json' | 'advanced';
  } = {},
): RunnerChild {
  const cp = fork(modulePath, [], {
    execArgv: opts.execArgv ?? [],
    env: { ...process.env, ...opts.env },
    cwd: opts.cwd,
    serialization: opts.serialization ?? 'json',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  cp.on('error', () => {
    /* the exit listener owns recovery */
  });
  return {
    get pid() {
      return cp.pid;
    },
    send: (m) => {
      try {
        cp.send(m as object, () => {});
      } catch {
        /* raced an exit */
      }
    },
    onMessage: (cb) => {
      cp.on('message', cb);
    },
    onExit: (cb) => {
      cp.on('exit', (code) => cb(code));
    },
    kill: (signal) => {
      try {
        cp.kill(signal);
      } catch {
        /* already gone */
      }
    },
  };
}

/** Electron utilityProcess adapter — the packaged app. `kill('SIGTERM')` is
 *  utilityProcess.kill() (SIGTERM / TerminateProcess); SIGKILL is the force step
 *  through the pid. Verified by the release smoke on macOS and Windows. */
export function utilityRunnerChild(
  modulePath: string,
  env: Record<string, string>,
  onOutput?: (line: string) => void,
  opts: {
    serviceName?: string;
    /** utilityProcess `pid` is only valid after 'spawn' (transport.ts:129). */
    onSpawn?: (pid: number | undefined) => void;
  } = {},
): RunnerChild {
  // Lazy-required so importing this module under jest (no electron) is safe.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { utilityProcess } = require('electron') as typeof import('electron');
  const child = utilityProcess.fork(modulePath, [], {
    serviceName: opts.serviceName ?? 'kia-sql-runner',
    stdio: 'pipe',
    env: { ...process.env, ...env } as Record<string, string>,
  });
  if (opts.onSpawn) child.once('spawn', () => opts.onSpawn!(child.pid));
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (b: Buffer | string) => {
      const line = b.toString().trimEnd();
      if (line) onOutput?.(line.slice(0, 4096));
    });
  }
  return {
    get pid() {
      return child.pid;
    },
    send: (m) => child.postMessage(m),
    onMessage: (cb) => {
      child.on('message', cb);
    },
    onExit: (cb) => {
      child.on('exit', (code) => cb(code));
    },
    kill: (signal) => {
      if (signal === 'SIGTERM') {
        child.kill();
      } else if (child.pid !== undefined) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    },
  };
}
