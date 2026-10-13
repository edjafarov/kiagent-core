/**
 * Container expansion, source side (spec B3): the record transitions a scan
 * or watcher event applies to a container, and one expansion STEP — a page
 * of children (or the full path's deletion batch) turned into batch items.
 *
 * The expander is the ONLY writer of a container row and its children: the
 * scan path never emits a container document, it only records where the
 * container's expansion stands.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { DocumentInput, ExternalRef } from '@shared/contracts';

import {
  ConverterUnavailableError,
  type Converter,
} from '../../core/converter/converter';
import {
  extractMember,
  scratchName,
  type NestedState,
  type ZipResume,
} from '../../core/converter/containers/zip';
import {
  DEFAULT_EXPAND_BUDGET,
  EXPANDER_VERSION,
  type ChildItem,
  type ContainerKind,
  type ExpandBudget,
} from '../../core/converter/containers/types';
import type { Expansion, PendingExpansion } from './cursor';
import { resolvePathMime } from './mime';
import { toAbsPosix } from './scanner';
import { toDocument, type LocalFolderItem } from './to-document';

/** A page that throws or times out this many times marks the container
 *  failed until it changes. */
export const MAX_EXPANSION_ATTEMPTS = 3;
/** Retry delay after an attempt failed, or while the converter is down. */
export const EXPANSION_RETRY_MS = 60_000;

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

const fullPath = (kind: ContainerKind, at: FileStamp): PendingExpansion => ({
  state: 'pending',
  kind,
  v: EXPANDER_VERSION[kind],
  size: at.size,
  mtimeMs: at.mtimeMs,
  resume: null,
  cleared: false,
  attempts: 0,
});

/**
 * The record for a container the scan path (backfill, rescan, watcher
 * add/change, policy re-emission) just saw. Unchanged containers keep their
 * record — a mailbox by SIZE only (Thunderbird rewrites status flags in
 * place, moving mtime but not size), everything else by size and mtime.
 */
export function noteContainer(
  prev: Expansion | undefined,
  kind: ContainerKind,
  at: FileStamp,
): Expansion {
  // A new expander version restarts even a pending record: its `resume` has
  // the old pager's shape.
  if (!prev || prev.kind !== kind || prev.v !== EXPANDER_VERSION[kind])
    return fullPath(kind, at);
  const mbox = kind === 'mbox';
  const same = mbox
    ? at.size === prev.size
    : at.size === prev.size && at.mtimeMs === prev.mtimeMs;
  if (prev.state === 'pending') {
    if (same) return prev;
    // A mailbox still growing while it is read: keep going, the pager reads
    // to the current end. Anything else restarts.
    if (mbox && at.size > prev.size) return { ...prev, ...at };
    return fullPath(kind, at);
  }
  if (same) return prev;
  if (mbox && prev.state === 'done' && prev.tail && at.size > prev.size)
    return {
      state: 'pending',
      kind,
      v: prev.v,
      ...at,
      resume: prev.tail,
      cleared: true, // an append adds children; nothing to archive first
      attempts: 0,
    };
  return fullPath(kind, at);
}

/** The externalId of the pending record to step next, or null. Oldest
 *  insertion first (records are only ever added at the end of the map). */
export function nextPending(
  expansions: Record<string, Expansion>,
  now: number,
): string | null {
  for (const [id, rec] of Object.entries(expansions))
    if (rec.state === 'pending' && (rec.notBefore ?? 0) <= now) return id;
  return null;
}

/** Epoch ms of the earliest deferred pending record, or null. */
export function nextDue(expansions: Record<string, Expansion>): number | null {
  let due: number | null = null;
  for (const rec of Object.values(expansions))
    if (rec.state === 'pending' && rec.notBefore !== undefined)
      due = due === null ? rec.notBefore : Math.min(due, rec.notBefore);
  return due;
}

/** The container's own row: an ordinary local file document whose markdown
 *  is the expander's (placeholder, summary or failure note). */
export function containerRow(
  absPath: string,
  stats: fs.Stats,
  kind: ContainerKind,
  markdown: string,
  scopeRootId?: string,
): LocalFolderItem {
  const doc = toDocument({
    absPath,
    externalId: toAbsPosix(absPath),
    size: stats.size,
    mtimeIso: stats.mtime.toISOString(),
    createdIso: (stats.birthtime && stats.birthtime.getTime() > 0
      ? stats.birthtime
      : stats.mtime
    ).toISOString(),
    ext: path.extname(absPath).slice(1).toLowerCase(),
    mime: resolvePathMime(absPath),
    markdownText: markdown,
    binary: null,
    ...(scopeRootId ? { scopeRootId } : {}),
  }) as DocumentInput;
  return {
    prebuilt: {
      ...doc,
      metadata: {
        ...doc.metadata,
        conversion: { status: 'ok' },
        container: { kind },
      },
    },
  };
}

function childDoc(
  containerId: string,
  kind: ContainerKind,
  c: ChildItem,
  scopeRootId?: string,
): LocalFolderItem {
  return {
    prebuilt: {
      externalId: `${containerId}#${c.key}`,
      type: c.type,
      title: c.title,
      markdown: c.markdown,
      // No absPath: workers skip children and fetchBytes returns null.
      metadata: {
        ...c.metadata,
        conversion: { status: 'ok' },
        extraction: { container: kind },
      },
      createdAt: c.createdAt,
      parent: { externalId: containerId, type: 'file' },
      ...(scopeRootId ? { scopeRootId } : {}),
    },
  };
}

export interface StepInput {
  absPath: string;
  rec: PendingExpansion;
  scopeRootId?: string;
  converter: Pick<Converter, 'expandPage'>;
  signal?: AbortSignal;
  now: number;
  budget?: ExpandBudget;
  /** Where nested ZIP members are extracted; absent = never (name-only). */
  scratchDir?: string;
}

export interface StepOutput {
  items: LocalFolderItem[];
  deletions: ExternalRef[];
  /** The record after this step; null drops it. */
  rec: Expansion | null;
}

/** The record with its retry state reset. */
function settled(rec: PendingExpansion): PendingExpansion {
  const { notBefore: _due, ...rest } = rec;
  return { ...rest, attempts: 0 };
}

function changedSince(rec: PendingExpansion, stats: fs.Stats): boolean {
  // A mailbox may grow while it is read (the pager reads to the current
  // end); it may not shrink.
  if (rec.kind === 'mbox') return stats.size < rec.size;
  return stats.size !== rec.size || stats.mtimeMs !== rec.mtimeMs;
}

/** The full path again, for the file as it is now. */
const restamped = (
  rec: PendingExpansion,
  stats: fs.Stats,
): PendingExpansion => ({
  ...settled(rec),
  size: stats.size,
  mtimeMs: stats.mtimeMs,
  resume: null,
  cleared: false,
});

/** The nested ZIP member a pending record is on, if any. */
export function nestedOf(rec: Expansion | undefined): NestedState | null {
  if (!rec || rec.state !== 'pending' || rec.kind !== 'zip') return null;
  const r = rec.resume as ZipResume | null;
  return r?.nested ?? null;
}

const withNested = (
  rec: PendingExpansion,
  patch: Partial<NestedState>,
): ZipResume => {
  const r = rec.resume as ZipResume;
  return { ...r, nested: { ...(r.nested as NestedState), ...patch } };
};

/**
 * Extracts a nested member, or says what to do instead. Null = extracted,
 * page it now. Before any of the member's items were emitted, a member that
 * cannot be extracted becomes name-only; after, the record waits (no room)
 * or restarts (the copy no longer matches), so committed children are never
 * left beside a silently missing remainder.
 */
async function extractStep(
  input: StepInput,
  n: NestedState,
  file: string | null,
  stats: fs.Stats,
): Promise<StepOutput | null> {
  const { rec, now, signal, absPath } = input;
  const progressed = n.inner !== null || n.items > 0;
  const keep = (r: PendingExpansion): StepOutput => ({
    items: [],
    deletions: [],
    rec: r,
  });
  const skip = () =>
    keep({ ...settled(rec), resume: withNested(rec, { skip: true }) });
  const later = () => keep({ ...rec, notBefore: now + EXPANSION_RETRY_MS });
  if (!file) return skip();
  let outcome;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    outcome = await extractMember(absPath, n, file, { signal });
  } catch {
    if (signal?.aborted) return keep(rec);
    return later(); // I/O: never an attempt, never name-only
  }
  // The copy took a while: the container may have changed meanwhile.
  const now2 = await fs.promises.lstat(absPath).catch(() => null);
  if (!now2 || changedSince(rec, now2)) {
    await removeScratch(file);
    return keep(restamped(rec, now2 ?? stats));
  }
  if (outcome === 'ok') return null;
  if (outcome === 'mismatch') return keep(restamped(rec, stats));
  if (!progressed) return skip();
  return outcome === 'nospace' ? later() : keep(restamped(rec, stats));
}

export async function removeScratch(file: string): Promise<void> {
  await Promise.all([
    fs.promises.rm(file, { force: true }),
    fs.promises.rm(`${file}.part`, { force: true }),
  ]);
}

/**
 * The one write path for expansion records. When a record stops being
 * pending on a nested member (done, failed, dropped, restarted, or moved on
 * to another member), that member's scratch copy is deleted at once.
 */
export function replaceRecord(
  exps: Record<string, Expansion>,
  id: string,
  next: Expansion | null,
  scratchDir?: string,
): void {
  const before = nestedOf(exps[id]);
  if (next) exps[id] = next;
  else delete exps[id];
  if (!before || !scratchDir) return;
  const after = nestedOf(next ?? undefined);
  const name = scratchName(id, before);
  if (after && scratchName(id, after) === name) return;
  void removeScratch(path.join(scratchDir, name));
}

/** Deletes every scratch file no pending record is on — the crash backstop
 *  (a quit mid-copy leaves a `.part`; a crash before a record moved on
 *  leaves a copy). */
export async function sweepScratch(
  scratchDir: string,
  exps: Record<string, Expansion>,
): Promise<void> {
  const keep = new Set<string>();
  for (const [id, rec] of Object.entries(exps)) {
    const n = nestedOf(rec);
    if (n) keep.add(scratchName(id, n));
  }
  let names: string[];
  try {
    names = await fs.promises.readdir(scratchDir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((f) => !keep.has(f))
      .map((f) => fs.promises.rm(path.join(scratchDir, f), { force: true })),
  );
}

const placeholder = (absPath: string) =>
  `# ${path.basename(absPath)}\n\nReading…`;
const failedNote = (absPath: string) =>
  `# ${path.basename(absPath)}\n\nCould not read this file.`;

/** One expansion step for one pending container. Never throws for the
 *  container's own failures; an abort leaves the record untouched. */
export async function expansionStep(input: StepInput): Promise<StepOutput> {
  const { absPath, rec, scopeRootId, converter, signal, now } = input;
  const containerId = toAbsPosix(absPath);
  const deletion: ExternalRef = { externalId: containerId, type: 'file' };
  let stats: fs.Stats;
  try {
    // lstat, like the scanner: a container swapped for a symlink (or
    // anything but a regular file) is gone, never followed.
    stats = await fs.promises.lstat(absPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { items: [], deletions: [deletion], rec: null };
    return {
      items: [],
      deletions: [],
      rec: { ...rec, notBefore: now + EXPANSION_RETRY_MS },
    };
  }
  if (!stats.isFile()) return { items: [], deletions: [deletion], rec: null };
  // The file changed since the record was noted (its watcher event may still
  // be queued): never page a stale resume — or a scratch copy — against it.
  if (changedSince(rec, stats))
    return { items: [], deletions: [], rec: restamped(rec, stats) };
  // Full path, step one: archive the container and every child it had
  // (the parent cascade). Its own batch — deletions apply after documents
  // within one commit, so they cannot share one with the re-emission.
  if (!rec.cleared && rec.resume === null)
    return { items: [], deletions: [deletion], rec: { ...rec, cleared: true } };

  // A nested ZIP member: extract it (here, in main — see extractMember)
  // before the pager can page it.
  let { resume } = rec;
  const nested = nestedOf(rec);
  if (nested && !nested.skip) {
    const file = input.scratchDir
      ? path.join(input.scratchDir, scratchName(containerId, nested))
      : null;
    if (file && fs.existsSync(file)) resume = withNested(rec, { file });
    else {
      const out = await extractStep(input, nested, file, stats);
      if (out) return out;
      resume = withNested(rec, { file: file as string });
    }
  }

  let result;
  try {
    result = await converter.expandPage(
      absPath,
      rec.kind,
      resume,
      input.budget ?? DEFAULT_EXPAND_BUDGET,
      signal,
    );
  } catch (e) {
    if (signal?.aborted) return { items: [], deletions: [], rec };
    if (e instanceof ConverterUnavailableError)
      return {
        items: [],
        deletions: [],
        rec: { ...rec, notBefore: now + EXPANSION_RETRY_MS },
      };
    const attempts = rec.attempts + 1;
    if (attempts < MAX_EXPANSION_ATTEMPTS)
      return {
        items: [],
        deletions: [],
        rec: { ...rec, attempts, notBefore: now + EXPANSION_RETRY_MS },
      };
    return {
      items: [
        containerRow(
          absPath,
          stats,
          rec.kind,
          failedNote(absPath),
          scopeRootId,
        ),
      ],
      deletions: [],
      rec: {
        state: 'failed',
        kind: rec.kind,
        v: rec.v,
        size: rec.size,
        mtimeMs: rec.mtimeMs,
      },
    };
  }
  if (result.restart)
    return {
      items: [],
      deletions: [],
      rec: { ...settled(rec), resume: null, cleared: false },
    };

  const items: LocalFolderItem[] = [];
  const done = result.resume === null;
  // The row goes first so its children resolve their parent in-batch.
  if (done)
    items.push(
      containerRow(
        absPath,
        stats,
        rec.kind,
        result.summary ?? `# ${path.basename(absPath)}`,
        scopeRootId,
      ),
    );
  else if (rec.resume === null)
    items.push(
      containerRow(absPath, stats, rec.kind, placeholder(absPath), scopeRootId),
    );
  for (const c of result.items)
    items.push(childDoc(containerId, rec.kind, c, scopeRootId));
  return {
    items,
    deletions: [],
    rec: done
      ? {
          state: 'done',
          kind: rec.kind,
          v: rec.v,
          size: rec.size,
          mtimeMs: rec.mtimeMs,
          ...(result.tail !== undefined ? { tail: result.tail } : {}),
        }
      : { ...settled(rec), resume: result.resume },
  };
}
