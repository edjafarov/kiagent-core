import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { LogLevel } from '@shared/contracts';

/** Native Windows OCR (WinRT Windows.Media.Ocr, native/windows-ocr) — the
 *  counterpart of apple-vision's kia-vision. Stateless; one exe run per
 *  image. A selftest non-zero exit is a status (no OCR language), never a
 *  throw. */
export function makeWindowsOcrHelper(
  exe: string,
  log: (level: LogLevel, msg: string) => void,
  opts: { timeoutMs?: number } = {},
) {
  const timeout = opts.timeoutMs ?? 60_000;
  const run = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        execFile(
          exe,
          args,
          {
            timeout,
            windowsHide: true,
            maxBuffer: 32 * 1024 * 1024,
            env: process.env,
          },
          (err, stdout, stderr) => {
            const e = err as
              | (NodeJS.ErrnoException & {
                  killed?: boolean;
                  code?: number | string;
                })
              | null;
            if (e?.killed) {
              reject(new Error(`windows-ocr timed out after ${timeout}ms`));
              return;
            }
            // A spawn failure (ENOENT, EACCES…) has a string code.
            if (e && typeof e.code !== 'number') {
              reject(e);
              return;
            }
            resolve({
              code: e ? Number(e.code) : 0,
              stdout: String(stdout),
              stderr: String(stderr),
            });
          },
        );
      },
    );
  return {
    async ocrImage(bytes: Uint8Array, mime = 'image/png'): Promise<string> {
      let ext = '.png';
      if (mime.includes('jpeg')) ext = '.jpg';
      else if (mime.includes('tiff')) ext = '.tif';
      else if (mime.includes('bmp')) ext = '.bmp';
      const dir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'kia-wocr-'),
      );
      const file = path.join(dir, `page${ext}`);
      try {
        await fs.promises.writeFile(file, bytes);
        const r = await run(['ocr', file]);
        if (r.code !== 0)
          throw new Error((r.stderr || `windows-ocr exited ${r.code}`).trim());
        return String((JSON.parse(r.stdout) as { text?: string }).text ?? '');
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    },
    /** Exit 1 + {"ok":false} = no OCR language on this profile. */
    async selftest(): Promise<{ ok: boolean }> {
      try {
        const r = await run(['selftest']);
        return {
          ok:
            r.code === 0 &&
            (JSON.parse(r.stdout) as { ok?: boolean }).ok === true,
        };
      } catch (err) {
        log('warn', `windows-ocr selftest failed: ${String(err)}`);
        return { ok: false };
      }
    },
  };
}
export type WindowsOcrHelper = ReturnType<typeof makeWindowsOcrHelper>;
