/**
 * Line-window ("grep -C") snippets for recency / filter-only listings, which
 * have no FTS5 snippet to lean on. Moved out of mcp/tools/search.ts so the
 * query module can build them where the rows are read.
 */

export const DEFAULT_CONTEXT_LINES = 2;
const SNIPPET_MAX_LINE_CHARS = 400;

/** Searchable terms out of a free-text query so a window can anchor near a
 *  real match: "quoted phrases" stay whole; `-`, `*`, parens and boolean
 *  operators are stripped. */
export function extractWindowTerms(q: string): string[] {
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

export function clampLine(line: string, terms: string[]): string {
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

/** `headTruncated`: `markdown` is only the head of a longer body (the recency
 *  projection reads `substr(markdown, 1, 65536)`), so the window always ends
 *  with an ellipsis. */
export function buildLineWindow(
  markdown: string,
  terms: string[],
  contextLines: number,
  headTruncated = false,
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
  if (end < lines.length || headTruncated) window = `${window}\n…`;
  for (const t of terms) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    window = window.replace(new RegExp(escaped, 'gi'), '**$&**');
  }
  return window
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
