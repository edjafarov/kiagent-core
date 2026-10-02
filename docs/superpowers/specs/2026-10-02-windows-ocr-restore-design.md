# Restore Windows OCR

Status: r1 (draft) · 2026-10-02

## Problem: a silent regression

Windows OCR **shipped and worked** in June 2026 (alpha-cent commits
`ea10c21` WinRT helper, `9c04a07` execFile wrapper, `3c89dd9` `WindowsOcr`
provider, `7fa50b8` main wiring, `fe40e009` selftest gate). The greenfield
rebuild kept the native half and dropped the runtime half.
`docs/rebuild/LEFTOVERS.md` §2 records it:

> the Windows WinRT OCR helper now BUILDS and is vendored into win32
> packaging … but no runtime `read` provider is registered for it — it ships
> as dead weight

So on Windows today:

- `providers/index.ts` registers `apple-vision` (the only `read` provider)
  on darwin only.
- `session.read` throws `NoProviderError('read')`. The vision worker sets
  `ocrFailed` and falls to pass 2 (VLM).
- Pass 2's `see` needs the local LLM, which does not start on Windows
  (core#127). Its error is caught and the doc is **deferred forever**.
- Every scanned PDF and image on Windows is re-driven every 30 minutes and
  never gets text. A client's 247 scanned legal documents are a likely
  instance.

The `convert.ts:111` comment ("OCR is … absent on Windows") is accurate
today, and wrong after this spec.

## Goals

- Windows scans and images get OCR text through the shipped
  `windows-ocr.exe`.
- A document whose OCR found text is never deferred forever for want of a
  VLM, on any platform.

## Non-goals

- Fixing the local LLM on Windows/Linux (core#127).
- Linux OCR. No helper exists; GLM-OCR stays a descriptor only.
- Choosing OCR languages beyond what Windows provides (below).

## Design

### 1. `windows-ocr` provider (mirror of `apple-vision`)

New `src/main/providers/windows-ocr/`:

- **`windows-ocr-helper.ts`** (port of the June `WindowsOcrHelper`,
  `4c553207`; trimmed to today's `VisionHelper` style):
  - `ocrImage(bytes, mime)` writes a temp PNG, runs
    `execFile(exe, ['ocr', path], { timeout: 60_000, windowsHide: true })`,
    parses `{text}` and removes the temp dir. Same temp-file approach as
    `vision-helper.ocrImage`.
  - `selftest()` runs `exe selftest` and returns `ok`.
- **`provider.ts`**: `id: 'windows-ocr'`, `supports: ['read']`.
  - `status()` is `'unsupported'` off win32, `{ error: 'windows-ocr helper
    missing' }` when the exe is absent, and
    `{ error: 'no Windows OCR language installed' }` when selftest failed.
    Otherwise it is `'ready'`.
  - Selftest runs **once at boot**, async. Until it resolves, status is
    `'standby'`, and a re-probe runs on the next boot only.
- **`providers/index.ts`** registers it when `process.platform === 'win32'`,
  with the exe at `assets/ocr/win32-<arch>/windows-ocr.exe`. That is the
  path `scripts/build-windows-ocr-helper.mjs` publishes to.

The vision worker's existing `read` call routes to it with no worker
change. Rasterization on Windows is the wasm pdfium path (`pickRasterizer`),
which already runs there.

**Languages.** The helper uses `OcrEngine.TryCreateFromUserProfileLanguages()`:
OCR quality follows the languages in the Windows user profile, as the June
version did. A German-only data room on an English-profile Windows still
OCRs (Latin script), but umlauts and ß may degrade. We document this in the
in-app processing help ("add your document languages in Windows Settings →
Language"). We don't add a language setting.

### 2. A VLM outage never strands OCR text

Today any pass-2 failure returns `'defer'`, forever. That is correct for a
transient crash and wrong when the VLM will never come up. It affects
Windows/Linux (core#127), and any mac whose model download is broken.

The change:

- Count pass-2 failures on the doc: `extraction.vlmFailures`, written as a
  metadata-only enrich before returning `'defer'`.
- When `vlmFailures ≥ 3` **and** pass 1 produced ≥ `HAS_TEXT_CHARS` (16)
  characters, complete with the OCR-only result:
  `extraction: { engine: 'local-ocr', vlm: 'unavailable' }`.
- A doc with < 16 OCR chars keeps deferring: nothing would be gained by
  completing it empty.

**Interaction with the classifier.** `classifyDocument` skips any doc with
an `extraction` marker. The failure counter must therefore live where it
does not mark the doc done. Either:

- use a sibling key `visionAttempts: { vlmFailures }`, or
- teach `classifyDocument` that an `extraction` with no `engine` is
  in-progress.

The first is simpler; use it.

### 3. Packaging check

The June wiring was verified on Windows. The rebuild changed packaging
(`build/inject.mjs`, the core/alpha-cent split), so confirm
`resources/assets/ocr/win32-x64/windows-ocr.exe` (and arm64) is present in
the installed app. If it is missing, add the `assets/ocr` dir to the same
extraResources merge that carries `assets/vision`.

Also add a `windows-ocr selftest` step to `build/release-smoke.mjs`'s win
leg. It is already the one command for release smoke.

### 4. Comment and docs cleanup

- Fix `convert.ts:111`.
- Fix `LEFTOVERS.md` §2.
- Update the README OCR section, which still describes the GLM-OCR swap.

## Testing

- **Unit tests:**
  - The helper wrapper against a fake exe (the June
    `fake-windows-ocr.cjs` fixture pattern): success JSON, non-zero exit,
    timeout, and selftest false → provider status error.
  - Provider registration happens only on win32.
- **Vision worker:**
  - With a `read` provider returning 50 chars and `see` throwing, the doc
    completes OCR-only on the 3rd attempt.
  - With `read` returning 0 chars, it keeps deferring.
  - mac behaviour is unchanged when `see` succeeds.
- **Live, Windows UTM VM** (`ssh win`; recipe in memory
  `windows-utm-vm-test-recipe`):
  - Install the RC build.
  - Put a scanned German PDF and a PNG screenshot in a local folder.
  - Leave the app idle on AC power.
  - Check the docs' markdown holds OCR text via the dev DB or MCP `get`.
  - Run once with a German language pack and once without.
