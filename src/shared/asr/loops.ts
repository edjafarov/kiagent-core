// Text repetition rule (spec: selective accuracy retry, trigger T1). Pure.
// A loop is a property of the emitted text alone — explainable to the user
// as "the same phrase repeated N times" — never a model-confidence score.
export const LOOP_MIN_TOKENS = 6;
export const LOOP_MAX_NGRAM = 4;
export const LOOP_MIN_REPEATS = 3;
export const LOOP_MIN_COVERAGE = 0.6;
export const LOOP_IDENTICAL_ROWS = 3;

export interface LoopRow {
  startMs: number;
  endMs: number;
  speaker: 'me' | 'them';
  speakerLabel: string | null;
  text: string;
}

export interface LoopFlag {
  speaker: 'me' | 'them';
  speakerLabel: string | null;
  startMs: number;
  endMs: number;
  /** Indices into the rows array handed to findLoopFlags, ascending. */
  rowIndices: number[];
}

/** NFKC, lower-case, letters/digits/apostrophes only, whitespace-split. */
export function normaliseTokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .split(' ')
    .filter((t) => t.length > 0);
}

function sameGram(tokens: string[], a: number, b: number, n: number): boolean {
  for (let k = 0; k < n; k += 1)
    if (tokens[a + k] !== tokens[b + k]) return false;
  return true;
}

export function isLoop(text: string): boolean {
  const tokens = normaliseTokens(text);
  if (tokens.length < LOOP_MIN_TOKENS) return false;
  for (let n = 1; n <= LOOP_MAX_NGRAM; n += 1) {
    if (n * LOOP_MIN_REPEATS > tokens.length) break;
    for (let i = 0; i + n <= tokens.length; i += 1) {
      let repeats = 1;
      let j = i + n;
      while (j + n <= tokens.length && sameGram(tokens, i, j, n)) {
        repeats += 1;
        j += n;
      }
      if (
        repeats >= LOOP_MIN_REPEATS &&
        repeats * n >= LOOP_MIN_COVERAGE * tokens.length
      ) {
        return true;
      }
    }
  }
  return false;
}

const keyOf = (r: LoopRow): string =>
  `${r.speaker}|${r.speakerLabel === null ? '\0' : r.speakerLabel}`;

/** Rows of ONE channel in startMs order. Each loop row is its own flag;
 *  a run of ≥ LOOP_IDENTICAL_ROWS consecutive same-key rows with identical
 *  normalised text is ONE flag covering the run (a loop row inside such a
 *  run is reported once, as part of the run). Output sorted by startMs. */
export function findLoopFlags(rows: readonly LoopRow[]): LoopFlag[] {
  const byKey = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const k = keyOf(r);
    const list = byKey.get(k);
    if (list) list.push(i);
    else byKey.set(k, [i]);
  });
  const flags: LoopFlag[] = [];
  for (const indices of byKey.values()) {
    const consumed = new Set<number>();
    // identical runs first, so a loop row inside one is not double-reported
    let runStart = 0;
    while (runStart < indices.length) {
      const norm = normaliseTokens(rows[indices[runStart]].text).join(' ');
      let runEnd = runStart + 1;
      while (
        runEnd < indices.length &&
        normaliseTokens(rows[indices[runEnd]].text).join(' ') === norm
      ) {
        runEnd += 1;
      }
      if (runEnd - runStart >= LOOP_IDENTICAL_ROWS && norm !== '') {
        const idx = indices.slice(runStart, runEnd);
        idx.forEach((i) => consumed.add(i));
        flags.push(flagFor(rows, idx));
      }
      runStart = runEnd;
    }
    for (const i of indices) {
      if (consumed.has(i)) continue;
      if (isLoop(rows[i].text)) flags.push(flagFor(rows, [i]));
    }
  }
  return flags.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function flagFor(rows: readonly LoopRow[], idx: number[]): LoopFlag {
  const first = rows[idx[0]];
  return {
    speaker: first.speaker,
    speakerLabel: first.speakerLabel,
    startMs: Math.min(...idx.map((i) => rows[i].startMs)),
    endMs: Math.max(...idx.map((i) => rows[i].endMs)),
    rowIndices: [...idx].sort((a, b) => a - b),
  };
}

// ── File-transcript cleanup (core addition; spec 2026-10-14 file ASR) ──────
// The file route has no timestamps, so sentences stand in for rows. Pure.
export const DEGENERATE_MIN_REMOVED_TOKENS = 50;
export const DEGENERATE_MIN_RATIO = 0.5;

/** Sentence rows for the loop rule: split after . ! ? … (plus any closing
 *  quote/bracket) when whitespace follows, and on newlines. A decimal like
 *  "3.5" has no whitespace after its dot, so it never splits. */
export function sentenceRows(text: string): LoopRow[] {
  return text
    .split(/\n+|(?<=[.!?…]["'»“”)\]]*)\s+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t, i) => ({
      startMs: i,
      endMs: i,
      speaker: 'them' as const,
      speakerLabel: null,
      text: t,
    }));
}

/** Removes repetition loops at sentence level (spec §3.3): a run of ≥3
 *  identical sentences keeps its first; any sentence `isLoop` flags is
 *  dropped whole — including a run's kept first, which `findLoopFlags`
 *  never tests itself (its `consumed` set). Clean input is returned
 *  byte-identical. `degenerate` is THE shared verdict for the audio worker
 *  and the legacy classifier. */
export function removeLoops(text: string): {
  text: string;
  removedTokens: number;
  totalTokens: number;
  degenerate: boolean;
} {
  const rows = sentenceRows(text);
  const counts = rows.map((r) => normaliseTokens(r.text).length);
  const totalTokens = counts.reduce((a, b) => a + b, 0);
  const drop = new Set<number>();
  for (const flag of findLoopFlags(rows)) {
    const [first, ...rest] = flag.rowIndices;
    rest.forEach((i) => drop.add(i));
    if (isLoop(rows[first].text)) drop.add(first);
  }
  let removedTokens = 0;
  drop.forEach((i) => {
    removedTokens += counts[i];
  });
  const cleaned =
    drop.size === 0
      ? text
      : rows
          .filter((_, i) => !drop.has(i))
          .map((r) => r.text)
          .join(' ');
  const degenerate =
    cleaned.trim() === '' ||
    (removedTokens >= DEGENERATE_MIN_REMOVED_TOKENS &&
      removedTokens / Math.max(1, totalTokens) >= DEGENERATE_MIN_RATIO);
  return { text: cleaned, removedTokens, totalTokens, degenerate };
}
