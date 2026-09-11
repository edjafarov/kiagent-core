import { pluginIdentifier } from '@shared/plugin-sql';

export interface PluginAuthorizerOptions { pluginId: string; tables: readonly string[]; indexes?: readonly string[]; views?: readonly string[]; triggers?: readonly string[]; }
const denied = /^sqlite_/i;
export function ownedNamespace(pluginId: string): string { return `p_${Buffer.from(pluginId, 'utf8').toString('hex')}__`; }
export function createPluginAuthorizer(options: PluginAuthorizerOptions) {
  const owned = new Set([...options.tables, ...(options.indexes ?? [])].map((n) => pluginIdentifier(options.pluginId, n).replaceAll('"', '')));
  for (const n of options.views ?? []) owned.add(pluginIdentifier(options.pluginId, n).replaceAll('"', ''));
  for (const n of options.triggers ?? []) owned.add(pluginIdentifier(options.pluginId, n).replaceAll('"', ''));
  let schemaWrite = false;
  let privateTransaction = false;
  let schemaMode = false;
  const allowedFunctions = new Set(['abs', 'coalesce', 'count', 'date', 'datetime', 'ifnull', 'julianday', 'json', 'json_array', 'json_extract', 'json_object', 'length', 'lower', 'max', 'min', 'nullif', 'printf', 'row_number', 'round', 'strftime', 'substr', 'sum', 'total', 'upper']);
  const authorizer = (...args: unknown[]): number => {
    const action = typeof args[0] === 'number' ? args[0] : -1;
    const table = typeof args[1] === 'string' ? args[1] : '';
    const db = typeof args[3] === 'string' ? args[3] : '';
    if (db && db !== 'main' && db !== 'temp') return 1;
    if (action === 22) return privateTransaction ? 0 : 1;
    if (action === 33) return 0;
    if (!table) {
      if (action === 31) return typeof args[2] === 'string' && allowedFunctions.has(args[2] as string) ? 0 : 1;
      if (action === 21) return 0;
      return 1;
    }
    // SQLite consults sqlite_master while compiling DDL. Permit those internal
    // CREATE/UPDATE callbacks, while denying reads and schema introspection.
    if (table === 'sqlite_master' || table === 'sqlite_schema') {
      if (action === 18) { if (!schemaMode) return 1; schemaWrite = true; return 0; }
      if (schemaMode && (action === 20 || action === 23)) return 0;
      return 1;
    }
    if ([1, 7].includes(action)) {
      const target = typeof args[2] === 'string' ? args[2] : '';
      return schemaMode && owned.has(table) && owned.has(target) ? 0 : 1;
    }
    if ([2, 8].includes(action)) return schemaMode && owned.has(table) ? 0 : 1;
    if ([3, 4, 5, 6, 10, 11, 12, 13].includes(action)) return schemaMode && owned.has(table) ? 0 : 1;
    if (action === 27) return schemaMode && owned.has(table) ? 0 : 1;
    if (action === 26) {
      const target = typeof args[2] === 'string' ? args[2] : '';
      return schemaMode && owned.has(target) ? 0 : 1;
    }
    if ([19, 24, 25, 26, 27, 28, 29, 30, 32].includes(action)) return 1;
    if (denied.test(table)) return 1;
    if (table.startsWith(ownedNamespace(options.pluginId))) return owned.has(table) ? 0 : 1;
    return 1;
  };
  (authorizer as typeof authorizer & { reset: () => void; setPrivateTransaction: (enabled: boolean) => void; setSchemaMode: (enabled: boolean) => void }).reset = () => { schemaWrite = false; };
  (authorizer as typeof authorizer & { setPrivateTransaction: (enabled: boolean) => void }).setPrivateTransaction = (enabled) => { privateTransaction = enabled; };
  (authorizer as typeof authorizer & { setSchemaMode: (enabled: boolean) => void }).setSchemaMode = (enabled) => { schemaMode = enabled; schemaWrite = false; };
  return authorizer;
}
