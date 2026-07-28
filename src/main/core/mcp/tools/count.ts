/**
 * `count` — document totals per connected source. `Query.count` only supports
 * {type, account, includeArchived} — no GROUP BY primitive — so the only
 * grouping offered is `group_by: 'source'` (enumerate `accounts()` and sum
 * per-account counts). Any other aggregation belongs in `query_sql` (see
 * `get_schema` for the tables/columns).
 */
import type { Query } from '@shared/contracts';

export const COUNT_GROUP_BY_VALUES = ['source'] as const;
export type CountGroupBy = (typeof COUNT_GROUP_BY_VALUES)[number];

export const countDescription = `Aggregate document counts, optionally filtered by \`source\`/\`type\`.
\`group_by: 'source'\` groups by connected account's source id. For any other grouped aggregation use \`query_sql\` (see \`get_schema\`).`;

export const countInputSchema = {
  type: 'object',
  properties: {
    source: { type: 'string' },
    type: { type: 'string' },
    group_by: { type: 'string', enum: [...COUNT_GROUP_BY_VALUES] },
  },
} as const;

export function makeCountTool(query: Query) {
  return async function count(
    args: Record<string, unknown>,
  ): Promise<Array<{ key: string; count: number }>> {
    const a = args as {
      source?: string;
      type?: string;
      group_by?: CountGroupBy;
    };

    const accounts = await query.accounts();
    let targets = accounts;
    if (a.source) {
      targets = accounts.filter((acc) => acc.source === a.source);
      if (targets.length === 0) return [{ key: 'all', count: 0 }];
    }

    if (!a.group_by) {
      let total = 0;
      if (a.source) {
        for (const acc of targets)
          total += await query.count({ type: a.type, account: acc.id });
      } else {
        total = await query.count({ type: a.type });
      }
      return [{ key: 'all', count: total }];
    }

    if (a.group_by === 'source') {
      const bySource = new Map<string, number>();
      for (const acc of targets) {
        const c = await query.count({ type: a.type, account: acc.id });
        bySource.set(acc.source, (bySource.get(acc.source) ?? 0) + c);
      }
      return [...bySource.entries()].map(([key, c]) => ({ key, count: c }));
    }

    throw new Error(
      `count: group_by '${a.group_by}' isn't supported directly — use query_sql (see get_schema) for grouped aggregations. Supported here: 'source'.`,
    );
  };
}
