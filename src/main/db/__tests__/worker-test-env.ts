import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Repo root (this file lives in src/main/db/__tests__). */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
/** The TS source of the DB worker entry (run under ts-node, never the bundle). */
export const WORKER_ENTRY = path.join(__dirname, '..', 'worker-entry.ts');

/**
 * `execArgv` for spawning TS sources in a Worker / child process, copied from
 * db-worker.test.ts: Node's native type-stripping must be off so ts-node
 * transpiles to CJS, and a tiny preload redirects the bare `better-sqlite3`
 * specifier (which `src/node_modules` would resolve to the Electron-ABI
 * junction) to the repo-root copy built for plain Node.
 */
export function createWorkerEnv(label: string): {
  execArgv: string[];
  preloadPath: string;
  cleanup(): void;
} {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const preloadPath = path.join(
    os.tmpdir(),
    `kiagent-${label}-preload-${unique}.js`,
  );
  const target = path
    .join(REPO_ROOT, 'node_modules', 'better-sqlite3')
    .replace(/\\/g, '\\\\');
  fs.writeFileSync(
    preloadPath,
    `const Module = require('module');
const target = ${JSON.stringify(target)};
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'better-sqlite3') {
    return orig.call(this, target, ...rest);
  }
  return orig.apply(this, [request, ...rest]);
};
`,
  );
  return {
    preloadPath,
    execArgv: [
      '--no-experimental-strip-types',
      '-r',
      preloadPath,
      '-r',
      'ts-node/register/transpile-only',
      '-r',
      'tsconfig-paths/register',
    ],
    cleanup: () => {
      if (fs.existsSync(preloadPath)) fs.rmSync(preloadPath);
    },
  };
}
