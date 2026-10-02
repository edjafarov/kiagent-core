# Restore Windows OCR

Status: r3 (review round 2 folded in) · 2026-10-02
Uses the large-file spec's §7 `session.bump`. If this spec lands first, it
brings that primitive with it.

## Problem: a silent regression, and a packaging gap

Windows OCR shipped in June 2026: alpha-cent `ea10c21` (WinRT helper),
`9c04a07` (execFile wrapper), `3c89dd9` (`WindowsOcr` provider), `7fa50b8`
(main wiring), `fe40e009` (selftest gate). The greenfield rebuild kept the
native half and dropped the runtime half.

**Today, no installer can contain the helper.**

- The Windows installer is built on the Docker (Linux) leg of
  `scripts/release-local.sh`.
- `vendor-deep-extraction.mjs` skips the helper off win32, and
  `build-windows-ocr-helper.mjs` exits 1 off win32.
- `release-local.sh` says so itself: "No native windows-ocr helper from this
  path either".
- `LEFTOVERS.md` §2 ("vendored into win32 packaging") is only true on a
  win32 build host, which the pipeline doesn't use.

**And no runtime provider exists.**

- `providers/index.ts` registers `apple-vision`, the only `read` provider,
  on darwin only.
- On Windows, `session.read` throws `NoProviderError('read')` and the vision
  worker falls to pass 2.
- Pass 2's local LLM goes standby → downloads → ready, then fails `see` with
  a spawn error (core#127).
- The caught error returns `defer`, so the doc is re-driven every 30
  minutes, forever: fetch + rasterize + nothing.

Every scanned PDF and image on Windows never gets text.

## Goals

- Windows installers carry `windows-ocr.exe` for x64 and arm64. A build
  gate fails without it.
- Windows scans and images get OCR text.
- A document whose OCR ran is never re-driven forever because a VLM will
  never work. A host with neither OCR nor VLM (Linux; Windows with no OCR
  language) keeps re-driving, by design, so a later fix recovers its docs.

## Non-goals

- Fixing the local LLM on Windows/Linux (core#127).
- Linux OCR.
- An OCR language setting.

## Design

### 1. Build the helper on the Docker leg

The Docker image already cross-publishes `net10.0-windows` exes for win-x64
and arm64: the meetings `KiaAudio`/`KiaDiarize` with
`EnableWindowsTargeting=true` (`release-local.sh` ~163). Do the same:

- Retarget `native/windows-ocr/windows-ocr.csproj` to the **versioned**
  `net10.0-windows10.0.19041.0` and add `<EnableWindowsTargeting>true`.
  `Windows.Media.Ocr`, `Windows.Graphics.Imaging` and `Windows.Storage` are
  WinRT projections that exist only on a versioned Windows TFM. The meetings
  helpers use NAudio/sherpa, not WinRT, so they prove the Docker toolchain
  but not that `Microsoft.Windows.SDK.NET.Ref` restores on Linux. Try
  cross-publish first; the fallback below is a real option.
- `build-windows-ocr-helper.mjs`:
  - drop the win32 guard;
  - publish both arches into `assets/ocr/win32-{x64,arm64}/windows-ocr.exe`;
  - run it from `vendor-deep-extraction.mjs` on every host that builds a
    Windows target, which includes the Docker leg.
- **Gate.** In `verify-win-installer.mjs`:
  - add `ocr/win32-x64/windows-ocr.exe` and
    `ocr/win32-arm64/windows-ocr.exe` to the required list (next to
    `REQUIRED_INFERENCE`);
  - extend `INFERENCE_RE` **and** the `INFERENCE_CLI` mapping to cover `ocr`;
  - extend the payload extraction filter (~:295), which currently drops
    `windows-ocr.exe`.

  Tests: a complete installer passes; a missing helper, or one of the wrong
  architecture, fails.
- Core's `extraResources` already ships `./assets/**`; nothing to add there.
- **Fallback** if the WinRT projection doesn't cross-publish: build on the
  `windows-latest` CI runner once per helper change, upload as a pinned
  release asset, and fetch it like `fetch-whisper-cli.mjs`.

### 2. `windows-ocr` provider (mirror of `apple-vision`)

New `src/main/providers/windows-ocr/`:

- **`windows-ocr-helper.ts`**, ported from the June `4c553207` + `fe40e009`:
  - `ocrImage(bytes, mime)` writes a temp PNG, runs
    `execFile(exe, ['ocr', path], { timeout: 60_000, windowsHide: true })`,
    parses `{ text }` and cleans up.
  - `selftest()` treats a **non-zero exit as `ok: false`, not a throw**: the
    helper exits 1 with `{ok:false}` when no OCR language exists.
- **`provider.ts`:** `id: 'windows-ocr'`, `supports: ['read']`.
  - `status()` is `'unsupported'` off win32, `{ error: 'windows-ocr helper
    missing' }` without the exe, and `{ error: 'no Windows OCR language
    installed' }` when selftest is false.
  - Selftest runs once at boot (async), with `'standby'` until it resolves.
    Otherwise status is `'ready'`.
- **`providers/index.ts`** registers it on win32 with the exe at
  `assets/ocr/win32-<arch>/windows-ocr.exe`.

The vision worker's `read` calls route to it unchanged. Windows
rasterization is the wasm pdfium path, which already runs.

**Large images.** `Program.cs` returns empty text when a side exceeds
`OcrEngine.MaxImageDimension`, and the worker sends full-size images (it
downscales only for the VLM). The helper therefore **downscales in-process**
to fit `MaxImageDimension`, keeping the aspect ratio, before recognizing,
instead of returning empty.

**Languages.** The helper uses `TryCreateFromUserProfileLanguages()`, so
quality follows the Windows profile languages (Latin text OCRs on an English
profile, but umlauts may degrade). The in-app processing help says: "add
your documents' languages in Windows Settings → Language, **then restart
KIAgent**". Selftest only re-probes at boot.

### 3. A dead VLM never strands a document

In the vision worker's pass 2, the `catch` distinguishes three cases:

- **`LaneClosedError`** (the processing window closed): `defer`, not
  counted. This is ordinary scheduling.
- **`NoProviderError('see')` while a `see` provider can still become ready:**
  `defer`, not counted. The check is a new
  `inference.mayBecomeReady('see')`, which is true only when a `see`
  provider is either:
  - `downloading`; or
  - `standby` **with `prefs.models.autoInstall` on and no cancelled
    install**.

  A `standby` provider whose install is disabled or was cancelled
  (`ensureInstalled` refuses it) will never become ready, so it counts as a
  failure.
- **Anything else** is a real VLM failure, including a `NoProviderError`
  with no provider that can ever become ready:
  `n = await session.bump('vlm')` (durable, **no document change**, so there
  is no feed loop).
  - `n < 3` → `defer`.
  - `n ≥ 3` **and pass 1 actually ran** (`!ocrFailed`): **complete** with
    whatever OCR produced (possibly empty, which is then genuinely final):
    `extraction: { engine: 'local-ocr', vlm: 'unavailable' }`.
  - `n ≥ 3` but pass 1 did not run (no `read` provider, e.g. a Windows host
    with no OCR language, or Linux): keep deferring. That is today's
    behaviour. Those docs must stay recoverable for when the user adds a
    language and restarts, so they are never buried with empty text.

**The same safeguard applies to the existing non-VLM-decodable branch**
(`vision-worker.ts` ~104, for HEIC/WebP/TIFF). Today it finalizes with the
OCR-only result even when `read` threw `NoProviderError`. It now returns
`defer` when `ocrFailed`, and finalizes only when pass 1 actually ran.

The worker reaches `mayBecomeReady` through a new
`WorkerSession.mayBecomeReady(kind)`. It does not reach for the plane
directly.

This ends the forever re-drive on Windows hosts whose OCR runs. A healthy Mac whose VLM
works never reaches it. Docs whose OCR gave ≥ 200 characters complete in
pass 1 and never get here.

### 4. Doc cleanup

Fix the stale text in:

- `convert.ts:111` ("OCR … absent on Windows");
- `LEFTOVERS.md` §2;
- `docs/rebuild/backend-surface.md`;
- `vendor-deep-extraction.mjs:12`;
- `release-local.sh:224`.

## Testing

- **Unit:**
  - Helper wrapper against a fake exe (June `fake-windows-ocr.cjs`
    pattern): success, non-zero exit, timeout, selftest exit 1 → `ok:false`.
  - Provider status per case. Registration on win32 only.
- **Vision worker (engine integration, real ledger):**
  - With `see` throwing a spawn error, the doc completes OCR-only after the
    3rd re-drive. No extra feed changes are produced.
  - `LaneClosedError` during pass 2 does not count.
  - `NoProviderError` with a `downloading` provider does not count.
  - With `autoInstall` off, or the install cancelled, it **does** count.
  - With no `read` provider (pass 1 never ran), the doc keeps deferring and
    is never finalized.
  - The same holds for a TIFF/HEIC on the non-VLM-decodable branch. After
    a `read` provider appears, it is OCR'd.
- **Build:** `verify-win-installer` fails when either exe is missing; the
  Docker leg passes with them.
- **Live, Windows UTM VM** (`ssh win`, see the `windows-utm-vm-test-recipe`
  memory):
  - Install the RC build.
  - Put a scanned German PDF, a phone photo of a page (> 4000 px) and a
    screenshot into a local folder.
  - Leave the app idle on AC power.
  - The markdown holds OCR text, and the oversized photo is not empty.
  - Run with and without the German language pack.
