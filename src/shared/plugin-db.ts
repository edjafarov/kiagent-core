/** Values accepted by the plugin database bridge. Unsupported objects,
 * undefined and non-finite numbers are rejected by the runtime adapter. */
export type PluginDbParams = unknown[];

export interface PluginDbStep {
  sql: string;
  params?: PluginDbParams;
  mode?: 'exec' | 'query';
}

export interface PluginDbSession {
  exec(sql: string, params?: PluginDbParams): Promise<void>;
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: PluginDbParams,
  ): Promise<Row[]>;
  batch(steps: readonly PluginDbStep[]): Promise<unknown[][]>;
}

/**
 * Shared plugin database contract. Integer policy is explicit at this
 * boundary: safe-range integers may be represented as numbers, while larger
 * integers remain bigint; binary values are Uint8Array and booleans/dates are
 * normalized by the bridge. The native authorizer remains the security floor.
 */
export interface PluginDb extends PluginDbSession {
  identifier(name: string): string;
  transaction<T>(work: (tx: PluginDbSession) => Promise<T>): Promise<T>;
  migrate(module: string, version: number, statements: readonly string[]): Promise<void>;
}
