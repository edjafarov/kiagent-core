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
  if (!prev || prev.kind !== kind) return fullPath(kind, at);
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
  if (prev.v !== EXPANDER_VERSION[kind]) return fullPath(kind, at);
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
    stats = await fs.promises.stat(absPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { items: [], deletions: [deletion], rec: null };
    return {
      items: [],
      deletions: [],
      rec: { ...rec, notBefore: now + EXPANSION_RETRY_MS },
    };
  }
  // Full path, step one: archive the container and every child it had
  // (the parent cascade). Its own batch — deletions apply after documents
  // within one commit, so they cannot share one with the re-emission.
  if (!rec.cleared && rec.resume === null)
    return { items: [], deletions: [deletion], rec: { ...rec, cleared: true } };

  let result;
  try {
    result = await converter.expandPage(
      absPath,
      rec.kind,
      rec.resume,
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
