/** @jest-environment node */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDbInWorker } from '../worker-client';

it('forwards plugin requests through the production worker client wrapper', async () => {
  const file = path.join(os.tmpdir(), `plugin-worker-${process.pid}-${Date.now()}.sqlite`);
  const preload = path.join(os.tmpdir(), `plugin-worker-preload-${process.pid}-${Date.now()}.js`);
  const rootBetter = path.join(path.resolve(__dirname, '..', '..', '..', '..'), 'node_modules', 'better-sqlite3');
  fs.writeFileSync(preload, `const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){return r==='better-sqlite3'?o.call(this,${JSON.stringify(rootBetter)},...a):o.apply(this,[r,...a])}`);
  const db = await openDbInWorker(file, require.resolve('./fixtures/plugin-worker-entry.ts'), {
    execArgv: ['--no-experimental-strip-types', '-r', preload, '-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'],
  });
  await expect(db.plugin?.({ op: 'diagnostics' })).resolves.toEqual({ op: 'diagnostics' });
  await db.close();
  for (const p of [file, `${file}-wal`, `${file}-shm`, preload]) if (fs.existsSync(p)) fs.rmSync(p);
});
