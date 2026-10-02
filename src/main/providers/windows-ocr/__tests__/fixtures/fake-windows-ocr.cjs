#!/usr/bin/env node
// Env-driven stand-in for windows-ocr.exe (tests only).
const { env } = process;
if (process.argv[2] === 'selftest') {
  const ok = env.FAKE_WOCR_NOLANG !== '1';
  process.stdout.write(`${JSON.stringify({ ok })}\n`);
  process.exit(ok ? 0 : 1);
}
if (env.FAKE_WOCR_HANG) {
  setTimeout(() => {}, 60_000);
} else if (env.FAKE_WOCR_FAIL) {
  process.stderr.write('boom\n');
  process.exit(1);
} else {
  process.stdout.write(
    `${JSON.stringify({ text: env.FAKE_WOCR_TEXT ?? '', width: 1, height: 1, confidence: 1 })}\n`,
  );
}
