/**
 * `count` — ported from kiagent-ref's src/main/mcp/tools/count.ts. Legacy
 * grouped by arbitrary SQL expressions (source, type, language, sender
 * address, month, label, tracked_root, mime_type) against the raw table.
 * `Query.count` only supports {type, account, includeArchived} — no GROUP BY
 * primitive at all — so only `group_by: 'source'` is really answerable here
 * (by enumerating `accounts()` and summing per-account counts). The other
 * legacy group_by values need raw SQL (query_sql/get_schema), which are
 * intentionally NOT ported (see server.ts) — this tool reports a clear error
 * for those rather than silently returning wrong/partial data.
 */
import type { Query } from '@shared/contracts';

export const COUNT_GROUP_BY_VALUES = [
  'source',
  'type',
  'language',
  'sender_address',
  'month',
  'label',
  'tracked_root',
  'mime_type',
] as const;
export type CountGroupBy = (typeof COUNT_GROUP_BY_VALUES)[number];

export const countDescription = `Aggregate document counts, optionally filtered by \`source\`/\`type\`.
\`group_by: 'source'\` is supported (grouped by connected account's source id). Other legacy group_by values (type, language, sender_address, month, label, tracked_root, mime_type) require raw SQL access, which this build does not expose over MCP — they will error rather than return partial data.`;

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
      `count: group_by '${a.group_by}' requires raw SQL access (query_sql/get_schema), which this MCP build does not expose. Supported without it: 'source'.`,
    );
  };
}
