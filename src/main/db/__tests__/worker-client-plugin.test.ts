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

it('cancels a queued real plugin write through openDbInWorker', async () => {
  const file = path.join(os.tmpdir(), `plugin-worker-cancel-${process.pid}-${Date.now()}.sqlite`);
  const preload = path.join(os.tmpdir(), `plugin-worker-cancel-preload-${process.pid}-${Date.now()}.js`);
  const rootBetter = path.join(path.resolve(__dirname, '..', '..', '..', '..'), 'node_modules', 'better-sqlite3');
  fs.writeFileSync(preload, `const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){return r==='better-sqlite3'?o.call(this,${JSON.stringify(rootBetter)},...a):o.apply(this,[r,...a])}`);
  const db = await openDbInWorker(file, require.resolve('./fixtures/plugin-worker-entry.ts'), { execArgv: ['--no-experimental-strip-types', '-r', preload, '-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'] });
  await db.exec('CREATE TABLE "p_70__items"(v INTEGER)');
  const owner = { kind: 'plugin' as const, extensionId: 'p', handle: 'worker-one' };
  const other = { kind: 'plugin' as const, extensionId: 'p', handle: 'worker-two' };
  await db.plugin?.({ op: 'open', owner, pluginId: 'p', tables: ['items'] });
  await db.plugin?.({ op: 'open', owner: other, pluginId: 'p', tables: ['items'] });
  const token = (await db.plugin?.({ op: 'begin', owner })) as string;
  const preAbort = new AbortController();
  preAbort.abort();
  await expect(db.plugin?.({ op: 'exec', owner, token, sql: 'INSERT INTO {{items}} VALUES (?)', params: [8] }, { signal: preAbort.signal })).rejects.toMatchObject({ code: 'DB_OPERATION_CANCELLED' });
  const abort = new AbortController();
  const queued = db.plugin?.({ op: 'exec', owner: other, sql: 'INSERT INTO {{items}} VALUES (?)', params: [9] }, { signal: abort.signal });
  abort.abort();
  await expect(queued).rejects.toMatchObject({ code: 'DB_OPERATION_CANCELLED' });
  await db.plugin?.({ op: 'commit', owner, token });
  await expect(db.all('SELECT COUNT(*) AS c FROM "p_70__items"')).resolves.toEqual([{ c: 0 }]);
  await db.plugin?.({ op: 'release', owner });
  await db.plugin?.({ op: 'release', owner: other });
  await db.close();
  for (const p of [file, `${file}-wal`, `${file}-shm`, preload]) if (fs.existsSync(p)) fs.rmSync(p);
});
