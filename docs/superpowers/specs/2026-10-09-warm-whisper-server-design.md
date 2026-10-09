# Warm whisper server for interactive transcription (#143)

Status: APPROVED rev 4 (2026-10-09). Astra r4 and fable r3 SATISFIED.

- **Issue:** kiagent-core #143. Tracking: #138.
- **Base:** core v0.106.0.
- **Pinned whisper.cpp:** `WHISPER_TAG = b5130`, commit 927cfce3.

## Problem

Every `hear` call spawns a fresh `whisper-cli`, which loads the model from
disk and initialises Metal before transcribing. Meetings are transcribed
after they stop, in 10-minute segments, with one call per channel per
segment:

| Meeting type | Calls |
|---|---|
| Plain 30-minute meeting | 6 |
| Diarized meeting | up to 12 per segment |
| Accuracy retries | additional calls |

The per-call load cost has not been measured. On Apple Silicon with
large-v3-turbo-q5_0 (574 MB) it is expected to be 0.5–2 s.

## Scope: macOS only

This issue targets Apple Silicon and Intel Macs. Windows and Linux are out of
scope.

- **Why:** on Windows and Linux, `hostBudget(host, null)` marks every host
  weak, because ASR there runs on the CPU. Those hosts only get the small and
  base tiers, which load cheaply. Windows vendoring, packaging and VM work
  would buy little.
- **If wanted later:** Windows needs its own eligibility rule and a
  measurement. Record that as a follow-up issue.
- **What core does off darwin:** `resolveWhisperServerBinary()` returns
  "absent", and behaviour is unchanged.

## Step 0: measure the premise (go/no-go)

The plan's first task is a five-repetition probe, recorded in the PR:

- Run `whisper-cli -m large-v3-turbo-q5_0` on a 1 s WAV on the founder Mac
  to measure the fixed cost of loading plus init.
- Run the same on small-q5_1.

Decision rule:

- **Below 0.5 s per load on turbo:** stop here. Close #143 with the number,
  because the saving is under 3 s per plain meeting.
- **0.5 s or more:** build the rest of this spec.

## Goals

1. Interactive meeting transcription on eligible Macs loads the default model
   once per warm period, instead of once per call.
2. Output is byte-identical to the CLI for every request shape the server
   serves.
3. Background work stays demotable and preemptable exactly as today (#145).
4. Weak hosts and non-darwin hosts behave exactly as today.
5. Measured before and after: wall time of a 30-minute two-channel meeting
   transcription, model loads, and peak RSS.

## Design

### 1. Routing

The provider keeps its single-flight FIFO queue, interactive-first insertion
and background abort. A job runs on the **warm server** only if all of these
hold:

- the platform is darwin and the host is not weak
  (`hostBudget(host, null).weak === false`);
- the class is `interactive` and the model is the default tier, not
  `accuracy`;
- the shape is `{format: wav, timestamps: true, vad: on}`, with `language`
  either fixed or `auto`.
  - With `auto`, the server takes the CLI's `-l auto` path:
    `whisper_full_with_state` detects on this call's own mel and overwrites
    `state->lang_id`, so nothing carries over between requests.
  - This matters because `auto` is the meetings default whenever
    `probeLanguage` returns null. Short or one-sided meetings are exactly
    that case, and excluding `auto` would make the feature inert for them.
- the server binary and the VAD model file are present;
- the server is not disabled for this session (§2), and `KIA_ASR_SERVER` is
  not `0`.

Everything else uses whisper-cli, as today:

- background indexing;
- the accuracy tier;
- detect-language probes;
- `timestamps: false`;
- **VAD off.** In b5130, `whisper_full()` skips `whisper_vad()` when VAD is
  disabled, so the previous request's `vad_mapping_table` and
  `has_vad_segments` survive. The timestamp getters would then map a VAD-off
  transcript through the previous recording's table. Every server request is
  therefore VAD-on, and VAD-on requests always rebuild that state;
- every non-eligible host.

**Why detect stays on the CLI:**

- The server's `json` format returns no language probability, and the
  meetings lock needs `p >= LANGUAGE_LOCK_MIN_P`.
- `verbose_json` probability comes from a second pass over whatever mel the
  shared state holds. On a VAD-silent input that mel is stale, so the result
  can carry over from the previous request.
- Both formats return full language names, not codes.

Detect probes cost at most 4 loads per run (`probeLanguage`), and only when no language is set.

**Why background stays on the CLI:** priority is process-wide. A shared
server can't be demoted per request, and #145's demotion and preemption
semantics depend on demotion. A single server with per-request `taskpolicy`
demotion was considered and rejected, because it changes #145's tested
behaviour and keeps hours-long indexing audio resident.

### 2. `WhisperServer` lifecycle

New `src/main/providers/local-asr/server.ts`, modelled on
`local-llm/server.ts`.

**Start.** It picks a free port on `127.0.0.1` and spawns:

```
whisper-server -m <default model> -t 4 -vm <silero> --host 127.0.0.1 --port N
```

`-t` uses the same thread count the CLI's interactive path computes for this host (`min(4, cores)`), not a literal 4. The server refuses to start if the
VAD file is missing, which matches `requireVadModel`'s fail-closed stance.

**Readiness.** It polls `GET /health` every 500 ms until it gets 200. The
server loads the model *before* binding, so connection errors mean "not
ready", as `LlamaServer.defaultHealth` treats them. No test asserts a 503.
The startup timeout is 60 s.

**Start failure.** The server is **disabled for the session**:

- log once: `[local-asr] server disabled: <err>`;
- all jobs go to the CLI;
- the disable clears only on the next app start.

This prevents every segment from paying the startup timeout.

**Crash.** The next eligible job respawns it lazily through a single-flight
`ensureServer()`. There is no background respawn loop. Two crashes in one
session disable the server for that session.

**Idle stop.** The server stops after `IDLE_STOP_MS = 5 min` with no job.

- The timer is **disarmed while a start is in progress or a job is running**,
  and re-armed after the job settles. A job therefore never has a deadline:
  a 20-minute request is fine.
- Stopping is serialised with `ensureServer()`. A job arriving during an idle
  stop waits for the stop to finish, then starts the server again.

**Overlap policy: at most one whisper model resident.** A CLI job calls
`stopServer()` **immediately before `runCli()` spawns the child**, after the
90 s hold-off check and any other early rejection. Meetings await each
segment before enqueueing the next, so a background job often runs (and is
rejected by the hold-off) between segments. That rejection must not stop the
warm server. Examples of a CLI job that does spawn are background indexing
and an accuracy retry.

- The cost is that with accuracy retry on, the next segment reloads the
  server, one extra load per segment, only for those users.
- Peak RSS is part of the measurement.

**Stop.** SIGTERM, then SIGKILL after 3 s, and await exit. `dispose()` on
before-quit awaits a pending start, then stops the server, in the existing
order after `localLlm.dispose()`.

**Orphans.** A pid file (`<userData>/whisper-server.pid`) records the pid and
the binary path. At provider start, if that pid is alive and
`ps -o comm= -p <pid>` names our binary, the process is killed. llama-server
has the same orphan risk today; that is noted and left as is.

**Logs.** Server stdout/stderr is forwarded at `debug`. Two `info` lines
record what happens:

- `[local-asr] server start model=<slug> ms=<n>`
- `[local-asr] job via=server|cli reason=<rule> ms=<n>`

### 3. Requests: a pinned contract, not discovered parity

**Client.** HTTP goes through an undici dispatcher with no client timeout:

```ts
new Agent({ headersTimeout: 0, bodyTimeout: 0 })
```

Node's default 300 s headers timeout would fail long transcriptions, because
the server sends headers only after compute finishes. Abort is via signal
only, the same as the CLI.

**Abort.** Aborting the `fetch` closes the socket. b5130's `abort_callback`
checks `is_connection_closed()` before each encoder/decoder run and returns
499. The server stays up and the warm model is kept. The parity task checks
this empirically: the abort reaches the server within about 1 s
(`Connection: close` per request if needed).

**Request.** Every request sends the constant `WHISPER_SERVER_REQUEST`,
versioned like `WHISPER_VAD_PARAMS`:

| Field | Value |
|---|---|
| `language` | always set (a code, or `auto`) |
| `response_format` | `vtt` |
| `no_timestamps` | false |
| `beam_size` | 5 |
| `best_of` | 5 |
| `temperature` | 0 |
| `temperature_inc` | 0.2 |
| `entropy_thold` | 2.4 |
| `logprob_thold` | -1 |
| `no_speech_thold` | 0.6 |
| `vad` | always true, plus the five `WHISPER_VAD_PARAMS` |

The values are the CLI's effective parameters. The server's own defaults
differ: greedy decoding, `best_of = 2`, and `language = en`.

`vtt` keeps token timestamps off, so segments are not wrapped at 60
characters, and it uses the same `HH:MM:SS.mmm` formatting as the CLI.

The plan's first build task produces a **field-by-field diff** of `cli.cpp`
`whisper_params` / `wparams` against `server.cpp` and records it in this
spec. The parity test then confirms the result rather than discovering it.

**Output.** `formatCliLines(vtt)` converts cues into exactly the CLI's lines:

```
[HH:MM:SS.mmm --> HH:MM:SS.mmm]  text
```

That is two spaces after `]`, with whisper's leading space kept. The output
also matches the CLI's framing: one leading `\n` before the first segment
line, and an empty string when VAD leaves zero segments. The golden strings
pin both. The meetings parser is unchanged.

**Errors** are keyed on HTTP status, never on body text (httplib rewrites
bodies):

| Status | Result |
|---|---|
| 400 | `AsrInputRejectedError` (status 400) |
| anything else (500, 503, 499, connection error) | plain `Error`, so the caller defers |

### 4. Parity and acceptance tests

**Unit tests (no binary):**

- routing reasons;
- `ensureServer` single-flight;
- the idle timer is disarmed during a job (a 6-minute fake job survives);
- a stop racing with a new job;
- start failure disables the server for the session, and a second crash does
  the same;
- a CLI job stops the server right before spawning;
- a hold-off-rejected background job leaves the server up and does not
  re-arm the idle timer early;
- abort cancels the `fetch` without stopping the server;
- pid reaping only on a matching `comm`;
- `dispose` ordering;
- `formatCliLines` golden strings;
- the status-to-error mapping;
- the dispatcher has no timeouts.

**Parity suite (real binaries).** It uses the **production default model
for the founder Mac** (large-v3-turbo-q5_0) and VAD on.

- **One server start for the whole suite.** The goldens run against that
  single process in a fixed order, so shared `whisper_state` leakage would
  show:
  1. silence;
  2. corrupt;
  3. English;
  4. German (fixed language);
  5. silence;
  6. English with `language=auto`;
  7. German with `language=auto`.
- Each output is compared byte-for-byte with a fresh CLI run of the same
  request. The corrupt golden compares the error class and status instead.
- It runs on the founder Mac via a documented command,
  `npm run test:asr-parity`.
- It is gated by a subprocess skip check on binaries and model presence.
- It is not CI.

**Routing.** A VAD-off job routes to the CLI, with a unit test for it.

**Provider acceptance (same command).** Six consecutive interactive `hear`
calls with the real meetings options must show the following. Three use a
fixed language and three use `auto`:

- six successful transcripts;
- `via=server` six times;
- one server start;
- zero CLI fallbacks.

**Observability instead of a packaged gate.** The smoke harness can reach
only renderer IPC, and there is no `hear` channel. So the packaged smoke is
**not** a gate for this feature, and the founder-Mac acceptance above is the
live check. `inference:stats` gains `asrServer: {starts, lastVia,
disabledReason}`, so a packaged or dev app can be inspected after a real
meeting.

### 5. Vendoring (darwin)

`scripts/build-whisper.mjs` also builds `--target whisper-server`. The
server binary gets the same treatment as the CLI: copy, `lipo` arch gate and
`-h` smoke test.

Idempotency and the `.whisper-tag` stamp now require **both** binaries. An
existing current-tag, CLI-only directory re-vendors, and a test covers that
upgrade.

alpha-cent already ships everything under `assets/**` as `extraResources`,
so packaging needs no change. `fetch-whisper-cli.mjs` (win/linux) is
unchanged.

## Rollout

- `KIA_ASR_SERVER=0` disables the server.
- Disabled for the session on any start failure.
- Weak hosts and non-darwin hosts never use it.

## Resolved questions

- **Idle stop of 5 minutes:** RAM matters on 16 GB Macs running gemma.
- **No server for background, detect or VAD-off:** see §1.
- **`modelLoads`:** server starts are reported through `inference:stats`
  `asrServer.starts`.
- **The 90 s interactive hold-off:** unchanged. It applies to background CLI
  jobs, and server jobs are always interactive.
