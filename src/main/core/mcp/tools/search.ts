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

Query syntax: bare terms are ANDed ("a b" = both must match); "quoted phrases" match exactly; \`-term\` or NOT excludes; UPPERCASE OR alternates (lowercase and/or/not are ordinary terms); \`term*\` prefix-matches; parentheses group. Example: \`("term sheet" OR investor*) -newsletter\`. Prefer OR-of-synonyms over long AND chains — every bare term narrows the result.
Omit \`query\` for a recency listing ordered by the document's own date, newest first.

Filters: \`source\` (account's source id, e.g. "gmail"), \`type\`, \`from_date\`/\`to_date\` (ISO, inclusive bounds on the document's origin \`created_at\`), \`limit\` (default 10, max 50). \`context_lines\` controls how many lines of surrounding context are included in the snippet (default 2, max 30) when a snippet has to be built client-side.

Batch mode: pass \`queries\` (array of independent search arg objects) to run several searches in one round-trip. Cannot be combined with top-level filters.

Follow-up: fetch the full body with \`get(id)\` (or \`get(ids=[...])\`).`;

export const searchInputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'optional — full-text search. Terms AND by default; "phrases", -exclusions, UPPERCASE OR, prefix*, (grouping). Omit/empty for a recency listing (newest first by document date).',
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
const SNIPPET_MAX_LINE_CHARS = 400;

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

// Pull searchable terms out of a free-text query so a client-built snippet can
// anchor near a real match. Handles "quoted phrases"; strips query syntax
// (`-` negation, `*` prefix, parens, boolean operators).
function extractTerms(q: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(q)) !== null) {
    const raw = (m[1] ?? m[2])
      .replace(/^[-(]+/, '')
      .replace(/[)*]+$/, '')
      .toLowerCase();
    if (raw && raw !== 'and' && raw !== 'or' && raw !== 'not') tokens.push(raw);
  }
  return tokens;
}

function clampLine(line: string, terms: string[]): string {
  if (line.length <= SNIPPET_MAX_LINE_CHARS) return line;
  const lower = line.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) return `${line.slice(0, SNIPPET_MAX_LINE_CHARS)}…`;
  const radius = Math.floor(SNIPPET_MAX_LINE_CHARS / 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(line.length, idx + radius);
  let w = line.slice(start, end);
  if (start > 0) w = `…${w}`;
  if (end < line.length) w += '…';
  return w;
}

/** Client-side fallback snippet builder (grep -C style), used when the store
 *  didn't already attach one (e.g. a recency listing with no text match). */
function buildSnippet(
  markdown: string,
  terms: string[],
  contextLines: number,
): string {
  if (!markdown) return '';
  const lines = markdown.split(/\r?\n/);
  let matchLine = -1;
  for (let i = 0; i < lines.length && matchLine < 0; i += 1) {
    const lower = lines[i].toLowerCase();
    if (terms.some((t) => lower.includes(t))) matchLine = i;
  }
  let start: number;
  let end: number;
  if (matchLine < 0) {
    start = 0;
    end = Math.min(lines.length, contextLines * 2 + 1);
  } else {
    start = Math.max(0, matchLine - contextLines);
    end = Math.min(lines.length, matchLine + contextLines + 1);
  }
  let window = lines
    .slice(start, end)
    .map((l) => clampLine(l, terms))
    .join('\n');
  if (start > 0) window = `…\n${window}`;
  if (end < lines.length) window = `${window}\n…`;
  for (const t of terms) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    window = window.replace(new RegExp(escaped, 'gi'), '**$&**');
  }
  return window
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function makeSearchTool(query: Query) {
  async function runOne(args: SearchArgs): Promise<SearchHit[]> {
    const limit = resolveLimit(args.limit);
    const contextLines = resolveContextLines(args.context_lines);

    const accounts: Account[] = await query.accounts();
    const sourceOf = new Map<string, string>(
      accounts.map((a) => [a.id as string, a.source]),
    );
    let accountIds: AccountId[] | undefined;
    if (args.source) {
      accountIds = accounts
        .filter((a) => a.source === args.source)
        .map((a) => a.id);
      if (accountIds.length === 0) return []; // no account for that source — no results
    }

    const rawText = args.query?.trim() ? args.query : undefined;
    const base = {
      text: rawText,
      type: args.type,
      fromDate: args.from_date,
      toDate: args.to_date,
      limit,
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

    const terms = rawText ? extractTerms(rawText) : [];
    return docs.map((d, i) => ({
      id: d.id,
      title: d.title ?? '',
      source: sourceOf.get(d.accountId) ?? 'unknown',
      type: d.type,
      snippet: d.snippet ?? buildSnippet(d.markdown ?? '', terms, contextLines),
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
