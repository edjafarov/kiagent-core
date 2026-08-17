// Vendors the deep-extraction native binaries into assets/ before packaging,
// so a locally packaged build can never silently ship the feature inert.
// Mirrors the per-OS vendor step in .github/workflows/release.yml.
//   - llama-server: fetched for every slug this host packages (all platforms).
//   - whisper-cli: fetched (linux/win) or built from source (darwin) for
//     local ASR — see scripts/whisper-assets.mjs.
//   - silero VAD model: fetched on EVERY platform (it is platform-independent,
//     and darwin fetches no whisper slugs at all) — without it the `hear`
//     route decodes silence into hallucinated repeats.
//   - kia-vision: built only on darwin (native OCR via Swift Vision framework).
//   - windows-ocr: built only on win32 (native OCR via .NET 8 + Windows.Media.Ocr).
//     Win/Linux without a native helper use the WASM rasterizer + GLM-OCR.
import { spawnSync } from 'node:child_process';

function run(script, args = []) {
  const r = spawnSync(process.execPath, [`scripts/${script}`, ...args], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run('fetch-llama-server.mjs'); // defaults to slugsForHost(process.platform, process.arch)
run('fetch-whisper-cli.mjs'); // prebuilt whisper-cli (linux/win); clean no-op on darwin
run('fetch-whisper-vad.mjs'); // silero VAD model — all platforms, not slug-gated
if (process.platform === 'darwin') {
  run('build-whisper.mjs'); // whisper-cli from source, both mac arches (no upstream macOS binary)
  run('build-vision-helper.mjs');
} else if (process.platform === 'win32') {
  run('build-windows-ocr-helper.mjs');
} else {
  console.log(`[vendor] native OCR helper skipped on ${process.platform} (WASM rasterizer + GLM-OCR)`);
}
