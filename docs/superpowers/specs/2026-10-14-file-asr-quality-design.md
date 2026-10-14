# File transcription quality — design

Rev 3 · 2026-10-14 · SATISFIED (codex astra r2, opus r2) · r1 blockers folded into rev 2, r2 suggestions into rev 3 · core `feat/file-asr-quality` (off origin/dev d3595d89, v0.111.0) + alpha-cent meetings follow-up

## 1. Problem

The audio worker stores garbage for long, noisy recordings and never retries them.

Case: `Z88 Clubhaus.m4a` (local-folder doc `01a136c9-…`). It is a 1 h 37 min German club meeting that opens with room noise and applause. The stored body is 4,358 characters of "Thank you. I'm. I'm. I'm. …" (about 790 repeats). The engine detected the document's language as `hau`, and the doc is marked done.

Reproduced exactly with the bundled whisper-cli and the app's argv (turbo q5_0, `-l auto --no-timestamps --no-prints -t 4`, no VAD). The cause is three things together:

1. **Wrong language.** Without VAD, whisper detects the language from the first 30 s of raw audio, which here is noise. It chose `en (p = 0.23)` and then decoded German as English.
2. **Loops never end.** Each 30 s window is conditioned on the previous text, so once a loop starts it runs to the end of the file. This is the default whisper `-mc` behaviour.
3. **Nothing checks the result.** `audio-worker.ts` treats any non-empty text as success. `classify.ts` then skips the doc forever, because `metadata.extraction` is set.

The indexing route disables VAD on purpose (`provider.ts:280`). VAD returns empty text for speechless files, and the worker turns an empty transcript into a retried failure.

### Measurements (same binary and model, `-t 4`)

| Run | Language | Result |
|---|---|---|
| App argv, no VAD | en p=0.23 | "I'm." loop to the end |
| VAD + `-mc 0`, whole file | de p=0.91 | 9.4k words, 0 repeated sentences, 128 s |
| large-v3 + VAD + `-l de`, no `-mc 0` | de | clean until 28:35, then looped to the end |
| VAD, 10-min chunks (`-ot/-d`), no `-mc 0` | de p=0.915 (identical in every chunk) | 6.7k words, 86 adjacent duplicate sentences. Several chunks lose most of their 10 minutes to loops: chunk 3 is 364 words of mostly "Klinikentizität."; chunk 7 is 80 words. |
| VAD, 10-min chunks, `-mc 0` | de p=0.915 | 10.2k words, 34 duplicates. 19 of them are "Vielen Dank." in the closing applause. 273 s in total. |

Three things follow:

- **VAD fixes language detection.** With VAD on, whisper detects the language on the first speech in the file, confidently. `-ot` does not move detection.
- **`-mc 0` is what stops content loss.** Loops also happen with the correct language. Chunking only contains them, and they still eat whole chunks.
- **Chunking is not worth its cost.** With `-mc 0`, the whole-file run and the chunked run are both readable, and chunking is about 2× slower: whisper re-runs VAD over the *whole* file on every `-ot` call ("detecting speech timestamps in 92141205 samples" each time). Hallucinations on applause ("Vielen Dank." ×20) still need an output check either way.

## 2. Goals / non-goals

- **G1:** Indexing a long or noisy recording produces readable text in the right language. It never stores a loop as a transcript.
- **G2:** A file with no speech ends in a final "no speech" state. It does not become a retried failure.
- **G3:** Existing junk transcripts get re-transcribed automatically. Good transcripts do not.
- **G4:** Meetings and core share one loop detector, and it lives in core.
- **Non-goals:**
  - model escalation for files (the accuracy model) — follow-up;
  - chunked transcription, and language voting or detection from samples — neither is needed once VAD and `-mc 0` are on (§1);
  - timestamps in the stored body;
  - lifting the RAM-tiered decoded-size cap;
  - any meetings behaviour change.

## 3. Design

### 3.1 Provider: the file route uses VAD and `-mc 0`, and reports VAD speech

`transcribeFile` (`provider.ts:285`) becomes:

```ts
transcribeFile(
  p: string,
  opts: { format: 'wav' | 'mp3' },
): Promise<{ text: string; speechSegments: number | null }>;
```

- **VAD is required.** It uses `requireVadModel()`, which already exists for `hear({vad:'required'})`. A missing Silero asset throws a plain Error, so the worker defers. Silently running without VAD would bring the bug back.
- **`-mc 0` is always on for this route**, through a new `runCli` arg `noContext: true`. It is keyed to the file route, not the priority class (`hear()` can also run in the background lane), and `hear()` does not change.
- **Speech evidence.** The file route drops `--no-prints`, so that whisper's log reaches stderr.
  - `runCli` already scans stderr incrementally with sticky flags, so `speechSegments` is one more sticky parse of `Final speech segments after filtering: N` (`whisper_vad_segments_from_probs`, measured on the bundled binary).
  - It is `null` when the line never appeared. Callers treat `null` as unknown, never as "no speech".
  - Text stays on stdout; only the log grows. VAD prints one line per segment (1,372 here), which the existing `STDERR_CAP_BYTES` tail-truncation bounds. The parse is sticky, so truncation can't un-see the line.
- **One result shape.** `runWhisperCli` and the provider queue (`runTranscribe`) always resolve `{ text, speechSegments }`. `hear()` returns `.text`, so its contract is unchanged, including the language-detection JSON. There is no second queue, no side channel, and no return type that depends on a flag.
- **Cheap VAD gate.** The provider exposes `vadAvailable(): boolean`, which reuses `requireVadModel`'s check without throwing. In `workers/index.ts`, the audio worker's `hearReady` gains `localAsr.vadAvailable() &&` in front of its existing inference-plane check. *Implementation note:* codex r2 suggested replacing the plane check with `localAsr.status()`. That was not done: `attach-bundled-workers.test.ts` pins the plane check as a deliberate provider-agnostic design, and changing it is outside this spec's scope. A broken install then parks candidates before the fetch, as it already does while whisper is missing, instead of fetching up to 200 MB and deferring every 30 minutes.
- **The comment at `whisper-cli.ts:257` gets narrowed.** `-mc 0` did not fix *silence* repeats; that is VAD's job. It does stop long-form loops (§1).

`hear()` does not change, and keeps its `--no-prints`.

### 3.2 Worker: transcribe, check, store

The changes are in `audio-worker.ts`. Fetch, prepare, caps and temp-dir cleanup stay as they are. It is still one `transcribeFile` call per document.

1. The transcribe catch keeps today's semantics: 4xx → skip, anything else → defer.
2. Run the loop check (§3.3) on the text.
3. Outcome, checked in this order. Every rev-3 outcome is a single `enrich` followed by `done`, except the empty-text throw:
   - **No speech:** `speechSegments === 0` and the text is empty. Enrich `markdown: ''` with `extraction: { engine: 'local-asr', rev: 3, at, speech: 'none' }`. The explicit empty value clears any old body and its FTS row (`write-tx.ts:815`). If text exists despite a zero count, it is treated as speech and goes through the steps below; text is never thrown away unread.
   - **Empty text with `speechSegments` > 0 or `null`:** throw `Error('empty transcript')`, exactly as today (`audio-worker.ts:211`). This is the documented empty-on-valid-speech case. The engine's bounded retry handles it: 3 attempts, then `failed`.
   - **Degenerate** (§3.3): enrich `markdown: ''` with `extraction: { engine: 'local-asr', rev: 3, at, quality: 'degenerate', loopsRemoved }`.
     - This is terminal on purpose. The output is deterministic, so retrying would just repeat about 2 minutes of turbo work, or hours on a CPU host, for the same junk. A throw would also leave a legacy junk body in place: a failed final attempt writes nothing (`engine.ts:879`).
     - The empty body takes the junk out of search. `rev: 3` stops it being admitted again.
     - Escalating to the accuracy model, the non-goal follow-up, would plug in exactly here.
   - **Otherwise:** enrich `markdown = cleaned` with `extraction: { engine: 'local-asr', rev: 3, at, loopsRemoved? }`. `loopsRemoved` is present only when it is > 0.

### 3.3 The loop check: `src/shared/asr/loops.ts`

The file moves byte-for-byte from `alpha-cent/extensions/meetings/src/pipeline/loops.ts`: `normaliseTokens`, `isLoop`, `findLoopFlags`, and the `LOOP_*` constants. Its jest suite moves with it.

The file route has no timestamps, so core adds one helper next to it:

```ts
/** Sentence rows for the loop rule: split on [.!?…] + newline boundaries. */
export function sentenceRows(text: string): LoopRow[]; // startMs=endMs=index, speaker 'them', label null
export function removeLoops(text: string): { text: string; removedTokens: number; totalTokens: number; degenerate: boolean };
```

`removeLoops` runs `findLoopFlags(sentenceRows(text))` and works on whole sentences only:

- **A run of identical sentences** (≥ 3) keeps its first sentence and drops the rest.
- **A sentence flagged by `isLoop`** is dropped whole, and all of its tokens count as removed. This includes the kept first sentence of a run, so a sentence that loops inside itself is caught too.
  - `findLoopFlags` never runs `isLoop` on rows inside an identical run (its `consumed` set). So `removeLoops` calls `isLoop` on each run's kept first row itself.
- **Why whole sentences:** `isLoop` only flags a sentence when the repetition covers ≥ 60 % of its tokens, so at most 40 % of meaningful text goes with it. Cutting out just the repeated span would need a span-returning version of the scan and would have to rebuild text from normalised tokens. That is more code for a search body.

**Degenerate**, returned by `removeLoops` so the worker and the classifier cannot drift apart, means `removedTokens ≥ 50` **and** `removedTokens / totalTokens ≥ 0.5`, or the text is empty after cleanup.

The absolute floor of 50 tokens keeps short repeats out of "degenerate". Fixture outcomes:

| Input | Result |
|---|---|
| "Ja. Ja. Ja." | stored as "Ja." (removed 2 of 3 tokens, under the floor) |
| Z88 legacy junk (~800 × "I'm.") | degenerate |
| mc0 output with "Vielen Dank." ×20 at the end | stored, `loopsRemoved` ≈ 38 |
| clean German | stored unchanged |

### 3.4 Re-transcribing the junk that is already stored

- **Version bump:** `version` goes from `2` to `3`. The new consumer `worker:audio:v3` gets seeded from `documents`, and the seed calls `matches()`.
- **`classifyTranscribable`** keeps skipping anything with `extraction` set, with one exception (the legacy repair): `extraction.engine === 'local-asr'`, no `rev`, and a stored `markdown` that counts as degenerate under §3.3. That admits exactly the junk bodies.
  - Good legacy transcripts are not reprocessed.
  - Docs from other extraction engines are never touched.
  - Every rev-3 outcome carries `rev: 3`, so the enrich that re-emits the doc can never re-admit it.
- **Seed cost:** the v3 seed calls `matches()` on every document. Docs that ended `skip` under v2 (over the decoded-size cap, or input rejected) carry no `extraction`, so they are fetched and prepared once more before skipping again. That is a one-time cost, not a regression.
- **Older failures:** docs that ended `failed` under v2 (for example after empty transcripts) have no `extraction`. They are ordinary candidates again on the v3 seed. That is intended: VAD is exactly what changes their outcome.

### 3.5 Meetings (alpha-cent, after the core release)

- Bump `core.lock`.
- `extensions/meetings/src/pipeline/{accuracy,transcribe}.ts` import from `@shared/asr/loops`. The meetings esbuild already aliases `@shared` to `build/.core/src/shared` (`extensions/meetings/build.mjs:68`).
- Delete `pipeline/loops.ts` and `__tests__/loops.test.ts`.
- No behaviour change. The meetings suite must stay green unchanged, apart from the import paths.

`language.ts` (the multi-probe language lock) stays in meetings. The file route doesn't need it (§1). Meetings needs it because its per-speaker channels start in silence and switch language per segment.

## 4. Tests

- **whisper-cli:**
  - file-route argv has `--vad …` and `-mc 0`, and no `--no-prints`;
  - `hear()` argv is unchanged;
  - `speechSegments` is parsed from a line split across stderr data events, stays sticky past stderr truncation, and is `null` when absent.
- **provider:**
  - `transcribeFile` fails closed without the VAD asset;
  - `vadAvailable()` reflects the asset, and `hearReady` is false without it;
  - `hear()` still resolves a plain string, and detect runs still return their JSON;
  - replaces the "never enables VAD on indexing" test (`provider.test.ts:896`).
- **loops:**
  - the moved meetings suite;
  - a long clean German fixture: 1k+ words of real transcript, including numbers, decimals and abbreviations, comes out unchanged;
  - `sentenceRows`/`removeLoops` on a sentence that loops inside itself (dropped), on a run whose first sentence also loops (all dropped), on the Z88 junk sample, on the "Und dann ist es so…" tail, on "Ja. Ja. Ja.", and on clean German.
- **audio-worker:**
  - a looped transcript is cleaned and stored with `loopsRemoved`;
  - degenerate → enrich `markdown: ''` + `quality: 'degenerate'`, `done`, no throw;
  - `speechSegments === 0` with empty text → `markdown: ''` + `speech: 'none'`;
  - `speechSegments === 0` with text → treated as speech;
  - empty text with `> 0` or `null` → throws;
  - "Ja. Ja. Ja." → stored as "Ja.";
  - a transcribe failure defers or skips as today;
  - temp-dir cleanup on every path.
- **classify:**
  - legacy junk local-asr is admitted;
  - legacy clean local-asr is skipped;
  - `rev: 3` (including `speech: 'none'` and `quality: 'degenerate'`) is skipped;
  - legacy "Ja. Ja. Ja." is skipped (not degenerate);
  - other engines are skipped.
- **Engine integration:** a v2-done junk doc is attached to the v3 worker, its body is replaced, and it is not re-admitted.
- **Real-binary acceptance (manual):** the final argv on Z88. Sample passages are listened to; word count is not used as the quality measure. Also a silent clip (→ no speech) and a short clean clip.
