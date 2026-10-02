# Restore Windows OCR

Status: r2 (fable + codex-astra round 1 folded in) · 2026-10-02
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
- On any platform, a document is never re-driven forever because a VLM
  will never work.

## Non-goals

- Fixing the local LLM on Windows/Linux (core#127).
- Linux OCR.
- An OCR language setting.

## Design

### 1. Build the helper on the Docker leg

The Docker image already cross-publishes `net10.0-windows` exes for win-x64
and arm64: the meetings `KiaAudio`/`KiaDiarize` with
`EnableWindowsTargeting=true` (`release-local.sh` ~163). Do the same:

- Retarget `native/windows-ocr/windows-ocr.csproj` to `net10.0-windows`
  (matching meetings) and add `<EnableWindowsTargeting>true`.
- `build-windows-ocr-helper.mjs`:
  - drop the win32 guard;
  - publish both arches into `assets/ocr/win32-{x64,arm64}/windows-ocr.exe`;
  - run it from `vendor-deep-extraction.mjs` on every host that builds a
    Windows target, which includes the Docker leg.
- **Gate.** Add `ocr/win32-x64/windows-ocr.exe` and
  `ocr/win32-arm64/windows-ocr.exe` to `verify-win-installer.mjs`'s required
  list (next to `REQUIRED_INFERENCE`). Extend its path regex to cover
  `assets/ocr`.
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
- **`NoProviderError('see')` while a `see` provider can still become ready**
  (status `standby` or `downloading`, i.e. a model download in progress):
  `defer`, not counted. The check is a new
  `inference.mayBecomeReady('see')`.
- **Anything else** is a real VLM failure, including a `NoProviderError`
  with no provider that can ever become ready:
  `n = await session.bump('vlm')` (durable, **no document change**, so there
  is no feed loop).
  - `n < 3` → `defer`.
  - `n ≥ 3` → **complete** with whatever pass 1 produced (possibly empty):
    `extraction: { engine: 'local-ocr', vlm: 'unavailable' }`.

This ends the forever re-drive on Windows/Linux. A healthy Mac whose VLM
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
