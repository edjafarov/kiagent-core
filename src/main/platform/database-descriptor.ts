import { formatPluginSql } from '@shared/plugin-sql';

export interface PluginDatabaseDescriptor {
  format: 1;
  objects: { name: string; kind: 'table' | 'index' | 'view' | 'trigger' }[];
  modules: { name: string; migrations: { version: number; statements: string[] }[] }[];
  legacy: {
    tables: { name: string; columns: string[] }[];
    versionTable?: string;
    userVersionModule?: string;
  };
}

const NAME = /^[a-z][a-z0-9_]*$/;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
const fail = (message: string): never => { throw new Error(`invalid database descriptor: ${message}`); };

export function parseDatabaseDescriptor(value: unknown): PluginDatabaseDescriptor {
  if (!isRecord(value) || !exact(value, ['format', 'objects', 'modules', 'legacy'])) fail('expected object with format, objects, modules and legacy');
  const root = value as Record<string, unknown>;
  if (root.format !== 1 || !Array.isArray(root.objects) || !Array.isArray(root.modules) || !isRecord(root.legacy)) fail('invalid top-level fields');
  const objects = (root.objects as unknown[]).map((o: unknown, i: number) => {
    if (!isRecord(o) || !exact(o, ['name', 'kind']) || typeof o.name !== 'string' || !NAME.test(o.name) || !['table', 'index', 'view', 'trigger'].includes(String(o.kind))) fail(`invalid object at ${i}`);
    const object = o as Record<string, unknown>;
    return { name: object.name as string, kind: object.kind as PluginDatabaseDescriptor['objects'][number]['kind'] };
  });
  if (new Set(objects.map((o) => o.name)).size !== objects.length) fail('duplicate object name');
  const registered = new Set(objects.map((o) => o.name));
  const modules = (root.modules as unknown[]).map((m: unknown, i: number) => {
    if (!isRecord(m)) fail(`invalid module at ${i}`);
    const module = m as Record<string, unknown>;
    if (!isRecord(m) || !exact(m, ['name', 'migrations']) || typeof m.name !== 'string' || !NAME.test(m.name) || !Array.isArray(m.migrations)) fail(`invalid module at ${i}`);
    let prior = -1;
    const migrations = (module.migrations as unknown[]).map((migration: unknown, j: number) => {
      if (!isRecord(migration) || !exact(migration, ['version', 'statements']) || !Number.isInteger(migration.version) || (migration.version as number) < 0 || !Array.isArray(migration.statements) || migration.statements.some((s) => typeof s !== 'string')) fail(`invalid migration at ${i}.${j}`);
      const migrationRecord = migration as Record<string, unknown>;
      const version = migrationRecord.version as number;
      if (version <= prior) fail(`migration versions must ascend at ${i}`);
      prior = version;
      const statements = migrationRecord.statements as string[];
      for (const statement of statements) {
        try { formatPluginSql('descriptor', statement, [...registered]); } catch (error) { fail(`invalid migration SQL at ${i}.${j}: ${(error as Error).message}`); }
      }
      return { version, statements };
    });
    return { name: module.name as string, migrations };
  });
  if (new Set(modules.map((m) => m.name)).size !== modules.length) fail('duplicate module name');
  const legacy = root.legacy as Record<string, unknown>;
  if (!exact(legacy, ['tables', 'versionTable', 'userVersionModule']) || !Array.isArray(legacy.tables)) fail('invalid legacy section');
  const tables = (legacy.tables as unknown[]).map((table: unknown, i: number) => {
    if (!isRecord(table) || !exact(table, ['name', 'columns']) || typeof table.name !== 'string' || !NAME.test(table.name) || !registered.has(table.name) || !Array.isArray(table.columns) || table.columns.some((c) => typeof c !== 'string' || !c)) fail(`invalid legacy table at ${i}`);
    const tableRecord = table as Record<string, unknown>;
    return { name: tableRecord.name as string, columns: tableRecord.columns as string[] };
  });
  const versionTable = legacy.versionTable;
  const userVersionModule = legacy.userVersionModule;
  if (versionTable !== undefined && (typeof versionTable !== 'string' || !NAME.test(versionTable) || !registered.has(versionTable))) fail('invalid versionTable');
  if (userVersionModule !== undefined && (typeof userVersionModule !== 'string' || !NAME.test(userVersionModule) || !modules.some((m: { name: string }) => m.name === userVersionModule))) fail('invalid userVersionModule');
  return { format: 1, objects, modules, legacy: { tables, ...(typeof versionTable === 'string' ? { versionTable } : {}), ...(typeof userVersionModule === 'string' ? { userVersionModule } : {}) } };
}
