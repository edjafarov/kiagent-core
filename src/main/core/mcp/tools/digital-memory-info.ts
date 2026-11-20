/**
 * `digital_memory_info` — ported from kiagent-ref's
 * src/main/mcp/tools/digital-memory-info.ts. Legacy computed exact counts by
 * source/type/language and an exact min/max date range with raw SQL
 * aggregates. `Query` has no distinct-value or MIN/MAX primitive, so:
 *  - `accounts` and `counts.by_source` are EXACT (built from `accounts()`
 *    plus one `count()` per account — cheap, bounded by account count).
 *  - `counts.by_type` discovers the set of types from a bounded recency
 *    sample, then upgrades each discovered type to an EXACT count via
 *    `query.count({type})` — correct for every type that appears in the
 *    sample, but a type used only outside the sampled window won't show up.
 *  - `counts.by_language` and `date_range` stay sample-based (approximate):
 *    `Query` has no language filter or "oldest" primitive at all, so there's
 *    no way to make these exact without raw SQL (query_sql/get_schema,
 *    intentionally not exposed here — see server.ts).
 */
import type { McpTool, Query } from '@shared/contracts';

export const digitalMemoryInfoDescription = `Information about the digital memory: connected accounts, document counts (exact by source; best-effort by type/language from a recent sample), and an approximate date range.
Call this first to know what sources/accounts exist before calling \`search\`. The result may include \`more\`: overviews contributed by other tools (for example the list of long-term memory pages), keyed by the tool to call for details.`;

export const digitalMemoryInfoInputSchema = {
  type: 'object',
  properties: {},
} as const;

const SAMPLE_SIZE = 500; // Query.search's own cap (store.ts)

export interface DigitalMemoryAccount {
  id: string;
  source: string;
  identifier: string;
  status: string;
  backfill_done_count: number | null;
  backfill_total_estimate: number | null;
  last_sync_at: string | null;
  last_error: string | null;
}

export const OVERVIEW_TIMEOUT_MS = 3000;
export const OVERVIEW_MAX_CHARS = 12_000;

/** Calls every registered `overview: true` tool with `{}` (registry read NOW,
 *  not at build time) and returns `{ [tool name]: result }`. A tool that
 *  throws or exceeds the timeout is skipped; an oversized result is replaced
 *  by a note. Calls go straight to `tool.call` — they are part of the one
 *  `digital_memory_info` call, so no audit/foreground wrapper runs again. */
export async function collectOverviews(
  tools: Iterable<McpTool>,
  warn?: (message: string, meta?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const targets = [...tools].filter(
    (t) => t.overview === true && t.name !== 'digital_memory_info',
  );
  const settled = await Promise.all(
    targets.map(async (tool) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          tool.call({}),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('overview timed out')),
              OVERVIEW_TIMEOUT_MS,
            );
          }),
        ]);
        const json = JSON.stringify(result);
        if (json === undefined) return null;
        return json.length > OVERVIEW_MAX_CHARS
          ? {
              name: tool.name,
              value: {
                note: `Too long to include; call ${tool.name} for it.`,
              },
            }
          : { name: tool.name, value: result };
      } catch (err) {
        warn?.(`overview of '${tool.name}' skipped`, {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
  const more: Record<string, unknown> = {};
  for (const s of settled) if (s) more[s.name] = s.value;
  return more;
}

export function makeDigitalMemoryInfoTool(
  query: Query,
  overviews?: () => Promise<Record<string, unknown>>,
) {
  return async function digitalMemoryInfo(): Promise<{
    accounts: DigitalMemoryAccount[];
    counts: {
      by_source: Array<{ key: string; count: number }>;
      by_type: Array<{ key: string; count: number }>;
      by_language: Array<{ key: string; count: number }>;
    };
    date_range: { oldest: string | null; newest: string | null };
    more?: Record<string, unknown>;
  }> {
    const accounts = await query.accounts();
    // Worker accounts are synthetic (deep-extraction / enrichment emits under
    // them) — not a user-facing "source" for this discovery tool.
    const realAccounts = accounts.filter((a) => a.source !== 'worker');

    const digitalAccounts: DigitalMemoryAccount[] = realAccounts.map((a) => ({
      id: a.id as string,
      source: a.source,
      identifier: a.identifier,
      status: a.status,
      backfill_done_count: a.progress?.done ?? null,
      backfill_total_estimate: a.progress?.totalEstimate ?? null,
      last_sync_at: a.lastSyncAt ?? null,
      last_error: a.lastError ?? null,
    }));

    const bySource = new Map<string, number>();
    for (const a of realAccounts) {
      const c = await query.count({ account: a.id });
      bySource.set(a.source, (bySource.get(a.source) ?? 0) + c);
    }

    const sample = await query.search({
      limit: SAMPLE_SIZE,
      project: 'metadata',
    });
    const typesSeen = new Set<string>();
    const byLanguageSample = new Map<string, number>();
    let oldest: string | null = null;
    let newest: string | null = null;
    for (const d of sample) {
      typesSeen.add(d.type);
      for (const lang of d.languages ?? []) {
        byLanguageSample.set(lang, (byLanguageSample.get(lang) ?? 0) + 1);
      }
      const created = d.createdAt ?? d.ingestedAt;
      if (created) {
        if (!oldest || created < oldest) oldest = created;
        if (!newest || created > newest) newest = created;
      }
    }

    const byType: Array<{ key: string; count: number }> = [];
    for (const type of typesSeen) {
      byType.push({ key: type, count: await query.count({ type }) });
    }

    const more = overviews ? await overviews() : {};

    return {
      accounts: digitalAccounts,
      counts: {
        by_source: [...bySource.entries()].map(([key, count]) => ({
          key,
          count,
        })),
        by_type: byType,
        by_language: [...byLanguageSample.entries()].map(([key, count]) => ({
          key,
          count,
        })),
      },
      date_range: { oldest, newest },
      ...(Object.keys(more).length ? { more } : {}),
    };
  };
}
