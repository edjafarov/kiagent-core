/**
 * The converter boundary (#136): what the commit path, the convert worker
 * and the vision worker call. `createConverterRunner` (runner.ts) runs it in
 * the crash-isolated `kia-converter` child; `createInlineConverter` runs the
 * same parsers in-process (KIA_CONVERTER_INLINE=1, tests).
 */
import { abortError } from '../abort';
import {
  capMarkdown,
  parseDetailed,
  parsePdfPages,
  rasterizePdf,
  type RasterResult,
} from './parsers';

export interface ParseResult {
  markdown: string | null;
  ocrPages?: number[];
}

export interface ConverterStats {
  mode: 'child' | 'inline';
  state: string;
  pid: number | null;
  jobs: number;
  crashes: number;
  timeouts: number;
  cancels: number;
  unavailable: number;
  queued: number;
  queuedBytes: number;
  p95Ms: number | null;
}

export interface Converter {
  /** Markdown is capped at MAX_MARKDOWN_CHARS before it is returned. */
  parseDetailed(
    bytes: Uint8Array,
    mime: string,
    filename?: string,
    signal?: AbortSignal,
  ): Promise<ParseResult>;
  parsePdfPages(bytes: Uint8Array, signal?: AbortSignal): Promise<string[]>;
  rasterizePdf(
    bytes: Uint8Array,
    pages: number[],
    opts?: { maxEdge?: number; signal?: AbortSignal },
  ): Promise<RasterResult>;
  stats(): ConverterStats;
  stop(): Promise<void>;
}

/** The child died while THIS job was running. Attributed to the active job only. */
export class ConverterCrashedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConverterCrashedError';
  }
}

/** THIS job ran past the wall-clock limit; the child was killed. */
export class ConverterTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConverterTimeoutError';
  }
}

/** Infrastructure, not the document: the child could not start (or the
 *  converter is stopped). Transient — callers try later, never record a
 *  permanent failure. */
export class ConverterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConverterUnavailableError';
  }
}

const RECENT = 64;

/** Nearest-rank p95 over the last RECENT job durations. */
export function p95(durations: number[]): number | null {
  if (durations.length === 0) return null;
  const s = [...durations].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

export function pushRecent(durations: number[], ms: number): void {
  durations.push(ms);
  if (durations.length > RECENT) durations.shift();
}

export function createInlineConverter(): Converter {
  let jobs = 0;
  let cancels = 0;
  const recent: number[] = [];
  const run = async <T>(
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T> => {
    if (signal?.aborted) {
      cancels += 1;
      throw abortError();
    }
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      jobs += 1;
      pushRecent(recent, Date.now() - t0);
    }
  };
  return {
    parseDetailed: (bytes, mime, filename, signal) =>
      run(signal, async () => {
        const r = await parseDetailed(bytes, mime, filename);
        return r.markdown === null
          ? r
          : { ...r, markdown: capMarkdown(r.markdown).markdown };
      }),
    parsePdfPages: (bytes, signal) => run(signal, () => parsePdfPages(bytes)),
    rasterizePdf: (bytes, pages, opts) =>
      run(opts?.signal, () => rasterizePdf(bytes, pages, opts?.maxEdge)),
    stats: () => ({
      mode: 'inline',
      state: 'inline',
      pid: null,
      jobs,
      crashes: 0,
      timeouts: 0,
      cancels,
      unavailable: 0,
      queued: 0,
      queuedBytes: 0,
      p95Ms: p95(recent),
    }),
    stop: async () => {},
  };
}
