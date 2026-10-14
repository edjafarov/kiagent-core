# File Transcription Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the audio worker index long or noisy recordings as readable text in the right language, end speechless files cleanly, and repair the junk transcripts already stored.

**Architecture:**
- The file route of the local-ASR provider gets VAD (fail-closed) and `-mc 0`, and reports VAD's whole-file speech-segment count.
- The worker cleans the transcript with the meetings loop detector, which moves into core as `src/shared/asr/loops.ts`.
- Every outcome becomes a single `rev: 3` enrich. Worker `version` 3 re-seeds, and `classifyTranscribable` re-admits only legacy local-asr bodies that count as degenerate.

**Tech Stack:** TypeScript, jest (ts-jest), whisper.cpp `whisper-cli` v1.9.2 (bundled), better-sqlite3 store (integration test).

**Spec:** `docs/superpowers/specs/2026-10-14-file-asr-quality-design.md` (Rev 3, SATISFIED)

## Global Constraints

- **Worktree:** `/Users/edjafarov/work/kcore-asr`, branch `feat/file-asr-quality` (off origin/dev `d3595d89`, core v0.111.0).
- **Git:**
  - never `git commit --amend`, `rebase`, `reset` or `stash`;
  - `git add` only the files you name;
  - commit messages carry no `Co-Authored-By`.
- **Jest:**
  - needs `release/app/dist/main/main.js` and `release/app/dist/renderer/renderer.js` to exist. They are gitignored placeholders, already created;
  - run with `npx jest <paths>`.
- **Gates before the final commit:**
  - `npx jest` (full);
  - `npm run typecheck`;
  - `npx eslint <changed files>`;
  - `npx prettier --check <changed files>`.
- **Unchanged by this plan:** `hear()`'s argv and string contract, including `--no-prints` and the detect JSON.
- **Constants (verbatim from the spec):**
  - `DEGENERATE_MIN_REMOVED_TOKENS = 50`;
  - `DEGENERATE_MIN_RATIO = 0.5`;
  - extraction `rev: 3`;
  - worker `version: 3`.
- `src/shared/asr/loops.ts` starts as a **byte-for-byte copy** of alpha-cent `origin/dev:extensions/meetings/src/pipeline/loops.ts`, with additions appended after it. Never edit the copied part.

## Review Focus

1. **A long clean transcript with numbers, decimals and abbreviations** ("3.5 km", "z.B.", "Dr. Müller") must come out unchanged and not count as degenerate. A false positive here would permanently wipe a good body. Covered by Task 1's long-fixture test.
2. **A legacy body that is good but has a few repeats** (e.g. "Ja. Ja. Ja." inside a real conversation) must not be re-admitted. Covered by Task 4's classify test.
3. **`speechSegments === 0` while stdout still has text** must be treated as speech, so text is never discarded unread. Covered by Task 4's worker test.
4. **A missing Silero asset on a real install** must park candidates before the fetch (`hearReady` false), not fetch-and-defer. Covered by Tasks 3 and 4.
5. **A rev-3 enrich re-emits the document,** and that change must not re-admit it, or the doc would loop forever. Covered by Task 5's integration test.

---

### Task 1: Move the loop detector into core and add sentence cleanup

**Files:**
- Create: `src/shared/asr/loops.ts` (meetings copy + additions)
- Create: `src/shared/asr/__tests__/loops.test.ts` (meetings suite copy + new tests)

**Interfaces:**
- Produces:
  - `normaliseTokens(text: string): string[]`, `isLoop(text: string): boolean`, `findLoopFlags(rows: readonly LoopRow[]): LoopFlag[]`, and the types `LoopRow`, `LoopFlag`, unchanged from meetings;
  - `sentenceRows(text: string): LoopRow[]`;
  - `removeLoops(text: string): { text: string; removedTokens: number; totalTokens: number; degenerate: boolean }`;
  - `DEGENERATE_MIN_REMOVED_TOKENS`, `DEGENERATE_MIN_RATIO`.

- [ ] **Step 1: Copy the meetings module and its suite verbatim**

```bash
cd /Users/edjafarov/work/kcore-asr
mkdir -p src/shared/asr/__tests__
git -C /Users/edjafarov/work/alpha-cent show origin/dev:extensions/meetings/src/pipeline/loops.ts > src/shared/asr/loops.ts
git -C /Users/edjafarov/work/alpha-cent show origin/dev:extensions/meetings/src/__tests__/loops.test.ts \
  | sed "s#'../pipeline/loops'#'../loops'#" > src/shared/asr/__tests__/loops.test.ts
npx jest src/shared/asr
```
Expected: PASS. This is the moved meetings suite, unchanged apart from the import path.

- [ ] **Step 2: Write the failing tests for the additions** (append to `src/shared/asr/__tests__/loops.test.ts`)

```ts
import { removeLoops, sentenceRows } from '../loops';

const CLEAN_DE = [
  'Wir haben sieben Kinder, die geblieben sind und vier Kinder, die alles neu auf vier Wochen angefangen haben.',
  'Das Training kostet 3.5 Euro pro Einheit, z.B. am Dienstag um 17.30 Uhr.',
  'Dr. Müller hat gesagt, dass die Halle bis 2027 ausgebucht ist.',
  'Ja, das ist so.',
  'Die Kinder schwimmen 1.200 Meter in der Woche, also ca. 300 Meter pro Training.',
];
// ~1k words of varied clean speech: 40 rotations of the five lines with a
// counter so no two sentences are identical.
const LONG_CLEAN = Array.from(
  { length: 40 },
  (_, i) => CLEAN_DE.map((s) => `${s} (Runde ${i + 1})`).join(' '),
).join(' ');

describe('sentenceRows', () => {
  it('splits on sentence punctuation + whitespace and on newlines, not inside decimals', () => {
    expect(sentenceRows('Es kostet 3.5 Euro. Gut! Wirklich?\nNeu').map((r) => r.text)).toEqual([
      'Es kostet 3.5 Euro.',
      'Gut!',
      'Wirklich?',
      'Neu',
    ]);
  });
});

describe('removeLoops', () => {
  it('leaves clean text byte-identical and not degenerate', () => {
    const r = removeLoops(LONG_CLEAN);
    expect(r.text).toBe(LONG_CLEAN);
    expect(r.removedTokens).toBe(0);
    expect(r.degenerate).toBe(false);
  });

  it('keeps one of a short legitimate repeat and stays under the floor', () => {
    const r = removeLoops('Ja. Ja. Ja.');
    expect(r.text).toBe('Ja.');
    expect(r.removedTokens).toBe(2);
    expect(r.degenerate).toBe(false);
  });

  it('flags the Z88 junk as degenerate', () => {
    const junk = `Thank you. ${'I’m. '.repeat(790)}Thank you.`;
    const r = removeLoops(junk);
    expect(r.degenerate).toBe(true);
    expect(r.removedTokens).toBeGreaterThanOrEqual(789);
  });

  it('collapses an applause tail in otherwise clean text and is not degenerate', () => {
    const r = removeLoops(`${LONG_CLEAN} ${'Vielen Dank. '.repeat(20)}`.trim());
    expect(r.text).toBe(`${LONG_CLEAN} Vielen Dank.`);
    expect(r.removedTokens).toBe(38);
    expect(r.degenerate).toBe(false);
  });

  it('drops a sentence that loops inside itself', () => {
    const looped = `Und das ist ${'Klinikentizität '.repeat(12).trim()}.`;
    const r = removeLoops(`${CLEAN_DE[0]} ${looped} ${CLEAN_DE[2]}`);
    expect(r.text).toBe(`${CLEAN_DE[0]} ${CLEAN_DE[2]}`);
    expect(r.degenerate).toBe(false);
  });

  it('drops the kept first sentence of a run when it also loops inside itself', () => {
    const s = `${'der Klinikentizität '.repeat(5).trim()}.`;
    const r = removeLoops(`${CLEAN_DE[0]} ${s} ${s} ${s}`);
    expect(r.text).toBe(CLEAN_DE[0]);
  });

  it('treats text that is empty after cleanup as degenerate', () => {
    const r = removeLoops(`${'Klinik '.repeat(10).trim()}.`);
    expect(r.text).toBe('');
    expect(r.degenerate).toBe(true);
  });
});
```

Run: `npx jest src/shared/asr`
Expected: FAIL. `removeLoops`/`sentenceRows` are not exported.

- [ ] **Step 3: Append the implementation to `src/shared/asr/loops.ts`** (below the copied code, which stays unchanged)

```ts
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
 *  byte-identical. `degenerate` is THE shared verdict for the worker and
 *  the legacy classifier. */
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
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/shared/asr`
Expected: PASS, for both the moved suite and the new tests. If the "Klinik" self-loop fixtures don't trip `isLoop` (it needs ≥6 tokens and ≥60 % coverage), change only the **fixture** text, never the copied rule.

- [ ] **Step 5: Commit**

```bash
git add src/shared/asr/loops.ts src/shared/asr/__tests__/loops.test.ts
git commit -m "feat(asr): shared loop detector in core + sentence-level removeLoops"
```

---

### Task 2: whisper-cli result shape, `-mc 0`, and the speech-segment parse

**Files:**
- Modify: `src/main/providers/local-asr/whisper-cli.ts` (args at :207–232, argv at :245–280, stderr scan at :305–321, resolve at :365–372, and the comment at :257)
- Test: `src/main/providers/local-asr/__tests__/whisper-cli.test.ts`

**Interfaces:**
- Produces:
  - `export interface WhisperResult { text: string; speechSegments: number | null }`;
  - `runWhisperCli(args & { noContext?: boolean; verboseLog?: boolean }): Promise<WhisperResult>`;
  - `export const SPEECH_SEGMENTS_DIAGNOSTIC = 'Final speech segments after filtering:'`.
- Detect runs resolve `{ text: <the JSON string as today>, speechSegments }`.

- [ ] **Step 1: Read the existing test file's fake-child helper**, then write the failing tests:

```bash
grep -n "function fakeChild\|spawnFn\|stderr.emit\|mockReturnValue" src/main/providers/local-asr/__tests__/whisper-cli.test.ts | head -20
```

Add tests, using the file's existing fake-spawn helper to emit stdout/stderr chunks and `close`:

```ts
it('file-route argv: -mc 0 present and --no-prints absent when noContext + verboseLog', async () => {
  // run with { noContext: true, verboseLog: true, vadModelPath: '/vad.bin' }
  // expect argv to contain ['-mc', '0'] and '--vad', and NOT '--no-prints'
});
it('default argv unchanged: --no-prints present, no -mc', async () => {
  // run with no new flags → argv contains '--no-prints', not '-mc'
});
it('parses speechSegments from a line split across stderr chunks', async () => {
  // emit 'whisper_vad_segments_from_probs: Final speech seg' then 'ments after filtering: 1372\n'
  // resolve → { text: <stdout>, speechSegments: 1372 }
});
it('speechSegments stays sticky after >8 KiB of later stderr', async () => {
  // emit the line with 0, then 20 KiB of 'VAD segment ...' lines → speechSegments 0
});
it('speechSegments is null when the line never appears', async () => {});
it('detect runs still resolve the JSON as .text', async () => {
  // existing detect fixture → expect(result.text).toBe(JSON.stringify({language:'de',probability:0.9}))
});
```

Write each body concretely, following the existing tests in this file (same helper, same `await` pattern). Also update every existing assertion that compares the resolved value to a string: `expect(await run(...)).toBe('x')` becomes `expect((await run(...)).text).toBe('x')`.

Run: `npx jest src/main/providers/local-asr/__tests__/whisper-cli.test.ts`
Expected: FAIL (no `-mc`, resolves a string).

- [ ] **Step 2: Implement in `whisper-cli.ts`**

```ts
/** whisper.cpp v1.9.2 `whisper_vad_segments_from_probs` log line — reaches
 *  stderr only WITHOUT --no-prints. Counts speech in the WHOLE input (VAD
 *  ignores -ot/-d; measured 2026-10-14). ⚠️ Re-verify on a WHISPER_TAG bump. */
export const SPEECH_SEGMENTS_DIAGNOSTIC = 'Final speech segments after filtering:';
const SPEECH_SEGMENTS_RE = /Final speech segments after filtering: (\d+)/;

export interface WhisperResult {
  text: string;
  /** VAD speech-segment count for the whole input; null = never reported. */
  speechSegments: number | null;
}
```

Args, added next to `detectLanguage`:

```ts
  /** `-mc 0`: no previous-text conditioning across 30 s windows — stops a
   *  long-form loop from running to the end of the file (file route). */
  noContext?: boolean;
  /** Omit `--no-prints` so whisper's log (VAD speech count) reaches stderr. */
  verboseLog?: boolean;
```

Signature: `}): Promise<WhisperResult> {` and `new Promise<WhisperResult>(…)`.

Argv: replace `...(args.detectLanguage === true ? ['-dl'] : ['--no-prints']),` with

```ts
      ...(args.detectLanguage === true
        ? ['-dl']
        : args.verboseLog === true
          ? []
          : ['--no-prints']),
      ...(args.noContext === true ? ['-mc', '0'] : []),
```

Narrow the comment at :257 to: `Decoder-side knobs do NOT fix *silence* repeats (-mc 0, -sns, -nth all measured: no effect) — VAD does. -mc 0 DOES stop long-form loops (file route, spec 2026-10-14).`

Stderr scan, next to the `detected` parse:

```ts
      if (speechSegments === null && text.includes(SPEECH_SEGMENTS_DIAGNOSTIC)) {
        const m = SPEECH_SEGMENTS_RE.exec(text);
        if (m) speechSegments = Number(m[1]);
      }
```

with `let speechSegments: number | null = null;` declared beside `let detected`.

Resolve:

```ts
      if (args.detectLanguage === true) {
        resolve({
          text: JSON.stringify(detected === null ? { language: null } : detected),
          speechSegments,
        });
        return;
      }
      resolve({ text: Buffer.concat(out).toString('utf8'), speechSegments });
```

Update the doc comment's "exit 0 → resolve stdout" line to "exit 0 → resolve `{ text: stdout, speechSegments }`".

- [ ] **Step 3: Run the tests**

Run: `npx jest src/main/providers/local-asr/__tests__/whisper-cli.test.ts`
Expected: PASS. `provider.test.ts` will fail to type-check until Task 3; that is expected.

- [ ] **Step 4: Commit**

```bash
git add src/main/providers/local-asr/whisper-cli.ts src/main/providers/local-asr/__tests__/whisper-cli.test.ts
git commit -m "feat(local-asr): whisper-cli resolves {text, speechSegments}; -mc 0 + verbose-log opts"
```

---

### Task 3: Provider file route — VAD required, `-mc 0`, `vadAvailable()`

**Files:**
- Modify: `src/main/providers/local-asr/provider.ts` (the interface at :51–63, `runTranscribe` at :193–283, `transcribeFile` at :280–289, the `hear` return at :489, and the returned object at :543)
- Test: `src/main/providers/local-asr/__tests__/provider.test.ts`, plus `active-calls.test.ts` if its fakes return strings

**Interfaces:**
- Consumes: `WhisperResult` and the `runWhisperCli` options `noContext` and `verboseLog` (Task 2).
- Produces:
  - `LocalAsrProvider.transcribeFile(p, opts: { format: 'wav' | 'mp3'; timestamps?: boolean }): Promise<WhisperResult>`;
  - `LocalAsrProvider.vadAvailable(): boolean`.
- `hear()` (`handle`) still resolves a `string`.

- [ ] **Step 1: Update the tests first**
  - In `makeDeps`, change `runCli: jest.fn(async () => 'the transcript')` to `runCli: jest.fn(async () => ({ text: 'the transcript', speechSegments: null }))`.
  - Wrap every other `runCli` fake's resolved string the same way (`grep -n "runCli = jest.fn" provider.test.ts`).
  - Do the same in `active-calls.test.ts` if it has any.
  - Replace the test at :896, `'never enables VAD on the indexing transcribeFile route'`, with:

```ts
  it('indexing transcribeFile: VAD required, -mc 0, verbose log, background', async () => {
    const { fn } = keyedFilesPresent([
      path.join(tmpDir, WHISPER_LARGE_V3_TURBO_Q5_0.id),
    ]);
    const deps = makeDeps({
      asrModelsDir: tmpDir,
      filesPresent: fn,
      vadModelPath: VAD,
      fileExists: () => true,
    });
    const provider = createLocalAsrProvider(deps);
    const r = await provider.transcribeFile('/podcast.mp3', { format: 'mp3' });
    expect(r).toEqual({ text: 'the transcript', speechSegments: null });
    const a = deps.runCli.mock.calls[0][0];
    expect(a.vadModelPath).toBe(VAD);
    expect(a.noContext).toBe(true);
    expect(a.verboseLog).toBe(true);
    expect(a.priority).toBe('background');
  });

  it('indexing transcribeFile fails closed without the VAD asset', async () => {
    const deps = makeDeps({ vadModelPath: VAD, fileExists: () => false });
    const provider = createLocalAsrProvider(deps);
    await expect(
      provider.transcribeFile('/a.wav', { format: 'wav' }),
    ).rejects.toThrow(/refusing/);
    expect(deps.runCli).not.toHaveBeenCalled();
  });

  it('vadAvailable() reflects the Silero asset', () => {
    expect(
      createLocalAsrProvider(makeDeps({ vadModelPath: VAD, fileExists: () => true })).vadAvailable(),
    ).toBe(true);
    expect(
      createLocalAsrProvider(makeDeps({ vadModelPath: VAD, fileExists: () => false })).vadAvailable(),
    ).toBe(false);
    expect(
      createLocalAsrProvider(makeDeps({ vadModelPath: undefined })).vadAvailable(),
    ).toBe(false);
  });

  it('hear() still resolves a plain string and never passes -mc 0', async () => {
    const { fn } = keyedFilesPresent([
      path.join(tmpDir, WHISPER_LARGE_V3_TURBO_Q5_0.id),
    ]);
    const deps = makeDeps({ asrModelsDir: tmpDir, filesPresent: fn });
    const provider = createLocalAsrProvider(deps);
    const out = await provider.handle({
      kind: 'hear',
      payload: { audio: new Uint8Array([1]), format: 'wav' },
    } as any);
    expect(out).toBe('the transcript');
    expect(deps.runCli.mock.calls[0][0].noContext).toBeUndefined();
    expect(deps.runCli.mock.calls[0][0].verboseLog).toBeUndefined();
  });
```

If `makeDeps` doesn't accept `vadModelPath`/`fileExists` overrides in this form, copy how the neighbouring VAD tests (around :860–895) construct them.

Run: `npx jest src/main/providers/local-asr`
Expected: FAIL.

- [ ] **Step 2: Implement in `provider.ts`**
  - Import: `import { runWhisperCli, type WhisperResult, … } from './whisper-cli';` (add `type WhisperResult` to the existing import).
  - Interface: `transcribeFile(p, opts): Promise<WhisperResult>;` with the comment `/** Bundled-only file-path route (never on WorkerSession/CapSurfaces). VAD required, -mc 0, reports VAD speech (spec 2026-10-14). */`. Add `/** Silero VAD asset present — the file route refuses to run without it. */ vadAvailable(): boolean;`.
  - `runTranscribe`:
    - add `noContext?: boolean; verboseLog?: boolean;` to its `opts`;
    - return `Promise<WhisperResult>`, with `new Promise<WhisperResult>`;
    - pass `noContext: opts.noContext === true ? true : undefined, verboseLog: opts.verboseLog === true ? true : undefined,` to `runCli`;
    - `const result = await runCli({...}); resolve(result);`.
  - `hear`: `return (await runTranscribe(…)).text;`.
  - Replace `transcribeFile` and its doc comment:

```ts
  /** Indexing route (spec 2026-10-14): VAD REQUIRED (fail closed — running
   *  without it reintroduces noise-led language misdetection and silence
   *  hallucination), `-mc 0` (stops long-form loops), and the verbose log so
   *  the worker learns VAD's whole-file speech count (`speechSegments === 0`
   *  is a terminal "no speech", not a retried empty transcript). */
  const transcribeFile = async (
    p: string,
    opts: { format: 'wav' | 'mp3'; timestamps?: boolean },
  ): Promise<WhisperResult> =>
    runTranscribe(
      p,
      { ...opts, noContext: true, verboseLog: true },
      requireVadModel(),
      defaultModel,
      'background',
    );

  const vadAvailable = (): boolean =>
    deps.vadModelPath !== undefined && fileExists(deps.vadModelPath);
```

  - Add `vadAvailable,` to the returned object next to `transcribeFile,`.

- [ ] **Step 3: Run the tests**

Run: `npx jest src/main/providers/local-asr`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/providers/local-asr/provider.ts src/main/providers/local-asr/__tests__/provider.test.ts src/main/providers/local-asr/__tests__/active-calls.test.ts
git commit -m "feat(local-asr): file route requires VAD, runs -mc 0, reports speech; vadAvailable()"
```

(Leave `active-calls.test.ts` out of the `git add` if it was unchanged.)

---

### Task 4: Worker outcomes, legacy repair in classify, and the readiness gate

**Files:**
- Modify: `src/main/workers/audio/audio-worker.ts` (the deps type at :65–68, `version` at :92, and the post-transcribe block at :182–222)
- Modify: `src/main/workers/audio/classify.ts` (the `classifyTranscribable` extraction gate at :146, plus a new export)
- Modify: `src/main/workers/index.ts` (`hearReady` at :69–71)
- Test: `src/main/workers/audio/__tests__/audio-worker.test.ts`, `src/main/workers/audio/__tests__/classify.test.ts`

**Interfaces:**
- Consumes:
  - `removeLoops` from `@shared/asr/loops` (Task 1);
  - `WhisperResult` from `@main/providers/local-asr/whisper-cli` (Task 2);
  - `LocalAsrProvider.vadAvailable()` and `.status()` (Task 3).
- Produces:
  - `export const ASR_EXTRACTION_REV = 3` (classify.ts);
  - `export function isLegacyJunkTranscript(doc: Document): boolean` (classify.ts);
  - the worker dep `transcribeFile(path, { format }): Promise<WhisperResult>`.

- [ ] **Step 1: Write the failing classify tests** (append to `classify.test.ts`, reusing that file's doc factory; `grep -n "const doc\|function doc\|baseDoc" classify.test.ts` to find it)

```ts
describe('legacy local-asr repair (spec 2026-10-14 §3.4)', () => {
  const junk = `Thank you. ${'I’m. '.repeat(790)}`.trim();
  const legacy = (markdown: string | null, extraction: object) =>
    doc({ markdown, metadata: { mime: 'audio/mp4', filename: 'z.m4a', extraction } });

  it('admits a legacy (no rev) local-asr doc whose body is degenerate', () => {
    expect(classifyTranscribable(legacy(junk, { engine: 'local-asr', at: 'x' }))).toBe('candidate');
  });
  it('skips a legacy local-asr doc with a clean body', () => {
    expect(classifyTranscribable(legacy('Wir haben sieben Kinder.', { engine: 'local-asr' }))).toBe('skip');
  });
  it('skips a legacy body with only a short legitimate repeat', () => {
    expect(classifyTranscribable(legacy('Ja. Ja. Ja.', { engine: 'local-asr' }))).toBe('skip');
  });
  it('skips every rev-3 outcome, even with a junk body', () => {
    for (const ex of [
      { engine: 'local-asr', rev: 3 },
      { engine: 'local-asr', rev: 3, speech: 'none' },
      { engine: 'local-asr', rev: 3, quality: 'degenerate', loopsRemoved: 800 },
    ]) expect(classifyTranscribable(legacy(junk, ex))).toBe('skip');
  });
  it('never re-admits another extraction engine', () => {
    expect(classifyTranscribable(legacy(junk, { engine: 'vision' }))).toBe('skip');
  });
  it('skips a legacy local-asr doc with no body', () => {
    expect(classifyTranscribable(legacy(null, { engine: 'local-asr' }))).toBe('skip');
  });
});
```

Adjust `doc(...)` to the file's real factory: its type must be `'file'` or `'attachment'`.

- [ ] **Step 2: Write the failing worker tests** (in `audio-worker.test.ts`)
  - Change the `setup()` default `transcribeFile` to resolve `{ text: 'the transcript', speechSegments: 12 }`.
  - Change every existing fake `transcribeFile: async () => '...'` to resolve `{ text: '...', speechSegments: 12 }`.
  - Keep the existing empty-transcript test, with `{ text: '   ', speechSegments: 12 }`.
  - Change any `version` assertion to 3.
  - Add:

```ts
describe('rev-3 outcomes (spec 2026-10-14 §3.2)', () => {
  const run = async (result: { text: string; speechSegments: number | null }) => {
    const h = setup({ deps: { transcribeFile: async () => result } });
    const outcome = await h.worker.work(change(), h.session);
    return { outcome, enriched: h.enriched as any[] };
  };

  it('no speech: empty text + 0 segments → empty body, speech:none, done', async () => {
    const { outcome, enriched } = await run({ text: '', speechSegments: 0 });
    expect(outcome).toBe('done');
    expect(enriched[0].markdown).toBe('');
    expect(enriched[0].metadata.extraction).toMatchObject({ engine: 'local-asr', rev: 3, speech: 'none' });
  });

  it('text despite 0 segments is treated as speech', async () => {
    const { enriched } = await run({ text: 'Wir haben sieben Kinder.', speechSegments: 0 });
    expect(enriched[0].markdown).toBe('Wir haben sieben Kinder.');
    expect(enriched[0].metadata.extraction.speech).toBeUndefined();
  });

  it.each([12, null])('empty text with %p segments throws (bounded retry)', async (n) => {
    const h = setup({ deps: { transcribeFile: async () => ({ text: '  ', speechSegments: n }) } });
    await expect(h.worker.work(change(), h.session)).rejects.toThrow(/empty transcript/);
    expect(h.enriched).toHaveLength(0);
  });

  it('degenerate → empty body, quality:degenerate, done (terminal, no throw)', async () => {
    const { outcome, enriched } = await run({ text: `Thank you. ${'I’m. '.repeat(790)}`, speechSegments: 300 });
    expect(outcome).toBe('done');
    expect(enriched[0].markdown).toBe('');
    expect(enriched[0].metadata.extraction).toMatchObject({ engine: 'local-asr', rev: 3, quality: 'degenerate' });
    expect(enriched[0].metadata.extraction.loopsRemoved).toBeGreaterThanOrEqual(789);
  });

  it('a loop inside good text is removed and counted', async () => {
    const good = 'Wir haben sieben Kinder, die geblieben sind. Das Training kostet 3.5 Euro. Dr. Müller kommt morgen.';
    const { enriched } = await run({ text: `${good} ${'Vielen Dank. '.repeat(20)}`, speechSegments: 40 });
    expect(enriched[0].markdown).toBe(`${good} Vielen Dank.`);
    expect(enriched[0].metadata.extraction).toMatchObject({ rev: 3, loopsRemoved: 38 });
  });

  it('clean text is stored as-is without loopsRemoved', async () => {
    const { enriched } = await run({ text: ' Ja. Ja. Ja. ', speechSegments: 3 });
    expect(enriched[0].markdown).toBe('Ja.');
    const { enriched: e2 } = await run({ text: 'Alles gut.', speechSegments: 3 });
    expect(e2[0].metadata.extraction).not.toHaveProperty('loopsRemoved');
  });
});
```

Note the "Vielen Dank" test: if the 3-sentence `good` prefix makes 38/(38+n) ≥ 0.5 with removed < 50, the floor still keeps it non-degenerate. That is the floor working as intended, so keep the assertion.

Run: `npx jest src/main/workers/audio`
Expected: FAIL.

- [ ] **Step 3: Implement in `classify.ts`**

```ts
import { removeLoops } from '@shared/asr/loops';

/** Bumped with the audio worker's `version` whenever re-transcription of
 *  legacy output is wanted; every rev-N outcome carries it so its own
 *  re-emitted enrich can never re-admit the doc. */
export const ASR_EXTRACTION_REV = 3;

/** Legacy repair (spec 2026-10-14 §3.4): a pre-rev local-asr transcript
 *  whose body is degenerate under the SAME rule the worker applies. Good
 *  legacy transcripts and other extraction engines are never re-admitted. */
export function isLegacyJunkTranscript(doc: Document): boolean {
  const ex = (doc.metadata as TranscribableMeta).extraction as
    | { engine?: unknown; rev?: unknown }
    | null
    | undefined;
  if (ex == null || typeof ex !== 'object') return false;
  if (ex.engine !== 'local-asr' || ex.rev !== undefined) return false;
  const body = doc.markdown;
  if (typeof body !== 'string' || body.trim() === '') return false;
  return removeLoops(body).degenerate;
}
```

In `classifyTranscribable`, replace `if (meta.extraction != null) return 'skip'; // already extracted/transcribed` with:

```ts
  // Already extracted/transcribed — except legacy local-asr junk (spec
  // 2026-10-14 §3.4), which the v3 seed re-admits for re-transcription.
  if (meta.extraction != null && !isLegacyJunkTranscript(doc)) return 'skip';
```

Also update the `classifyTranscribable` doc comment's "Re-entrancy" sentence: rev-3 outcomes always carry `rev`, so the re-emitted change skips.

- [ ] **Step 4: Implement in `audio-worker.ts`**
  - Imports: `import { removeLoops } from '@shared/asr/loops';`, `import type { WhisperResult } from '@main/providers/local-asr/whisper-cli';`, and add `ASR_EXTRACTION_REV` to the `./classify` import.
  - Deps: `transcribeFile(path: string, opts: { format: 'wav' | 'mp3' }): Promise<WhisperResult>;`.
  - `version: 3,`, with the comment `// v3 (spec 2026-10-14): VAD + -mc 0 + loop cleanup; re-seed repairs legacy junk`.
  - `let transcript: string;` becomes `let result: WhisperResult;`, and `transcript = await deps.transcribeFile(...)` becomes `result = await deps.transcribeFile(...)`. The catch is unchanged.
  - Replace everything from `const text = transcript.trim();` through `return 'done';` with:

```ts
        const text = result.text.trim();
        const at = new Date().toISOString();
        const extraction = { engine: 'local-asr', rev: ASR_EXTRACTION_REV, at };
        if (!text) {
          if (result.speechSegments === 0) {
            // VAD found no speech in the whole file — terminal, and the
            // explicit '' clears any legacy body + its FTS row.
            session.enrich({
              documentId: doc.id,
              markdown: '',
              metadata: { extraction: { ...extraction, speech: 'none' } },
            });
            return 'done';
          }
          // Retained deliberately (spec §8): the audio path has returned empty
          // transcripts on valid speech; THROW so the engine's bounded retry
          // gets more shots and then records 'failed' — never a permanent skip.
          throw new Error('empty transcript');
        }

        const clean = removeLoops(text);
        if (clean.degenerate) {
          // Terminal on purpose (spec 2026-10-14 §3.2): the output is
          // deterministic, so retrying repeats the same junk; a throw would
          // also leave a legacy junk body in place (failed attempts write
          // nothing). The empty body takes the junk out of search.
          session.log(
            'info',
            `audio: degenerate transcript (${clean.removedTokens}/${clean.totalTokens} tokens looped) — ${doc.id}`,
          );
          session.enrich({
            documentId: doc.id,
            markdown: '',
            metadata: {
              extraction: {
                ...extraction,
                quality: 'degenerate',
                loopsRemoved: clean.removedTokens,
              },
            },
          });
          return 'done';
        }

        session.enrich({
          documentId: doc.id,
          markdown: clean.text,
          metadata: {
            extraction:
              clean.removedTokens > 0
                ? { ...extraction, loopsRemoved: clean.removedTokens }
                : extraction,
          },
        });
        return 'done';
```

Update the header doc comment: add a bullet "a transcript that is mostly loop, or a file with no speech → DONE with an empty body and a rev-3 marker (terminal)".

- [ ] **Step 5: Implement the readiness gate in `workers/index.ts`**

Replace the `hearReady` property and its comment with:

```ts
    // The provider transcribeFile actually uses, AND its Silero asset: the
    // file route refuses to run without VAD, so a broken install parks
    // candidates here — before the fetch — instead of fetch-and-defer.
    hearReady: () =>
      deps.localAsr.status() === 'ready' && deps.localAsr.vadAvailable(),
```

If a test covers `workers/index.ts` wiring (`grep -rn "hearReady" src/main/workers/__tests__ 2>/dev/null`), update its fake `localAsr` to include `vadAvailable: () => true` and add a case where `vadAvailable: () => false` → the worker's `hearReady` is false.

- [ ] **Step 6: Run the tests**

Run: `npx jest src/main/workers src/shared/asr src/main/providers/local-asr`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/workers/audio/audio-worker.ts src/main/workers/audio/classify.ts src/main/workers/index.ts src/main/workers/audio/__tests__/audio-worker.test.ts src/main/workers/audio/__tests__/classify.test.ts
git commit -m "feat(audio): v3 — loop cleanup, terminal no-speech/degenerate, legacy junk repair"
```

---

### Task 5: Engine integration — v2 junk is repaired once, then never re-admitted

**Files:**
- Create: `src/main/workers/audio/__tests__/audio-legacy-repair.test.ts`

**Interfaces:**
- Consumes:
  - `createAudioWorker` (Task 4);
  - the real `openStore`/`openDb`/`createEngine`, following the pattern in `src/main/workers/convert/__tests__/convert-pipeline.test.ts:1–145`.

- [ ] **Step 1: Write the test**

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Document, DocumentInput, Source } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { createEngine } from '../../../core/engine/engine';
import { openStore, type CoreStore } from '../../../core/store/store';
import { createAudioWorker } from '../audio-worker';

const JUNK = `Thank you. ${'I’m. '.repeat(790)}`.trim();
const GOOD = 'Wir haben sieben Kinder, die geblieben sind und vier Kinder, die neu angefangen haben.';

const legacyFile = (externalId: string, markdown: string): DocumentInput => ({
  externalId,
  type: 'file',
  title: 'Z88 Clubhaus.m4a',
  markdown,
  metadata: {
    mime: 'audio/mp4',
    filename: 'Z88 Clubhaus.m4a',
    sizeBytes: 1000,
    extraction: { engine: 'local-asr', at: '2026-10-13T19:47:00Z' },
  },
  createdAt: null,
});

const source = (): Source => ({
  descriptor: { id: 'folder', name: 'Folder', documentTypes: ['file'], auth: 'none' },
  async connect() { return { identifier: 'me' }; },
  // eslint-disable-next-line require-yield
  async *pull() {},
  toDocument: (item) => item as DocumentInput,
  fetchBytes: async () => new Uint8Array([1, 2, 3]),
});

async function waitFor(cond: () => Promise<boolean>, ms = 5000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('audio v3 legacy repair (real store + engine)', () => {
  let dir: string;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-audio-v3-'));
    store = await openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
    });
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('re-transcribes a v2 junk body once, replaces it, and does not re-admit it; a clean v2 body is untouched', async () => {
    const engine = createEngine({
      store,
      sources: { get: () => source() },
      inference: { complete: async () => '', see: async () => '', read: async () => '', hear: async () => '' },
      convert: async (d) => d,
      logs: { log: () => {} },
    });
    const account = await store.createAccount({ source: 'folder', identifier: 'x' });
    await store.commit({
      account: account.id,
      documents: [legacyFile('junk', JUNK), legacyFile('good', GOOD)],
      cursor: 1,
    });

    const transcribeFile = jest.fn(async () => ({ text: GOOD, speechSegments: 9 }));
    const worker = createAudioWorker({
      laneOpen: () => true,
      requestAsr: () => {},
      hearReady: () => true,
      transcribeFile,
      prepareFile: async () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-audio-v3-p-'));
        const p = path.join(d, 'a.wav');
        fs.writeFileSync(p, Buffer.alloc(4));
        return { path: p, dir: d, format: 'wav', sizeBytes: 4 } as never;
      },
      mp3Duration: () => null,
      totalMemBytes: 32 * 1024 ** 3,
    });
    const handle = engine.attach(worker); // new consumer worker:audio:v3 → seed

    const read = async (id: string) =>
      (await store.read.byExternalId(account.id, id, 'file')) as Document;
    await waitFor(async () => ((await read('junk')).metadata as any).extraction?.rev === 3);

    const junk = await read('junk');
    expect(junk.markdown).toBe(GOOD);
    expect((await read('good')).markdown).toBe(GOOD);
    expect(((await read('good')).metadata as any).extraction.rev).toBeUndefined();
    // The rev-3 enrich re-emitted 'junk'; give the feed time to see it.
    await new Promise((r) => setTimeout(r, 300));
    expect(transcribeFile).toHaveBeenCalledTimes(1);
    await handle.stop();
  });
});
```

Copy the exact `createEngine` deps shape from `convert-pipeline.test.ts:132–145`. If `store.commit` requires extra fields there, mirror them.

- [ ] **Step 2: Run it**

Run: `npx jest src/main/workers/audio/__tests__/audio-legacy-repair.test.ts`
Expected: PASS. If better-sqlite3 reports an ABI mismatch, run `npm rebuild better-sqlite3` and retry.

- [ ] **Step 3: Mutation check.** Temporarily change `ASR_EXTRACTION_REV` usage so the outcome omits `rev`: the test must fail with `toHaveBeenCalledTimes(1)` (re-admission) or a timeout. Revert.

- [ ] **Step 4: Commit**

```bash
git add src/main/workers/audio/__tests__/audio-legacy-repair.test.ts
git commit -m "test(audio): v3 seed repairs v2 junk once and never re-admits it"
```

---

### Task 6: Gates and real-binary acceptance

- [ ] **Step 1: Full gates**

```bash
cd /Users/edjafarov/work/kcore-asr
npx jest 2>&1 | tail -15
npm run typecheck
F=(src/shared/asr/loops.ts src/shared/asr/__tests__/loops.test.ts src/main/providers/local-asr/whisper-cli.ts src/main/providers/local-asr/provider.ts src/main/workers/audio/audio-worker.ts src/main/workers/audio/classify.ts src/main/workers/index.ts src/main/workers/audio/__tests__/*.ts src/main/providers/local-asr/__tests__/*.ts)
npx eslint $F && npx prettier --check $F
```
Expected: everything green. Re-run any timing-flaky suite on its own before believing a failure.

- [ ] **Step 2: Real-binary acceptance on Z88 with the exact production argv**

Build the argv from the code (`-m <turbo> -f z88.wav -l auto --no-timestamps --vad -vm <silero> -vt 0.5 -vspd 150 -vsd 100 -vp 120 -vo 0.1 -mc 0 -t 4`, no `--no-prints`). Then:
- run `removeLoops` over stdout through a throwaway jest test, or `npx ts-node`;
- check `speechSegments` from stderr;
- listen to 3 sampled passages against the text.

Repeat on a 30 s silent WAV (expect `Final speech segments after filtering: 0` and empty text) and on a short clean clip. Record the results in the spec's §1 table.

- [ ] **Step 3: Commit any spec update**

```bash
git add docs/superpowers/specs/2026-10-14-file-asr-quality-design.md
git commit -m "docs(spec): file ASR acceptance results"
```

---

### Task 7 (after the core release — founder OK required): Meetings imports the shared detector

**Repo:** alpha-cent, on a new branch off `dev`.

- [ ] Bump `core.lock` to the released tag. Then:
  - `cp -R assets/whisper assets/llama assets/vision build/.core/assets/`;
  - `cd build/.core && npm ci`.
- [ ] In `extensions/meetings/src/pipeline/transcribe.ts:70`, change `from './loops'` to `from '@shared/asr/loops'`. Do the same in `extensions/meetings/src/pipeline/accuracy.ts:12`.
- [ ] Delete `extensions/meetings/src/pipeline/loops.ts` and `extensions/meetings/src/__tests__/loops.test.ts`. The suite now lives in core.
- [ ] Run `npx jest extensions/meetings` and `npm run typecheck`, then build the meetings extension (`cd extensions/meetings && KIA_MEETINGS_SKIP_NATIVE=1 node build.mjs`). All must be green with no behaviour change.
- [ ] Commit: `refactor(meetings): use core's shared loop detector`.
