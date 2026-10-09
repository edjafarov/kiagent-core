# Warm whisper server (#143) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Interactive meeting transcription on eligible Macs loads the default whisper model once per warm period (a resident `whisper-server`) instead of once per `hear` call, with byte-identical output to `whisper-cli`.

**Architecture:** The local-ASR provider keeps its single-flight FIFO queue. A pure `routeJob()` decides per job: eligible interactive jobs go over HTTP to a lazily started, idle-stopped `WhisperServer` child (modelled on `local-llm/server.ts`, minus the respawn loop); everything else runs `whisper-cli` exactly as today, and every CLI spawn first stops the server so at most one whisper model is resident. The HTTP request is a pinned constant (`WHISPER_SERVER_REQUEST`), and `formatCliLines()` turns the server's VTT into the CLI's exact stdout.

**Tech Stack:** TypeScript (Electron main), undici 7.30.0 (`Agent`, `fetch`, `FormData`), whisper.cpp b5130 (`whisper-cli`, `whisper-server`), jest 29.7 (ts-jest; repo default env is jsdom, so new tests that touch undici/child processes use `/** @jest-environment node */`), node .mjs build scripts.

**Spec:** `docs/superpowers/specs/2026-10-09-warm-whisper-server-design.md` (APPROVED rev 4; binding). Read it before any task.

**Repo/worktree:** kiagent-core at `~/work/kcore-asr`, branch `opt/asr`, base v0.106.0 (`c8d91864` adds the spec). All paths below are relative to `~/work/kcore-asr` unless absolute.

`SCR` below means `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad`.

## Global Constraints

- Tests/builds run SEQUENTIALLY only; full jest suites, builds and packaging go through `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh <cmd>`. Targeted single jest files may run directly.
- Worktrees symlink node_modules/release/app deps to ~/work/kiagent-core; NEVER run `npm run build` or `npm ci` in a worktree (shared dist). Building whisper-server (scripts/build-whisper.mjs) writes vendored assets — run it only with an output dir in the scratchpad, via heavy.sh.
- Never git stash/amend/rebase/reset. Commit with `git commit -F <msgfile> -- <paths>`; no Co-Authored-By lines.
- `npm run lint` (or eslint on touched files) and `npx tsc --noEmit -p .` are gates.
- Every task after Task 1 proceeds ONLY if Task 1 recorded **go**.
- Scope is macOS only. Off darwin, `resolveWhisperServerBinary()` returns null ("absent") and behaviour is unchanged (spec "Scope").
- Pinned whisper.cpp: `WHISPER_TAG = b5130`, commit `927cfce34f31707e17f2bff35c349632fb9e2c3a` (scripts/whisper-assets.mjs). Do not bump.
- `IDLE_STOP_MS = 5 * 60_000`; startup timeout 60 s; health poll 500 ms; stop = SIGTERM then SIGKILL after 3 s; two crashes in one session disable the server; `KIA_ASR_SERVER=0` disables it (spec §2, Rollout).
- Errors are keyed on HTTP status only: 400 → `AsrInputRejectedError` (status 400); anything else (500, 503, 499, connection error) → plain `Error` (spec §3).
- HTTP client dispatcher: `new Agent({ headersTimeout: 0, bodyTimeout: 0 })`; abort is via signal only (spec §3).
- Log lines (exact prefixes): `[local-asr] server start model=<slug> ms=<n>`, `[local-asr] job via=server|cli reason=<rule> ms=<n>`, `[local-asr] server disabled: <err>` (spec §2).
- whisper-server is always spawned with `--request-path /<secret>`. `<secret>` is `crypto.randomBytes(24).toString('base64url')` (32 chars), fresh per child. It is part of `baseUrl()` and is never logged or put in an error message. b5130 prefixes `/`, `/inference`, `/load` and `/health` with it (server.cpp:818, 823, 826, 1175, 1218), so a caller without the secret (e.g. a web page: a multipart POST needs no CORS preflight) cannot reach `/load`, which `exit(1)`s on a bad model path.
- Pid file `<userData>/whisper-server.pid` holding `{pid, binary}`; reap only when the pid is alive AND `ps -o comm= -p <pid>` names our binary (spec §2).
- Any jest invocation naming more than one file or a directory goes through heavy.sh too; only a single named test file runs directly.
- Jest in this worktree: `release/app/dist` is a symlink to the shared built dist, so `.erb/scripts/check-build-exists.ts` passes without building. Run single files as `npx jest <path>`.
- Tasks 1 and 11 are CONTROLLER steps on the founder Mac (vendored binaries + downloaded models). Implementer subagents never run them, never run `scripts/build-whisper.mjs`, and never run `npm run test:asr-parity`.

## Review Focus

1. **App quits while the server is still loading the model (the 60 s start window).** Expected: `dispose()` waits for the pending start to settle, then stops that child; no orphan `whisper-server`. Test added to Task 7 (`dispose during a pending start`).
2. **A stale pid file whose pid has been recycled to an unrelated process.** Expected: it is NOT killed; the stale file is removed. Test added to Task 5 (`reapOrphanServer` "not ours").
3. **`KIA_HOST_WEAK=0` on a non-darwin host** (the override makes `weak` false). Expected: still CLI with reason `platform` — the platform rule is checked independently of `weak`. Test added to Task 6.
4. **The server process dies before it ever becomes healthy** (port grabbed between `pickFreePort` and bind, Metal init failure). Expected: start rejects fast (not after 60 s) with the server's output tail in the message, the session is disabled once, and the job that tried still runs on the CLI. Tests added to Task 5 (exit-before-healthy) and Task 7 (start failure falls back).
5. **A segment whose VTT has an empty-text cue or hours ≥ 100.** Expected: `formatCliLines` emits `[t0 --> t1]  ` + empty text + `\n`, and 3-digit hours unchanged, exactly as the CLI would print. Tests added to Task 4.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/main/providers/local-asr/routing.ts` | Create | Pure `routeJob()` → `{via, reason}` (spec §1). |
| `src/main/providers/local-asr/server-request.ts` | Create | Pinned HTTP contract: `WHISPER_SERVER_REQUEST`, form fields, dispatcher, `transcribeViaServer`, `formatCliLines`, status→error (spec §3). |
| `src/main/providers/local-asr/server.ts` | Create | `WhisperServer` child lifecycle (spawn, health, stop, pid file), `reapOrphanServer`, `whisperServerArgs`, `resolveWhisperServerBinary` (spec §2). |
| `src/main/providers/local-asr/provider.ts` | Modify | Routing, `ensureServer`/`stopServer`/idle timer, crash/disable bookkeeping, `serverStats()`, dispose order. |
| `src/main/providers/local-asr/index.ts` | Modify | Re-export new public names. |
| `src/main/providers/index.ts` | Modify | Pass `serverBinaryPath` + `pidFilePath`. |
| `src/shared/ipc.ts` | Modify | `inference:stats` res gains optional `asrServer`. |
| `src/main/main.ts` | Modify | `inference:stats` handler adds `asrServer`. |
| `scripts/whisper-assets.mjs` | Modify | `WHISPER_DARWIN_BINARIES`, `WHISPER_TAG_STAMP`, `whisperVendorIsCurrent()`. |
| `scripts/build-whisper.mjs` | Modify | Build/gate/vendor `whisper-server` too; `KIA_WHISPER_OUT_DIR`. |
| `scripts/test-asr-parity.mjs` | Create | Founder-Mac runner: subprocess prerequisite checks, fixtures, runs the parity jest file. |
| `package.json` | Modify | `"test:asr-parity"` script. |
| `src/main/providers/local-asr/__tests__/routing.test.ts` | Create | Routing reasons. |
| `src/main/providers/local-asr/__tests__/server-request.test.ts` | Create | Contract, goldens, error map, dispatcher. |
| `src/main/providers/local-asr/__tests__/server.test.ts` | Create | Lifecycle + reaping. |
| `src/main/providers/local-asr/__tests__/provider-server.test.ts` | Create | Provider ↔ server integration with fakes. |
| `src/main/providers/local-asr/__tests__/parity.real.test.ts` | Create | Real-binary parity + acceptance + measurement (skipped unless `KIA_ASR_PARITY=1`). |
| `src/__tests__/whisper-vendor-current.test.ts` | Create | Stamp requires both binaries; CLI-only dir re-vendors. |
| `docs/superpowers/specs/2026-10-09-warm-whisper-server-design.md` | Modify | Field diff (Task 2), rulings, status (Task 10), results (Task 11). |

---

### Task 1: Step 0 go/no-go measurement — CONTROLLER, founder Mac

**This is a manual controller step. Implementer subagents do not run it. No later task starts until this task records "go".**

**Files:** none in the repo (results go into the PR body and issue #143; Task 11 copies them into the spec).

Inputs on the founder Mac (checked 2026-10-09):
- `whisper-cli`: `~/work/kiagent-core/assets/whisper/darwin-arm64/whisper-cli`. Its `.whisper-tag` says **v1.9.2** (not b5130). Record that in the result. Model load + Metal init cost does not depend on that version difference, so it is representative.
- VAD model: `~/work/kiagent-core/assets/whisper/ggml-silero-v5.1.2.bin`.
- Turbo: `~/Library/Application Support/KIAgent-dev/data/models/asr/whisper-large-v3-turbo-q5_0/ggml-large-v3-turbo-q5_0.bin`.
- small-q5_1 is NOT on disk; Step 2 downloads it to the scratchpad.

What is measured: the production `hear` argv on **1 s of digital silence with VAD on**. VAD finds no speech, so `whisper_full()` returns before any encode (whisper.cpp:7898-7907). Wall time is therefore exactly process start + model load + Metal init + VAD model load: the fixed per-call cost the warm server removes.

- [ ] **Step 1: Set up.**

```bash
SCR=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad
OUT=$SCR/opt/step0; mkdir -p "$OUT"
CLI=~/work/kiagent-core/assets/whisper/darwin-arm64/whisper-cli
VAD=~/work/kiagent-core/assets/whisper/ggml-silero-v5.1.2.bin
TURBO="$HOME/Library/Application Support/KIAgent-dev/data/models/asr/whisper-large-v3-turbo-q5_0/ggml-large-v3-turbo-q5_0.bin"
SMALL="$OUT/ggml-small-q5_1.bin"
cat ~/work/kiagent-core/assets/whisper/darwin-arm64/.whisper-tag   # record (expect v1.9.2)
```

- [ ] **Step 2: Download small-q5_1 (pinned revision from models.ts) and verify its sha256.**

```bash
curl -fL -o "$SMALL" https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small-q5_1.bin
shasum -a 256 "$SMALL"
# Expected: ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb
```

- [ ] **Step 3: Write a 1 s, 16 kHz, mono, 16-bit silent WAV.**

```bash
node -e 'const n=16000,b=Buffer.alloc(44+n*2);b.write("RIFF",0);b.writeUInt32LE(36+n*2,4);b.write("WAVE",8);b.write("fmt ",12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write("data",36);b.writeUInt32LE(n*2,40);require("fs").writeFileSync(process.argv[1],b)' "$OUT/silence-1s.wav"
```

- [ ] **Step 4: Probe, five repetitions plus one discarded warm-up per model.** Make sure no other heavy job is running (use heavy.sh to hold the lock):

```bash
cat > "$OUT/probe.sh" <<'EOF'
#!/bin/bash
# usage: probe.sh <cli> <vad> <wav> <model>...
CLI=$1; VAD=$2; WAV=$3; shift 3
for M in "$@"; do
  echo "== $M"
  for i in 0 1 2 3 4 5; do
    /usr/bin/time -p "$CLI" -m "$M" -f "$WAV" -l en --no-prints \
      --vad -vm "$VAD" -vt 0.5 -vspd 150 -vsd 100 -vp 120 -vo 0.1 2>&1 >/dev/null | awk -v i=$i '/^real/{print "run " i ": " $2 " s" (i==0?" (warm-up, discarded)":"")}'
  done
done
EOF
chmod +x "$OUT/probe.sh"
$SCR/opt/heavy.sh "$OUT/probe.sh" "$CLI" "$VAD" "$OUT/silence-1s.wav" "$TURBO" "$SMALL" | tee "$OUT/step0.txt"
```

- [ ] **Step 5: Context line (not used for the decision).** One run without `--no-prints` to capture whisper's own timing:

```bash
"$CLI" -m "$TURBO" -f "$OUT/silence-1s.wav" -l en --vad -vm "$VAD" 2>&1 >/dev/null | grep -E "load time|total time" | tee -a "$OUT/step0.txt"
```

- [ ] **Step 6: Also record the `ps` comm format** (Task 5's reaping and Task 11's RSS sampler rely on macOS printing the full path):

```bash
"$CLI" -m "$TURBO" -f "$OUT/silence-1s.wav" -l en --no-prints --vad -vm "$VAD" & P=$!; sleep 0.3; ps -o comm= -p $P | tee -a "$OUT/step0.txt"; wait $P
```

Expected: the absolute path of `whisper-cli`. If it prints a truncated name instead, note it. Task 5's basename fallback covers that.

- [ ] **Step 7: Decide.** Take the **median of runs 1–5** for each model.
  - **Turbo median < 0.5 s → NO-GO.** Stop the plan. Comment on #143 with the numbers (turbo and small medians, the binary version, the Mac model) and the reason ("saving under 3 s per plain 30-minute meeting"), then close it: `gh issue comment 143 --body-file "$OUT/step0.txt"` then `gh issue close 143`, run from `~/work/kcore-asr`. Do not start Task 2.
  - **Turbo median ≥ 0.5 s → GO.** Post `step0.txt` as an issue comment, keep it for the PR body, and continue with Task 2.

---

### Task 2: Field-by-field `cli.cpp` vs `server.cpp` diff into the spec

**Proceeds only on GO from Task 1.**

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-warm-whisper-server-design.md`

Source of truth for the diff: the b5130 source copy at `$SCR/opt/whisper-b5130-src/` (`cli.cpp`, `server.cpp`, `whisper.cpp`, `common-whisper.cpp`). The values below were checked against it while this plan was written. The implementer re-checks each cited line before pasting. If any line disagrees, stop and report; do not "fix" the table to match.

**Thread-count ruling (verified).** The spec says the server should use "the thread count the CLI's interactive path computes (`min(4, cores)`)". The provider computes nothing for interactive jobs: `provider.ts` passes `threads` only for background jobs (`cls === 'background' ? Math.min(4, …backgroundThreads) : undefined`), and `runWhisperCli` then omits `-t`. So whisper-cli uses its built-in default `std::min(4, (int32_t) std::thread::hardware_concurrency())` (cli.cpp:36). whisper-server's default is the identical expression (server.cpp:73). So the value really is `min(4, logical cores)`, but the binary computes it, not the provider. **Ruling: spawn whisper-server with no `-t`.** Both binaries then evaluate the same expression on the same host, and the value cannot drift from a TypeScript re-implementation (`host.cores` is `os.availableParallelism()`, not `hardware_concurrency()`).

- [ ] **Step 1: Correct §2 "Start".** Replace the code block and the sentence after it:

Old:

````markdown
```
whisper-server -m <default model> -t 4 -vm <silero> --host 127.0.0.1 --port N
```

`-t` uses the same thread count the CLI's interactive path computes for this host (`min(4, cores)`), not a literal 4. The server refuses to start if the
VAD file is missing, which matches `requireVadModel`'s fail-closed stance.
````

New:

````markdown
```
whisper-server -m <default model> -vm <silero> --host 127.0.0.1 --port N --request-path /<secret>
```

`<secret>` is a fresh `crypto.randomBytes(24)` base64url string per child. It
is part of the base URL and never logged. *(Added in plan 2026-10-09: b5130
serves an unauthenticated `POST /load` that frees the model and `exit(1)`s on a
bad path. Any local web page can send that as a CORS-simple multipart POST,
and `--request-path` puts every route, `/load` included, behind the secret.)*
No `-t` is passed. *(Corrected in plan 2026-10-09: rev 4 said `-t` takes the
thread count "the CLI's interactive path computes". The provider computes
none. It passes `-t` only for background jobs, so interactive whisper-cli
runs use the binary's built-in `std::min(4, hardware_concurrency())`
(cli.cpp:36). whisper-server's default is the same expression
(server.cpp:73). Omitting the flag keeps the two identical by construction.)*
The server refuses to start if the VAD file is missing, which matches
`requireVadModel`'s fail-closed stance.
````

- [ ] **Step 2: Add `token_timestamps` to the §3 request table.** After the `no_timestamps` row insert:

```markdown
| `token_timestamps` | false *(added in plan 2026-10-09: the CLI's effective value, pinned rather than left to the server's derivation rule)* |
```

- [ ] **Step 3: Append a new subsection at the end of §3** (just before `### 4. Parity and acceptance tests`):

```markdown
### 3a. Field-by-field diff, b5130 (recorded by plan 2026-10-09, Task 2)

Left column: whisper-cli exactly as `runWhisperCli` invokes it for a meetings
`hear` (`-m -f -l <code|auto> --no-prints --vad -vm … -vt 0.5 -vspd 150 -vsd
100 -vp 120 -vo 0.1`, no `-t`, no `-of`). Line numbers are b5130.

| Field | whisper-cli effective | whisper-server default | Sent per request | Server effective |
|---|---|---|---|---|
| n_threads | `min(4, hardware_concurrency())` (cli.cpp:36; no `-t`) | same expression (server.cpp:73) | not a request field; no `-t` at start | identical |
| n_processors | 1 → `whisper_full` (whisper.cpp:7921) | 1 | — | identical |
| strategy | beam search: `beam_size > 1` (cli.cpp:1213) | greedy (`beam_size = -1`, server.cpp:82) | via beam_size | beam search |
| beam_size | 5 (`whisper_full_default_params(BEAM_SEARCH)`, cli.cpp:45) | -1 | 5 | 5 |
| best_of | 5 (`whisper_full_default_params(GREEDY)`, cli.cpp:44) | 2 (server.cpp:81) | 5 | 5 |
| temperature | 0.0 | 0.0 | 0 | 0 |
| temperature_inc | 0.2 (`no_fallback` false, cli.cpp:1245) | 0.2 (server has no `no_fallback` branch) | 0.2 | 0.2 |
| entropy_thold / logprob_thold / no_speech_thold | 2.4 / -1 / 0.6 | 2.4 / -1 / 0.6 | 2.4 / -1 / 0.6 | same |
| language | `<code>` or `auto` | `en` (server.cpp:113) | always | as sent |
| detect_language / translate | false / false | false / false | not sent | false |
| no_timestamps | false | false | false | false |
| token_timestamps | false: `output_wts‖output_jsn_full‖max_len>0` (cli.cpp:1227) | true, then re-derived to false for `vtt` without `max_len`/`split_on_word` (end of `get_req_parameters`) | **false** | false |
| max_len | 0 (cli.cpp:1229) | forced to 60 when 0 | not sent | inert: wrapping only runs when `token_timestamps` (whisper.cpp:7789-7795, 7838-7843) |
| split_on_word | false | false | — | false |
| no_context | not set → library default true | true (server.cpp:109) | — | true |
| initial_prompt / carry_initial_prompt | "" / false | "" / false | — | same |
| suppress_nst / suppress_regex | false / null | false / unset (null) | — | same |
| n_max_text_ctx | library default (max_context -1) | same | — | same |
| offset_ms / duration_ms / audio_ctx | 0 / 0 / 0 | 0 / 0 / 0 | — | same |
| diarize / tinydiarize | false | false | — | false |
| use_gpu / flash_attn / gpu_device | true / true / 0 (cli.cpp:78-80) | true / true / 0 (server.cpp:105-107) | — (context flags) | same |
| dtw | "" | "" | — | same |
| vad | on (`--vad`) | off | true | on |
| vad_model | `-vm <silero>` | `-vm <silero>` at start | — | same file |
| vad_threshold | 0.5 | 0.5 | 0.5 | 0.5 |
| vad_min_speech_duration_ms | 150 | 250 | 150 | 150 |
| vad_min_silence_duration_ms | 100 | 100 | 100 | 100 |
| vad_speech_pad_ms | 120 | 30 | 120 | 120 |
| vad_samples_overlap | 0.1 | 0.1 | 0.1 | 0.1 |
| vad_max_speech_duration_s | FLT_MAX (not passed) | FLT_MAX | not sent | FLT_MAX |
| audio decode | miniaudio `ma_decoder_init_file`, f32 mono 16 kHz (common-whisper.cpp:78-163) | miniaudio `ma_decoder_init_memory`, same config (common-whisper.cpp:166-178); `--convert` off | multipart `file` | same decoder |
| decode failure | stderr `failed to read audio file` (cli.cpp:1169), exit 0 → `AsrInputRejectedError` | HTTP 400 `failed to read audio data` | — | 400 → `AsrInputRejectedError` |
| output | stdout via `new_segment_callback`: one `\n` when `s0 == 0`, then `[t0 --> t1]  text\n` per segment (cli.cpp:376-387, 448) | `vtt`: `WEBVTT\n\n` then `t0 --> t1\ntext\n\n` per segment | `response_format=vtt` | `formatCliLines` |
| timestamps | `to_timestamp(t, comma=false)` → `HH:MM:SS.mmm` (common-whisper.cpp:182) | same function | — | same |

Notes:
- `vad_min_speech_duration_ms` is parsed with `std::stof` and assigned to an
  int; `"150"` round-trips exactly.
- httplib `read_timeout`/`write_timeout` (600 s) are socket I/O timeouts. Compute
  runs between reading the request and writing the response, so they do not
  bound transcription time. The parity suite's 10-minute fixture confirms this.
- `/load` protection (in scope): whisper-server sends
  `Access-Control-Allow-Origin: *` and serves `POST /load`. That endpoint frees
  the working model and calls `exit(1)` when the new path fails to initialise
  (server.cpp:1175-1205); `/etc/hosts` is enough. A browser `FormData` POST
  needs no preflight, so dropping CORS would not help. Every route is
  registered under `sparams.request_path` (`/` server.cpp:818, OPTIONS/POST
  inference 823/826, `/load` 1175, `/health` 1218). Spawning with
  `--request-path /<per-child secret>` therefore makes every route unreachable
  without the secret. Unmatched paths get the error handler's 404
  (server.cpp:1243-1249). The parity suite checks this against the real binary
  (wrong/missing prefix → 404, server alive, authorised requests work).
  `--inference-path` alone would leave `/load` open.

### 3b. Implementation rulings (plan 2026-10-09)

- **Thread count:** no `-t` (see §2).
- **Request path:** `--request-path /<crypto.randomBytes(24) base64url>`, fresh
  per child, included in `baseUrl()`, never logged (see §2 and §3a).
- **`token_timestamps=false`** is sent explicitly (table above).
- **Pid file path:** `registerBundledProviders` receives `dataDir =
  <userData>/data`, so the path is `path.join(path.dirname(dataDir),
  'whisper-server.pid')`, which is `<userData>/whisper-server.pid` as specified.
- **Server output logging:** core's `LogLevel` has no `debug`. Server
  stdout/stderr is therefore not forwarded line by line. It is kept as an 8 KiB
  tail and attached to start-failure and crash messages.
- **Start failure inside a job:** the job that hit the failed start runs on the
  CLI in the same job (`reason=start-failed`), so the triggering segment does
  not fail. Later jobs route with `reason=disabled`.
- **"VAD on"** means the job's resolved VAD model path is defined. That is
  `vad: 'required'` (meetings), or the soft path found the file.
- **`format: 'mp3'`** routes to the CLI (`reason=not-wav`), because §1 limits
  the server shape to wav.
```

- [ ] **Step 4: Commit.**

```bash
printf 'docs(spec): record cli/server field diff and plan rulings (#143)\n' > $SCR/opt/msg-wws-2
git -C ~/work/kcore-asr commit -F $SCR/opt/msg-wws-2 -- docs/superpowers/specs/2026-10-09-warm-whisper-server-design.md
```

---

### Task 3: Vendor `whisper-server` (darwin) — stamp requires both binaries

**Proceeds only on GO from Task 1.** The implementer edits and unit-tests the scripts but does **not** run `build-whisper.mjs` (Task 11 does, into the scratchpad).

**Files:**
- Modify: `scripts/whisper-assets.mjs`
- Modify: `scripts/build-whisper.mjs`
- Test: `src/__tests__/whisper-vendor-current.test.ts`

**Interfaces:**
- Produces (whisper-assets.mjs): `export const WHISPER_DARWIN_BINARIES = ['whisper-cli', 'whisper-server']`, `export const WHISPER_TAG_STAMP = '.whisper-tag'`, `export function whisperVendorIsCurrent(destDir: string, fsImpl?: { existsSync(p): boolean; readFileSync(p, enc): string }): boolean`.
- Produces (build-whisper.mjs): env `KIA_WHISPER_OUT_DIR=<dir>` makes it vendor into `<dir>/assets/whisper/<slug>/` instead of `<repo>/assets/whisper/<slug>/`. Task 11 uses `$SCR/opt/whisper-out/assets/whisper/darwin-arm64/{whisper-cli,whisper-server,.whisper-tag}`.

Verified in the b5130 source: `whisper-server -h` calls `whisper_print_usage` then `exit(0)` (server.cpp:206-208), so the same `-h` smoke gate as the CLI works. The server target is added unconditionally by the examples CMakeLists (`add_subdirectory(server)`).

- [ ] **Step 1: Write the failing test** `src/__tests__/whisper-vendor-current.test.ts`:

```ts
// src/__tests__/whisper-vendor-current.test.ts
/**
 * The darwin vendor stamp must cover BOTH binaries (spec §5): a directory
 * stamped for the current tag that holds only whisper-cli (every install
 * vendored before #143) must re-vendor, or the warm server ships inert.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  WHISPER_COMMIT,
  WHISPER_DARWIN_BINARIES,
  WHISPER_TAG,
  WHISPER_TAG_STAMP,
  whisperVendorIsCurrent,
} from '../../scripts/whisper-assets.mjs';

describe('whisperVendorIsCurrent', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-vendor-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const stamp = (tag = WHISPER_TAG, commit = WHISPER_COMMIT) =>
    fs.writeFileSync(path.join(dir, WHISPER_TAG_STAMP), `${tag}\n${commit}\n`);
  const bin = (name: string) => fs.writeFileSync(path.join(dir, name), '');

  it('lists exactly whisper-cli and whisper-server', () => {
    expect([...WHISPER_DARWIN_BINARIES]).toEqual(['whisper-cli', 'whisper-server']);
  });

  it('is current with both binaries and a current stamp', () => {
    bin('whisper-cli');
    bin('whisper-server');
    stamp();
    expect(whisperVendorIsCurrent(dir)).toBe(true);
  });

  it('a current-tag CLI-only directory is NOT current (upgrade re-vendors)', () => {
    bin('whisper-cli');
    stamp();
    expect(whisperVendorIsCurrent(dir)).toBe(false);
  });

  it('a stale tag or commit is not current', () => {
    bin('whisper-cli');
    bin('whisper-server');
    stamp('b0000');
    expect(whisperVendorIsCurrent(dir)).toBe(false);
    stamp(WHISPER_TAG, 'deadbeef');
    expect(whisperVendorIsCurrent(dir)).toBe(false);
  });

  it('a missing stamp is not current', () => {
    bin('whisper-cli');
    bin('whisper-server');
    expect(whisperVendorIsCurrent(dir)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** (`whisperVendorIsCurrent` is not exported):

Run: `cd ~/work/kcore-asr && npx jest src/__tests__/whisper-vendor-current.test.ts`
Expected: FAIL — `whisperVendorIsCurrent is not a function` (or TS import error).

- [ ] **Step 3: Implement in `scripts/whisper-assets.mjs`.** Add at the top (after the header comment):

```js
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
```

Append at the end of the file:

```js
/** Binaries build-whisper.mjs vendors per darwin slug. The warm interactive
 *  server (#143) ships beside the CLI; both share one tag stamp. */
export const WHISPER_DARWIN_BINARIES = ['whisper-cli', 'whisper-server'];

/** Per-slug stamp file: `<WHISPER_TAG>\n<WHISPER_COMMIT>\n`. */
export const WHISPER_TAG_STAMP = '.whisper-tag';

/** True only when EVERY darwin binary exists and the stamp names the current
 *  tag + commit. A current-tag CLI-only dir (vendored before #143) is NOT
 *  current, so the next vendor run rebuilds it with whisper-server. */
export function whisperVendorIsCurrent(destDir, fsImpl = { existsSync, readFileSync }) {
  for (const name of WHISPER_DARWIN_BINARIES) {
    if (!fsImpl.existsSync(path.join(destDir, name))) return false;
  }
  const stampPath = path.join(destDir, WHISPER_TAG_STAMP);
  if (!fsImpl.existsSync(stampPath)) return false;
  const [tag, commit] = fsImpl.readFileSync(stampPath, 'utf8').trim().split('\n');
  return tag === WHISPER_TAG && commit === WHISPER_COMMIT;
}
```

- [ ] **Step 4: Run the test, expect PASS.** Also run the existing contract test to be sure the new imports don't break it:

Run: `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh npx jest src/__tests__/whisper-vendor-current.test.ts src/__tests__/whisper-slug-contract.test.ts`
Expected: PASS (both files).

- [ ] **Step 5: Rewrite `scripts/build-whisper.mjs`.** Replace the whole file with the following. It keeps every existing gate and comment intent. What changes: the output root is configurable, two binaries are built, copied, arch-gated and smoke-tested, and idempotency comes from `whisperVendorIsCurrent`.

```js
// scripts/build-whisper.mjs
// Builds whisper-cli AND whisper-server from source for darwin-arm64 AND
// darwin-x64 (cross), the same both-arches pattern as build-vision-helper.mjs.
// whisper.cpp publishes no runnable macOS binary (the release carries an
// XCFramework — a library, not a CLI), so macOS is a cmake build on the runner
// that already compiles two other native helpers. Requires cmake + Xcode CLT.
//
// whisper-server is the warm interactive transcription server (#143); it is
// gated exactly like whisper-cli (copy, lipo arch gate, `-h` smoke).
//
// KIA_WHISPER_OUT_DIR=<dir> vendors into <dir>/assets/whisper/<slug> instead
// of the repo's assets/ — used to build into a scratch dir without touching a
// shared checkout's vendored assets.
import { existsSync, mkdirSync, rmSync, renameSync, copyFileSync, chmodSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  WHISPER_TAG,
  WHISPER_COMMIT,
  WHISPER_DARWIN_SLUGS,
  WHISPER_DARWIN_BINARIES,
  WHISPER_TAG_STAMP,
  whisperDir,
  whisperVendorIsCurrent,
} from './whisper-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = process.env.KIA_WHISPER_OUT_DIR ? path.resolve(process.env.KIA_WHISPER_OUT_DIR) : ROOT;

if (process.platform !== 'darwin') {
  console.error(`build-whisper only runs on darwin (got ${process.platform})`);
  process.exit(1);
}

function hint(cmd) {
  if (cmd === 'cmake') return 'cmake is required to build whisper from source. Install it (e.g. `brew install cmake` on macOS) and re-run.';
  if (cmd === 'git') return 'git is required to build whisper from source. Install it (e.g. via Xcode Command Line Tools: `xcode-select --install`) and re-run.';
  return null;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) {
    console.error(`${cmd} failed to launch: ${r.error.message}`);
    if (r.error.code === 'ENOENT') {
      const h = hint(cmd);
      if (h) console.error(h);
    }
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// osxArch (the -DCMAKE_OSX_ARCHITECTURES value) per arch — derived alongside
// WHISPER_DARWIN_SLUGS so the slug contract test also covers what is built.
const OSX_ARCH = { arm64: 'arm64', x64: 'x86_64' };
const TARGETS = WHISPER_DARWIN_SLUGS.map((slug) => {
  const arch = slug.replace(/^darwin-/, '');
  const osxArch = OSX_ARCH[arch];
  if (!osxArch) throw new Error(`build-whisper.mjs has no -DCMAKE_OSX_ARCHITECTURES mapping for slug "${slug}"`);
  const destDir = path.join(OUT_ROOT, whisperDir(slug));
  return { arch, osxArch, destDir, stagingDir: `${destDir}.tmp` };
});

// A stagingDir is never the known-good artifact — always safe to delete.
for (const { stagingDir } of TARGETS) {
  rmSync(stagingDir, { recursive: true, force: true });
}

// Idempotency keys on the tag stamp AND every binary in
// WHISPER_DARWIN_BINARIES: a WHISPER_TAG bump rebuilds, and so does a
// current-tag directory vendored before whisper-server existed (#143).
const todo = TARGETS.filter(({ destDir }) => !whisperVendorIsCurrent(destDir));
if (todo.length === 0) {
  console.log(`${WHISPER_DARWIN_BINARIES.join(' + ')} already built for both darwin arches (${WHISPER_TAG}) in ${OUT_ROOT}`);
  process.exit(0);
}
for (const { arch, destDir } of todo) {
  if (existsSync(destDir)) {
    // destDir stays exactly as-is until the replacement is built and gated
    // (the swap at the end of the loop is the only place it is mutated).
    console.log(`Vendored whisper (${arch}) at ${destDir} is stale, unstamped or missing a binary — rebuilding for ${WHISPER_TAG}`);
  }
}

// Shallow-clone the pinned tag and verify the commit.
const src = path.join(os.tmpdir(), `whisper-cpp-${WHISPER_TAG}`);
if (!existsSync(path.join(src, 'CMakeLists.txt'))) {
  rmSync(src, { recursive: true, force: true });
  run('git', ['clone', '--depth', '1', '--branch', WHISPER_TAG,
    'https://github.com/ggml-org/whisper.cpp.git', src]);
}
const head = spawnSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
if (head.error) {
  console.error(`git failed to launch: ${head.error.message}`);
  if (head.error.code === 'ENOENT') console.error(hint('git'));
  process.exit(1);
}
if (head.stdout?.trim() !== WHISPER_COMMIT) {
  console.error(`whisper checkout is ${head.stdout?.trim()}, expected ${WHISPER_COMMIT}`);
  process.exit(1);
}

for (const { arch, osxArch, destDir, stagingDir } of todo) {
  const buildDir = path.join(src, `build-${arch}`);
  console.log(`Building ${WHISPER_DARWIN_BINARIES.join(' + ')} (${arch})`);
  run('cmake', ['-B', buildDir, '-S', src,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',            // self-contained binaries — nothing to vendor beside them
    '-DWHISPER_METAL_EMBED_LIBRARY=ON',   // Metal shader baked in: no .metallib to ship
    '-DWHISPER_BUILD_TESTS=OFF',
    `-DCMAKE_OSX_ARCHITECTURES=${osxArch}`,
    // GGML_NATIVE=OFF on BOTH arches, deliberately: these binaries run on
    // strangers' Macs. ON bakes the BUILD host's CPU in (x64 cross: clang
    // rejects "apple-m3"; arm64: silently bakes SME etc. that can fault on an
    // older M1/M2). Do not "optimise" this back to GGML_NATIVE=ON.
    '-DGGML_NATIVE=OFF',
  ]);
  run('cmake', ['--build', buildDir, '--config', 'Release', '--target', ...WHISPER_DARWIN_BINARIES, '-j']);
  mkdirSync(stagingDir, { recursive: true });

  for (const name of WHISPER_DARWIN_BINARIES) {
    const binary = path.join(stagingDir, name);
    copyFileSync(path.join(buildDir, 'bin', name), binary);
    chmodSync(binary, 0o755);

    // Architecture gate (UNCONDITIONAL, both arches): the produced Mach-O
    // must match what cmake was asked to cross-compile.
    const archCheck = spawnSync('lipo', ['-archs', binary], { encoding: 'utf8' });
    const reportedArch = archCheck.stdout?.trim();
    if (archCheck.status !== 0 || reportedArch !== osxArch) {
      console.error(`${name} (${arch}) architecture check failed: expected '${osxArch}', lipo reported '${reportedArch || archCheck.stderr?.trim() || archCheck.error?.message}'`);
      process.exit(1);
    }

    // Smoke gate: must run wherever it CAN run. Non-zero exit is fatal on
    // both arches; the only tolerated outcome for the non-host arch is a
    // spawn error (no Rosetta) — the arch gate above already proved shape.
    const smoke = spawnSync(binary, ['-h'], { stdio: 'ignore' });
    const hostNative = arch === process.arch;
    if (smoke.error) {
      if (hostNative) {
        console.error(`${name} (${arch}) smoke run failed to launch: ${smoke.error.message}`);
        process.exit(1);
      }
      console.log(`${name} (${arch}) did not launch on this host (${smoke.error.code ?? smoke.error.message}) — expected without Rosetta for a non-native arch; architecture verified above.`);
    } else if (smoke.status !== 0) {
      console.error(`${name} (${arch}) smoke run failed (exit ${smoke.status})`);
      process.exit(1);
    } else {
      console.log(`${name} (${arch}) smoke run OK`);
    }
  }

  // Stamp last, only after every binary passed every gate.
  writeFileSync(path.join(stagingDir, WHISPER_TAG_STAMP), `${WHISPER_TAG}\n${WHISPER_COMMIT}\n`);

  // Swap (the only place destDir is mutated).
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(path.dirname(destDir), { recursive: true });
  renameSync(stagingDir, destDir);
  console.log(`Vendored ${WHISPER_DARWIN_BINARIES.join(' + ')} (${arch}) at ${destDir}`);
}
```

- [ ] **Step 6: Syntax check (does NOT build anything).**

Run: `node --check scripts/build-whisper.mjs && node --check scripts/whisper-assets.mjs`
Expected: no output, exit 0.

- [ ] **Step 7: Lint and commit.**

```bash
npx eslint scripts/build-whisper.mjs scripts/whisper-assets.mjs src/__tests__/whisper-vendor-current.test.ts
git add src/__tests__/whisper-vendor-current.test.ts
printf 'build(whisper): vendor whisper-server beside whisper-cli on darwin (#143)\n\nThe tag stamp now requires both binaries, so a current-tag CLI-only\ndirectory re-vendors. KIA_WHISPER_OUT_DIR builds into a scratch dir.\n' > $SCR/opt/msg-wws-3
git commit -F $SCR/opt/msg-wws-3 -- scripts/whisper-assets.mjs scripts/build-whisper.mjs src/__tests__/whisper-vendor-current.test.ts
```

(If eslint reports that `.mjs` files are ignored by the config, that's fine. Lint only the `.ts` file.)

---

### Task 4: `server-request.ts` — the pinned HTTP contract

**Proceeds only on GO from Task 1.**

**Files:**
- Create: `src/main/providers/local-asr/server-request.ts`
- Test: `src/main/providers/local-asr/__tests__/server-request.test.ts`

**Interfaces:**
- Consumes: `AsrInputRejectedError`, `WHISPER_VAD_PARAMS` from `./whisper-cli`.
- Produces:
  - `export const WHISPER_SERVER_REQUEST: { version: 1; fields: Readonly<Record<string, string>> }`
  - `export function serverFormFields(language: string): Array<[string, string]>` (language first, then `fields` in declaration order)
  - `export const SERVER_AGENT_OPTIONS = { headersTimeout: 0, bodyTimeout: 0 } as const`
  - `export function serverDispatcher(): Agent` (memoized)
  - `export function formatCliLines(vtt: string): string`
  - `export function errorForStatus(status: number, body: string): Error`
  - `export async function transcribeViaServer(args: { baseUrl: string; audio: Uint8Array; language: string; signal: AbortSignal; fetchImpl?: typeof fetch; dispatcher?: Dispatcher }): Promise<string>`

- [ ] **Step 1: Write the failing test** `src/main/providers/local-asr/__tests__/server-request.test.ts`:

```ts
/** @jest-environment node */
import { Agent, FormData, Response } from 'undici';

import {
  SERVER_AGENT_OPTIONS,
  WHISPER_SERVER_REQUEST,
  errorForStatus,
  formatCliLines,
  serverDispatcher,
  serverFormFields,
  transcribeViaServer,
} from '../server-request';
import { AsrInputRejectedError } from '../whisper-cli';

describe('WHISPER_SERVER_REQUEST (spec §3, pinned)', () => {
  it('is version 1 with exactly the CLI-effective values', () => {
    expect(WHISPER_SERVER_REQUEST).toEqual({
      version: 1,
      fields: {
        response_format: 'vtt',
        no_timestamps: 'false',
        token_timestamps: 'false',
        beam_size: '5',
        best_of: '5',
        temperature: '0',
        temperature_inc: '0.2',
        entropy_thold: '2.4',
        logprob_thold: '-1',
        no_speech_thold: '0.6',
        vad: 'true',
        vad_threshold: '0.5',
        vad_min_speech_duration_ms: '150',
        vad_min_silence_duration_ms: '100',
        vad_speech_pad_ms: '120',
        vad_samples_overlap: '0.1',
      },
    });
  });

  it('always sends language first (a code or auto)', () => {
    expect(serverFormFields('auto')[0]).toEqual(['language', 'auto']);
    expect(serverFormFields('de')[0]).toEqual(['language', 'de']);
    expect(serverFormFields('de')).toHaveLength(
      1 + Object.keys(WHISPER_SERVER_REQUEST.fields).length,
    );
  });
});

describe('dispatcher', () => {
  it('has no client timeouts (long transcriptions send headers late)', () => {
    expect(SERVER_AGENT_OPTIONS).toEqual({ headersTimeout: 0, bodyTimeout: 0 });
    const d = serverDispatcher();
    expect(d).toBeInstanceOf(Agent);
    expect(serverDispatcher()).toBe(d);
  });
});

describe('formatCliLines (golden strings = whisper-cli stdout framing)', () => {
  it('zero cues → empty string (VAD found no speech)', () => {
    expect(formatCliLines('WEBVTT\n\n')).toBe('');
  });

  it('one cue → leading \\n, two spaces after ], whisper leading space kept', () => {
    expect(
      formatCliLines('WEBVTT\n\n00:00:00.000 --> 00:00:02.500\n Hello there.\n\n'),
    ).toBe('\n[00:00:00.000 --> 00:00:02.500]   Hello there.\n');
  });

  it('several cues → one line each, single leading \\n', () => {
    expect(
      formatCliLines(
        'WEBVTT\n\n00:00:00.000 --> 00:00:02.500\n Hello.\n\n00:00:02.500 --> 00:00:04.000\n Bye.\n\n',
      ),
    ).toBe(
      '\n[00:00:00.000 --> 00:00:02.500]   Hello.\n[00:00:02.500 --> 00:00:04.000]   Bye.\n',
    );
  });

  it('an empty-text cue keeps its line (CLI prints the prefix and nothing)', () => {
    expect(
      formatCliLines('WEBVTT\n\n00:00:01.000 --> 00:00:01.500\n\n\n'),
    ).toBe('\n[00:00:01.000 --> 00:00:01.500]  \n');
  });

  it('hours >= 100 pass through unchanged', () => {
    expect(
      formatCliLines('WEBVTT\n\n100:00:00.000 --> 100:00:01.000\n x\n\n'),
    ).toBe('\n[100:00:00.000 --> 100:00:01.000]   x\n');
  });

  it('rejects a body that is not WEBVTT', () => {
    expect(() => formatCliLines('{"error":"x"}')).toThrow(/not WEBVTT/);
  });

  it('rejects a broken cue structure instead of guessing', () => {
    expect(() =>
      formatCliLines('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n a\n b\n\n'),
    ).toThrow(/malformed/);
  });
});

describe('errorForStatus (keyed on status, never body text)', () => {
  it('400 → AsrInputRejectedError with status 400', () => {
    const e = errorForStatus(400, '{"error":"failed to read audio data"}');
    expect(e).toBeInstanceOf(AsrInputRejectedError);
    expect((e as AsrInputRejectedError).status).toBe(400);
  });

  it.each([499, 500, 503])('%i → plain Error with no status (caller defers)', (s) => {
    const e = errorForStatus(s, 'whatever');
    expect(e).not.toBeInstanceOf(AsrInputRejectedError);
    expect((e as { status?: number }).status).toBeUndefined();
  });
});

describe('transcribeViaServer', () => {
  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n Hi.\n\n';

  it('POSTs multipart to /inference with the pinned fields, the dispatcher and the signal', async () => {
    const seen: { url?: string; init?: any } = {};
    const fetchImpl = jest.fn(async (url: any, init: any) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(vtt, { status: 200 });
    });
    const signal = new AbortController().signal;
    const out = await transcribeViaServer({
      baseUrl: 'http://127.0.0.1:5555',
      audio: new Uint8Array([1, 2, 3, 4]),
      language: 'auto',
      signal,
      fetchImpl: fetchImpl as never,
    });
    expect(out).toBe('\n[00:00:00.000 --> 00:00:01.000]   Hi.\n');
    expect(seen.url).toBe('http://127.0.0.1:5555/inference');
    expect(seen.init.method).toBe('POST');
    expect(seen.init.signal).toBe(signal);
    expect(seen.init.dispatcher).toBe(serverDispatcher());
    const form = seen.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('language')).toBe('auto');
    expect(form.get('response_format')).toBe('vtt');
    expect(form.get('vad')).toBe('true');
    expect((form.get('file') as Blob).size).toBe(4);
  });

  it('maps a 400 to AsrInputRejectedError', async () => {
    const fetchImpl = jest.fn(async () => new Response('{"error":"x"}', { status: 400 }));
    await expect(
      transcribeViaServer({
        baseUrl: 'http://127.0.0.1:1',
        audio: new Uint8Array(1),
        language: 'en',
        signal: new AbortController().signal,
        fetchImpl: fetchImpl as never,
      }),
    ).rejects.toBeInstanceOf(AsrInputRejectedError);
  });

  it('a connection error is a plain Error', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const err = await transcribeViaServer({
      baseUrl: 'http://127.0.0.1:1',
      audio: new Uint8Array(1),
      language: 'en',
      signal: new AbortController().signal,
      fetchImpl: fetchImpl as never,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AsrInputRejectedError);
    expect(err.message).toMatch(/whisper-server request failed/);
  });

  it('abort cancels the fetch and rejects as a plain Error', async () => {
    const ac = new AbortController();
    const fetchImpl = jest.fn(
      (_url: any, init: any) =>
        new Promise<Response>((_res, rej) => {
          init.signal.addEventListener('abort', () => rej(new Error('This operation was aborted')));
        }),
    );
    const p = transcribeViaServer({
      baseUrl: 'http://127.0.0.1:1',
      audio: new Uint8Array(1),
      language: 'en',
      signal: ac.signal,
      fetchImpl: fetchImpl as never,
    });
    ac.abort();
    const err = await p.catch((e) => e);
    expect(err).not.toBeInstanceOf(AsrInputRejectedError);
    expect(err.message).toMatch(/aborted/);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**

Run: `npx jest src/main/providers/local-asr/__tests__/server-request.test.ts`
Expected: FAIL — `Cannot find module '../server-request'`.

- [ ] **Step 3: Implement** `src/main/providers/local-asr/server-request.ts`:

```ts
import { Blob } from 'node:buffer';

import { Agent, FormData, fetch } from 'undici';
import type { Dispatcher } from 'undici';

import { AsrInputRejectedError, WHISPER_VAD_PARAMS } from './whisper-cli';

/**
 * The ONE request shape the warm whisper-server serves (spec §3 + §3a):
 * the CLI's effective parameters, pinned, never discovered. whisper-server's
 * own defaults differ (greedy, best_of 2, language en, VAD off), so every
 * field is sent on every request. Bump `version` whenever a value changes —
 * the same discipline as WHISPER_VAD_PARAMS.
 */
export const WHISPER_SERVER_REQUEST = {
  version: 1,
  fields: {
    response_format: 'vtt',
    no_timestamps: 'false',
    token_timestamps: 'false',
    beam_size: '5',
    best_of: '5',
    temperature: '0',
    temperature_inc: '0.2',
    entropy_thold: '2.4',
    logprob_thold: '-1',
    no_speech_thold: '0.6',
    vad: 'true',
    vad_threshold: String(WHISPER_VAD_PARAMS.threshold),
    vad_min_speech_duration_ms: String(WHISPER_VAD_PARAMS.minSpeechMs),
    vad_min_silence_duration_ms: String(WHISPER_VAD_PARAMS.minSilenceMs),
    vad_speech_pad_ms: String(WHISPER_VAD_PARAMS.speechPadMs),
    vad_samples_overlap: String(WHISPER_VAD_PARAMS.samplesOverlapS),
  } as Readonly<Record<string, string>>,
} as const;

/** `language` (a validated code or `auto`) first, then the pinned fields. */
export function serverFormFields(language: string): Array<[string, string]> {
  return [['language', language], ...Object.entries(WHISPER_SERVER_REQUEST.fields)];
}

/** No client timeouts: whisper-server sends headers only after compute
 *  finishes, and Node's default 300 s headersTimeout would fail a long
 *  segment. Abort is by signal only, like the CLI. */
export const SERVER_AGENT_OPTIONS = { headersTimeout: 0, bodyTimeout: 0 } as const;

let dispatcher: Agent | null = null;
export function serverDispatcher(): Agent {
  dispatcher ??= new Agent(SERVER_AGENT_OPTIONS);
  return dispatcher;
}

const CUE_TIMES = /^(\d{2,}:\d{2}:\d{2}\.\d{3}) --> (\d{2,}:\d{2}:\d{2}\.\d{3})$/;
const VTT_HEADER = 'WEBVTT\n\n';

/**
 * whisper-server `vtt` → whisper-cli stdout, byte for byte (spec §3):
 * one leading `\n` before the first segment line, then
 * `[HH:MM:SS.mmm --> HH:MM:SS.mmm]  text\n` per segment (two spaces after
 * `]`, whisper's own leading space kept); `''` when there are no segments.
 * Each server cue is exactly `<t0> --> <t1>\n<text>\n\n` (segment text never
 * contains a newline); anything else is rejected, never guessed at.
 */
export function formatCliLines(vtt: string): string {
  if (!vtt.startsWith(VTT_HEADER)) {
    throw new Error('whisper-server response is not WEBVTT');
  }
  const lines = vtt.slice(VTT_HEADER.length).split('\n');
  const out: string[] = [];
  let i = 0;
  while (lines.length - i > 1) {
    const times = CUE_TIMES.exec(lines[i]);
    if (!times || i + 2 >= lines.length || lines[i + 2] !== '') {
      throw new Error(`whisper-server VTT malformed at line ${i + 3}`);
    }
    out.push(`[${times[1]} --> ${times[2]}]  ${lines[i + 1]}\n`);
    i += 3;
  }
  if (lines[i] !== '') throw new Error('whisper-server VTT malformed at end');
  return out.length === 0 ? '' : `\n${out.join('')}`;
}

/** Status only — httplib rewrites bodies, so body text is never a signal. */
export function errorForStatus(status: number, body: string): Error {
  const detail = body.slice(0, 200);
  if (status === 400) {
    return new AsrInputRejectedError(
      `whisper-server could not decode the input (HTTP 400): ${detail}`,
    );
  }
  return new Error(`whisper-server HTTP ${status}: ${detail}`);
}

/** One warm transcription: wav bytes in → whisper-cli-shaped text out. */
export async function transcribeViaServer(args: {
  baseUrl: string;
  audio: Uint8Array;
  language: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  dispatcher?: Dispatcher;
}): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(args.audio)], { type: 'audio/wav' }), 'audio.wav');
  for (const [k, v] of serverFormFields(args.language)) form.append(k, v);
  const doFetch = args.fetchImpl ?? fetch;
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await doFetch(`${args.baseUrl}/inference`, {
      method: 'POST',
      body: form,
      signal: args.signal,
      dispatcher: args.dispatcher ?? serverDispatcher(),
    });
  } catch (err) {
    throw new Error(
      `whisper-server request failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const body = await res.text();
  if (res.status !== 200) throw errorForStatus(res.status, body);
  return formatCliLines(body);
}
```

If `tsc` rejects `new Blob([...])` from `node:buffer` against undici's `FormData.append` overloads, cast the Blob as `as unknown as import('undici').File`-compatible. Do NOT switch to the global `fetch`. Mixing Node's bundled undici with the npm undici 7.30.0 `Agent` is the mismatch this module avoids.

- [ ] **Step 4: Run the test, expect PASS.**

Run: `npx jest src/main/providers/local-asr/__tests__/server-request.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Lint, typecheck, commit.**

```bash
npx eslint src/main/providers/local-asr/server-request.ts src/main/providers/local-asr/__tests__/server-request.test.ts
npx tsc --noEmit -p .
git add src/main/providers/local-asr/server-request.ts src/main/providers/local-asr/__tests__/server-request.test.ts
printf 'feat(local-asr): pinned whisper-server request contract + CLI line format (#143)\n' > $SCR/opt/msg-wws-4
git commit -F $SCR/opt/msg-wws-4 -- src/main/providers/local-asr/server-request.ts src/main/providers/local-asr/__tests__/server-request.test.ts
```

---

### Task 5: `server.ts` — `WhisperServer` lifecycle and orphan reaping

**Proceeds only on GO from Task 1.**

**Files:**
- Create: `src/main/providers/local-asr/server.ts`
- Test: `src/main/providers/local-asr/__tests__/server.test.ts`

**Interfaces:**
- Produces:
  - `export interface WhisperServerLike { start(): Promise<void>; stop(): Promise<void>; baseUrl(): string; pid(): number | null; onExit(cb: (detail: string) => void): void; }`
  - `export interface WhisperServerOptions { binaryPath: string; modelPath: string; vadModelPath: string; log(level: LogLevel, msg: string): void; pidFilePath?: string; host?: string; port?: number; startupTimeoutMs?: number; healthPollMs?: number; stopGraceMs?: number; spawnFn?: (binaryPath: string, args: string[]) => ChildProcess; isHealthyAt?: (baseUrl: string) => Promise<boolean>; fileExists?: (p: string) => boolean; }`
  - `export class WhisperServer implements WhisperServerLike` (constructor `(o: WhisperServerOptions)`)
  - `export function whisperServerArgs(o: { modelPath: string; vadModelPath: string; host: string; port: number; requestPath: string }): string[]`
  - `export function newRequestPath(): string` — `'/' + crypto.randomBytes(24).toString('base64url')`
  - `WhisperServerOptions.requestPathFn?: () => string` (test seam; default `newRequestPath`)
  - `WhisperServer.onOutput(cb: (chunk: string) => void): void` (class only, not on `WhisperServerLike`; the parity suite uses it to see the server start processing)
  - `export function resolveWhisperServerBinary(whisperDir: string, platform?: NodeJS.Platform, arch?: string): string | null`
  - `export async function reapOrphanServer(o: ReapOptions): Promise<'none' | 'reaped' | 'not-ours'>` with `ReapOptions = { pidFilePath: string; log(level: LogLevel, msg: string): void; readFile?: (p: string) => Promise<string>; removeFile?: (p: string) => Promise<void>; isAlive?: (pid: number) => boolean; commOf?: (pid: number) => Promise<string | null>; kill?: (pid: number, sig: NodeJS.Signals) => void }`

Behaviour (spec §2): no respawn loop. Every child gets a fresh `--request-path` secret. `baseUrl()` = `http://127.0.0.1:<port>/<secret>`, so `${baseUrl}/health` and `${baseUrl}/inference` carry it unchanged. No log line or error message includes `this.url`; the server's own output never prints the request path (server.cpp:1267 prints host:port only). `onExit` fires only for an exit after a successful start that `stop()` did not cause. A start failure (exit, spawn error or health timeout before healthy) leaves no child and rejects with the server's output tail in the message.

- [ ] **Step 1: Write the failing test** `src/main/providers/local-asr/__tests__/server.test.ts`:

```ts
/** @jest-environment node */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import {
  WhisperServer,
  newRequestPath,
  reapOrphanServer,
  resolveWhisperServerBinary,
  whisperServerArgs,
} from '../server';

/** Sync-exit stand-in for a spawned child (same rationale as
 *  local-llm/__tests__/server.test.ts FakeChild). */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  constructor(
    readonly pid = 4242,
    private readonly exitOn: NodeJS.Signals[] | 'any' = 'any',
  ) {
    super();
  }
  kill(sig: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(sig);
    if (this.exitOn === 'any' || this.exitOn.includes(sig)) {
      this.signalCode = sig;
      this.emit('exit', null, sig);
    }
    return true;
  }
  crash(code = 1): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 50));

const SECRET = '/s3cr3tS3cr3tS3cr3tS3cr3tS3cr3tAB';

function make(over: Partial<ConstructorParameters<typeof WhisperServer>[0]> = {}) {
  const child = new FakeChild();
  const spawnFn = jest.fn(
    (_binaryPath: string, _args: string[]) => child as unknown as ChildProcess,
  );
  const server = new WhisperServer({
    binaryPath: '/opt/w/whisper-server',
    modelPath: '/m/turbo.bin',
    vadModelPath: '/opt/w/silero.bin',
    log: jest.fn(),
    port: 5555,
    healthPollMs: 1,
    startupTimeoutMs: 200,
    stopGraceMs: 20,
    spawnFn,
    requestPathFn: () => SECRET,
    isHealthyAt: async () => true,
    fileExists: () => true,
    ...over,
  });
  return { server, child, spawnFn };
}

describe('whisperServerArgs', () => {
  it('is -m, -vm, host, port, --request-path and NO -t (binary default = the CLI default)', () => {
    const args = whisperServerArgs({
      modelPath: '/m/turbo.bin',
      vadModelPath: '/v/silero.bin',
      host: '127.0.0.1',
      port: 5555,
      requestPath: SECRET,
    });
    expect(args).toEqual([
      '-m', '/m/turbo.bin', '-vm', '/v/silero.bin', '--host', '127.0.0.1', '--port', '5555',
      '--request-path', SECRET,
    ]);
    expect(args).not.toContain('-t');
  });
});

describe('newRequestPath', () => {
  it('is "/" + 24 random bytes as base64url (32 chars), fresh every call', () => {
    const a = newRequestPath();
    const b = newRequestPath();
    expect(a).toMatch(/^\/[A-Za-z0-9_-]{32}$/);
    expect(b).toMatch(/^\/[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('resolveWhisperServerBinary', () => {
  it('darwin → <dir>/<platform>-<arch>/whisper-server', () => {
    expect(resolveWhisperServerBinary('/a/whisper', 'darwin', 'arm64')).toBe('/a/whisper/darwin-arm64/whisper-server');
  });
  it.each(['win32', 'linux'] as const)('%s → null (absent: macOS only)', (p) => {
    expect(resolveWhisperServerBinary('/a/whisper', p, 'x64')).toBeNull();
  });
});

describe('WhisperServer', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-server-test-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('refuses to start without the VAD model and never spawns', async () => {
    const { server, spawnFn } = make({ fileExists: () => false });
    await expect(server.start()).rejects.toThrow(/VAD model missing/);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('polls /health until 200, then is ready at http://127.0.0.1:<port> and writes the pid file', async () => {
    let probes = 0;
    const pidFilePath = path.join(dir, 'whisper-server.pid');
    const { server, spawnFn } = make({
      pidFilePath,
      isHealthyAt: async () => {
        probes += 1;
        return probes >= 3;
      },
    });
    await server.start();
    expect(probes).toBe(3);
    expect(server.baseUrl()).toBe(`http://127.0.0.1:5555${SECRET}`);
    const args = spawnFn.mock.calls[0][1];
    expect(args).not.toContain('-t');
    expect(args.slice(-2)).toEqual(['--request-path', SECRET]);
    expect(JSON.parse(fs.readFileSync(pidFilePath, 'utf8'))).toEqual({
      pid: 4242,
      binary: '/opt/w/whisper-server',
    });
  });

  it('each child gets a fresh secret prefix (default generator), baseUrl carries it, and it is never logged', async () => {
    const log = jest.fn();
    const probed: string[] = [];
    const children = [new FakeChild(1), new FakeChild(2)];
    const spawnFn = jest.fn(
      (_binaryPath: string, _args: string[]) => children.shift() as unknown as ChildProcess,
    );
    const mk = () =>
      new WhisperServer({
        binaryPath: '/opt/w/whisper-server',
        modelPath: '/m/turbo.bin',
        vadModelPath: '/opt/w/silero.bin',
        log,
        port: 5555,
        healthPollMs: 1,
        spawnFn,
        fileExists: () => true,
        isHealthyAt: async (u) => {
          probed.push(u);
          return true;
        },
      });
    const a = mk();
    await a.start();
    await a.stop();
    const b = mk();
    await b.start();
    const [args1, args2] = [spawnFn.mock.calls[0][1], spawnFn.mock.calls[1][1]];
    const s1 = args1[args1.length - 1];
    const s2 = args2[args2.length - 1];
    expect(args1[args1.length - 2]).toBe('--request-path');
    expect(s1).toMatch(/^\/[A-Za-z0-9_-]{32}$/);
    expect(s1).not.toBe(s2);
    expect(a.baseUrl()).toBe(`http://127.0.0.1:5555${s1}`);
    expect(b.baseUrl()).toBe(`http://127.0.0.1:5555${s2}`);
    expect(probed[0]).toBe(`http://127.0.0.1:5555${s1}`);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(s1.slice(1));
    expect(logged).not.toContain(s2.slice(1));
  });

  it('exit before healthy rejects fast with the output tail, and never fires onExit', async () => {
    const { server, child } = make({ isHealthyAt: async () => false, startupTimeoutMs: 10_000 });
    const onExit = jest.fn();
    server.onExit(onExit);
    const started = server.start();
    await tick();
    child.stderr.emit('data', Buffer.from("couldn't bind to server socket\n"));
    child.crash(1);
    const err = await started.catch((e) => e);
    expect(err.message).toMatch(/exited before becoming healthy/);
    expect(err.message).toMatch(/couldn't bind/);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('health timeout rejects and kills the child', async () => {
    const { server, child } = make({ isHealthyAt: async () => false, startupTimeoutMs: 30 });
    await expect(server.start()).rejects.toThrow(/health check timed out/);
    expect(child.signals[0]).toBe('SIGTERM');
  });

  it('an exit after start is a crash: onExit fires once and the pid file goes', async () => {
    const pidFilePath = path.join(dir, 'whisper-server.pid');
    const { server, child } = make({ pidFilePath });
    const onExit = jest.fn();
    server.onExit(onExit);
    await server.start();
    child.crash(139);
    await tick();
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit.mock.calls[0][0]).toMatch(/code=139/);
    expect(fs.existsSync(pidFilePath)).toBe(false);
  });

  it('stop(): SIGTERM, SIGKILL after the grace for a wedged child, no onExit, pid file removed', async () => {
    const pidFilePath = path.join(dir, 'whisper-server.pid');
    const child = new FakeChild(4242, ['SIGKILL']);
    const { server } = make({
      pidFilePath,
      spawnFn: jest.fn((_binaryPath: string, _args: string[]) => child as unknown as ChildProcess),
    });
    const onExit = jest.fn();
    server.onExit(onExit);
    await server.start();
    await server.stop();
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(onExit).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFilePath)).toBe(false);
  });
});

describe('reapOrphanServer', () => {
  let dir: string;
  let pidFilePath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-reap-'));
    pidFilePath = path.join(dir, 'whisper-server.pid');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (o: unknown) => fs.writeFileSync(pidFilePath, JSON.stringify(o));
  const base = (over: Record<string, unknown> = {}) => ({
    pidFilePath,
    log: jest.fn(),
    isAlive: jest.fn(() => true),
    commOf: jest.fn(async () => '/opt/w/whisper-server'),
    kill: jest.fn(),
    ...over,
  });

  it('no pid file → none', async () => {
    const o = base();
    expect(await reapOrphanServer(o)).toBe('none');
    expect(o.kill).not.toHaveBeenCalled();
  });

  it('dead pid → none, file removed, nothing killed', async () => {
    write({ pid: 99, binary: '/opt/w/whisper-server' });
    const o = base({ isAlive: jest.fn(() => false) });
    expect(await reapOrphanServer(o)).toBe('none');
    expect(o.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFilePath)).toBe(false);
  });

  it('alive and ps comm names our binary → SIGKILL, reaped', async () => {
    write({ pid: 99, binary: '/opt/w/whisper-server' });
    const o = base();
    expect(await reapOrphanServer(o)).toBe('reaped');
    expect(o.kill).toHaveBeenCalledWith(99, 'SIGKILL');
    expect(fs.existsSync(pidFilePath)).toBe(false);
  });

  it('alive but the pid was recycled to another program → NOT killed, not-ours', async () => {
    write({ pid: 99, binary: '/opt/w/whisper-server' });
    const o = base({ commOf: jest.fn(async () => '/usr/bin/vim') });
    expect(await reapOrphanServer(o)).toBe('not-ours');
    expect(o.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFilePath)).toBe(false);
  });

  it('garbage pid file → none, removed', async () => {
    fs.writeFileSync(pidFilePath, 'not json');
    const o = base();
    expect(await reapOrphanServer(o)).toBe('none');
    expect(o.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFilePath)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**

Run: `npx jest src/main/providers/local-asr/__tests__/server.test.ts`
Expected: FAIL — `Cannot find module '../server'`.

- [ ] **Step 3: Implement** `src/main/providers/local-asr/server.ts`:

```ts
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import type { LogLevel } from '@shared/contracts';

/** What the provider needs from a warm server (fakes implement this). */
export interface WhisperServerLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  baseUrl(): string;
  pid(): number | null;
  /** Fires once if the child exits on its own AFTER a successful start
   *  (a crash). Never for stop(), never for a failed start. */
  onExit(cb: (detail: string) => void): void;
}

export interface WhisperServerOptions {
  binaryPath: string;
  modelPath: string;
  vadModelPath: string;
  log(level: LogLevel, msg: string): void;
  /** <userData>/whisper-server.pid — `{pid, binary}`, for orphan reaping. */
  pidFilePath?: string;
  host?: string;
  port?: number;
  startupTimeoutMs?: number;
  healthPollMs?: number;
  stopGraceMs?: number;
  spawnFn?: (binaryPath: string, args: string[]) => ChildProcess;
  isHealthyAt?: (baseUrl: string) => Promise<boolean>;
  fileExists?: (p: string) => boolean;
  /** Test seam; default newRequestPath(). */
  requestPathFn?: () => string;
}

const DEFAULTS = {
  host: '127.0.0.1',
  startupTimeoutMs: 60_000,
  healthPollMs: 500,
  stopGraceMs: 3_000,
};
/** Server output is not logged line by line (LogLevel has no debug); the
 *  tail rides along on start-failure and crash messages instead. */
const OUTPUT_TAIL_BYTES = 8 * 1024;

/** macOS only (spec "Scope"): anywhere else the server is absent. */
export function resolveWhisperServerBinary(
  whisperDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform !== 'darwin') return null;
  return path.join(whisperDir, `${platform}-${arch}`, 'whisper-server');
}

/** Per-child secret route prefix (spec §2): every whisper-server route,
 *  `/load` included, lives under it, so nothing without the secret (e.g. a
 *  web page's preflight-free multipart POST) can make the server load a bad
 *  path and exit. 24 random bytes → 32 base64url chars. Never logged. */
export function newRequestPath(): string {
  return `/${randomBytes(24).toString('base64url')}`;
}

/** No `-t`: whisper-server's default n_threads is the same
 *  `std::min(4, hardware_concurrency())` whisper-cli uses, and interactive
 *  CLI runs pass no `-t` (spec §2, §3a). */
export function whisperServerArgs(o: {
  modelPath: string;
  vadModelPath: string;
  host: string;
  port: number;
  requestPath: string;
}): string[] {
  return [
    '-m', o.modelPath,
    '-vm', o.vadModelPath,
    '--host', o.host,
    '--port', String(o.port),
    '--request-path', o.requestPath,
  ];
}

async function pickFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** whisper-server loads the model BEFORE binding, so a connection error
 *  means "not ready yet" (same as LlamaServer's defaultHealth). */
async function defaultHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`);
    return res.status === 200;
  } catch {
    return false;
  }
}

export class WhisperServer implements WhisperServerLike {
  private child: ChildProcess | null = null;

  private url = '';

  private started = false;

  private stopping = false;

  private tail = '';

  private readonly exitCbs: Array<(detail: string) => void> = [];

  private readonly outputCbs: Array<(chunk: string) => void> = [];

  private readonly o: WhisperServerOptions & typeof DEFAULTS;

  constructor(options: WhisperServerOptions) {
    this.o = { ...DEFAULTS, ...options };
  }

  baseUrl(): string {
    return this.url;
  }

  pid(): number | null {
    return this.child?.pid ?? null;
  }

  onExit(cb: (detail: string) => void): void {
    this.exitCbs.push(cb);
  }

  /** Raw stdout/stderr chunks (parity suite: "processing started" marker). */
  onOutput(cb: (chunk: string) => void): void {
    this.outputCbs.push(cb);
  }

  async start(): Promise<void> {
    const exists = this.o.fileExists ?? existsSync;
    if (!exists(this.o.vadModelPath)) {
      throw new Error(`VAD model missing at ${this.o.vadModelPath} — refusing to start whisper-server`);
    }
    const port = this.o.port ?? (await pickFreePort(this.o.host));
    // Fresh secret per child; it lives only in this.url and argv.
    const requestPath = (this.o.requestPathFn ?? newRequestPath)();
    this.url = `http://${this.o.host}:${port}${requestPath}`;
    const args = whisperServerArgs({
      modelPath: this.o.modelPath,
      vadModelPath: this.o.vadModelPath,
      host: this.o.host,
      port,
      requestPath,
    });
    const spawnFn =
      this.o.spawnFn ??
      ((bin: string, a: string[]) => spawn(bin, a, { stdio: ['ignore', 'pipe', 'pipe'] }));
    const child = spawnFn(this.o.binaryPath, args);
    this.child = child;
    const keep = (c: Buffer | string): void => {
      const text = c.toString();
      this.tail = (this.tail + text).slice(-OUTPUT_TAIL_BYTES);
      for (const cb of this.outputCbs) cb(text);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    // EPIPE on a stdio stream emits on the Readable, not the child — unhandled
    // it would take down the main process (same guard as whisper-cli.ts).
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    let failEarly!: (e: Error) => void;
    const early = new Promise<never>((_resolve, reject) => {
      failEarly = reject;
    });
    early.catch(() => {});
    child.on('error', (err: Error) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.started) failEarly(err);
      else this.crashed(`error=${err.message}`);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child !== child) return;
      this.child = null;
      if (child.pid !== undefined) void this.removePidFile(child.pid);
      const detail = `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      if (!this.started) failEarly(new Error(`whisper-server exited before becoming healthy (${detail})`));
      else if (!this.stopping) this.crashed(detail);
    });
    if (child.pid !== undefined) await this.writePidFile(child.pid);

    try {
      await Promise.race([this.waitHealthy(child), early]);
      this.started = true;
    } catch (err) {
      await this.stop();
      const msg = err instanceof Error ? err.message : String(err);
      const tail = this.tail.trim().slice(-500);
      throw new Error(tail ? `${msg} — output: ${tail}` : msg);
    }
  }

  private crashed(detail: string): void {
    const tail = this.tail.trim().slice(-300);
    const full = tail ? `${detail} — output: ${tail}` : detail;
    for (const cb of this.exitCbs) cb(full);
  }

  private async waitHealthy(child: ChildProcess): Promise<void> {
    const probe = this.o.isHealthyAt ?? defaultHealth;
    const deadline = Date.now() + this.o.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.child !== child) throw new Error('whisper-server exited during startup');
      // eslint-disable-next-line no-await-in-loop
      if (await probe(this.url)) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => {
        const t = setTimeout(r, this.o.healthPollMs);
        t.unref?.();
      });
    }
    throw new Error(`whisper-server health check timed out after ${this.o.startupTimeoutMs} ms`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const { child } = this;
    this.child = null;
    if (!child) return;
    const pid = child.pid;
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        let exited = false;
        let killTimer: NodeJS.Timeout | null = null;
        // We own this child's exit now: drop the crash handlers first.
        child.removeAllListeners('exit');
        child.removeAllListeners('error');
        child.on('error', () => {});
        child.once('exit', () => {
          exited = true;
          if (killTimer) clearTimeout(killTimer);
          resolve();
        });
        child.kill('SIGTERM');
        if (!exited) {
          killTimer = setTimeout(() => {
            killTimer = null;
            child.kill('SIGKILL');
          }, this.o.stopGraceMs);
          killTimer.unref?.();
        }
      });
    }
    if (pid !== undefined) await this.removePidFile(pid);
  }

  private async writePidFile(pid: number): Promise<void> {
    if (!this.o.pidFilePath) return;
    await fsp
      .writeFile(this.o.pidFilePath, JSON.stringify({ pid, binary: this.o.binaryPath }), { mode: 0o600 })
      .catch((e) => this.o.log('warn', `[local-asr] pid file write failed: ${String(e)}`));
  }

  /** Only removes the file while it still names THIS child — a later
   *  server may already have written its own. */
  private async removePidFile(pid: number): Promise<void> {
    const p = this.o.pidFilePath;
    if (!p) return;
    try {
      const rec = JSON.parse(await fsp.readFile(p, 'utf8')) as { pid?: unknown };
      if (rec.pid !== pid) return;
    } catch {
      return;
    }
    await fsp.rm(p, { force: true }).catch(() => {});
  }
}

export interface ReapOptions {
  pidFilePath: string;
  log(level: LogLevel, msg: string): void;
  readFile?: (p: string) => Promise<string>;
  removeFile?: (p: string) => Promise<void>;
  isAlive?: (pid: number) => boolean;
  commOf?: (pid: number) => Promise<string | null>;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultCommOf(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'comm=', '-p', String(pid)], (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

/**
 * Provider start (spec §2 "Orphans"): a whisper-server left behind by a
 * crashed or SIGKILLed app is killed ONLY when its pid is alive and
 * `ps -o comm=` names our binary — a recycled pid is never touched. macOS
 * prints the full path; the basename comparison covers a truncated comm.
 */
export async function reapOrphanServer(o: ReapOptions): Promise<'none' | 'reaped' | 'not-ours'> {
  const readFile = o.readFile ?? ((p: string) => fsp.readFile(p, 'utf8'));
  const removeFile = o.removeFile ?? ((p: string) => fsp.rm(p, { force: true }));
  const isAlive = o.isAlive ?? defaultIsAlive;
  const commOf = o.commOf ?? defaultCommOf;
  const kill = o.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));

  let raw: string;
  try {
    raw = await readFile(o.pidFilePath);
  } catch {
    return 'none';
  }
  let rec: { pid?: unknown; binary?: unknown };
  try {
    rec = JSON.parse(raw) as typeof rec;
  } catch {
    await removeFile(o.pidFilePath).catch(() => {});
    return 'none';
  }
  const { pid, binary } = rec;
  if (typeof pid !== 'number' || typeof binary !== 'string' || !isAlive(pid)) {
    await removeFile(o.pidFilePath).catch(() => {});
    return 'none';
  }
  const comm = await commOf(pid);
  const ours = comm !== null && (comm === binary || path.basename(comm) === path.basename(binary));
  if (ours) {
    try {
      kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    o.log('warn', `[local-asr] reaped orphan whisper-server pid=${pid}`);
  }
  await removeFile(o.pidFilePath).catch(() => {});
  return ours ? 'reaped' : 'not-ours';
}
```

- [ ] **Step 4: Run the test, expect PASS.**

Run: `npx jest src/main/providers/local-asr/__tests__/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit.**

```bash
npx eslint src/main/providers/local-asr/server.ts src/main/providers/local-asr/__tests__/server.test.ts
npx tsc --noEmit -p .
git add src/main/providers/local-asr/server.ts src/main/providers/local-asr/__tests__/server.test.ts
printf 'feat(local-asr): WhisperServer lifecycle + orphan reaping (#143)\n' > $SCR/opt/msg-wws-5
git commit -F $SCR/opt/msg-wws-5 -- src/main/providers/local-asr/server.ts src/main/providers/local-asr/__tests__/server.test.ts
```

---

### Task 6: `routing.ts` — pure routing rule

**Proceeds only on GO from Task 1.**

**Files:**
- Create: `src/main/providers/local-asr/routing.ts`
- Test: `src/main/providers/local-asr/__tests__/routing.test.ts`

**Interfaces:**
- Produces:
  - `export type AsrRouteReason = 'eligible' | 'platform' | 'env-off' | 'weak-host' | 'no-server-binary' | 'disabled' | 'background' | 'accuracy' | 'detect' | 'no-timestamps' | 'not-wav' | 'vad-off'`
  - `export interface AsrRouteInput { platform: NodeJS.Platform; weak: boolean; envOff: boolean; serverBinaryPresent: boolean; disabled: boolean; cls: 'interactive' | 'background'; accuracy: boolean; detect: boolean; timestamps: boolean; format: 'wav' | 'mp3'; vadOn: boolean }`
  - `export interface AsrRoute { via: 'server' | 'cli'; reason: AsrRouteReason }`
  - `export function routeJob(i: AsrRouteInput): AsrRoute`
- The log line uses `reason` verbatim (`[local-asr] job via=cli reason=vad-off …`). Task 7 adds one more reason string, `start-failed`, which is logged by the provider and never returned by `routeJob`.

- [ ] **Step 1: Write the failing test** `src/main/providers/local-asr/__tests__/routing.test.ts`:

```ts
import { routeJob, type AsrRouteInput } from '../routing';

const ELIGIBLE: AsrRouteInput = {
  platform: 'darwin',
  weak: false,
  envOff: false,
  serverBinaryPresent: true,
  disabled: false,
  cls: 'interactive',
  accuracy: false,
  detect: false,
  timestamps: true,
  format: 'wav',
  vadOn: true,
};

describe('routeJob (spec §1)', () => {
  it('an eligible meetings hear goes to the warm server', () => {
    expect(routeJob(ELIGIBLE)).toEqual({ via: 'server', reason: 'eligible' });
  });

  it.each<[Partial<AsrRouteInput>, string]>([
    [{ platform: 'win32' }, 'platform'],
    [{ platform: 'linux' }, 'platform'],
    [{ envOff: true }, 'env-off'],
    [{ weak: true }, 'weak-host'],
    [{ serverBinaryPresent: false }, 'no-server-binary'],
    [{ disabled: true }, 'disabled'],
    [{ cls: 'background' }, 'background'],
    [{ accuracy: true }, 'accuracy'],
    [{ detect: true }, 'detect'],
    [{ timestamps: false }, 'no-timestamps'],
    [{ format: 'mp3' }, 'not-wav'],
    [{ vadOn: false }, 'vad-off'],
  ])('%o → cli (%s)', (over, reason) => {
    expect(routeJob({ ...ELIGIBLE, ...over })).toEqual({ via: 'cli', reason });
  });

  it('platform is checked independently of weak (KIA_HOST_WEAK=0 on Windows stays CLI)', () => {
    expect(routeJob({ ...ELIGIBLE, platform: 'win32', weak: false })).toEqual({
      via: 'cli',
      reason: 'platform',
    });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**

Run: `npx jest src/main/providers/local-asr/__tests__/routing.test.ts`
Expected: FAIL — `Cannot find module '../routing'`.

- [ ] **Step 3: Implement** `src/main/providers/local-asr/routing.ts`:

```ts
/** Why a job runs where it runs; logged verbatim as `reason=<value>`. */
export type AsrRouteReason =
  | 'eligible'
  | 'platform'
  | 'env-off'
  | 'weak-host'
  | 'no-server-binary'
  | 'disabled'
  | 'background'
  | 'accuracy'
  | 'detect'
  | 'no-timestamps'
  | 'not-wav'
  | 'vad-off';

export interface AsrRouteInput {
  platform: NodeJS.Platform;
  /** hostBudget(host, null).weak */
  weak: boolean;
  /** KIA_ASR_SERVER === '0' */
  envOff: boolean;
  serverBinaryPresent: boolean;
  /** Disabled for this session (start failure or two crashes). */
  disabled: boolean;
  cls: 'interactive' | 'background';
  accuracy: boolean;
  detect: boolean;
  timestamps: boolean;
  format: 'wav' | 'mp3';
  /** The job's resolved VAD model path is defined. */
  vadOn: boolean;
}

export interface AsrRoute {
  via: 'server' | 'cli';
  reason: AsrRouteReason;
}

/**
 * Spec §1. The warm server serves exactly one shape: darwin, non-weak host,
 * interactive, default tier, `{wav, timestamps, VAD on}`, language fixed or
 * auto. Everything else is whisper-cli, as before #143. Detect stays on the
 * CLI (the server has no usable probability); VAD-off stays on the CLI (b5130
 * keeps the previous request's VAD mapping when VAD is off); background stays
 * on the CLI (#145 demotion is process-wide).
 */
export function routeJob(i: AsrRouteInput): AsrRoute {
  const cli = (reason: AsrRouteReason): AsrRoute => ({ via: 'cli', reason });
  if (i.platform !== 'darwin') return cli('platform');
  if (i.envOff) return cli('env-off');
  if (i.weak) return cli('weak-host');
  if (!i.serverBinaryPresent) return cli('no-server-binary');
  if (i.disabled) return cli('disabled');
  if (i.cls !== 'interactive') return cli('background');
  if (i.accuracy) return cli('accuracy');
  if (i.detect) return cli('detect');
  if (!i.timestamps) return cli('no-timestamps');
  if (i.format !== 'wav') return cli('not-wav');
  if (!i.vadOn) return cli('vad-off');
  return { via: 'server', reason: 'eligible' };
}
```

- [ ] **Step 4: Run the test, expect PASS.**

Run: `npx jest src/main/providers/local-asr/__tests__/routing.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, commit.**

```bash
npx eslint src/main/providers/local-asr/routing.ts src/main/providers/local-asr/__tests__/routing.test.ts
git add src/main/providers/local-asr/routing.ts src/main/providers/local-asr/__tests__/routing.test.ts
printf 'feat(local-asr): pure warm-server routing rule (#143)\n' > $SCR/opt/msg-wws-6
git commit -F $SCR/opt/msg-wws-6 -- src/main/providers/local-asr/routing.ts src/main/providers/local-asr/__tests__/routing.test.ts
```

---

### Task 7: Provider integration — `ensureServer`, idle stop, overlap policy, disable, stats, dispose

**Proceeds only on GO from Task 1.**

**Files:**
- Modify: `src/main/providers/local-asr/provider.ts`
- Modify: `src/main/providers/local-asr/index.ts`
- Test: `src/main/providers/local-asr/__tests__/provider-server.test.ts`
- Must stay green unchanged: `src/main/providers/local-asr/__tests__/provider.test.ts`. Its `makeDeps` passes no `serverBinaryPath`, so every job routes `no-server-binary` → CLI as today.

**Interfaces:**
- Consumes: `routeJob` (Task 6), `WhisperServer`, `WhisperServerLike`, `WhisperServerOptions`, `reapOrphanServer` (Task 5), `transcribeViaServer` (Task 4).
- Produces:
  - `export const IDLE_STOP_MS = 5 * 60_000;` `export const MAX_SERVER_CRASHES = 2;`
  - `export interface AsrServerStats { starts: number; lastVia: 'server' | 'cli' | null; disabledReason: string | null }`
  - `LocalAsrProvider.serverStats(): AsrServerStats` (Task 8 wires it to `inference:stats`). `disabledReason` is `'KIA_ASR_SERVER=0'` when the env switch is set.
  - New `createLocalAsrProvider` deps: `serverBinaryPath?: string | null; pidFilePath?: string; makeServer?: (o: WhisperServerOptions) => WhisperServerLike; transcribeServer?: typeof transcribeViaServer; readAudio?: (p: string) => Promise<Uint8Array>; reapOrphan?: () => Promise<unknown>; env?: NodeJS.ProcessEnv; idleStopMs?: number; idleTimers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }`.

- [ ] **Step 1: Write the failing test** `src/main/providers/local-asr/__tests__/provider-server.test.ts`:

```ts
/** @jest-environment node */
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Prefs } from '@shared/contracts';

import { createLocalAsrProvider } from '../provider';
import type { WhisperServerLike, WhisperServerOptions } from '../server';
import { AsrInputRejectedError } from '../whisper-cli';

function fakePrefs(): Prefs {
  let current = {
    theme: 'system' as const,
    logLevel: 'info' as const,
    launchAtLogin: false,
    showInMenuBar: false,
    processing: { enabled: true, window: 'always' as const },
    models: { override: 'auto', autoInstall: true },
  } as any;
  return {
    get: () => current,
    patch: async (p) => {
      current = { ...current, ...p };
    },
    onChange: () => () => {},
  };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeServer implements WhisperServerLike {
  exitCb: ((d: string) => void) | null = null;
  startGate: Promise<void> = Promise.resolve();
  stopGate: Promise<void> = Promise.resolve();
  failStart: Error | null = null;
  constructor(
    readonly opts: WhisperServerOptions,
    private readonly events: string[],
  ) {}
  async start() {
    this.events.push('start');
    await this.startGate;
    if (this.failStart) throw this.failStart;
  }
  async stop() {
    this.events.push('stop');
    await this.stopGate;
  }
  baseUrl() {
    return 'http://127.0.0.1:1';
  }
  pid() {
    return 1;
  }
  onExit(cb: (d: string) => void) {
    this.exitCb = cb;
  }
  crash() {
    this.exitCb?.('code=139 signal=null');
  }
}

function fakeIdleTimers() {
  const live = new Map<number, () => void>();
  let next = 1;
  let sets = 0;
  let clears = 0;
  return {
    set(fn: () => void) {
      sets += 1;
      const h = next;
      next += 1;
      live.set(h, fn);
      return h;
    },
    clear(h: unknown) {
      clears += 1;
      live.delete(h as number);
    },
    pending: () => live.size,
    fire() {
      const fns = [...live.values()];
      live.clear();
      fns.forEach((fn) => fn());
    },
    counts: () => ({ sets, clears }),
  };
}

const VTT_TEXT = '\n[00:00:00.000 --> 00:00:01.000]   hi\n';

function setup(over: Record<string, any> = {}) {
  const events: string[] = [];
  const servers: FakeServer[] = [];
  const logs: string[] = [];
  const timers = fakeIdleTimers();
  const configure = over.configureServer as ((s: FakeServer, n: number) => void) | undefined;
  const deps = {
    binaryPath: '/opt/w/whisper-cli',
    serverBinaryPath: '/opt/w/whisper-server',
    vadModelPath: '/opt/w/silero.bin',
    asrModelsDir: '/models/asr',
    pidFilePath: '/tmp/never-written.pid',
    prefs: fakePrefs(),
    log: (_l: string, m: string) => logs.push(m),
    host: { platform: 'darwin' as NodeJS.Platform, arch: 'arm64', cores: 8, totalMemBytes: 32 * 1024 ** 3 },
    env: {},
    binaryPresent: () => true,
    filesPresent: () => true,
    fileExists: () => true,
    download: jest.fn(async () => {}),
    readAudio: async () => new Uint8Array(4),
    reapOrphan: async () => undefined,
    idleTimers: timers,
    runCli: jest.fn(async (a: any) => {
      events.push(`cli:${a.priority}`);
      return 'cli text';
    }),
    transcribeServer: jest.fn(async (_a: any) => {
      events.push('http');
      return VTT_TEXT;
    }),
    makeServer: (o: WhisperServerOptions) => {
      const s = new FakeServer(o, events);
      configure?.(s, servers.length);
      servers.push(s);
      return s;
    },
    ...over,
  };
  delete (deps as any).configureServer;
  const provider = createLocalAsrProvider(deps as any);
  return { provider, deps, events, servers, logs, timers };
}

const meetingHear = (extra: Record<string, unknown> = {}) =>
  ({
    kind: 'hear',
    payload: { audio: new Uint8Array(4), format: 'wav', timestamps: true, vad: 'required', ...extra },
  }) as never;

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('local-asr warm server integration (spec §1-§2)', () => {
  it('routes eligible meetings hears to ONE warm server; logs via=server; stats', async () => {
    const { provider, servers, logs, deps } = setup();
    expect(await provider.handle(meetingHear({ language: 'de' }))).toBe(VTT_TEXT);
    await provider.handle(meetingHear());
    await provider.handle(meetingHear({ language: 'en' }));
    expect(servers).toHaveLength(1);
    expect(deps.runCli).not.toHaveBeenCalled();
    expect(deps.transcribeServer.mock.calls.map((c: any[]) => c[0].language)).toEqual(['de', 'auto', 'en']);
    expect(servers[0].opts).toMatchObject({
      binaryPath: '/opt/w/whisper-server',
      vadModelPath: '/opt/w/silero.bin',
      modelPath: path.join('/models/asr', 'whisper-large-v3-turbo-q5_0', 'ggml-large-v3-turbo-q5_0.bin'),
      pidFilePath: '/tmp/never-written.pid',
    });
    expect(logs.filter((m) => /^\[local-asr\] server start model=whisper-large-v3-turbo-q5_0 ms=\d+$/.test(m))).toHaveLength(1);
    expect(logs.filter((m) => /^\[local-asr\] job via=server reason=eligible ms=\d+$/.test(m))).toHaveLength(3);
    expect(provider.serverStats()).toEqual({ starts: 1, lastVia: 'server', disabledReason: null });
  });

  it('a VAD-off hear (no VAD model configured) routes to the CLI', async () => {
    const { provider, servers, logs } = setup({ vadModelPath: undefined });
    await provider.handle(meetingHear({ vad: undefined }));
    expect(servers).toHaveLength(0);
    expect(logs.some((m) => m.startsWith('[local-asr] job via=cli reason=vad-off'))).toBe(true);
  });

  it('a weak host routes to the CLI', async () => {
    const { provider, servers, logs } = setup({
      host: { platform: 'darwin', arch: 'arm64', cores: 4, totalMemBytes: 32 * 1024 ** 3 },
    });
    await provider.handle(meetingHear());
    expect(servers).toHaveLength(0);
    expect(logs.some((m) => m.startsWith('[local-asr] job via=cli reason=weak-host'))).toBe(true);
  });

  it('KIA_ASR_SERVER=0 routes to the CLI and reports it in stats', async () => {
    const { provider, servers } = setup({ env: { KIA_ASR_SERVER: '0' } });
    await provider.handle(meetingHear());
    expect(servers).toHaveLength(0);
    expect(provider.serverStats()).toEqual({ starts: 0, lastVia: 'cli', disabledReason: 'KIA_ASR_SERVER=0' });
  });

  it('start failure: this job falls back to the CLI, the session is disabled once, later jobs skip the server', async () => {
    const { provider, servers, logs, deps } = setup({
      configureServer: (s: FakeServer) => {
        s.failStart = new Error('whisper-server health check timed out after 60000 ms');
      },
    });
    expect(await provider.handle(meetingHear())).toBe('cli text');
    expect(logs.some((m) => m.startsWith('[local-asr] job via=cli reason=start-failed'))).toBe(true);
    await provider.handle(meetingHear());
    expect(servers).toHaveLength(1);
    expect(deps.runCli).toHaveBeenCalledTimes(2);
    expect(logs.filter((m) => m.startsWith('[local-asr] server disabled: '))).toHaveLength(1);
    expect(logs.some((m) => m.startsWith('[local-asr] job via=cli reason=disabled'))).toBe(true);
    expect(provider.serverStats().disabledReason).toMatch(/timed out/);
  });

  it('a crash respawns lazily on the next job; a second crash disables for the session', async () => {
    const { provider, servers, logs } = setup();
    await provider.handle(meetingHear());
    servers[0].crash();
    await provider.handle(meetingHear());
    expect(servers).toHaveLength(2);
    servers[1].crash();
    await provider.handle(meetingHear());
    expect(servers).toHaveLength(2);
    expect(logs.some((m) => m.startsWith('[local-asr] job via=cli reason=disabled'))).toBe(true);
    expect(provider.serverStats()).toMatchObject({ starts: 2, disabledReason: 'crashed 2 times' });
  });

  it('a CLI job stops the warm server immediately before spawning', async () => {
    const { provider, events } = setup();
    await provider.handle(meetingHear());
    await provider.handle(meetingHear({ model: 'accuracy' }));
    expect(events).toEqual(['start', 'http', 'stop', 'cli:interactive']);
  });

  it('a hold-off-rejected background job leaves the server up and the idle timer untouched', async () => {
    const { provider, events, timers } = setup();
    await provider.handle(meetingHear());
    expect(timers.counts()).toEqual({ sets: 1, clears: 0 });
    await expect(provider.transcribeFile('/tmp/a.wav', { format: 'wav' })).rejects.toThrow(
      'local ASR busy with interactive work',
    );
    expect(events).toEqual(['start', 'http']);
    expect(timers.counts()).toEqual({ sets: 1, clears: 0 });
    expect(timers.pending()).toBe(1);
  });

  it('idle timer: absent while a job runs (any length), armed after it settles, firing stops the server', async () => {
    const gate = deferred<string>();
    const { provider, timers, events, deps } = setup();
    await provider.handle(meetingHear());
    expect(timers.pending()).toBe(1);
    deps.transcribeServer.mockImplementationOnce(async () => {
      events.push('http-long');
      return gate.promise;
    });
    const long = provider.handle(meetingHear());
    await tick();
    expect(timers.pending()).toBe(0); // a 20-minute job can never hit the 5-minute idle stop
    gate.resolve(VTT_TEXT);
    await long;
    expect(timers.pending()).toBe(1);
    timers.fire();
    await tick();
    expect(events.filter((e) => e === 'stop')).toHaveLength(1);
  });

  it('a job arriving during an idle stop waits for the stop, then starts a fresh server', async () => {
    const stopGate = deferred();
    const { provider, timers, events } = setup({
      configureServer: (s: FakeServer, n: number) => {
        if (n === 0) s.stopGate = stopGate.promise;
      },
    });
    await provider.handle(meetingHear());
    timers.fire(); // stop begins, blocked on stopGate
    const next = provider.handle(meetingHear());
    await tick();
    expect(events).toEqual(['start', 'http', 'stop']);
    stopGate.resolve();
    await next;
    expect(events).toEqual(['start', 'http', 'stop', 'start', 'http']);
    expect(provider.serverStats().starts).toBe(2);
  });

  it('a failed or aborted request does not stop the server; the next job reuses it', async () => {
    const { provider, servers, deps } = setup();
    deps.transcribeServer.mockImplementationOnce(async () => {
      throw new Error('whisper-server request failed: This operation was aborted');
    });
    await expect(provider.handle(meetingHear())).rejects.toThrow(/aborted/);
    await provider.handle(meetingHear());
    expect(servers).toHaveLength(1);
    expect(provider.serverStats().starts).toBe(1);
  });

  it('a 400 from the server reaches the caller as the same AsrInputRejectedError', async () => {
    const rejected = new AsrInputRejectedError('whisper-server could not decode the input (HTTP 400): x');
    const { provider, deps } = setup();
    deps.transcribeServer.mockImplementationOnce(async () => {
      throw rejected;
    });
    await expect(provider.handle(meetingHear())).rejects.toBe(rejected);
  });

  it('dispose during a pending start: waits for the start, then stops that server (no orphan)', async () => {
    const startGate = deferred();
    const { provider, events } = setup({
      configureServer: (s: FakeServer) => {
        s.startGate = startGate.promise;
      },
    });
    const job = provider.handle(meetingHear());
    await tick();
    const disposed = provider.dispose();
    await expect(job).rejects.toThrow();
    startGate.resolve();
    await disposed;
    expect(events).toEqual(['start', 'stop']);
  });

  it('dispose during an in-flight request: aborts the fetch, then stops the server after the job settles', async () => {
    const { provider, events, deps } = setup();
    deps.transcribeServer.mockImplementationOnce(
      (a: any) =>
        new Promise<string>((_res, rej) => {
          events.push('http-pending');
          a.signal.addEventListener('abort', () => {
            events.push('aborted');
            rej(new Error('whisper-server request failed: aborted'));
          });
        }),
    );
    const job = provider.handle(meetingHear());
    await tick();
    await provider.dispose();
    await expect(job).rejects.toThrow();
    expect(events).toEqual(['start', 'http-pending', 'aborted', 'stop']);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**

Run: `npx jest src/main/providers/local-asr/__tests__/provider-server.test.ts`
Expected: FAIL. The first test fails because `servers` is empty (no routing yet) and `provider.serverStats` is not a function.

- [ ] **Step 3: Implement in `provider.ts`.** Make these edits, in order.

(3a) Imports. Add after the existing `./whisper-cli` import:

```ts
import { routeJob } from './routing';
import {
  WhisperServer,
  reapOrphanServer,
  type WhisperServerLike,
  type WhisperServerOptions,
} from './server';
import { transcribeViaServer } from './server-request';
```

(3b) Exported constants and types. Add just after `const INTERACTIVE_HOLD_OFF_MS = 90_000;`:

```ts
/** Warm server idle stop (spec §2): RAM matters on 16 GB Macs running gemma. */
export const IDLE_STOP_MS = 5 * 60_000;
/** Two crashes in one session disable the warm server until next app start. */
export const MAX_SERVER_CRASHES = 2;

export interface AsrServerStats {
  starts: number;
  lastVia: 'server' | 'cli' | null;
  disabledReason: string | null;
}
```

Add `serverStats(): AsrServerStats;` to the `LocalAsrProvider` interface (after `variants(): AsrVariant[];`).

(3c) New deps. Add to the `deps` parameter type of `createLocalAsrProvider` (after `now?: () => number;`):

```ts
  /** Vendored whisper-server (darwin only); null/undefined → never warm. */
  serverBinaryPath?: string | null;
  /** <userData>/whisper-server.pid — orphan reaping across app crashes. */
  pidFilePath?: string;
  makeServer?: (o: WhisperServerOptions) => WhisperServerLike;
  transcribeServer?: typeof transcribeViaServer;
  readAudio?: (p: string) => Promise<Uint8Array>;
  reapOrphan?: () => Promise<unknown>;
  /** KIA_ASR_SERVER / KIA_HOST_WEAK source (tests). Default process.env. */
  env?: NodeJS.ProcessEnv;
  idleStopMs?: number;
  idleTimers?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
```

(3d) Warm-server state and helpers. Insert immediately AFTER the `requireVadModel` function and BEFORE `const runTranscribe = (`:

```ts
  // ── warm whisper-server (spec §2) ─────────────────────────────────────────
  const env = deps.env ?? process.env;
  const makeServer =
    deps.makeServer ?? ((o: WhisperServerOptions) => new WhisperServer(o));
  const transcribeServer = deps.transcribeServer ?? transcribeViaServer;
  const readAudio =
    deps.readAudio ?? ((p: string) => fsp.readFile(p) as Promise<Uint8Array>);
  const idleTimers = deps.idleTimers ?? {
    set: (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    },
    clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const serverBinaryPresent =
    typeof deps.serverBinaryPath === 'string' &&
    (deps.binaryPresent ?? existsSync)(deps.serverBinaryPath);
  const modelPathOf = (m: ModelDescriptor): string =>
    path.join(modelDir(deps.asrModelsDir, m.id), m.files[0].name);
  // Started at construction, awaited before the first server start: a
  // whisper-server orphaned by a crashed app is reaped before we spawn ours.
  const reaped: Promise<unknown> = (
    deps.reapOrphan ??
    (async () =>
      deps.pidFilePath
        ? reapOrphanServer({ pidFilePath: deps.pidFilePath, log: deps.log })
        : undefined)
  )().catch(() => undefined);

  let server: WhisperServerLike | null = null;
  let serverStarting: Promise<WhisperServerLike> | null = null;
  let serverStopping: Promise<void> | null = null;
  let idleHandle: unknown = null;
  let serverCrashes = 0;
  let serverStarts = 0;
  let disabledReason: string | null = null;
  let lastVia: AsrServerStats['lastVia'] = null;

  const disableServer = (reason: string): void => {
    if (disabledReason !== null) return;
    disabledReason = reason;
    deps.log('warn', `[local-asr] server disabled: ${reason}`);
  };

  const disarmIdle = (): void => {
    if (idleHandle === null) return;
    idleTimers.clear(idleHandle);
    idleHandle = null;
  };

  // At most one stop in flight; a job arriving meanwhile waits for it
  // (ensureServer) and then starts a fresh server.
  const stopServer = (): Promise<void> => {
    disarmIdle();
    const s = server;
    server = null;
    if (s === null) return serverStopping ?? Promise.resolve();
    const stopping: Promise<void> = s
      .stop()
      .catch((err) => deps.log('warn', `[local-asr] server stop: ${String(err)}`))
      .finally(() => {
        if (serverStopping === stopping) serverStopping = null;
      });
    serverStopping = stopping;
    return stopping;
  };

  // Armed only when a server job settles; never while a start or a job is
  // running, so a long request has no deadline (spec §2 "Idle stop").
  const armIdle = (): void => {
    disarmIdle();
    if (server === null || closing) return;
    idleHandle = idleTimers.set(() => {
      idleHandle = null;
      deps.log('info', '[local-asr] server idle — releasing model RAM');
      void stopServer();
    }, deps.idleStopMs ?? IDLE_STOP_MS);
  };

  // Single-flight: the queue already runs one job at a time, but dispose()
  // can observe a pending start, and an idle stop can be in flight.
  const ensureServer = async (vadModelPath: string): Promise<WhisperServerLike> => {
    await reaped;
    // eslint-disable-next-line no-await-in-loop
    while (serverStopping) await serverStopping;
    if (closing) throw new Error('local-asr disposed — app quitting');
    if (server) return server;
    if (serverStarting) return serverStarting;
    const startedAt = now();
    const s = makeServer({
      binaryPath: deps.serverBinaryPath as string,
      modelPath: modelPathOf(defaultModel),
      vadModelPath,
      pidFilePath: deps.pidFilePath,
      log: deps.log,
    });
    s.onExit((detail) => {
      if (server !== s) return;
      server = null;
      disarmIdle();
      serverCrashes += 1;
      deps.log('warn', `[local-asr] server exited unexpectedly (${detail}); crashes=${serverCrashes}`);
      if (serverCrashes >= MAX_SERVER_CRASHES) {
        disableServer(`crashed ${serverCrashes} times`);
      }
    });
    const starting = s.start().then(() => {
      server = s;
      serverStarts += 1;
      deps.log('info', `[local-asr] server start model=${defaultModel.id} ms=${now() - startedAt}`);
      return s;
    });
    serverStarting = starting;
    try {
      return await starting;
    } catch (err) {
      disableServer(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (serverStarting === starting) serverStarting = null;
    }
  };

  const raceAbort = <T>(p: Promise<T>, signal: AbortSignal): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('local-asr job aborted'));
        return;
      }
      const onAbort = (): void => reject(new Error('local-asr job aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });

  /** The transcript, or null when the server could not be started (the
   *  session is now disabled, so the caller runs this job on the CLI).
   *  Transcription errors propagate unchanged: 400 → AsrInputRejectedError,
   *  anything else a plain Error the caller defers. */
  const runOnServer = async (
    p: string,
    language: string | undefined,
    vadModelPath: string,
    signal: AbortSignal,
  ): Promise<string | null> => {
    disarmIdle();
    let s: WhisperServerLike;
    try {
      s = await raceAbort(ensureServer(vadModelPath), signal);
    } catch (err) {
      if (signal.aborted) throw err;
      return null;
    }
    const audio = await readAudio(p);
    return transcribeServer({
      baseUrl: s.baseUrl(),
      audio,
      language: language ?? 'auto',
      signal,
    });
  };
```

(3e) Replace the whole `async run() { … }` method inside `runTranscribe`'s `job` object with:

```ts
        async run() {
          if (closing) {
            reject(new Error('local-asr disposed — app quitting'));
            return;
          }
          if (!installedModel(which)) {
            reject(new Error('local-asr model not installed'));
            return;
          }
          if (cls === 'background') {
            // Plain Error (no `status`): the audio worker defers it and
            // re-drives on its cadence instead of marking the doc failed.
            if (
              lastInteractiveAt !== null &&
              now() - lastInteractiveAt < INTERACTIVE_HOLD_OFF_MS
            ) {
              reject(new Error('local ASR busy with interactive work'));
              return;
            }
          } else {
            lastInteractiveAt = now();
          }
          const route = routeJob({
            platform: host.platform,
            weak: hostBudget(host, null, env).weak,
            envOff: env.KIA_ASR_SERVER === '0',
            serverBinaryPresent,
            disabled: disabledReason !== null,
            cls,
            accuracy: which !== defaultModel,
            detect: opts.detectLanguage === true,
            timestamps: opts.timestamps === true,
            format: opts.format,
            vadOn: vadModelPath !== undefined,
          });
          const abort = new AbortController();
          active = abort;
          const startedAt = now();
          try {
            if (route.via === 'server') {
              const text = await runOnServer(
                p,
                opts.language,
                vadModelPath as string,
                abort.signal,
              );
              if (text !== null) {
                lastVia = 'server';
                deps.log(
                  'info',
                  `[local-asr] job via=server reason=${route.reason} ms=${now() - startedAt}`,
                );
                resolve(text);
                return;
              }
            }
            const reason = route.via === 'server' ? 'start-failed' : route.reason;
            // At most one whisper model resident (spec §2): stop the warm
            // server right before a CLI child spawns, never earlier, so a
            // hold-off-rejected background job (above) leaves it up.
            await stopServer();
            const text = await runCli({
              binaryPath: deps.binaryPath,
              modelPath: modelPathOf(which),
              inputPath: p,
              timestamps: opts.timestamps === true,
              language: opts.language,
              detectLanguage: opts.detectLanguage === true ? true : undefined,
              vadModelPath,
              signal: abort.signal,
              priority: cls,
              threads:
                cls === 'background'
                  ? Math.min(4, hostBudget(host, null).backgroundThreads)
                  : undefined,
            });
            lastVia = 'cli';
            deps.log(
              'info',
              `[local-asr] job via=cli reason=${reason} ms=${now() - startedAt}`,
            );
            resolve(text);
          } catch (err) {
            // Pass the original through unchanged — an AsrInputRejectedError
            // must stay instanceof for the worker's terminal-skip branch.
            reject(err instanceof Error ? err : new Error(String(err)));
          } finally {
            if (cls === 'interactive') lastInteractiveAt = now();
            if (active === abort) active = null;
            if (route.via === 'server') armIdle();
          }
        },
```

(3f) `dispose()`: after the existing lines `const run = activeRun;` and `if (run) await run.catch(() => {});`, append:

```ts
      // (5) Warm server: let a pending start settle (stop the real child,
      // never orphan a spawning one), then stop it. main.ts still calls this
      // after localLlm.dispose(), unchanged.
      const starting = serverStarting;
      if (starting) await starting.catch(() => {});
      await stopServer();
```

(3g) Add to the returned object (next to `variants,`):

```ts
    serverStats(): AsrServerStats {
      return {
        starts: serverStarts,
        lastVia,
        disabledReason:
          env.KIA_ASR_SERVER === '0' ? 'KIA_ASR_SERVER=0' : disabledReason,
      };
    },
```

(3h) `src/main/providers/local-asr/index.ts`: re-export the new names so Task 8 and the parity suite can import them from the package entry:

```ts
export {
  IDLE_STOP_MS,
  MAX_SERVER_CRASHES,
  type AsrServerStats,
} from './provider';
export { resolveWhisperServerBinary } from './server';
```

(Keep every existing export line in that file as is. Add these lines to them.)

- [ ] **Step 4: Run the new test and the unchanged provider suite, expect PASS.**

Run (multi-suite → heavy lock): `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh npx jest src/main/providers/local-asr/__tests__/provider-server.test.ts src/main/providers/local-asr/__tests__/provider.test.ts src/main/providers/local-asr/__tests__/active-calls.test.ts`
Expected: PASS, all three files. If `provider.test.ts` fails, the routing default leaked: `makeDeps` there passes no `serverBinaryPath`, so every job must log `reason=no-server-binary` and behave exactly as before. Fix the provider, not that test.

Two sanctioned exceptions, and nothing else:
- `provider.test.ts` and `active-calls.test.ts` run in the repo's default **jsdom** env, and `provider.ts` now imports undici transitively (via `server-request.ts`). No existing jsdom test proves undici loads there; every `net-guard` test is `@jest-environment node`. If either file fails at import time with a missing-global error from undici, add `/** @jest-environment node */` as its first line. Change only the environment, no assertions.
- Every job now emits an `info` `[local-asr] job via=…` line. The existing log assertions (`provider.test.ts:728`, `:832`) filter with `.some(c => c[0] === 'warn' && …)`, so they are unaffected. If some other assertion counts raw `log` calls, filtering it by level `'warn'` is the only allowed change.

- [ ] **Step 5: Lint, typecheck, commit.**

```bash
npx eslint src/main/providers/local-asr/provider.ts src/main/providers/local-asr/index.ts src/main/providers/local-asr/__tests__/provider-server.test.ts
npx tsc --noEmit -p .
git add src/main/providers/local-asr/__tests__/provider-server.test.ts
printf 'feat(local-asr): route interactive meeting hears to a warm whisper-server (#143)\n\nLazy single-flight start, 5-min idle stop disarmed during jobs, CLI\nspawns stop the server first, start failure or two crashes disable it\nfor the session, KIA_ASR_SERVER=0 opt-out, serverStats().\n' > $SCR/opt/msg-wws-7
git commit -F $SCR/opt/msg-wws-7 -- src/main/providers/local-asr/provider.ts src/main/providers/local-asr/index.ts src/main/providers/local-asr/__tests__/provider-server.test.ts
```

---

### Task 8: Wiring — binary path, pid file, `inference:stats`

**Proceeds only on GO from Task 1.**

**Files:**
- Modify: `src/main/providers/index.ts` (the `createLocalAsrProvider({...})` call, ~line 98)
- Modify: `src/shared/ipc.ts:551-557` (`'inference:stats'` res)
- Modify: `src/main/main.ts:752-757` (`'inference:stats'` handler)
- No test fake is typed as `LocalAsrProvider` (only `provider.test.ts` and `active-calls.test.ts` reference it, both through `createLocalAsrProvider`), so adding `serverStats()` to the interface breaks no fake.
- Test: `src/renderer/screens/Settings/__tests__/LocalProcessing.test.tsx` must stay green unchanged. It builds `inference:stats` responses without `asrServer`, which is why the field is optional.

**Interfaces:**
- Consumes: `resolveWhisperServerBinary` (Task 5, exported via local-asr index), `LocalAsrProvider.serverStats()` (Task 7).
- Produces: `Invokes['inference:stats']['res'].asrServer?: { starts: number; lastVia: 'server' | 'cli' | null; disabledReason: string | null }`.

- [ ] **Step 1: `src/main/providers/index.ts`.** Change the import line `import { createLocalAsrProvider } from './local-asr';` to:

```ts
import { createLocalAsrProvider, resolveWhisperServerBinary } from './local-asr';
```

In the `createLocalAsrProvider({ … })` call, add after `binaryPath: resolveWhisperBinary(path.join(opts.assetsDir, 'whisper')),`:

```ts
    // Warm interactive server (#143): darwin only (null elsewhere → never
    // used); its absence on disk just routes every job to whisper-cli.
    serverBinaryPath: resolveWhisperServerBinary(
      path.join(opts.assetsDir, 'whisper'),
    ),
    // dataDir is <userData>/data; the pid file lives at <userData> (spec §2).
    pidFilePath: path.join(path.dirname(opts.dataDir), 'whisper-server.pid'),
```

- [ ] **Step 2: `src/shared/ipc.ts`.** Replace the `'inference:stats'` entry with:

```ts
  /** Vision-pipeline queue counts + the "Recently processed" list, plus the
   *  warm whisper-server's observability counters (#143). */
  'inference:stats': {
    req: void;
    res: {
      processed: number;
      recent: RecentExtraction[];
      /** Optional: absent from builds/mocks that predate #143. */
      asrServer?: {
        starts: number;
        lastVia: 'server' | 'cli' | null;
        disabledReason: string | null;
      };
    };
  };
```

- [ ] **Step 3: `src/main/main.ts`.** Replace the handler body:

```ts
    'inference:stats': async () => {
      // One waiting computation for both surfaces: recompute and push, so
      // opening Settings also refreshes the sidebar row.
      void refreshWaiting();
      return {
        ...(await p.store.extractionStats()),
        asrServer: bundled.localAsr.serverStats(),
      };
    },
```

- [ ] **Step 4: Typecheck and run the affected tests.**

```bash
npx tsc --noEmit -p .
/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh npx jest src/renderer/screens/Settings/__tests__/LocalProcessing.test.tsx src/main/providers/local-asr
```

Expected: tsc clean; both PASS.

- [ ] **Step 5: Lint and commit.**

```bash
npx eslint src/main/providers/index.ts src/shared/ipc.ts src/main/main.ts
printf 'feat(local-asr): wire whisper-server path, pid file and inference:stats asrServer (#143)\n' > $SCR/opt/msg-wws-8
git commit -F $SCR/opt/msg-wws-8 -- src/main/providers/index.ts src/shared/ipc.ts src/main/main.ts
```

---

### Task 9: Parity suite, acceptance, measurement — written by the implementer, RUN by the controller (Task 11)

**Proceeds only on GO from Task 1.** The implementer writes these files and confirms the jest file **skips** without the env. The implementer does NOT run `npm run test:asr-parity`.

**Files:**
- Create: `scripts/test-asr-parity.mjs`
- Create: `src/main/providers/local-asr/__tests__/parity.real.test.ts`
- Modify: `package.json` (`scripts`)

**Interfaces:**
- Consumes: `runWhisperCli`, `WhisperServer`, `transcribeViaServer`, `createLocalAsrProvider` (+ `serverStats`), `WHISPER_LARGE_V3_TURBO_Q5_0`, `modelDir`.
- Produces: `npm run test:asr-parity -- --whisper-dir <dir> [--models-dir <dir>] [--vad <file>] [--measure]`. It sets the env vars `KIA_ASR_PARITY=1`, `KIA_WHISPER_CLI`, `KIA_WHISPER_SERVER`, `KIA_ASR_MODELS_DIR`, `KIA_ASR_VAD`, `KIA_ASR_FIXTURES`, and optionally `KIA_ASR_MEASURE=1`.

Gate design (follows the "environment-dependent skip gates" rule): the **subprocess script** checks every prerequisite (binaries run with `-h`, both are a b5130 build, model/VAD files exist, voices exist) and fails hard. The jest file only switches on `KIA_ASR_PARITY === '1'` (same shape as `folder-scope-corpus-dryrun.test.ts:116`). So a plain `npm test` skips it, and a misconfigured parity run fails instead of skipping. The "fresh CLI run" must be the **b5130 whisper-cli built beside the server** (Task 11). The worktree has no `assets/whisper`, and `~/work/kiagent-core`'s is v1.9.2.

- [ ] **Step 1: Create `scripts/test-asr-parity.mjs`:**

```js
// scripts/test-asr-parity.mjs
// Founder-Mac parity + acceptance run for the warm whisper server (#143,
// spec §4). NOT CI. Every prerequisite is checked HERE, in subprocesses, and
// a missing one is a hard failure — never a skip. Then the single jest file
// runs with KIA_ASR_PARITY=1.
//
//   npm run test:asr-parity -- --whisper-dir <dir with b5130 whisper-cli + whisper-server>
//        [--models-dir <asr models root>] [--vad <silero .bin>] [--measure]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WHISPER_TAG, WHISPER_TAG_STAMP } from './whisper-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = 'src/main/providers/local-asr/__tests__/parity.real.test.ts';

const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);
function fail(msg) {
  console.error(`asr-parity: ${msg}`);
  process.exit(1);
}

if (process.platform !== 'darwin') fail('macOS only (spec "Scope")');
const whisperDir = opt('whisper-dir');
if (!whisperDir) fail('--whisper-dir <dir with whisper-cli and whisper-server> is required');
const cli = path.resolve(whisperDir, 'whisper-cli');
const server = path.resolve(whisperDir, 'whisper-server');
const modelsDir = path.resolve(opt('models-dir', path.join(os.homedir(), 'Library/Application Support/KIAgent-dev/data/models/asr')));
const vad = path.resolve(opt('vad', path.join(os.homedir(), 'work/kiagent-core/assets/whisper/ggml-silero-v5.1.2.bin')));
const turbo = path.join(modelsDir, 'whisper-large-v3-turbo-q5_0', 'ggml-large-v3-turbo-q5_0.bin');

for (const bin of [cli, server]) {
  const r = spawnSync(bin, ['-h'], { stdio: 'ignore' });
  if (r.error || r.status !== 0) fail(`${bin} does not run (-h): ${r.error?.message ?? `exit ${r.status}`}`);
}
const stampPath = path.join(whisperDir, WHISPER_TAG_STAMP);
if (!existsSync(stampPath) || readFileSync(stampPath, 'utf8').split('\n')[0] !== WHISPER_TAG) {
  fail(`${whisperDir} is not a ${WHISPER_TAG} build (missing or stale ${WHISPER_TAG_STAMP})`);
}
for (const f of [turbo, vad]) if (!existsSync(f)) fail(`missing ${f}`);

// ── fixtures: synthesized speech, nothing private ─────────────────────────
const EN_TEXT = 'The quarterly budget review is scheduled for Thursday afternoon. Please bring the updated revenue forecast and the hiring plan for the engineering team.';
const DE_TEXT = 'Die Besprechung beginnt morgen um zehn Uhr. Bitte bringen Sie die aktuellen Zahlen und den Projektplan für das nächste Quartal mit.';
const fx = mkdtempSync(path.join(os.tmpdir(), 'asr-parity-fx-'));
function say(voice, text, out) {
  const aiff = `${out}.aiff`;
  let r = spawnSync('say', ['-v', voice, '-o', aiff, text]);
  if (r.status !== 0) fail(`say -v ${voice} failed — install the voice (System Settings > Accessibility > Spoken Content)`);
  r = spawnSync('afconvert', [aiff, out, '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1']);
  if (r.status !== 0) fail(`afconvert failed for ${out}`);
}
say('Samantha', EN_TEXT, path.join(fx, 'en.wav'));
say('Anna', DE_TEXT, path.join(fx, 'de.wav'));

function pcmOf(file) {
  const b = readFileSync(file);
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'data') return b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  return fail(`${file}: no data chunk`);
}
function wavOf(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
// A 10-minute meeting-shaped segment (speech + long silences), 19.2 MB: the
// real per-request body size, and long enough to exercise "no timeouts".
const en = pcmOf(path.join(fx, 'en.wav'));
const de = pcmOf(path.join(fx, 'de.wav'));
const gap = Buffer.alloc(20 * 16000 * 2);
const parts = [];
let bytes = 0;
const target = 600 * 16000 * 2;
while (bytes < target) {
  for (const p of [en, gap, de, gap]) { parts.push(p); bytes += p.length; }
}
writeFileSync(path.join(fx, 'long.wav'), wavOf(Buffer.concat(parts).subarray(0, target)));

const env = {
  ...process.env,
  KIA_ASR_PARITY: '1',
  KIA_WHISPER_CLI: cli,
  KIA_WHISPER_SERVER: server,
  KIA_ASR_MODELS_DIR: modelsDir,
  KIA_ASR_VAD: vad,
  KIA_ASR_FIXTURES: fx,
  ...(flag('measure') ? { KIA_ASR_MEASURE: '1' } : {}),
};
const r = spawnSync('npx', ['jest', TEST_FILE, '--runInBand', '--forceExit', '--testTimeout=3600000'], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
```

- [ ] **Step 2: Create `src/main/providers/local-asr/__tests__/parity.real.test.ts`:**

```ts
/** @jest-environment node */
/**
 * Founder-Mac parity + acceptance for the warm whisper server (#143, spec §4).
 * Run ONLY via `npm run test:asr-parity -- --whisper-dir <b5130 build>`;
 * scripts/test-asr-parity.mjs checks every prerequisite in a subprocess and
 * generates the fixtures. Without KIA_ASR_PARITY=1 this file is skipped
 * (it is not CI).
 */
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Prefs } from '@shared/contracts';

import { Blob } from 'node:buffer';

import { FormData, fetch } from 'undici';

import { modelDir } from '../../local-llm/models';
import { WHISPER_LARGE_V3_TURBO_Q5_0 } from '../models';
import { createLocalAsrProvider } from '../provider';
import { WhisperServer } from '../server';
import { transcribeViaServer } from '../server-request';
import { runWhisperCli } from '../whisper-cli';

const ON = process.env.KIA_ASR_PARITY === '1';
const MEASURE = ON && process.env.KIA_ASR_MEASURE === '1';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set — run via npm run test:asr-parity`);
  return v;
};

function wavOf(pcm: Buffer): Uint8Array {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return new Uint8Array(Buffer.concat([h, pcm]));
}
const SILENCE_10S = wavOf(Buffer.alloc(10 * 16000 * 2));
const CORRUPT = new Uint8Array(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4096, 0x5a)]));

type Outcome = { text: string } | { error: string; status: number | undefined };
async function settle(p: Promise<string>): Promise<Outcome> {
  try {
    return { text: await p };
  } catch (e) {
    return { error: (e as Error).name, status: (e as { status?: number }).status };
  }
}

function fakePrefs(): Prefs {
  const current = {
    theme: 'system',
    logLevel: 'info',
    launchAtLogin: false,
    showInMenuBar: false,
    processing: { enabled: true, window: 'always' },
    models: { override: 'auto', autoInstall: false },
  } as any;
  return { get: () => current, patch: async () => {}, onChange: () => () => {} };
}

const fixture = async (name: string): Promise<Uint8Array> =>
  new Uint8Array(await fsp.readFile(path.join(env('KIA_ASR_FIXTURES'), name)));

const turboPath = (): string =>
  path.join(
    modelDir(env('KIA_ASR_MODELS_DIR'), WHISPER_LARGE_V3_TURBO_Q5_0.id),
    WHISPER_LARGE_V3_TURBO_Q5_0.files[0].name,
  );

(ON ? describe : describe.skip)('warm whisper server parity (real b5130 binaries)', () => {
  let server: WhisperServer;
  let tmp: string;

  beforeAll(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'asr-parity-run-'));
    server = new WhisperServer({
      binaryPath: env('KIA_WHISPER_SERVER'),
      modelPath: turboPath(),
      vadModelPath: env('KIA_ASR_VAD'),
      log: () => {},
    });
    await server.start(); // ONE server for the whole suite
  });

  afterAll(async () => {
    await server?.stop();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  const cases: Array<{
    name: string;
    audio: () => Promise<Uint8Array>;
    language?: string;
    kind: 'empty' | 'speech' | 'rejected';
  }> = [
    { name: '1-silence', audio: async () => SILENCE_10S, language: 'en', kind: 'empty' },
    { name: '2-corrupt', audio: async () => CORRUPT, language: 'en', kind: 'rejected' },
    { name: '3-english', audio: () => fixture('en.wav'), language: 'en', kind: 'speech' },
    { name: '4-german-fixed', audio: () => fixture('de.wav'), language: 'de', kind: 'speech' },
    { name: '5-silence', audio: async () => SILENCE_10S, language: 'en', kind: 'empty' },
    { name: '6-english-auto', audio: () => fixture('en.wav'), kind: 'speech' },
    { name: '7-german-auto', audio: () => fixture('de.wav'), kind: 'speech' },
  ];

  it('seven goldens, in order, on ONE server process, byte-for-byte vs a fresh CLI run', async () => {
    const pid = server.pid();
    for (const c of cases) {
      // eslint-disable-next-line no-await-in-loop
      const audio = await c.audio();
      const file = path.join(tmp, `${c.name}.wav`);
      // eslint-disable-next-line no-await-in-loop
      await fsp.writeFile(file, audio);
      // eslint-disable-next-line no-await-in-loop
      const viaCli = await settle(
        runWhisperCli({
          binaryPath: env('KIA_WHISPER_CLI'),
          modelPath: turboPath(),
          inputPath: file,
          timestamps: true,
          language: c.language,
          vadModelPath: env('KIA_ASR_VAD'),
          priority: 'interactive',
        }),
      );
      // eslint-disable-next-line no-await-in-loop
      const viaServer = await settle(
        transcribeViaServer({
          baseUrl: server.baseUrl(),
          audio,
          language: c.language ?? 'auto',
          signal: new AbortController().signal,
        }),
      );
      if (c.kind === 'rejected') {
        expect({ case: c.name, out: viaServer }).toEqual({
          case: c.name,
          out: { error: 'AsrInputRejectedError', status: 400 },
        });
        expect({ case: c.name, out: viaCli }).toEqual({
          case: c.name,
          out: { error: 'AsrInputRejectedError', status: 400 },
        });
      } else {
        expect({ case: c.name, out: viaServer }).toEqual({ case: c.name, out: viaCli });
        if (c.kind === 'empty') expect(viaServer).toEqual({ text: '' });
        else expect((viaServer as { text: string }).text).toMatch(/^\n\[\d{2}:\d{2}:\d{2}\.\d{3} --> /);
      }
    }
    expect(server.pid()).toBe(pid);
  });

  it('only the secret prefix reaches the server: wrong/missing prefix cannot /load or kill it', async () => {
    const pid = server.pid();
    const { origin } = new URL(server.baseUrl());
    const loadForm = () => {
      const f = new FormData();
      f.append('model', '/etc/hosts'); // exists, not a model: an authorised /load would exit(1)
      return f;
    };
    for (const prefix of ['', '/wrong-prefix', '/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']) {
      // eslint-disable-next-line no-await-in-loop
      const load = await fetch(`${origin}${prefix}/load`, { method: 'POST', body: loadForm() });
      expect({ prefix, route: 'load', status: load.status }).toEqual({ prefix, route: 'load', status: 404 });
      // eslint-disable-next-line no-await-in-loop
      const health = await fetch(`${origin}${prefix}/health`);
      expect({ prefix, route: 'health', status: health.status }).toEqual({ prefix, route: 'health', status: 404 });
      const inf = new FormData();
      inf.append('file', new Blob([new Uint8Array(SILENCE_10S)]), 'a.wav');
      // eslint-disable-next-line no-await-in-loop
      const inference = await fetch(`${origin}${prefix}/inference`, { method: 'POST', body: inf });
      expect({ prefix, route: 'inference', status: inference.status }).toEqual({ prefix, route: 'inference', status: 404 });
    }
    // Still the same live process, and authorised requests still work.
    expect(server.pid()).toBe(pid);
    expect((await fetch(`${server.baseUrl()}/health`)).status).toBe(200);
    expect(
      await settle(
        transcribeViaServer({
          baseUrl: server.baseUrl(),
          audio: SILENCE_10S,
          language: 'en',
          signal: new AbortController().signal,
        }),
      ),
    ).toEqual({ text: '' });
  });

  it('an abort mid-processing reaches the server, frees it within ~1 s of the abort, and the model stays warm', async () => {
    const pid = server.pid();
    // Markers are stderr lines (unbuffered on a pipe), server.cpp:911 / 1003.
    let processing = false;
    let serverSawAbort = false;
    server.onOutput((chunk) => {
      if (chunk.includes("processing 'audio.wav'")) processing = true;
      if (chunk.includes('client disconnected, aborted processing')) serverSawAbort = true;
    });
    const ac = new AbortController();
    let settled = false;
    const pending = transcribeViaServer({
      baseUrl: server.baseUrl(),
      audio: await fixture('long.wav'),
      language: 'en',
      signal: ac.signal,
    }).then(
      (text) => ({ text }),
      (err: Error) => ({ err }),
    ).finally(() => {
      settled = true;
    });
    // 1. Processing has started on the server…
    const deadline = Date.now() + 30_000;
    while (!processing && !settled && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(processing).toBe(true);
    // 2. …and is still running a second later (long.wav takes far longer).
    await new Promise((r) => setTimeout(r, 1000));
    expect(settled).toBe(false);
    // 3. Abort, and time recovery from THIS instant.
    const tAbort = Date.now();
    ac.abort();
    const outcome = await pending;
    expect('err' in outcome).toBe(true);
    const err = (outcome as { err: Error & { cause?: { name?: string } } }).err;
    expect(err.message).toMatch(/^whisper-server request failed: /);
    expect(err.cause?.name).toBe('AbortError');
    const next = await settle(
      transcribeViaServer({
        baseUrl: server.baseUrl(),
        audio: SILENCE_10S,
        language: 'en',
        signal: new AbortController().signal,
      }),
    );
    const recoveryMs = Date.now() - tAbort;
    // eslint-disable-next-line no-console
    console.log(`[asr-parity] abort → next request done in ${recoveryMs} ms`);
    expect(serverSawAbort).toBe(true); // whisper's abort_callback fired: 499 path
    expect(next).toEqual({ text: '' });
    expect(recoveryMs).toBeLessThan(2000);
    expect(server.pid()).toBe(pid);
  });
});

(ON ? describe : describe.skip)('provider acceptance (real binaries, spec §4)', () => {
  it('six consecutive interactive meeting hears: six transcripts, via=server x6, one start, zero CLI', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'asr-accept-'));
    const logs: string[] = [];
    const provider = createLocalAsrProvider({
      binaryPath: env('KIA_WHISPER_CLI'),
      serverBinaryPath: env('KIA_WHISPER_SERVER'),
      vadModelPath: env('KIA_ASR_VAD'),
      asrModelsDir: env('KIA_ASR_MODELS_DIR'),
      pidFilePath: path.join(tmp, 'whisper-server.pid'),
      prefs: fakePrefs(),
      log: (_l, m) => logs.push(m),
    });
    try {
      const en = await fixture('en.wav');
      const de = await fixture('de.wav');
      const long = await fixture('long.wav');
      const calls: Array<[Uint8Array, string | undefined]> = [
        [en, 'en'],
        [de, 'de'],
        [long, 'en'],
        [en, undefined],
        [de, undefined],
        [long, undefined],
      ];
      for (const [audio, language] of calls) {
        // eslint-disable-next-line no-await-in-loop
        const out = await provider.handle({
          kind: 'hear',
          payload: { audio, format: 'wav', timestamps: true, vad: 'required', ...(language ? { language } : {}) },
        } as never);
        expect(out).toMatch(/^\n\[\d{2}:\d{2}:\d{2}\.\d{3} --> /);
      }
      expect(logs.filter((m) => m.startsWith('[local-asr] job via=server'))).toHaveLength(6);
      expect(logs.filter((m) => m.startsWith('[local-asr] job via=cli'))).toHaveLength(0);
      expect(logs.filter((m) => m.startsWith('[local-asr] server start model='))).toHaveLength(1);
      expect(provider.serverStats()).toEqual({ starts: 1, lastVia: 'server', disabledReason: null });
    } finally {
      await provider.dispose();
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});

/** Sum of RSS of the processes whose `comm` is one of `bins` (macOS prints
 *  the full path). Sampled every 250 ms; returns the peak in MB. */
function startRssSampler(bins: string[]) {
  let peakKb = 0;
  const t = setInterval(() => {
    try {
      const out = execFileSync('ps', ['-axo', 'rss=,comm='], { encoding: 'utf8' });
      let sum = 0;
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (m && bins.includes(m[2].trim())) sum += Number(m[1]);
      }
      peakKb = Math.max(peakKb, sum);
    } catch {
      /* one missed sample */
    }
  }, 250);
  return { stop: () => (clearInterval(t), Math.round(peakKb / 1024)) };
}

(MEASURE ? describe : describe.skip)('Goal 5 measurement: 3 segments x 2 channels of 10 min', () => {
  it.each([
    ['before (cli)', { KIA_ASR_SERVER: '0' }],
    ['after (server)', {}],
  ])('%s', async (label, extraEnv) => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'asr-measure-'));
    const logs: string[] = [];
    const provider = createLocalAsrProvider({
      binaryPath: env('KIA_WHISPER_CLI'),
      serverBinaryPath: env('KIA_WHISPER_SERVER'),
      vadModelPath: env('KIA_ASR_VAD'),
      asrModelsDir: env('KIA_ASR_MODELS_DIR'),
      pidFilePath: path.join(tmp, 'whisper-server.pid'),
      prefs: fakePrefs(),
      env: { ...process.env, ...extraEnv },
      log: (_l, m) => logs.push(m),
    });
    const sampler = startRssSampler([env('KIA_WHISPER_CLI'), env('KIA_WHISPER_SERVER')]);
    const long = await fixture('long.wav');
    const t0 = Date.now();
    try {
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await provider.handle({
          kind: 'hear',
          payload: { audio: long, format: 'wav', timestamps: true, vad: 'required', language: 'en' },
        } as never);
      }
    } finally {
      const wallMs = Date.now() - t0;
      const peakRssMb = sampler.stop();
      const cliLoads = logs.filter((m) => m.startsWith('[local-asr] job via=cli')).length;
      const modelLoads = cliLoads + provider.serverStats().starts;
      // eslint-disable-next-line no-console
      console.log(`[asr-measure] ${JSON.stringify({ label, wallMs, modelLoads, peakRssMb })}`);
      await provider.dispose();
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Add the npm script.** In `package.json` `"scripts"`, after `"test": "jest",` add:

```json
    "test:asr-parity": "node scripts/test-asr-parity.mjs",
```

- [ ] **Step 4: Confirm the jest file SKIPS without the env** (no binaries touched):

Run: `npx jest src/main/providers/local-asr/__tests__/parity.real.test.ts`
Expected: all 6 tests skipped (goldens, request-path, abort, acceptance, 2 × measure), exit 0.

Run: `node --check scripts/test-asr-parity.mjs`
Expected: exit 0.

- [ ] **Step 5: Lint, typecheck, commit.**

```bash
npx eslint src/main/providers/local-asr/__tests__/parity.real.test.ts
npx tsc --noEmit -p .
git add scripts/test-asr-parity.mjs src/main/providers/local-asr/__tests__/parity.real.test.ts
printf 'test(local-asr): founder-Mac parity, acceptance and measurement suite (#143)\n\nnpm run test:asr-parity; not CI. Prerequisites are checked in the\nrunner subprocess and fail hard; the jest file skips without\nKIA_ASR_PARITY=1.\n' > $SCR/opt/msg-wws-9
git commit -F $SCR/opt/msg-wws-9 -- scripts/test-asr-parity.mjs src/main/providers/local-asr/__tests__/parity.real.test.ts package.json
```

---

### Task 10: Gates + spec status (implementer)

**Proceeds only on GO from Task 1.**

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-warm-whisper-server-design.md` (status line)

- [ ] **Step 1: Lint every changed file.**

```bash
cd ~/work/kcore-asr
git diff --name-only c8d91864 -- '*.ts' '*.tsx' | xargs npx eslint
```

Expected: no errors. Fix any findings in the owning file and commit them with that file's message style.

- [ ] **Step 2: Typecheck.** `npx tsc --noEmit -p .` → clean.

- [ ] **Step 3: Targeted suites (direct, sequential):**

```bash
/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh npx jest src/main/providers/local-asr src/__tests__/whisper-vendor-current.test.ts src/__tests__/whisper-slug-contract.test.ts src/renderer/screens/Settings/__tests__/LocalProcessing.test.tsx
```

Expected: all PASS; `parity.real.test.ts` skipped.

- [ ] **Step 4: Full suite via the heavy lock (alone, nothing else running):**

```bash
/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh npx jest --json --outputFile=$SCR/opt/jest-wws.json
node -e "const r=require('$SCR/opt/jest-wws.json');console.log(r.testResults.filter(t=>t.status==='failed').map(t=>t.name.replace(/^.*\/src\//,'src/')).join('\n')||'NO FAILED SUITES')"
```

Every failing suite under `src/main/providers/`, `src/shared/`, `src/renderer/screens/Settings/`, or `src/__tests__/whisper-*` must be fixed. Other failing suites must be recorded in the PR body with their first error line. `task8-real-core-adoption` is a known pre-existing red.

- [ ] **Step 5: Spec status.** Change the status line

`Status: APPROVED rev 4 (2026-10-09). Astra r4 and fable r3 SATISFIED.`

to

`Status: IMPLEMENTED (local, opt/asr; plan 2026-10-09-warm-whisper-server.md; founder-Mac parity + acceptance OWED) — was APPROVED rev 4 (2026-10-09). Astra r4 and fable r3 SATISFIED.`

```bash
printf 'docs(spec): warm whisper server implemented, parity owed (#143)\n' > $SCR/opt/msg-wws-10
git commit -F $SCR/opt/msg-wws-10 -- docs/superpowers/specs/2026-10-09-warm-whisper-server-design.md
```

---

### Task 11: Build, parity, acceptance, measurement — CONTROLLER, founder Mac

**This is a manual controller step. Implementer subagents do not run it. It requires Task 1 = GO and Tasks 2–10 done.** Run each heavy step alone (docker/mac builds, smokes, other jest runs: none in parallel).

- [ ] **Step 1: Build b5130 `whisper-cli` + `whisper-server` into the scratchpad** (never into a shared checkout):

```bash
SCR=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad
cd ~/work/kcore-asr
KIA_WHISPER_OUT_DIR=$SCR/opt/whisper-out $SCR/opt/heavy.sh node scripts/build-whisper.mjs
ls -la $SCR/opt/whisper-out/assets/whisper/darwin-arm64/
cat $SCR/opt/whisper-out/assets/whisper/darwin-arm64/.whisper-tag
```

Expected: `whisper-cli`, `whisper-server`, and `.whisper-tag` = `b5130` / `927cfce3…`, with both arch gates passing and the arm64 smoke OK. Re-run the same command: it must print `… already built for both darwin arches (b5130)` (idempotency).

- [ ] **Step 2: Parity suite + provider acceptance.**

```bash
$SCR/opt/heavy.sh npm run test:asr-parity -- --whisper-dir $SCR/opt/whisper-out/assets/whisper/darwin-arm64 2>&1 | tee $SCR/opt/asr-parity.txt
```

Expected: the seven goldens PASS byte-for-byte on one server process, the request-path check PASSES (wrong/missing prefix → 404 on `/load`, `/health`, `/inference`; same pid; authorised requests work), the abort test PASSES (record the logged `abort → next request done in N ms`), and acceptance PASSES (6 transcripts, `via=server` ×6, one start, zero CLI).

If a golden differs, do NOT loosen the comparison. Record the diff in the PR and take it back to the field table (Task 2). The spec says parity "confirms rather than discovers". If the abort test fails at ≥ 2000 ms, record the number. The only sanctioned client-side change is `pipelining: 0` in `SERVER_AGENT_OPTIONS` (per-request connection close). Re-test after making it, and amend the spec §3 dispatcher line in the same commit.

- [ ] **Step 3: Goal 5 measurement (before/after).**

```bash
$SCR/opt/heavy.sh npm run test:asr-parity -- --whisper-dir $SCR/opt/whisper-out/assets/whisper/darwin-arm64 --measure 2>&1 | grep '\[asr-measure\]' | tee $SCR/opt/asr-measure.txt
```

Two JSON lines: `before (cli)` (expect `modelLoads: 6`) and `after (server)` (expect `modelLoads: 1`), each with `wallMs` and `peakRssMb`.

- [ ] **Step 4: Record results.** Append to the spec, after `### 3b`:

```markdown
### 3c. Results (founder Mac, <date>, <Mac model>, <RAM>)

- Step 0 (whisper-cli <version>, 1 s silence, VAD on, median of 5): turbo <x> s, small <y> s → GO.
- Parity: 7/7 goldens byte-identical on one server process; post-abort request <n> ms.
- Acceptance: 6/6 via=server, 1 start, 0 CLI.
- 3 × 2 × 10-min segments: before <wallMs> ms / <loads> loads / peak <rss> MB;
  after <wallMs> ms / <loads> loads / peak <rss> MB.
```

Commit it:

```bash
printf 'docs(spec): warm whisper server parity and measurement results (#143)\n' > $SCR/opt/msg-wws-11
git -C ~/work/kcore-asr commit -F $SCR/opt/msg-wws-11 -- docs/superpowers/specs/2026-10-09-warm-whisper-server-design.md
```

Then post the same block as a comment on #143. Also file the deferred follow-ups as issues: (a) Windows eligibility + measurement (spec "Scope"); (b) nothing else; `/load` is protected by the request-path secret in this change.

---

## Self-review (writing-plans checklist)

**Spec coverage.** Step 0 → Task 1. §1 routing (darwin, weak, interactive, default tier, wav/timestamps/VAD, auto) → Task 6 + Task 7 wiring. Detect, background, VAD-off and accuracy on the CLI → Task 6 reasons + Task 7 tests. §2 start, no `-t`, VAD fail-closed → Task 5. Readiness poll at 500 ms with a 60 s timeout, connection error = not ready → Task 5. Start failure disables for the session and logs once → Task 7. Lazy crash respawn, two crashes disable → Task 7. Idle stop at 5 min, disarmed during start and job, serialised with ensureServer → Task 7. Overlap policy, stop right before the CLI spawn after the hold-off → Task 7. Stop SIGTERM→SIGKILL 3 s → Task 5. dispose order → Task 7 (main.ts order unchanged). Orphans via pid file + `ps -o comm=` → Task 5 + Task 7 `reaped`. Log lines → Task 7. §3 dispatcher, abort, pinned request, field diff → Tasks 2 and 4. `formatCliLines` framing → Task 4. Status→error map → Task 4. §4 unit list → Tasks 4–7. Parity suite (one server, 7 goldens in order, corrupt by class+status, founder Mac, subprocess gate, not CI) → Task 9 + Task 11. Acceptance → Task 9 + Task 11. `inference:stats asrServer` → Task 8. §5 vendoring (both binaries, lipo, `-h`, stamp requires both, upgrade test, packaging unchanged, `fetch-whisper-cli.mjs` unchanged) → Task 3. Rollout `KIA_ASR_SERVER=0` → Tasks 6–7. Goal 5 measurement → Task 9 + Task 11.

**Placeholder scan.** No TBD/TODO. Every code step shows the code. Task 11's results block has `<…>` slots that the controller fills with measured numbers. That is intended, not a placeholder.

**Type consistency.** `WhisperServerLike` (start/stop/baseUrl/pid/onExit) is used the same way in Tasks 5, 7 and 9. `transcribeViaServer({baseUrl, audio, language, signal})` is used the same way in Tasks 4, 7 and 9. `routeJob` input fields match their use in Task 7. `serverStats()` is `AsrServerStats`, which matches the optional `asrServer` shape in ipc.ts. `resolveWhisperServerBinary(dir, platform?, arch?)` is used the same way in Tasks 5 and 8. `whisperVendorIsCurrent` / `WHISPER_DARWIN_BINARIES` / `WHISPER_TAG_STAMP` are used the same way in Tasks 3 and 9.

**Request path (astra r1 #1).** Secret prefix per child → Task 5 (args, generator, baseUrl, never logged) + Task 2 spec text + Task 9/11 real-binary check (wrong/missing prefix cannot `/load`, `/health`, `/inference`; server survives; authorised works).

**Review Focus.** Five items, each pinned by a test in its owning task: dispose during start (Task 7), recycled pid (Task 5), non-darwin with weak=false (Task 6), exit before healthy (Tasks 5 and 7), empty cue / 3-digit hours (Task 4).
