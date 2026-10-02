# Restore Windows OCR Implementation Plan (core + alpha-cent packaging)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows installers ship `windows-ocr.exe` (x64 + arm64), behind a build gate. Windows scans and images get OCR text. A document whose OCR ran is never re-driven forever because a VLM can't work.

**Architecture:**
- Core builds the WinRT helper by cross-publishing from the Linux Docker leg (a versioned Windows TFM with `EnableWindowsTargeting`).
- alpha-cent's installer verifier requires both exes.
- A `windows-ocr` `read` provider mirrors `apple-vision` and registers on win32.
- In the vision worker's VLM pass, real failures are counted with the durable `session.bump('vlm')`. After 3 of them, the doc completes OCR-only, but only if OCR actually ran.

**Tech Stack:** .NET 10 SDK (cross-publish, `Windows.Media.Ocr`), Node `execFile`, TypeScript, jest, alpha-cent `release-local.sh` Docker leg, `verify-win-installer.mjs` (node:test).

**Spec:** `docs/superpowers/specs/2026-10-02-windows-ocr-restore-design.md` (r3.1)

## Global Constraints

- Lands on top of the large-file core plan (`2026-10-02-large-file-indexing.md`). It needs Task 4 (`session.bump`, cleared in the `done` commit) and Task 7 (windowed OCR: `vlmPass`, `complete`, and the `NoProviderError` fill-and-fall-through). Task 4 below changes `vlmPass` to take prepared images and `ocrRan`.
- The VLM failure threshold is 3 (`n >= 3`), keyed `'vlm'`. `LaneClosedError` never counts. A `NoProviderError('see')` while `mayBecomeReady('see')` holds never counts.
- Complete OCR-only **only when pass 1 ran**. With no `read` provider (Linux, or Windows without an OCR language), keep deferring; never bury a doc with empty text.
- Helper timeout is 60 s, with `windowsHide: true`. A selftest non-zero exit means `ok: false`; it is never a throw.
- Installer paths: `resources/assets/ocr/win32-{x64,arm64}/windows-ocr.exe`.
- Builds run sequentially: docker leg → mac → smoke mac → smoke win. Fully kill Docker after the docker leg.
- Commits: no `Co-Authored-By` line, never `--no-verify`, never amend.

## Review Focus

1. **A Windows host whose profile has no OCR language** (selftest exit 1). The provider reports an error, `read` throws `NoProviderError`, and docs keep deferring. They are never completed empty. Task 4.
2. **The local LLM on Windows reaching `ready`, then every `see` failing with a spawn error** (core#127). After 3 re-drives the doc completes with its OCR text, and there are no extra feed changes. Task 4.
3. **A user who cancels the model download** (autoInstall off). A standby `see` provider stops counting as "may become ready", so docs finish OCR-only instead of deferring forever. Task 4.
4. **A 12000 px panorama screenshot.** The helper downscales it to `MaxImageDimension` and returns text, not empty. Task 1 (helper) and Task 6 (live).
5. **A Docker leg whose .NET restore can't fetch the Windows SDK projection.** The build must fail loudly at the installer gate; it must not ship without OCR. Task 2.

---

### Task 1: Helper cross-publishes from Linux, and downscales oversized images (core)

**Files:**
- Modify: `native/windows-ocr/windows-ocr.csproj`
- Modify: `native/windows-ocr/Program.cs`
- Modify: `scripts/build-windows-ocr-helper.mjs`
- Modify: `scripts/vendor-deep-extraction.mjs` (comment only)

- [ ] **Step 1: Retarget the csproj**

```xml
<TargetFramework>net10.0-windows10.0.19041.0</TargetFramework>
<!-- Cross-publish from the linux docker leg (release-local.sh), like the
     meetings helpers; the WinRT projection is a NuGet reference package. -->
<EnableWindowsTargeting>true</EnableWindowsTargeting>
```

Keep every other property.

- [ ] **Step 2: Downscale in-process instead of returning empty**

In `Program.cs`, replace the `MaxImageDimension` early-return and the `GetSoftwareBitmapAsync()` call:

```csharp
// Windows.Media.Ocr refuses images over MaxImageDimension; the worker sends
// full-size images (it downscales only for the VLM). Scale to fit, keep the
// aspect ratio, honour EXIF orientation.
var transform = new BitmapTransform();
uint maxDim = OcrEngine.MaxImageDimension;
if (width > maxDim || height > maxDim)
{
    double s = Math.Min((double)maxDim / width, (double)maxDim / height);
    transform.ScaledWidth = (uint)Math.Max(1, Math.Floor(width * s));
    transform.ScaledHeight = (uint)Math.Max(1, Math.Floor(height * s));
    transform.InterpolationMode = BitmapInterpolationMode.Fant;
}
using var bitmap = await decoder.GetSoftwareBitmapAsync(
    BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied, transform,
    ExifOrientationMode.RespectExifOrientation, ColorManagementMode.DoNotColorManage);
var result = await engine.RecognizeAsync(bitmap);
```

Delete the separate `SoftwareBitmap.Convert` (the overload above already yields Bgra8/premultiplied). Update the header comment: oversize is downscaled, not empty.

- [ ] **Step 3: Drop the win32 guard in the build script**

`build-windows-ocr-helper.mjs`:
- delete the `process.platform !== 'win32'` exit;
- add `'-p:EnableWindowsTargeting=true'` to the `dotnet publish` args (belt and braces with the csproj);
- in the header, say ".NET 10 SDK; runs on win32 and on the linux docker leg (cross-publish)".

After publishing, check the PE header so a wrong-arch or non-PE output fails right here:

```js
const pe = readFileSync(binary);
const off = pe.readUInt32LE(0x3c);
const machine = pe.readUInt16LE(off + 4);
const want = { x64: 0x8664, arm64: 0xaa64 }[arch];
if (pe.toString('latin1', off, off + 4) !== 'PE\0\0' || machine !== want) {
  console.error(`windows-ocr (${arch}) is not a PE ${arch} binary`); process.exit(1);
}
```

`vendor-deep-extraction.mjs`: update only its comment line. Windows targets get the helper from the docker leg (alpha-cent) or a win32 host; this script's darwin/win32/linux branching stays as it is.

- [ ] **Step 4: Prove the cross-publish on Linux once (Docker, sequentially, nothing else running)**

```bash
docker run --rm -v "$PWD":/src -w /src mcr.microsoft.com/dotnet/sdk:10.0 \
  node --version >/dev/null 2>&1 || true   # the sdk image has no node; use dotnet directly:
docker run --rm -v "$PWD":/src -w /src mcr.microsoft.com/dotnet/sdk:10.0 \
  dotnet publish native/windows-ocr/windows-ocr.csproj -c Release -r win-x64 --self-contained true \
  -p:PublishSingleFile=true -p:EnableWindowsTargeting=true -o /tmp/wocr && echo CROSS-PUBLISH-OK
```

Then fully stop Docker (`com.docker.backend` included).

**If it fails** with a missing `Microsoft.Windows.SDK.NET.Ref` / WinRT projection, stop Task 1 here and take the spec's **fallback**:
- build on `windows-latest` once per helper change (`gh workflow` or the Windows UTM VM, `ssh win`);
- upload both exes as a pinned release asset on kiagent-core (`windows-ocr-v1`);
- write `scripts/fetch-windows-ocr.mjs`, modelled on `fetch-whisper-cli.mjs`, with a sha256 pin per arch;
- Task 2 then calls that fetch script instead of the build script.

Record which path was taken in the commit message.

- [ ] **Step 5: Commit**

```bash
git add native/windows-ocr scripts/build-windows-ocr-helper.mjs scripts/vendor-deep-extraction.mjs
git commit -m "build(windows-ocr): cross-publish net10.0-windows10.0.19041.0 from linux; downscale oversized images"
```

---

### Task 2: The Docker win leg ships the helper, gated by the installer verifier (alpha-cent)

**Files (alpha-cent, in the worktree that takes this core release's `core.lock` bump):**
- Modify: `scripts/release-local.sh` (the docker windows leg)
- Modify: `build/verify-win-installer.mjs`
- Test: `build/verify-win-installer.test.mjs`

- [ ] **Step 1: Failing verifier tests**

In `verify-win-installer.test.mjs`, **first extend the shared fixtures**. Once `REQUIRED_INFERENCE` lists the helpers, a `GOOD_INFERENCE` without them yields two extra "missing" violations, and that breaks the clean-payload test plus the exact `v.length` counts in the rc.5 and wrong-arch tests:

```js
const GOOD_INFERENCE = {
  …existing five entries…,
  [`${ASSETS}/ocr/win32-x64/windows-ocr.exe`]: pe(MACHINE.x64),
  [`${ASSETS}/ocr/win32-arm64/windows-ocr.exe`]: pe(MACHINE.arm64),
};
const inferenceListing = (files) => [
  `${ASSETS}/llama`,
  `${ASSETS}/whisper`,
  `${ASSETS}/ocr`,
  `${ASSETS}/whisper/ggml-silero-v5.1.2.bin`,
  ...Object.keys(files).flatMap((f) => [f.replace(/\/[^/]+$/, ''), f]),
];
```

Then add the new cases, derived from that fixture:

```js
test('checkInferenceBinaries: a missing windows-ocr helper fails the gate', () => {
  const files = { ...GOOD_INFERENCE };
  delete files[`${ASSETS}/ocr/win32-arm64/windows-ocr.exe`];
  const v = checkInferenceBinaries(inferenceListing(files), kindsFrom(files));
  assert.equal(v.length, 1, v.join('\n'));
  assert.match(v[0], /ocr\/win32-arm64\/windows-ocr\.exe missing/);
});
test('checkInferenceBinaries: a wrong-arch windows-ocr helper fails the gate', () => {
  const files = { ...GOOD_INFERENCE, [`${ASSETS}/ocr/win32-arm64/windows-ocr.exe`]: pe(MACHINE.x64) };
  const v = checkInferenceBinaries(inferenceListing(files), kindsFrom(files));
  assert.equal(v.length, 1, v.join('\n'));
  assert.match(v[0], /ocr\/win32-arm64\/windows-ocr\.exe is PE x64, expected PE arm64/);
});
test('REQUIRED_INFERENCE lists both helpers', () => {
  assert.ok(REQUIRED_INFERENCE.includes('ocr/win32-x64/windows-ocr.exe'));
  assert.ok(REQUIRED_INFERENCE.includes('ocr/win32-arm64/windows-ocr.exe'));
});
```

Add `REQUIRED_INFERENCE` to the file's import from `./verify-win-installer.mjs` (it is already exported). The existing clean-payload, rc.5 and llama wrong-arch tests stay unchanged. With the extended fixture, they keep their counts.

- [ ] **Step 2: Run, and confirm they fail.** `node --test build/verify-win-installer.test.mjs`

- [ ] **Step 3: Implement the gate**

```js
const INFERENCE_RE =
  /(?:^|\/)resources\/assets\/(llama|whisper|ocr)\/([^/]+)(?:\/(.+))?$/;
export const REQUIRED_INFERENCE = [
  …existing four…,
  'ocr/win32-x64/windows-ocr.exe',
  'ocr/win32-arm64/windows-ocr.exe',
];
const INFERENCE_CLI = { llama: 'llama-server.exe', whisper: 'whisper-cli.exe', ocr: 'windows-ocr.exe' };
```

In the payload-extraction filter (~:295):

```js
const inferenceClis = inference.filter((p) => /(?:llama-server|whisper-cli|windows-ocr)\.exe$/i.test(p));
```

The "missing" message names the script to run: `(fetch-llama-server.mjs / fetch-whisper-cli.mjs / build-windows-ocr-helper.mjs)`.

- [ ] **Step 4: Build the helper in the docker windows leg**

In `release-local.sh`, after the whisper swap (`node scripts/fetch-whisper-cli.mjs win32-x64 win32-arm64`), inside `build/.core`, with the .NET 10 SDK already on `PATH`:

```bash
      # Native Windows OCR (Windows.Media.Ocr), cross-published like the
      # meetings helpers. verify-win-installer below fails the build if
      # either arch is missing or the wrong arch.
      rm -rf assets/ocr
      node scripts/build-windows-ocr-helper.mjs
```

Delete the stale "No native windows-ocr helper from this path either" sentence (~:223). Update the verify step's echo to mention OCR.

If Task 1 took the fallback, call `node scripts/fetch-windows-ocr.mjs` instead.

- [ ] **Step 5: Run the tests, and commit**

```bash
node --test build/verify-win-installer.test.mjs
git add scripts/release-local.sh build/verify-win-installer.mjs build/verify-win-installer.test.mjs
git commit -m "build(win): ship windows-ocr.exe (x64+arm64) from the docker leg; installer gate requires it"
```

The full docker leg runs as part of the release build (Task 6). Never run it in parallel with another build.

---

### Task 3: `windows-ocr` read provider (core)

**Files:**
- Create: `src/main/providers/windows-ocr/windows-ocr-helper.ts`, `src/main/providers/windows-ocr/provider.ts`
- Create: `src/main/providers/windows-ocr/__tests__/fixtures/fake-windows-ocr.cjs`
- Modify: `src/main/providers/index.ts`
- Test: `src/main/providers/windows-ocr/__tests__/windows-ocr.test.ts`

**Interfaces:**
- Produces:
  - `makeWindowsOcrHelper(exe, log, opts?) → { ocrImage(bytes, mime?): Promise<string>; selftest(): Promise<{ ok: boolean }> }`
  - `createWindowsOcrProvider({ binaryPath, helper, platform?, log }) → InferenceProvider` (`id: 'windows-ocr'`, `supports: ['read']`)

- [ ] **Step 1: The fake exe (the June `fake-windows-ocr.cjs` pattern)**

```js
#!/usr/bin/env node
// Env-driven stand-in for windows-ocr.exe (tests only).
const env = process.env;
if (process.argv[2] === 'selftest') {
  const ok = env.FAKE_WOCR_NOLANG !== '1';
  process.stdout.write(JSON.stringify({ ok }) + '\n');
  process.exit(ok ? 0 : 1);
}
if (env.FAKE_WOCR_HANG) { setTimeout(() => {}, 60_000); return; }
if (env.FAKE_WOCR_FAIL) { process.stderr.write('boom\n'); process.exit(1); }
process.stdout.write(JSON.stringify({ text: env.FAKE_WOCR_TEXT ?? '', width: 1, height: 1, confidence: 1 }) + '\n');
```

`chmod +x` it and commit it executable (`git update-index --chmod=+x`).

- [ ] **Step 2: Failing tests**

```ts
import path from 'path';
import { makeWindowsOcrHelper } from '../windows-ocr-helper';
import { createWindowsOcrProvider, NO_OCR_LANGUAGE } from '../provider';

const FAKE = path.join(__dirname, 'fixtures', 'fake-windows-ocr.cjs');
const log = jest.fn();
const withEnv = async <T>(env: Record<string, string>, f: () => Promise<T>) => {
  Object.assign(process.env, env);
  try { return await f(); } finally { for (const k of Object.keys(env)) delete process.env[k]; }
};

describe('windows-ocr helper', () => {
  it('returns the recognized text', async () => {
    await withEnv({ FAKE_WOCR_TEXT: 'Rechnung Nr. 42' }, async () =>
      expect(await makeWindowsOcrHelper(FAKE, log).ocrImage(new Uint8Array([1, 2]), 'image/png')).toBe('Rechnung Nr. 42'));
  });
  it('a non-zero exit rejects with stderr', async () => {
    await withEnv({ FAKE_WOCR_FAIL: '1' }, async () =>
      expect(makeWindowsOcrHelper(FAKE, log).ocrImage(new Uint8Array([1]))).rejects.toThrow('boom'));
  });
  it('a hung helper times out', async () => {
    await withEnv({ FAKE_WOCR_HANG: '1' }, async () =>
      expect(makeWindowsOcrHelper(FAKE, log, { timeoutMs: 300 }).ocrImage(new Uint8Array([1]))).rejects.toThrow(/timed out/));
  });
  it('selftest: exit 1 with {ok:false} is ok:false, not a throw', async () => {
    await withEnv({ FAKE_WOCR_NOLANG: '1' }, async () =>
      expect(await makeWindowsOcrHelper(FAKE, log).selftest()).toEqual({ ok: false }));
    expect(await makeWindowsOcrHelper(FAKE, log).selftest()).toEqual({ ok: true });
  });
});

describe('windows-ocr provider status', () => {
  const helper = (ok: boolean) => ({ ocrImage: jest.fn(), selftest: jest.fn(async () => ({ ok })) });
  it('unsupported off win32', () => {
    expect(createWindowsOcrProvider({ binaryPath: FAKE, helper: helper(true), platform: 'darwin', log }).status()).toBe('unsupported');
  });
  it('missing exe → error', () => {
    expect(createWindowsOcrProvider({ binaryPath: '/nope.exe', helper: helper(true), platform: 'win32', log }).status())
      .toEqual({ error: 'windows-ocr helper missing' });
  });
  it('standby until selftest resolves, then ready / no-language error', async () => {
    const p = createWindowsOcrProvider({ binaryPath: FAKE, helper: helper(true), platform: 'win32', log });
    expect(p.status()).toBe('standby');
    await new Promise((r) => setImmediate(r));
    expect(p.status()).toBe('ready');
    const q = createWindowsOcrProvider({ binaryPath: FAKE, helper: helper(false), platform: 'win32', log });
    await new Promise((r) => setImmediate(r));
    expect(q.status()).toEqual({ error: NO_OCR_LANGUAGE });
  });
  it('handle routes read to ocrImage', async () => {
    const h = helper(true); h.ocrImage.mockResolvedValue('text');
    const p = createWindowsOcrProvider({ binaryPath: FAKE, helper: h, platform: 'win32', log });
    expect(await p.handle({ kind: 'read', payload: { image: new Uint8Array([1]), mime: 'image/png' } } as never)).toBe('text');
  });
});
```

Create `src/main/providers/__tests__/register-bundled-providers.test.ts` (no registration tests exist yet; that folder holds only `install-registry.test.ts`). Assert that `registerBundledProviders` registers `windows-ocr` on win32 and not on darwin. Stub `process.platform` with `Object.defineProperty(process, 'platform', { value: 'win32' })`, and restore it in `afterEach`. The fake `CorePlatform` needs `inference.register` (a `jest.fn`), `logSink.log`, and `prefs.get`/`prefs.onChange`. local-llm and local-asr construct fine against a nonexistent `modelsDir`.

- [ ] **Step 3: Run, and confirm they fail.** `npx jest src/main/providers`

- [ ] **Step 4: Implement**

`windows-ocr-helper.ts`:

```ts
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { LogLevel } from '@shared/contracts';

/** Native Windows OCR (WinRT Windows.Media.Ocr) — port of the June helper
 *  (alpha-cent 9c04a07f/fe40e009). Stateless; one exe run per image. */
export function makeWindowsOcrHelper(exe: string, log: (l: LogLevel, m: string) => void,
  opts: { timeoutMs?: number } = {}) {
  const timeout = opts.timeoutMs ?? 60_000;
  const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        if (e?.killed) return reject(new Error(`windows-ocr timed out after ${timeout}ms`));
        if (e && typeof e.code !== 'number') return reject(e); // spawn failure (ENOENT…)
        resolve({ code: e ? Number(e.code) : 0, stdout: String(stdout), stderr: String(stderr) });
      });
  });
  return {
    async ocrImage(bytes: Uint8Array, mime = 'image/png'): Promise<string> {
      const ext = mime.includes('jpeg') ? '.jpg' : mime.includes('tiff') ? '.tif' : mime.includes('bmp') ? '.bmp' : '.png';
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kia-wocr-'));
      const file = path.join(dir, `page${ext}`);
      try {
        await fs.promises.writeFile(file, bytes);
        const r = await run(['ocr', file]);
        if (r.code !== 0) throw new Error((r.stderr || `windows-ocr exited ${r.code}`).trim());
        return String((JSON.parse(r.stdout) as { text?: string }).text ?? '');
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    },
    /** Exit 1 + {"ok":false} = no OCR language on this profile: a status, not an error. */
    async selftest(): Promise<{ ok: boolean }> {
      try {
        const r = await run(['selftest']);
        return { ok: r.code === 0 && (JSON.parse(r.stdout) as { ok?: boolean }).ok === true };
      } catch (err) {
        log('warn', `windows-ocr selftest failed: ${String(err)}`);
        return { ok: false };
      }
    },
  };
}
export type WindowsOcrHelper = ReturnType<typeof makeWindowsOcrHelper>;
```

`provider.ts`:

```ts
import fs from 'fs';
import type { InferenceProvider, LogLevel, ProviderStatus } from '@shared/contracts';
import type { WindowsOcrHelper } from './windows-ocr-helper';

/** Selftest runs only at boot, so the guidance must say restart. */
export const NO_OCR_LANGUAGE =
  'No text-recognition language is installed. Add a language in Windows Settings → Time & language → Language & region (one with Optical character recognition), then restart KIAgent.';

export function createWindowsOcrProvider(deps: {
  binaryPath: string; helper: Pick<WindowsOcrHelper, 'ocrImage' | 'selftest'>;
  platform?: string; log: (level: LogLevel, msg: string) => void;
}): InferenceProvider {
  const platform = deps.platform ?? process.platform;
  // Selftest once at boot (languages are re-probed only on restart — the
  // processing help says so). Until it resolves: standby.
  let probed: boolean | null = null;
  if (platform === 'win32' && fs.existsSync(deps.binaryPath)) {
    void deps.helper.selftest().then((r) => { probed = r.ok; });
  }
  return {
    id: 'windows-ocr',
    supports: ['read'],
    status(): ProviderStatus {
      if (platform !== 'win32') return 'unsupported';
      if (!fs.existsSync(deps.binaryPath)) return { error: 'windows-ocr helper missing' };
      if (probed === null) return 'standby';
      return probed ? 'ready' : { error: NO_OCR_LANGUAGE };
    },
    async handle(req) {
      if (req.kind !== 'read') throw new Error(`windows-ocr only supports 'read' (got '${req.kind}')`);
      const { image, mime } = req.payload as { image: Uint8Array; mime?: string };
      return deps.helper.ocrImage(image, mime);
    },
  };
}
```

`providers/index.ts`, after the apple-vision block:

```ts
  if (process.platform === 'win32') {
    const wocr = path.join(opts.assetsDir, 'ocr', `win32-${process.arch}`, 'windows-ocr.exe');
    platform.inference.register(createWindowsOcrProvider({
      binaryPath: wocr, helper: makeWindowsOcrHelper(wocr, log('inference')), log: log('inference'),
    }));
  }
```

**In-app language and restart guidance (spec §2, required).** The selftest runs only at boot, so the user must hear "restart". The guidance goes in the existing provider-error display: `LocalProcessing.tsx` lists any provider in `{ error }` with its name and `status.error` as the detail. Don't build a new surface.
- `provider.ts`: `NO_OCR_LANGUAGE` (above) is the selftest-failed error.
- `src/renderer/screens/Settings/LocalProcessing.tsx`: add `'windows-ocr': 'Text recognition (Windows)'` to `PROVIDER_NAMES`.
- Add a test in `src/renderer/screens/Settings/__tests__/LocalProcessing.test.tsx`, next to "a non-installable provider in error…":

```tsx
test('windows-ocr without a language shows the language + restart guidance', async () => {
  mockInvoke({ providers: [{ id: 'windows-ocr', supports: ['read'],
    status: { error: 'No text-recognition language is installed. Add a language in Windows Settings → Time & language → Language & region (one with Optical character recognition), then restart KIAgent.' }, installable: false }] });
  render(<LocalProcessing />);
  await screen.findByText('Text recognition (Windows)');
  expect(screen.getByText(/then restart KIAgent/)).toBeInTheDocument();
});
```

- [ ] **Step 5: Run, and confirm they pass.** `npx jest src/main/providers src/renderer/screens/Settings`

- [ ] **Step 6: Commit**

```bash
git add src/main/providers src/renderer/screens/Settings
git commit -m "feat(providers): windows-ocr read provider (WinRT helper, selftest-gated)"
```

---

### Task 4: A dead VLM never strands a doc whose OCR ran (core)

**Files:**
- Modify: `src/shared/contracts.ts` (`InferenceProvider.mayBecomeReady?`, `WorkerSession.mayBecomeReady`)
- Modify: `src/main/core/inference.ts` (plane `mayBecomeReady(kind)`)
- Modify: `src/main/providers/local-llm/provider.ts` (`mayBecomeReady`)
- Modify: `src/main/core/engine/engine.ts` (session literal)
- Modify: `src/main/workers/vision/vision-worker.ts` (`vlmPass` catch; non-VLM-decodable branch)
- Modify: worker test fakes: add `mayBecomeReady: () => false`
- Test: `src/main/core/__tests__/inference.test.ts`, `src/main/providers/local-llm/__tests__/*.test.ts`, `src/main/workers/vision/__tests__/vision-worker.test.ts`, `src/main/core/engine/__tests__/engine.test.ts`

**Interfaces:**
- Produces:
  - `InferenceProvider.mayBecomeReady?(): boolean`
  - `InferencePlane.mayBecomeReady(kind): boolean`
  - `WorkerSession.mayBecomeReady(kind: 'see' | 'read'): boolean`

**Design (a simplification of spec §3).** The spec puts the "standby + autoInstall on" knowledge in the plane. Here each provider answers for itself: only `local-llm` knows its install state and reads `prefs.models.autoInstall`. The plane ORs the answers, plus a generic "status is `downloading`" check. A cancelled install already turns `autoInstall` off: the cancel is global by design (`install-registry.ts:2`).

- [ ] **Step 1: Failing tests (plane and local-llm)**

```ts
// inference.test.ts
it('mayBecomeReady: true while a see provider downloads or says it may; false otherwise', () => {
  const plane = createInference(noopLogs);
  plane.register({ id: 'dl', supports: ['see'], status: () => ({ downloading: { pct: 10 } }), handle: jest.fn() } as never);
  expect(plane.mayBecomeReady('see')).toBe(true);
  const p2 = createInference(noopLogs);
  p2.register({ id: 'sb', supports: ['see'], status: () => 'standby', mayBecomeReady: () => false, handle: jest.fn() } as never);
  expect(p2.mayBecomeReady('see')).toBe(false);
  p2.register({ id: 'sb2', supports: ['see'], status: () => 'standby', mayBecomeReady: () => true, handle: jest.fn() } as never);
  expect(p2.mayBecomeReady('see')).toBe(true);
  expect(p2.mayBecomeReady('read')).toBe(false);
});
```

In the local-llm provider test, reusing its existing provider setup with a prefs stub:
- `mayBecomeReady()` is true when the selected model is not installed and `autoInstall` is on;
- it is false with `autoInstall` off;
- it is false when the selected model is installed and ready (nothing to become);
- it is false on unsupported hardware.

- [ ] **Step 2: Implement the plane, provider and session**

`contracts.ts`:

```ts
  /** Can this provider still become `ready` without user action (it is
   *  downloading, or will auto-install)? Absent = no. Used to tell "wait"
   *  from "this will never work" (windows-ocr spec §3). */
  mayBecomeReady?(): boolean;
```

On `WorkerSession`: `mayBecomeReady(kind: 'see' | 'read'): boolean;`.

`inference.ts`, in the plane:

```ts
mayBecomeReady(kind) {
  return providers.some((p) => !p.remote && p.supports.includes(kind) && (
    (typeof p.status() === 'object' && 'downloading' in (p.status() as object)) || p.mayBecomeReady?.() === true));
},
```

`local-llm/provider.ts`:

```ts
mayBecomeReady() {
  if (!capability.ok || selectedInstalled()) return false;
  return downloadPct !== null || (lastError === null && deps.prefs.get().models.autoInstall);
},
```

`engine.ts`, session literal: `mayBecomeReady: (kind) => deps.inference.mayBecomeReady?.(kind) ?? false,`. Widen the engine's `inference` dep type with the optional method.

- [ ] **Step 3: Failing vision-worker tests**

These tests reuse the large-file plan's `pagedRasterizer` and `fakeSession(over)`. Add `bump` and `mayBecomeReady` to the fake's defaults.

```ts
const thinPdf = () => { const { r } = pagedRasterizer(2); return r; };
const spawnErr = async () => { throw Object.assign(new Error('spawn llama-server ENOENT'), { code: 'ENOENT' }); };

it('a real VLM failure counts; the 3rd completes OCR-only with vlm: unavailable', async () => {
  const bump = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3);
  const w = createVisionWorker({ rasterizer: thinPdf(), laneOpen: () => true });
  const mk = () => fakeSession({ read: async () => 'few', see: spawnErr, bump });
  expect(await w.work(change({}), mk())).toBe('defer');
  expect(await w.work(change({}), mk())).toBe('defer');
  const s3 = mk();
  expect(await w.work(change({}), s3)).toBe('done');
  expect(s3.enriched[0].metadata.extraction).toMatchObject({ engine: 'local-ocr', vlm: 'unavailable' });
  expect(s3.enriched[0].markdown).toContain('few');
});
it('LaneClosedError never counts', async () => {
  const bump = jest.fn();
  const s = fakeSession({ read: async () => 'few', see: async () => { throw new LaneClosedError(); }, bump });
  expect(await createVisionWorker({ rasterizer: thinPdf(), laneOpen: () => true }).work(change({}), s)).toBe('defer');
  expect(bump).not.toHaveBeenCalled();
});
it('NoProviderError(see) while a see provider may become ready never counts', async () => {
  const bump = jest.fn();
  const s = fakeSession({ read: async () => 'few', see: async () => { throw new NoProviderError('see'); },
    bump, mayBecomeReady: () => true });
  expect(await createVisionWorker({ rasterizer: thinPdf(), laneOpen: () => true }).work(change({}), s)).toBe('defer');
  expect(bump).not.toHaveBeenCalled();
});
it('NoProviderError(see) with nothing that can become ready DOES count', async () => {
  const bump = jest.fn(async () => 3);
  const s = fakeSession({ read: async () => 'few', see: async () => { throw new NoProviderError('see'); },
    bump, mayBecomeReady: () => false });
  expect(await createVisionWorker({ rasterizer: thinPdf(), laneOpen: () => true }).work(change({}), s)).toBe('done');
});
it('no read provider (pass 1 never ran): keeps deferring even after 3 VLM failures', async () => {
  const s = fakeSession({ read: async () => { throw new NoProviderError('read'); }, see: spawnErr, bump: async () => 9 });
  expect(await createVisionWorker({ rasterizer: thinPdf(), laneOpen: () => true }).work(change({}), s)).toBe('defer');
  expect(s.enriched).toEqual([]);
});
it('non-VLM-decodable TIFF: defers when OCR did not run, completes when it did', async () => {
  const tiff = change({ title: 'scan.tif', metadata: { mime: 'image/tiff', filename: 'scan.tif', sizeBytes: 50_000 } });
  const w = createVisionWorker({ rasterizer: thinPdf(), laneOpen: () => true });
  expect(await w.work(tiff, fakeSession({ read: async () => { throw new NoProviderError('read'); } }))).toBe('defer');
  const s = fakeSession({ read: async () => 'tiff text' });
  expect(await w.work(tiff, s)).toBe('done');
  expect(s.enriched[0].markdown).toContain('tiff text');
});
```

`change`, `baseDoc` and the fetch fake follow the existing `vision-worker.test.ts` helpers; the TIFF case needs an image `fetchBytes` result.

- [ ] **Step 4: Implement in `vision-worker.ts`**

**Pass 1 ran?** In the large-file plan's windowed loop, the `NoProviderError` branch sets a local `let ocrRan = true` to `false` before it fills pages with `''`. The single-image path already has `ocrFailed`; use `ocrRan = !ocrFailed` there.

**Gate both completions on it**, not just the VLM-failure one. The inherited completion after the window loop changes to:

```ts
const chars = Object.values(done).join('').replace(/\s+/g, '').length;
if (ocrRan && chars >= OCR_SUFFICIENT_CHARS) return complete('local-ocr', pagesOut());
// Resumed doc, and OCR vanished between windows: the '' fills are pages that were
// never read. Completing now would make them permanently unsearchable. Wait for OCR.
if (!ocrRan && prog) return 'defer';
return vlmPass(pagesOut(), pdfImages(Math.min(pageCount, MAX_PAGES)), complete, ocrRan);
```

(`!ocrRan` with no prior progress is today's whole-doc no-OCR path: the VLM may describe it.)

**`vlmPass` takes prepared images, not PDF bytes.** Its signature becomes:

```ts
type VlmImage = { page: number; bytes: Uint8Array; mime: string };
vlmPass(pages: PageResult[], images: () => Promise<VlmImage[]>, complete, ocrRan: boolean)
```

- PDF caller: `const pdfImages = (n: number) => async () => (await deps.rasterizer.pdfToPngs(bytes, { pages: Array.from({ length: n }, (_, i) => i + 1) })).pages.map((p) => ({ page: p.page, bytes: p.png, mime: 'image/png' }));`
- Single-image caller: `async () => [{ page: 1, bytes, mime: mime ?? 'image/png' }]`. The image bytes never reach PDFium.

Inside `vlmPass`, load the images **before** the failure-counting `try`. A rasterizer error is not a VLM failure: `let imgs: VlmImage[]; try { imgs = await images(); } catch { return 'defer'; }`. Then, per image, it calls `downscale(img.bytes, img.mime)` → `seeWithMeta`, as today.

`vlmPass`'s counting catch replaces today's `catch { return 'defer'; }`:

```ts
} catch (err) {
  // Ordinary scheduling: the window closed. Never a failure.
  if (err instanceof LaneClosedError) return 'defer';
  // A see provider is downloading / will auto-install: wait for it.
  if (err instanceof NoProviderError && session.mayBecomeReady('see')) return 'defer';
  // A real VLM failure (incl. a NoProviderError nothing can ever fix).
  // Durable and change-free: no feed loop (large-file plan Task 4).
  const n = await session.bump('vlm');
  if (n >= 3 && ocrRan) return complete('local-ocr', pages, { vlm: 'unavailable' });
  return 'defer'; // pass 1 never ran → stay recoverable for when OCR appears
}
```

Add these tests to Step 1's block:

```ts
it('OCR lost between windows: a resumed doc defers instead of completing with unread pages', async () => {
  const { r } = pagedRasterizer(25);
  const prior = { pageCount: 25, pages: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i + 1), 'plenty of text '.repeat(20)])) };
  const s = fakeSession({ read: async () => { throw new NoProviderError('read'); }, see: jest.fn() });
  expect(await createVisionWorker({ rasterizer: r, laneOpen: () => true })
    .work(change({ metadata: { ...baseDoc.metadata, mime: 'application/pdf', ocrProgress: prior } }), s)).toBe('defer');
  expect(s.enriched).toEqual([]);
});
it('a text-poor PNG goes to the VLM as a PNG, never through the PDF rasterizer', async () => {
  const pdfToPngs = jest.fn();
  const see = jest.fn(async () => ({ text: 'a chart of sales', model: 'm' }));
  const png = change({ title: 'chart.png', metadata: { ...baseDoc.metadata, mime: 'image/png', filename: 'chart.png' } });
  const s = fakeSession({ read: async () => 'few', seeWithMeta: see });
  expect(await createVisionWorker({ rasterizer: { pdfToPngs } as never, laneOpen: () => true }).work(png, s)).toBe('done');
  expect(pdfToPngs).not.toHaveBeenCalled();
  expect(see.mock.calls[0][2]).toMatchObject({ mime: 'image/png' });
  expect(s.enriched[0].metadata.extraction.engine).toBe('local-ocr+vlm');
});
```

Match `seeWithMeta`'s fake shape to the existing `vision-worker.test.ts` helpers; the assertion is on the MIME it receives.

Non-VLM-decodable branch (~l.104): prefix it with `if (ocrFailed) return 'defer';`. Leave the rest as is. Update its comment: it finalizes only when pass 1 actually ran.

- [ ] **Step 5: Engine integration (real ledger, real re-drives)**

In `engine.test.ts`:
- Attach a real `createVisionWorker`. The inference fake has `read` returning `'few words'`, and **both** `see` and `seeWithMeta` throwing the spawn error. Otherwise the session's "seeWithMeta is not wired" Error is what gets counted.
- Commit a text-poor PDF doc. **Wait** until the live tail has deferred it: poll `store.ledgerHasDeferred(workerConsumerName(worker))` until it's true (≤ 2 s). Only then call `engine.rerunDeferred(worker)` twice. Calling it earlier finds no deferred row, so the count never reaches 3.

Assert:
- `metadata.extraction` is `{ engine: 'local-ocr', vlm: 'unavailable', … }`;
- the feed grew by exactly **one** change for that doc (the completing enrich): read the doc's `seq` before and after, or count change rows, the way the existing feed tests do.

- [ ] **Step 6: Run everything vision/engine/providers**

Run: `npx jest src/main/workers src/main/core src/main/providers`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/contracts.ts src/main/core src/main/providers src/main/workers
git commit -m "feat(vision): count real VLM failures (session.bump); finish OCR-only after 3 when OCR ran"
```

---

### Task 5: Stale-doc cleanup (core + alpha-cent)

- [ ] Fix the stale text. Grep each; the line numbers are from the spec:
  - core `src/main/core/engine/convert.ts:111` ("OCR … absent on Windows") → "OCR is off by default".
  - core `LEFTOVERS.md` §2: the helper now ships from the docker leg; drop "vendored into win32 packaging" as a future item.
  - core `docs/rebuild/backend-surface.md`: list `windows-ocr` next to `apple-vision` as `read` providers.
  - core `scripts/vendor-deep-extraction.mjs:12`: done in Task 1.
  - alpha-cent `scripts/release-local.sh:224`: done in Task 2.
- [ ] Commit each repo separately: `docs: windows OCR ships again`.

---

### Task 6: Release build and live check on the Windows VM

- [ ] **Release build, sequential** (release runbook; one leg at a time):
  1. Docker leg. It must print the verify step passing, with OCR included. Then fully kill Docker.
  2. The mac leg.
  3. Smoke mac.
  4. Smoke win (`node build/release-smoke.mjs --build-root ~/work/ac-prod-build`). RC builds use `KIA_TEST_BUILD=1`.
- [ ] **Live, `ssh win`** (auto-logon VM; GUI via `schtasks /IT`):
  - Install the RC.
  - Into a tracked local folder, copy: a scanned German PDF, a phone photo of a page (> 4000 px), a 12000 px-wide panorama screenshot with text, and a plain screenshot.
  - Leave the app idle on AC power for the processing window.
  - Via MCP `get`: each doc's markdown holds OCR text, the panorama is **not** empty, and `extraction.engine` is `local-ocr` (or `local-ocr+vlm` if the VLM worked).
  - Repeat **without** the German language pack: German umlauts may degrade, but text exists. Then remove every OCR language: docs stay deferred, not completed empty. Re-add a language, restart KIAgent, and the docs get OCR'd.

## Self-Review notes

- **Spec coverage:**
  - §1 (build on the Docker leg, versioned TFM, gate, fallback) → T1 and T2.
  - §2 (helper, provider, status, selftest, registration, large images, language help) → T1 (downscale) and T3.
  - §3 (`LaneClosedError` / `mayBecomeReady` / `bump('vlm')` / only-if-pass-1-ran / non-VLM-decodable branch / session accessor) → T4.
  - §4 → T5.
  - Testing (unit, worker, engine integration, build gate, live VM) → T2–T4 and T6.
- **Deviation (simplification).** `mayBecomeReady` is answered per provider, so `local-llm` keeps its prefs knowledge instead of the plane reading prefs. The behaviour is the spec's.
- **Ordering.** T4 depends on the large-file plan's Task 4 (`bump`) and Task 7 (`vlmPass`/`complete`). T1–T3 are independent of it.
