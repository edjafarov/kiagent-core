/**
 * The MCP activity feed — the enriched, user-facing sibling of the raw
 * LogSink 'mcp.call' audit (core/logs.ts). One concept, one owner: an
 * append-only JSONL file next to kiagent.db that BOTH processes write
 * (main for HTTP sessions, ../../mcp/stdio-entry.ts for client-spawned
 * stdio siblings) and only main reads. The file is the entire
 * cross-process channel: the stdio process may run while the app is
 * closed, so events must survive on disk — watch()'s boot replay is also
 * what latches the onboarding first-query step for those offline queries
 * (see main.ts's watch consumer).
 *
 * Writes are path-based per append (never a held fd) so reset()/rotation
 * never strand a writer on an unlinked inode. Appends are one small line,
 * so concurrent O_APPEND writers don't interleave mid-line. Rotation has a
 * benign race (an append landing between read and rename can be lost) —
 * the feed is an operational trail, not a ledger.
 */
import fs from 'fs';
import path from 'path';

import {
  MCP_ACTIVITY_RECENT_MAX,
  type McpActivityRecord,
} from '@shared/contracts';

export const ROTATE_BYTES = 1_000_000;

const FILE_NAME = 'mcp-activity.jsonl';

export interface ActivityLog {
  /** Append one record — used by main AND the stdio process. Fire-and-forget:
   *  an unwritable feed must never break serving a call. */
  append(rec: McpActivityRecord): void;
  /** Main only. Rotate if oversized, replay the last MCP_ACTIVITY_RECENT_MAX
   *  records on disk as the first batch (synchronously, before returning),
   *  then tail new complete lines until the returned disposer is called. */
  watch(onRecords: (recs: McpActivityRecord[]) => void): () => void;
  /** Main only: the last MCP_ACTIVITY_RECENT_MAX records seen (replay +
   *  live), oldest first. */
  recent(): McpActivityRecord[];
  /** Main only: truncate the file and clear recent() (factory reset). */
  reset(): void;
}

function parseLines(text: string): McpActivityRecord[] {
  const out: McpActivityRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as McpActivityRecord;
      if (rec && typeof rec.ts === 'string' && typeof rec.tool === 'string') {
        out.push(rec);
      }
    } catch {
      /* malformed line (partial write, manual edit) — skip, never crash */
    }
  }
  return out;
}

function rotateIfOversized(file: string): void {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size <= ROTATE_BYTES) return;
    const keep = parseLines(fs.readFileSync(file, 'utf8')).slice(
      -MCP_ACTIVITY_RECENT_MAX,
    );
    const tmp = `${file}.rotate`;
    fs.writeFileSync(
      tmp,
      keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''),
    );
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort — the tail below still works on the unrotated file */
  }
}

export function createActivityLog(dataDir: string): ActivityLog {
  const file = path.join(dataDir, FILE_NAME);
  const recent: McpActivityRecord[] = [];
  // Serialize this instance's appends: parallel fs.appendFile calls go
  // through the threadpool and can land out of order, reordering the feed.
  let appendChain: Promise<void> = Promise.resolve();

  function remember(recs: McpActivityRecord[]): void {
    recent.push(...recs);
    if (recent.length > MCP_ACTIVITY_RECENT_MAX) {
      recent.splice(0, recent.length - MCP_ACTIVITY_RECENT_MAX);
    }
  }

  return {
    append(rec) {
      try {
        const line = `${JSON.stringify(rec)}\n`;
        appendChain = appendChain.then(
          () =>
            new Promise<void>((resolve) => {
              fs.appendFile(file, line, () => resolve());
            }),
        );
      } catch {
        /* unwritable feed must never break serving a call */
      }
    },

    watch(onRecords) {
      rotateIfOversized(file);

      let offset = 0;
      let partial = '';

      // Replay: whatever is on disk (capped) is the first batch, delivered
      // synchronously so boot consumers (the onboarding latch) see offline
      // stdio queries immediately.
      try {
        const text = fs.readFileSync(file, 'utf8');
        offset = Buffer.byteLength(text, 'utf8');
        const lastNl = text.lastIndexOf('\n');
        partial = lastNl < 0 ? text : text.slice(lastNl + 1);
        const replay = parseLines(
          lastNl < 0 ? '' : text.slice(0, lastNl + 1),
        ).slice(-MCP_ACTIVITY_RECENT_MAX);
        if (replay.length) {
          remember(replay);
          onRecords(replay);
        }
      } catch {
        /* no file yet — nothing to replay */
      }

      const readDelta = (): void => {
        let chunk: string;
        try {
          const { size } = fs.statSync(file);
          if (size < offset) {
            // reset() truncated the file under us — start over.
            offset = 0;
            partial = '';
          }
          if (size === offset) return;
          const fd = fs.openSync(file, 'r');
          try {
            const buf = Buffer.alloc(size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            offset = size;
            chunk = buf.toString('utf8');
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          return; // file may not exist yet
        }
        const joined = partial + chunk;
        const lastNl = joined.lastIndexOf('\n');
        if (lastNl < 0) {
          partial = joined;
          return;
        }
        partial = joined.slice(lastNl + 1);
        const recs = parseLines(joined.slice(0, lastNl + 1));
        if (recs.length) {
          remember(recs);
          onRecords(recs);
        }
      };

      // Watch the DIRECTORY, not the file: the file may not exist yet, and
      // rotation/reset replace it — a file watcher would follow the dead
      // inode. dataDir always exists (kiagent.db lives there).
      const watcher = fs.watch(dataDir, (_event, filename) => {
        if (filename === FILE_NAME) readDelta();
      });
      return () => watcher.close();
    },

    recent() {
      return [...recent];
    },

    reset() {
      recent.length = 0;
      try {
        fs.writeFileSync(file, '');
      } catch {
        /* nothing to truncate */
      }
    },
  };
}

const MAX_TITLES = 20;
const MAX_ARGS_CHARS = 120;

/** Titles are the ONLY document content that leaves a tool result for the
 *  feed — never snippets or bodies. */
function titlesOf(items: unknown[]): string[] {
  const titles = items
    .filter(
      (x): x is Record<string, unknown> => x != null && typeof x === 'object',
    )
    .map((x) =>
      typeof x.title === 'string' && x.title.trim() !== ''
        ? x.title
        : '(untitled)',
    );
  if (titles.length > MAX_TITLES) {
    return [
      ...titles.slice(0, MAX_TITLES),
      `…and ${titles.length - MAX_TITLES} more`,
    ];
  }
  return titles;
}

function compactArgs(args: Record<string, unknown>): string {
  let s: string;
  try {
    s = JSON.stringify(args);
  } catch {
    s = String(args);
  }
  return s.length > MAX_ARGS_CHARS ? `${s.slice(0, MAX_ARGS_CHARS)}…` : s;
}

/**
 * Turn a successful tool call into the feed's human line + title list.
 * Shapes come from core/mcp/tools/*: search → SearchHit[] (or SearchHit[][]
 * for batch `queries`), get → LegacyDocument|null (or an array of those for
 * `ids`), get_related → Document[], count → Array<{key, count}>. Unknown
 * (extension) tools fall back to name + compact args, no detail.
 */
export function summarizeCall(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
): { summary: string; detail?: string[] } {
  const withDetail = (summary: string, items: unknown[]) => {
    const detail = titlesOf(items);
    return detail.length ? { summary, detail } : { summary };
  };

  switch (tool) {
    case 'search': {
      if (Array.isArray(args.queries)) {
        const hits = (Array.isArray(result) ? result : []).flat();
        return withDetail(
          `search ×${args.queries.length} queries → ${hits.length} hits`,
          hits,
        );
      }
      const hits = Array.isArray(result) ? result : [];
      const q =
        typeof args.query === 'string' && args.query.trim() !== ''
          ? `"${args.query}"`
          : null;
      const filters: string[] = [];
      if (typeof args.source === 'string') filters.push(`source=${args.source}`);
      if (typeof args.type === 'string') filters.push(`type=${args.type}`);
      const filterText = filters.length ? `(${filters.join(', ')})` : null;
      const what = [q, filterText].filter(Boolean).join(' ') || '(all)';
      return withDetail(`search ${what} → ${hits.length} hits`, hits);
    }
    case 'get': {
      const items = Array.isArray(result) ? result : [result];
      const found = items.filter((x) => x != null);
      const missing = items.length - found.length;
      const summary =
        missing > 0
          ? `fetched ${found.length} document(s), ${missing} not found`
          : `fetched ${found.length} document(s)`;
      return withDetail(summary, found);
    }
    case 'get_related': {
      const docs = Array.isArray(result) ? result : [];
      const rel = typeof args.relation === 'string' ? args.relation : '?';
      return withDetail(`related "${rel}" → ${docs.length} documents`, docs);
    }
    case 'count': {
      const rows = Array.isArray(result)
        ? (result as Array<{ key?: unknown; count?: unknown }>)
        : [];
      const by =
        typeof args.group_by === 'string' ? ` by ${args.group_by}` : '';
      const parts = rows.map((r) => `${String(r.key)}=${String(r.count)}`);
      return { summary: `counted${by}: ${parts.join(', ') || '—'}` };
    }
    case 'digital_memory_info':
      return { summary: 'read corpus overview' };
    default:
      return { summary: `${tool} ${compactArgs(args)}` };
  }
}
