import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { LogLevel } from '@shared/contracts';
import { dir as createTempDir } from 'tmp-promise';

import { launch, type ChildClass } from '../../core/child-priority';
import {
  HelperTimeoutError,
  type RasterResult,
} from '../../workers/vision/rasterize';

/** Narrow execFile shape used by VisionHelper — avoids coupling to node's overloaded typeof execFile. */
export type ExecFileFn = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number },
  callback: (
    err: (Error & { killed?: boolean }) | null,
    stdout: string | Buffer,
    stderr: string | Buffer,
  ) => void,
) => { pid?: number } | void;

export interface VisionHelper {
  /** `cls` follows the request lane; rasterizePdf is always background (vision worker only). */
  ocrImage(bytes: Uint8Array, mime?: string, cls?: ChildClass): Promise<string>;
  /** Renders the requested 1-based pages; out-of-range numbers are skipped. */
  rasterizePdf(bytes: Uint8Array, pages: number[]): Promise<RasterResult>;
}

interface OcrResult {
  text: string;
  width: number;
  height: number;
  confidence: number;
}

interface RasterizeResult {
  pages: string[];
  /** 1-based page number of each entry in `pages` (absent from old helpers). */
  pageNumbers?: number[];
  pageCount: number;
}

interface VisionHelperOptions {
  binaryPath: string;
  log: (level: LogLevel, msg: string) => void;
  /** Override the child-process executor; injected in tests. */
  execFileFn?: ExecFileFn;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  taskpolicyExists?: (p: string) => boolean;
}

// Rasterizing a 20-page PDF or OCRing a dense scan are seconds-scale; 120s is
// a generous ceiling that still frees a wedged helper.
const DEFAULT_TIMEOUT_MS = 120_000;

class VisionHelperImpl implements VisionHelper {
  constructor(private readonly o: VisionHelperOptions) {}

  /** Invoke the binary with args, parse stdout as JSON; reject on non-zero exit, timeout, or malformed output. */
  private runJson<T>(args: string[], cls: ChildClass): Promise<T> {
    const exec = (this.o.execFileFn ?? execFile) as ExecFileFn;
    const timeoutMs = this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const cb: Parameters<ExecFileFn>[3] = (err, stdout, stderr) => {
        if (err) {
          if (err.killed) {
            reject(
              new HelperTimeoutError(
                `kia-vision ${args[0]} timed out after ${timeoutMs}ms`,
              ),
            );
          } else {
            reject(
              new Error(
                `kia-vision ${args[0]} failed: ${
                  stderr?.toString().trim() || err.message
                }`,
              ),
            );
          }
          return;
        }
        try {
          resolve(JSON.parse(stdout.toString()) as T);
        } catch {
          reject(new Error(`kia-vision ${args[0]} returned malformed JSON`));
        }
      };
      launch(
        cls,
        this.o.binaryPath,
        args,
        (cmd, a) =>
          exec(cmd, a, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, cb),
        { platform: this.o.platform, exists: this.o.taskpolicyExists },
      );
    });
  }

  private ocr(imagePath: string, cls: ChildClass): Promise<OcrResult> {
    return this.runJson<OcrResult>(['ocr', imagePath], cls);
  }

  private rasterize(
    pdfPath: string,
    outDir: string,
    opts: { pages?: number[]; scale?: number } = {},
  ): Promise<RasterizeResult> {
    const args = ['rasterize', pdfPath, outDir];
    if (opts.pages) args.push('--pages', opts.pages.join(','));
    if (opts.scale !== undefined) args.push('--scale', String(opts.scale));
    return this.runJson<RasterizeResult>(args, 'background');
  }

  async ocrImage(
    bytes: Uint8Array,
    mime?: string,
    cls: ChildClass = 'interactive',
  ): Promise<string> {
    const tmpDir = await createTempDir({ unsafeCleanup: true });
    const ext =
      mime === 'image/png' ? '.png' : mime === 'image/jpeg' ? '.jpg' : '.png';
    const imagePath = path.join(tmpDir.path, `image${ext}`);
    try {
      await fs.promises.writeFile(imagePath, bytes);
      const result = await this.ocr(imagePath, cls);
      return result.text;
    } finally {
      await tmpDir.cleanup();
    }
  }

  async rasterizePdf(
    bytes: Uint8Array,
    pages: number[],
  ): Promise<RasterResult> {
    const tmpDir = await createTempDir({ unsafeCleanup: true });
    // The helper creates outDir itself (withIntermediateDirectories).
    const outDir = path.join(tmpDir.path, 'pages');
    const pdfPath = path.join(tmpDir.path, 'input.pdf');
    try {
      await fs.promises.writeFile(pdfPath, bytes);
      const result = await this.rasterize(pdfPath, outDir, { pages });
      const pngs = await Promise.all(
        result.pages.map(async (pagePath) => {
          const data = await fs.promises.readFile(pagePath);
          return new Uint8Array(data);
        }),
      );
      const numbers = result.pageNumbers ?? pngs.map((_, i) => i + 1);
      return {
        pageCount: result.pageCount,
        pages: pngs.map((png, i) => ({ page: numbers[i], png })),
      };
    } finally {
      await tmpDir.cleanup();
    }
  }
}

export function makeVisionHelper(
  binaryPath: string,
  log: (level: LogLevel, msg: string) => void,
  /** Test-only seam: override execFile/timeout without touching the driver internals. */
  opts?: {
    execFileFn?: ExecFileFn;
    timeoutMs?: number;
    platform?: NodeJS.Platform;
    taskpolicyExists?: (p: string) => boolean;
  },
): VisionHelper {
  return new VisionHelperImpl({ binaryPath, log, ...opts });
}
