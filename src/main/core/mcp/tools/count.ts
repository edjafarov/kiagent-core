/**
 * `count` — document totals per connected source, or grouped by
 * sender/label. `group_by: 'source'` enumerates `accounts()` and sums
 * per-account `Query.count` calls. `group_by: 'from' | 'label'` delegates to
 * `Query.countBy`, merging across accounts when `source` is given. Any other
 * aggregation belongs in `query_sql` (see `get_schema` for the tables/
 * columns).
 */
import type { Query } from '@shared/contracts';

export const COUNT_GROUP_BY_VALUES = ['source', 'from', 'label'] as const;
export type CountGroupBy = (typeof COUNT_GROUP_BY_VALUES)[number];

export const countDescription = `Aggregate document counts, optionally filtered by \`source\`/\`type\`/\`from_date\`/\`to_date\`.
\`group_by\`: 'source' (per connected source), 'from' (per sender, email-ish docs), 'label' (per gmail label). "How many mails per sender this week" = \`{group_by:'from', from_date:...}\`. For anything else use \`query_sql\` (see \`get_schema\`).`;

export const countInputSchema = {
  type: 'object',
  properties: {
    source: { type: 'string' },
    type: { type: 'string' },
    group_by: { type: 'string', enum: [...COUNT_GROUP_BY_VALUES] },
    from_date: { type: 'string' },
    to_date: { type: 'string' },
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
      from_date?: string;
      to_date?: string;
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
          total += await query.count({
            type: a.type,
            account: acc.id,
            fromDate: a.from_date,
            toDate: a.to_date,
          });
      } else {
        total = await query.count({
          type: a.type,
          fromDate: a.from_date,
          toDate: a.to_date,
        });
      }
      return [{ key: 'all', count: total }];
    }

    if (a.group_by === 'source') {
      const bySource = new Map<string, number>();
      for (const acc of targets) {
        const c = await query.count({
          type: a.type,
          account: acc.id,
          fromDate: a.from_date,
          toDate: a.to_date,
        });
        bySource.set(acc.source, (bySource.get(acc.source) ?? 0) + c);
      }
      return [...bySource.entries()].map(([key, c]) => ({ key, count: c }));
    }

    if (a.group_by === 'from' || a.group_by === 'label') {
      const opts = {
        field: a.group_by,
        type: a.type,
        fromDate: a.from_date,
        toDate: a.to_date,
      } as const;
      if (!a.source) return query.countBy(opts);
      const merged = new Map<string, number>();
      for (const acc of targets) {
        for (const row of await query.countBy({ ...opts, account: acc.id })) {
          merged.set(row.key, (merged.get(row.key) ?? 0) + row.count);
        }
      }
      return [...merged.entries()]
        .map(([key, n]) => ({ key, count: n }))
        .sort((x, y) => y.count - x.count || (x.key < y.key ? -1 : 1));
    }

    throw new Error(
      `count: group_by '${a.group_by}' isn't supported directly — use query_sql (see get_schema) for grouped aggregations. Supported here: 'source', 'from', 'label'.`,
    );
  };
}
