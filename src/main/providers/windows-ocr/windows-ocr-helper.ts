import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { LogLevel } from '@shared/contracts';

import { launch, type ChildClass } from '../../core/child-priority';

/** Native Windows OCR (WinRT Windows.Media.Ocr, native/windows-ocr) — the
 *  counterpart of apple-vision's kia-vision. Stateless; one exe run per
 *  image. A selftest non-zero exit is a status (no OCR language), never a
 *  throw. */
export function makeWindowsOcrHelper(
  exe: string,
  log: (level: LogLevel, msg: string) => void,
  opts: {
    timeoutMs?: number;
    setPriority?: (pid: number, p: number) => void;
  } = {},
) {
  const timeout = opts.timeoutMs ?? 60_000;
  const run = (args: string[], cls: ChildClass = 'interactive') =>
    new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const cb = (
          err: Error | null,
          stdout: string | Buffer,
          stderr: string | Buffer,
        ) => {
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
        };
        launch(
          cls,
          exe,
          args,
          (c, a) =>
            execFile(
              c,
              a,
              {
                timeout,
                windowsHide: true,
                maxBuffer: 32 * 1024 * 1024,
                env: process.env,
              },
              cb,
            ),
          { platform: 'win32', setPriority: opts.setPriority },
        );
      },
    );
  return {
    async ocrImage(
      bytes: Uint8Array,
      mime = 'image/png',
      cls: ChildClass = 'interactive',
    ): Promise<string> {
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
        const r = await run(['ocr', file], cls);
        if (r.code !== 0)
          throw new Error((r.stderr || `windows-ocr exited ${r.code}`).trim());
        return String((JSON.parse(r.stdout) as { text?: string }).text ?? '');
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    },
    /** A parsed {"ok":false} (exit 1) = no OCR language on this profile.
     *  Anything else that is not ok — a crash, a timeout, AV blocking the
     *  exe — carries `error` with the reason, so the UI can tell them apart. */
    async selftest(): Promise<{ ok: boolean; error?: string }> {
      let r: { code: number; stdout: string; stderr: string };
      try {
        r = await run(['selftest']);
      } catch (err) {
        log('warn', `windows-ocr selftest failed: ${String(err)}`);
        return { ok: false, error: String(err) };
      }
      let parsed: { ok?: unknown } | null = null;
      try {
        parsed = JSON.parse(r.stdout) as { ok?: unknown };
      } catch {
        parsed = null;
      }
      if (parsed?.ok === true && r.code === 0) return { ok: true };
      if (parsed?.ok === false) return { ok: false };
      const reason =
        r.stderr.trim().split('\n')[0] || `windows-ocr exited ${r.code}`;
      log('warn', `windows-ocr selftest failed: ${r.stderr.trim() || reason}`);
      return { ok: false, error: reason };
    },
  };
}
export type WindowsOcrHelper = ReturnType<typeof makeWindowsOcrHelper>;
