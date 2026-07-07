import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { LogLevel } from '@shared/contracts';
import { dir as createTempDir } from 'tmp-promise';

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
) => void;

export interface VisionHelper {
  ocrImage(bytes: Uint8Array, mime?: string): Promise<string>;
  rasterizePdf(bytes: Uint8Array, maxPages: number): Promise<Uint8Array[]>;
}

interface OcrResult {
  text: string;
  width: number;
  height: number;
  confidence: number;
}

interface RasterizeResult {
  pages: string[];
  pageCount: number;
}

interface VisionHelperOptions {
  binaryPath: string;
  log: (level: LogLevel, msg: string) => void;
  /** Override the child-process executor; injected in tests. */
  execFileFn?: ExecFileFn;
  timeoutMs?: number;
}

// Rasterizing a 20-page PDF or OCRing a dense scan are seconds-scale; 120s is
// a generous ceiling that still frees a wedged helper.
const DEFAULT_TIMEOUT_MS = 120_000;

class VisionHelperImpl implements VisionHelper {
  constructor(private readonly o: VisionHelperOptions) {}

  /** Invoke the binary with args, parse stdout as JSON; reject on non-zero exit, timeout, or malformed output. */
  private runJson<T>(args: string[]): Promise<T> {
    const exec = (this.o.execFileFn ?? execFile) as ExecFileFn;
    const timeoutMs = this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      exec(
        this.o.binaryPath,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            if (err.killed) {
              reject(
                new Error(
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
        },
      );
    });
  }

  private ocr(imagePath: string): Promise<OcrResult> {
    return this.runJson<OcrResult>(['ocr', imagePath]);
  }

  private rasterize(
    pdfPath: string,
    outDir: string,
    opts: { maxPages?: number; scale?: number } = {},
  ): Promise<RasterizeResult> {
    const args = ['rasterize', pdfPath, outDir];
    if (opts.maxPages !== undefined)
      args.push('--max-pages', String(opts.maxPages));
    if (opts.scale !== undefined) args.push('--scale', String(opts.scale));
    return this.runJson<RasterizeResult>(args);
  }

  async ocrImage(bytes: Uint8Array, mime?: string): Promise<string> {
    const tmpDir = await createTempDir({ unsafeCleanup: true });
    const ext =
      mime === 'image/png' ? '.png' : mime === 'image/jpeg' ? '.jpg' : '.png';
    const imagePath = path.join(tmpDir.path, `image${ext}`);
    try {
      await fs.promises.writeFile(imagePath, bytes);
      const result = await this.ocr(imagePath);
      return result.text;
    } finally {
      await tmpDir.cleanup();
    }
  }

  async rasterizePdf(
    bytes: Uint8Array,
    maxPages: number,
  ): Promise<Uint8Array[]> {
    const tmpDir = await createTempDir({ unsafeCleanup: true });
    // The helper creates outDir itself (withIntermediateDirectories).
    const outDir = path.join(tmpDir.path, 'pages');
    const pdfPath = path.join(tmpDir.path, 'input.pdf');
    try {
      await fs.promises.writeFile(pdfPath, bytes);
      const result = await this.rasterize(pdfPath, outDir, { maxPages });
      const pngBytes = await Promise.all(
        result.pages.map(async (pagePath) => {
          const data = await fs.promises.readFile(pagePath);
          return new Uint8Array(data);
        }),
      );
      return pngBytes;
    } finally {
      await tmpDir.cleanup();
    }
  }
}

export function makeVisionHelper(
  binaryPath: string,
  log: (level: LogLevel, msg: string) => void,
  /** Test-only seam: override execFile/timeout without touching the driver internals. */
  opts?: { execFileFn?: ExecFileFn; timeoutMs?: number },
): VisionHelper {
  return new VisionHelperImpl({ binaryPath, log, ...opts });
}
