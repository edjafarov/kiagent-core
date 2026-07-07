/**
 * @jest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';

import { makeVisionHelper } from '../vision-helper';
import type { ExecFileFn } from '../vision-helper';

const noop = () => {};

describe('vision-helper driver (execFile protocol)', () => {
  it('spawns the binary with ["ocr", <image path>] and resolves with OCR text', async () => {
    let seenFile: string | undefined;
    let seenArgs: string[] | undefined;
    let imagePath: string | undefined;
    const exec: ExecFileFn = (file, args, _opts, callback) => {
      seenFile = file;
      seenArgs = args;
      [, imagePath] = args;
      callback(
        null,
        JSON.stringify({
          text: 'hello world',
          width: 10,
          height: 10,
          confidence: 0.9,
        }),
        '',
      );
    };
    const helper = makeVisionHelper('/opt/kia-vision', noop, {
      execFileFn: exec,
    });

    const text = await helper.ocrImage(new Uint8Array([1, 2, 3]), 'image/png');

    expect(seenFile).toBe('/opt/kia-vision');
    expect(seenArgs?.[0]).toBe('ocr');
    expect(imagePath).toMatch(/image\.png$/);
    expect(text).toBe('hello world');
    // temp-file cleanup on success: the tmp dir holding the written image is gone.
    expect(fs.existsSync(path.dirname(imagePath!))).toBe(false);
  });

  it('spawns the binary with ["rasterize", <pdf path>, <out dir>, "--max-pages", n] and resolves with page bytes', async () => {
    let seenArgs: string[] | undefined;
    let outDir: string | undefined;
    let pdfPath: string | undefined;
    const exec: ExecFileFn = (file, args, _opts, callback) => {
      seenArgs = args;
      [, pdfPath, outDir] = args;
      fs.mkdirSync(outDir, { recursive: true });
      const pagePath = path.join(outDir, 'page-0.png');
      fs.writeFileSync(pagePath, Buffer.from([9, 9, 9]));
      callback(null, JSON.stringify({ pages: [pagePath], pageCount: 1 }), '');
    };
    const helper = makeVisionHelper('/opt/kia-vision', noop, {
      execFileFn: exec,
    });

    const pages = await helper.rasterizePdf(new Uint8Array([1, 2, 3, 4]), 5);

    expect(seenArgs?.[0]).toBe('rasterize');
    expect(pdfPath).toMatch(/input\.pdf$/);
    expect(seenArgs?.slice(3)).toEqual(['--max-pages', '5']);
    expect(pages).toHaveLength(1);
    expect(Array.from(pages[0])).toEqual([9, 9, 9]);
    // temp-file cleanup on success: the tmp root (parent of outDir) is gone.
    expect(fs.existsSync(path.dirname(outDir!))).toBe(false);
  });

  it('rejects with a descriptive error on malformed JSON, and still cleans up the temp dir', async () => {
    let imagePath: string | undefined;
    const exec: ExecFileFn = (_file, args, _opts, callback) => {
      [, imagePath] = args;
      callback(null, 'not json', '');
    };
    const helper = makeVisionHelper('/opt/kia-vision', noop, {
      execFileFn: exec,
    });

    await expect(
      helper.ocrImage(new Uint8Array([1]), 'image/png'),
    ).rejects.toThrow(/kia-vision ocr returned malformed JSON/);
    expect(fs.existsSync(path.dirname(imagePath!))).toBe(false);
  });

  it('rejects with a timeout-specific message when execFile reports killed, and cleans up', async () => {
    let imagePath: string | undefined;
    const exec: ExecFileFn = (_file, args, _opts, callback) => {
      [, imagePath] = args;
      const err = Object.assign(new Error('signal SIGTERM'), { killed: true });
      callback(err, '', '');
    };
    const helper = makeVisionHelper('/opt/kia-vision', noop, {
      execFileFn: exec,
      timeoutMs: 5_000,
    });

    await expect(
      helper.ocrImage(new Uint8Array([1]), 'image/png'),
    ).rejects.toThrow(/kia-vision ocr timed out after 5000ms/);
    expect(fs.existsSync(path.dirname(imagePath!))).toBe(false);
  });

  it('rejects with the stderr message on non-zero exit, and cleans up', async () => {
    let pdfPath: string | undefined;
    const exec: ExecFileFn = (_file, args, _opts, callback) => {
      [, pdfPath] = args;
      callback(new Error('exited with code 1'), '', 'no such helper mode\n');
    };
    const helper = makeVisionHelper('/opt/kia-vision', noop, {
      execFileFn: exec,
    });

    await expect(
      helper.rasterizePdf(new Uint8Array([1, 2]), 3),
    ).rejects.toThrow(/kia-vision rasterize failed: no such helper mode/);
    expect(fs.existsSync(path.dirname(pdfPath!))).toBe(false);
  });
});
