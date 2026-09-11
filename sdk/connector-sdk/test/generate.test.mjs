import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = (f) => join(sdkRoot, '..', '..', 'src', 'shared', f);
const gen = (f) => join(sdkRoot, 'src', 'generated', f);

const GENERATED_SHARED = [
  'contracts.ts',
  'source-errors.ts',
  'file-indexability.ts',
  'message-evidence.ts',
  'plugin-db.ts',
  'plugin-files.ts',
  'plugin-net.ts',
  'plugin-sql.ts',
];

for (const f of GENERATED_SHARED) {
  test(`generated ${f} is byte-identical to canonical`, () => {
    assert.equal(readFileSync(gen(f), 'utf8'), readFileSync(core(f), 'utf8'));
  });
}

test('compiled entrypoint exposes the taxonomy', async () => {
  assert.ok(existsSync(join(sdkRoot, 'dist', 'index.js')));
  const sdk = await import(join(sdkRoot, 'dist', 'index.js'));
  const e = new sdk.SourceAuthError('x');
  assert.equal(e.code, 'auth');
  assert.equal(sdk.sourceErrorCode(e), 'auth');
});

test('generated shared closure uses only local imports and no unchecked declarations', () => {
  for (const f of GENERATED_SHARED) {
    assert.ok(existsSync(gen(f)), `missing generated dependency ${f}`);
    const source = readFileSync(gen(f), 'utf8');
    assert.doesNotMatch(source, /from\s+['"](?:@shared\/|src\/shared\/)/);
    assert.doesNotMatch(source, /@ts-(?:ignore|nocheck|expect-error)/);
  }
});

test('built root exports SQL helpers and compiles a published-package consumer', async () => {
  const sdk = await import(join(sdkRoot, 'dist', 'index.js'));
  assert.equal(
    sdk.pluginIdentifier('publisher.connector', 'settings'),
    '"p_7075626c69736865722e636f6e6e6563746f72__settings"',
  );
  assert.equal(
    sdk.formatPluginSql('publisher.connector', 'SELECT * FROM {{settings}}', ['settings']),
    'SELECT * FROM "p_7075626c69736865722e636f6e6e6563746f72__settings"',
  );

  const project = mkdtempSync(join(tmpdir(), 'connector-sdk-consumer-'));
  try {
    const packageDir = join(project, 'node_modules', '@kiagent', 'connector-sdk');
    mkdirSync(dirname(packageDir), { recursive: true });
    symlinkSync(sdkRoot, packageDir, 'dir');
    writeFileSync(
      join(project, 'consumer.ts'),
      `import { formatPluginSql, pluginIdentifier } from '@kiagent/connector-sdk';
import type {
  FileEntry,
  FileInfo,
  FileRef,
  HostFor,
  PluginDatabaseDescriptor,
  PluginDb,
  PluginDbParams,
  PluginDbSession,
  PluginDbStep,
  PluginNet,
  PluginNetInit,
  PluginNetResult,
  ScopedFileHandle,
  ScopedFiles,
} from '@kiagent/connector-sdk';

declare const db: PluginDb;
declare const files: ScopedFiles;
declare const net: PluginNet;

const params: PluginDbParams = [null, 'text', 7, 7n, true, new Date(), new Uint8Array([1])];
const step: PluginDbStep = { sql: 'SELECT 1', params, mode: 'query' };
const session: PluginDbSession = db;
const descriptor: PluginDatabaseDescriptor = {
  format: 1,
  objects: [{ name: 'settings', kind: 'table' }],
  modules: [{ name: 'main', migrations: [{ version: 0, statements: ['CREATE TABLE {{settings}} (id TEXT)'] }] }],
  legacy: { tables: [{ name: 'settings', columns: ['id'] }] },
};
const ref: FileRef = { root: 'approved-root', rel: 'state.json' };
const handle: ScopedFileHandle = { id: 'opaque' };
const info: FileInfo = {
  kind: 'file', size: 2, blocks: 1, mtimeMs: 1.25, dev: '1', ino: '2',
  nlink: 1, mode: 0o600, symbolicLink: false,
};
const entry: FileEntry = { ...info, name: 'state.json' };
const netInit: PluginNetInit = {
  signal: new AbortController().signal, timeoutMs: 5000, method: 'POST',
  headers: { 'content-type': 'application/json' }, body: new Uint8Array([1]),
};
const netResult: PluginNetResult = {
  status: 200, statusText: 'OK', headers: {}, body: new Uint8Array(),
};
const host: HostFor<'db' | 'files' | 'net'> = {
  self: { id: 'publisher.connector', dataDir: '/approved' }, log: () => {},
  db, files, net,
};

async function exercise(): Promise<void> {
  await db.exec('CREATE TABLE {{settings}} (id TEXT)', params);
  await db.query<{ id: string }>('SELECT id FROM {{settings}}', params);
  await db.batch([step]);
  await db.transaction(async (tx) => {
    await tx.exec('INSERT INTO {{settings}} VALUES (?)', ['x']);
    await tx.query('SELECT id FROM {{settings}}');
    await tx.batch([step]);
  });
  await db.migrate('main', 0, descriptor.modules[0].migrations[0].statements);
  await files.write(ref, new Uint8Array([1, 2]), { atomic: true, mode: 0o600 });
  await files.write(ref, new Uint8Array([3]), { ifAbsent: true });
  await files.fstat(handle);
  const init: PluginNetInit = netInit;
  const result: PluginNetResult = await net.fetch('https://example.test', init);
  void [pluginIdentifier('publisher.connector', 'settings'), formatPluginSql('publisher.connector', '{{settings}}', ['settings']), session, entry, host, result, netResult];
}

void exercise;
`,
    );
    const tsc = join(sdkRoot, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(
      process.execPath,
      [
		tsc,
		'--noEmit',
		'--strict',
		'--module',
		'commonjs',
		'--target',
		'es2022',
		'--moduleResolution',
		'node',
		'--skipLibCheck',
		join(project, 'consumer.ts'),
      ],
      { cwd: project, encoding: 'utf8', stdio: 'pipe' },
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
