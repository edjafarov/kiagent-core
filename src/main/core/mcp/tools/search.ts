/**
 * `search` — ported from kiagent-ref's src/main/mcp/tools/search.ts, rebuilt
 * on top of the greenfield `Query.search`. The legacy tool queried the raw
 * `documents` table with hand-rolled bm25/trigram fusion; here ranking, the
 * boolean query syntax, date bounds, and date-ordered recency listings all
 * live INSIDE `Query.search` (store.ts), so this file's job is argument
 * translation (legacy `source` = connector id → our `Account.id`,
 * `from_date`/`to_date` → `fromDate`/`toDate`) and reshaping the result rows
 * back into the legacy `SearchHit` wire shape so existing client configs /
 * prompts keep working.
 */
import type { Account, AccountId, Document, Query } from '@shared/contracts';
import { buildLineWindow, extractWindowTerms } from '../../store/line-window';
import { parseOperators } from './search-operators';

export interface SearchArgs {
  query?: string;
  source?: string;
  type?: string;
  from_date?: string;
  to_date?: string;
  limit?: number;
  context_lines?: number;
  queries?: SearchArgs[];
}

export interface SearchHit {
  id: string;
  title: string;
  source: string;
  type: string;
  snippet: string;
  source_url: string;
  created_at: string;
  score: number;
}

export const searchDescription = `Search everything ingested so far — emails, chat messages, files, notes, attachments — across all connected accounts.
START by calling \`digital_memory_info\` to see which sources/accounts/types exist.

Query syntax: bare terms are ANDed ("a b" = both must match); "quoted phrases" match exactly; \`-term\` or NOT excludes; UPPERCASE OR alternates (lowercase and/or/not are ordinary terms); \`term*\` prefix-matches; parentheses group. Terms are stemmed ("invoice" matches "invoices"). Example: \`("term sheet" OR investor*) -newsletter\`. Prefer OR-of-synonyms over long AND chains — every bare term narrows the result.

Operators (gmail-style, inside the query string): \`from:\` \`to:\` \`participant:\` match people by case-insensitive substring on name or address — \`from:sebastian\`, \`from:@zoolatech.com\`, \`from:"Roman Kaplun"\`. Case folding is ASCII-only — names with non-ASCII capitals (Ünal, MÜLLER) may not match; use the address, or a substring without those letters (from:nal). \`label:inbox\`; \`has:attachment\`; \`filename:report\`; \`ext:pdf\`; \`in:gmail\` (alias \`source:\`) and \`type:email.thread\` mirror the JSON params; \`order:newest\`/\`order:relevance\` picks the sort (default: relevance with text, newest without). Repeat an operator to OR within it (\`from:a from:b\`); different operators AND. When a source has several connected accounts, merged results are ordered by date — order:relevance applies within each account. Example: \`from:@zoolatech.com has:attachment order:newest log*\`.
Omit \`query\` (or pass operators only) for a recency listing ordered by the document's own date, newest first.

Filters: \`source\` (account's source id, e.g. "gmail"), \`type\`, \`from_date\`/\`to_date\` (ISO, inclusive bounds on the document's origin \`created_at\`), \`limit\` (default 10, max 50). \`context_lines\` controls how many lines of surrounding context are included in the snippet (default 2, max 30) when a snippet has to be built client-side.

Batch mode: pass \`queries\` (array of independent search arg objects) to run several searches in one round-trip. Cannot be combined with top-level filters.

Every hit carries \`source_url\` — a deep link back to the original (a \`file://\` absolute path for local files, the app's web link for cloud sources; empty when the source has none). Every document has a url — when presenting documents to the user, link each one, not just the first; if url is empty or non-http, cite by title and date.

Follow-up: fetch the full body with \`get(id)\` (or \`get(ids=[...])\`).`;

export const searchInputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'optional — full-text search. Terms AND by default (stemmed); "phrases", -exclusions, UPPERCASE OR, prefix*, (grouping); gmail-style operators from:/to:/participant:/label:/has:attachment/filename:/ext:/in:/type:/order:. Omit/empty for a recency listing (newest first by document date).',
    },
    source: {
      type: 'string',
      description: "account's source id, e.g. 'gmail'",
    },
    type: { type: 'string' },
    from_date: {
      type: 'string',
      description: 'ISO lower bound on the document created_at',
    },
    to_date: {
      type: 'string',
      description: 'ISO upper bound on the document created_at',
    },
    limit: { type: 'number', description: 'max results (default 10, max 50)' },
    context_lines: {
      type: 'number',
      description:
        'lines of context around a client-built snippet (default 2, max 30)',
    },
    queries: {
      type: 'array',
      description:
        'batch mode: array of independent search arg objects (same shape as the top level).',
      items: { type: 'object' },
    },
  },
} as const;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const SNIPPET_DEFAULT_CONTEXT_LINES = 2;
const SNIPPET_MAX_CONTEXT_LINES = 30;

function resolveLimit(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function resolveContextLines(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return SNIPPET_DEFAULT_CONTEXT_LINES;
  return Math.min(Math.max(0, n), SNIPPET_MAX_CONTEXT_LINES);
}

export function makeSearchTool(query: Query) {
  async function runOne(args: SearchArgs): Promise<SearchHit[]> {
    const limit = resolveLimit(args.limit);
    const contextLines = resolveContextLines(args.context_lines);
    const parsed = parseOperators(args.query ?? '');
    const effSource = parsed.source ?? args.source;
    const effType = parsed.type ?? args.type;

    const accounts: Account[] = await query.accounts();
    const sourceOf = new Map<string, string>(
      accounts.map((a) => [a.id as string, a.source]),
    );
    let accountIds: AccountId[] | undefined;
    if (effSource) {
      accountIds = accounts
        .filter((a) => a.source === effSource)
        .map((a) => a.id);
      if (accountIds.length === 0) return []; // no account for that source — no results
    }

    const rawText = parsed.text.trim() ? parsed.text : undefined;
    const people =
      parsed.from.length || parsed.to.length || parsed.participant.length
        ? {
            from: parsed.from.length ? parsed.from : undefined,
            to: parsed.to.length ? parsed.to : undefined,
            participant: parsed.participant.length
              ? parsed.participant
              : undefined,
          }
        : undefined;
    const base = {
      text: rawText,
      type: effType,
      fromDate: args.from_date,
      toDate: args.to_date,
      limit,
      people,
      label: parsed.label.length ? parsed.label : undefined,
      hasAttachment: parsed.hasAttachment || undefined,
      filename: parsed.filename.length ? parsed.filename : undefined,
      ext: parsed.ext.length ? parsed.ext : undefined,
      orderBy: parsed.order,
      // The store builds the snippet where the rows are read; the tool never
      // needs a body (get(id) fetches it).
      project: 'snippet' as const,
      contextLines,
    };

    let docs: Array<Document & { snippet?: string }>;
    if (!accountIds || accountIds.length <= 1) {
      docs = await query.search({ ...base, account: accountIds?.[0] });
    } else {
      const lists = await Promise.all(
        accountIds.map((account) => query.search({ ...base, account })),
      );
      docs = lists.flat();
      // Multiple per-account result lists are each independently ranked;
      // merge by the document's own date as the best cross-account ordering.
      const dateOf = (d: Document) => d.createdAt ?? d.ingestedAt;
      docs.sort((a, b) =>
        dateOf(a) < dateOf(b) ? 1 : dateOf(a) > dateOf(b) ? -1 : 0,
      );
      docs = docs.slice(0, limit);
    }

    const terms = rawText ? extractWindowTerms(rawText) : [];
    return docs.map((d, i) => ({
      id: d.id,
      title: d.title ?? '',
      source: sourceOf.get(d.accountId) ?? 'unknown',
      type: d.type,
      snippet:
        d.snippet ?? buildLineWindow(d.markdown ?? '', terms, contextLines),
      source_url: d.url ?? '',
      created_at: d.createdAt ?? d.ingestedAt,
      // Query.search doesn't expose its internal bm25 score; approximate a
      // monotonic "higher is better" rank so the field stays populated.
      score:
        docs.length > 1
          ? Math.round(((docs.length - i) / docs.length) * 100) / 100
          : 1,
    }));
  }

  return async function search(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const a = args as SearchArgs;
    if (Array.isArray(a.queries)) {
      const hasTopLevel =
        a.query != null ||
        a.source != null ||
        a.type != null ||
        a.from_date != null ||
        a.to_date != null ||
        a.limit != null;
      if (hasTopLevel) {
        throw new Error(
          'pass either a single query (with filters) or `queries` (batch) — not both',
        );
      }
      return Promise.all(a.queries.map((q) => runOne(q)));
    }
    return runOne(a);
  };
}
