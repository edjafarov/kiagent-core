import { pluginIdentifier } from '@shared/plugin-sql';

export interface PluginAuthorizerOptions {
  pluginId: string;
  tables: readonly string[];
  indexes?: readonly string[];
  views?: readonly string[];
  triggers?: readonly string[];
  /** Host-only registry metadata names. The mode is toggled around fixed
   * registry statements and is never exposed through PluginDb. */
  hostMetadataTables?: readonly string[];
  /** Logical names of the plugin's tables that are copied between devices, and
   *  the subset it may still write on a follower (step 2). */
  synced?: readonly string[];
  ownerCapture?: readonly string[];
  /** Asked per statement; must not run SQL. A follower, a joining device or a
   *  fenced master is read-only. */
  readOnly?: () => boolean;
}
const denied = /^sqlite_/i;
export function ownedNamespace(pluginId: string): string {
  return `p_${Buffer.from(pluginId, 'utf8').toString('hex')}__`;
}
export function createPluginAuthorizer(options: PluginAuthorizerOptions) {
  let owned = new Set(
    [...options.tables, ...(options.indexes ?? [])].map((n) =>
      pluginIdentifier(options.pluginId, n).replaceAll('"', ''),
    ),
  );
  for (const n of options.views ?? [])
    owned.add(pluginIdentifier(options.pluginId, n).replaceAll('"', ''));
  for (const n of options.triggers ?? [])
    owned.add(pluginIdentifier(options.pluginId, n).replaceAll('"', ''));
  const physical = (n: string) => pluginIdentifier(options.pluginId, n).replaceAll('"', '');
  const syncedTables = new Set((options.synced ?? []).map(physical));
  const captured = new Set((options.ownerCapture ?? []).map(physical));
  let refusedByRole: string | null = null;
  let privateTransaction = false;
  let schemaMode = false;
  let explicitSchemaSelect = false;
  const allowedFunctions = new Set([
    'abs',
    'coalesce',
    'count',
    'date',
    'datetime',
    'glob',
    'ifnull',
    'julianday',
    'json',
    'json_array',
    'json_extract',
    'json_object',
    'length',
    'like',
    'lower',
    'max',
    'min',
    'nullif',
    'printf',
    'row_number',
    'round',
    'replace',
    'rtrim',
    'strftime',
    'substr',
    'sum',
    'total',
    'trim',
    'upper',
  ]);
  const hostMetadata = new Set(options.hostMetadataTables ?? []);
  let hostMetadataMode = false;
  const authorizer = (...args: unknown[]): number => {
    const action = typeof args[0] === 'number' ? args[0] : -1;
    const table = typeof args[1] === 'string' ? args[1] : '';
    const db = typeof args[3] === 'string' ? args[3] : '';
    if (db && db !== 'main' && db !== 'temp') return 1;
    const trigger = typeof args[4] === 'string' ? args[4] : '';
    // The change tracker's own triggers write what they track and read the
    // switch, whoever fired them.
    if (trigger.startsWith('sync_')) {
      if (table === 'sync_rows' && (action === 18 || action === 9 || action === 23)) return 0;
      if (table === 'sync_state' && action === 20) return 0;
      if (table === 'sqlite_sequence') return 0;
    }
    if (action === 22) return privateTransaction ? 0 : 1;
    if (action === 33) return 0;
    if (!table) {
      if (action === 31)
        return typeof args[2] === 'string' &&
          allowedFunctions.has(args[2] as string)
          ? 0
          : 1;
      if (action === 21) {
        explicitSchemaSelect = schemaMode && !hostMetadataMode;
        return 0;
      }
      return 1;
    }
    // SQLite consults sqlite_master while compiling DDL. Permit those internal
    // CREATE/UPDATE callbacks, while denying reads and schema introspection.
    if (table === 'sqlite_master' || table === 'sqlite_schema') {
      if (action === 18) {
        if (!schemaMode) return 1;
        return 0;
      }
      if (action === 20 || action === 23) {
        if (hostMetadataMode) return 0;
        if (schemaMode) return explicitSchemaSelect ? 1 : 0;
      }
      return 1;
    }
    if ([1, 7].includes(action)) {
      const target = typeof args[2] === 'string' ? args[2] : '';
      if (schemaMode && /^sqlite_autoindex_/i.test(table)) {
        const base = table
          .replace(/^sqlite_autoindex_/i, '')
          .replace(/_[0-9]+$/i, '');
        if (owned.has(base) || (hostMetadataMode && hostMetadata.has(base)))
          return 0;
      }
      return schemaMode &&
        ((owned.has(table) && owned.has(target)) ||
          (hostMetadataMode &&
            hostMetadata.has(table) &&
            hostMetadata.has(target)))
        ? 0
        : 1;
    }
    if ([2, 8].includes(action))
      return schemaMode &&
        (owned.has(table) ||
          (hostMetadataMode &&
            (hostMetadata.has(table) || table === 'sqlite_sequence')) ||
          (table === 'sqlite_sequence' && owned.size > 0))
        ? 0
        : 1;
    if ([3, 4, 5, 6, 10, 11, 12, 13].includes(action))
      return schemaMode &&
        (owned.has(table) || (hostMetadataMode && hostMetadata.has(table)))
        ? 0
        : 1;
    if (action === 27)
      return schemaMode &&
        (owned.has(table) || (hostMetadataMode && hostMetadata.has(table)))
        ? 0
        : 1;
    if (action === 26) {
      const target = typeof args[2] === 'string' ? args[2] : '';
      return schemaMode && owned.has(target) ? 0 : 1;
    }
    if (hostMetadataMode && action === 19) {
      const pragma = typeof args[1] === 'string' ? args[1].toLowerCase() : '';
      return [
        'foreign_key_check',
        'foreign_key_list',
        'foreign_keys',
        'table_info',
        'table_list',
      ].includes(pragma)
        ? 0
        : 1;
    }
    if ([19, 24, 25, 26, 27, 28, 29, 30, 32].includes(action)) return 1;
    if ([9, 18, 23].includes(action) && syncedTables.has(table)) {
      // One write authority per copied table: on a follower only the master's
      // delta writes it, except rows this device is capturing itself.
      if (options.readOnly?.() && !captured.has(table)) {
        refusedByRole = table;
        return 1;
      }
    }
    if (hostMetadataMode && table === 'sqlite_sequence') return 0;
    if (denied.test(table)) return 1;
    if (hostMetadataMode && hostMetadata.has(table)) return 0;
    if (owned.has(table)) return 0;
    if (table.startsWith(ownedNamespace(options.pluginId))) return 1;
    return 1;
  };
  (
    authorizer as typeof authorizer & {
      reset: () => void;
      setPrivateTransaction: (enabled: boolean) => void;
      setSchemaMode: (enabled: boolean) => void;
    }
  ).reset = () => {
    explicitSchemaSelect = false;
    refusedByRole = null;
  };
  (
    authorizer as typeof authorizer & {
      takeRoleRefusal: () => string | null;
    }
  ).takeRoleRefusal = () => {
    const t = refusedByRole;
    refusedByRole = null;
    return t;
  };
  (
    authorizer as typeof authorizer & {
      setPrivateTransaction: (enabled: boolean) => void;
    }
  ).setPrivateTransaction = (enabled) => {
    privateTransaction = enabled;
  };
  (
    authorizer as typeof authorizer & {
      setSchemaMode: (enabled: boolean) => void;
    }
  ).setSchemaMode = (enabled) => {
    schemaMode = enabled;
    explicitSchemaSelect = false;
  };
  (
    authorizer as typeof authorizer & {
      setHostMetadataMode: (enabled: boolean) => void;
    }
  ).setHostMetadataMode = (enabled) => {
    hostMetadataMode = enabled;
  };
  (
    authorizer as typeof authorizer & {
      setOwnedObjects: (names: readonly string[]) => void;
    }
  ).setOwnedObjects = (names) => {
    owned = new Set(names);
  };
  return authorizer;
}
