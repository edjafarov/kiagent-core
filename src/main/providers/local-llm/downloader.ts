import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ModelDescriptor, ModelFile } from './models';
import { modelTotalBytes } from './models';

export type DownloadErrorCode = 'disk_full' | 'sha_mismatch' | 'http' | 'aborted';

export class DownloadError extends Error {
  constructor(
    public readonly code: DownloadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface DownloadOptions {
  /** Cumulative progress across all files. */
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  /** Fetch implementation (default: globalThis.fetch). */
  fetchImpl?: typeof fetch;
  /** Free bytes on the destination volume (default: check via statfs). */
  freeDiskBytes?: (dir: string) => Promise<number>;
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

async function getFreeDiskBytes(dir: string): Promise<number> {
  const stat = await fsp.statfs(dir);
  return stat.bavail * stat.bsize;
}

/**
 * Download every file of `model` into `destDir`, resumable and checksum-verified.
 * Throws DownloadError on disk/network/checksum failure, leaving a resumable
 * `.part` for the network case (and nothing for checksum mismatch). Idempotent:
 * a present, correctly-sized final file is skipped (its checksum is trusted on
 * the size match to avoid re-hashing multi-GB files every launch — a fresh
 * download always hashes before promoting).
 */
export async function downloadModel(
  model: ModelDescriptor,
  destDir: string,
  opts: DownloadOptions = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const freeDiskBytesImpl = opts.freeDiskBytes ?? getFreeDiskBytes;

  await fsp.mkdir(destDir, { recursive: true });

  const total = modelTotalBytes(model);
  const free = await freeDiskBytesImpl(destDir);
  if (free < total * 1.5) {
    throw new DownloadError(
      'disk_full',
      `Need ~${Math.ceil((total * 1.5) / 1024 ** 3)} GB free to download the model.`,
    );
  }

  // Bytes already on disk in completed files, so progress is cumulative.
  let baseReceived = 0;
  for (const f of model.files) {
    const finalPath = path.join(destDir, f.name);
    if (fileSize(finalPath) === f.sizeBytes)
      baseReceived += f.sizeBytes;
  }

  for (const f of model.files) {
    const finalPath = path.join(destDir, f.name);
    if (fileSize(finalPath) === f.sizeBytes) continue; // already done
    baseReceived = await downloadOne(
      f,
      destDir,
      baseReceived,
      total,
      opts,
      fetchImpl,
    );
  }
}

async function downloadOne(
  f: ModelFile,
  destDir: string,
  baseReceived: number,
  total: number,
  opts: DownloadOptions,
  fetchImpl: typeof fetch,
): Promise<number> {
  const finalPath = path.join(destDir, f.name);
  const partPath = `${finalPath}.part`;
  let start = fileSize(partPath);

  // A .part at/over the expected size means a prior run finished the transfer
  // but died before checksum+promote (or left a stale/oversized file). Ranging
  // from here sends `Range: bytes=<sizeBytes>-`, which an RFC-compliant server
  // answers with 416 → treated as a network error → the .part survives → every
  // retry wedges forever. Settle it in place instead: promote if it already
  // matches the checksum, else discard and re-download clean from offset 0.
  if (start >= f.sizeBytes) {
    if ((await sha256File(partPath)) === f.sha256) {
      await fsp.rename(partPath, finalPath);
      return baseReceived + f.sizeBytes;
    }
    await fsp.rm(partPath, { force: true });
    start = 0;
  }

  let res: Response;
  try {
    res = await fetchImpl(f.url, {
      headers: start > 0 ? { Range: `bytes=${start}-` } : {},
      signal: opts.signal,
    });
  } catch (e) {
    const errorMsg = (e as Error).message;
    if (opts.signal?.aborted) {
      throw new DownloadError(
        'aborted',
        `Download aborted: ${errorMsg}`,
      );
    }
    throw new DownloadError(
      'http',
      `Download failed: ${errorMsg}`,
    );
  }
  if (!res.ok || !res.body) {
    throw new DownloadError('http', `Download failed: HTTP ${res.status}`);
  }

  // A 200 to a Range request means the server ignored the range — restart clean.
  const append = start > 0 && res.status === 206;

  // A 206 that resumes from a different offset than requested would silently
  // corrupt the splice — verify before writing a single byte (.part survives).
  if (append) {
    const cr = res.headers.get('content-range');
    const m = cr ? /^bytes (\d+)-/.exec(cr) : null;
    if (cr && (!m || Number(m[1]) !== start)) {
      throw new DownloadError(
        'http',
        `Resume offset mismatch for ${f.name}: asked ${start}, got ${cr}`,
      );
    }
  }

  // Hash the bytes as they arrive (existing prefix first when appending) so a
  // final mismatch is attributable: stream hash wrong → bad bytes off the
  // wire; stream hash right but file hash wrong → write path / disk lied.
  const streamHash = crypto.createHash('sha256');
  if (append) {
    for await (const chunk of fs.createReadStream(partPath)) {
      streamHash.update(chunk as Buffer);
    }
  }

  const out = fs.createWriteStream(partPath, { flags: append ? 'a' : 'w' });
  let received = append ? start : 0;

  try {
    const src = Readable.fromWeb(
      res.body as Parameters<typeof Readable.fromWeb>[0],
    );
    // Single consumer, and every chunk is copied before entering the write
    // queue: a fetch body chunk's backing buffer may be recycled by its
    // producer once the chunk is "consumed", while fs.WriteStream flushes
    // asynchronously — writing the original buffer raced that reuse and put
    // garbage on disk at multi-GB scale (field corruption, 2026-06-10, where
    // the streamed hash and the on-disk hash of the same attempt disagreed).
    await pipeline(
      src,
      async function* copyAndCount(source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          received += chunk.length;
          streamHash.update(chunk);
          opts.onProgress?.(baseReceived + received, total);
          yield Buffer.from(chunk);
        }
      },
      out,
    );
  } catch (e) {
    const errorMsg = (e as Error).message;
    if (opts.signal?.aborted) {
      throw new DownloadError(
        'aborted',
        `Download interrupted: ${errorMsg}`,
      );
    }
    throw new DownloadError(
      'http',
      `Download interrupted: ${errorMsg}`,
    );
  }

  // A CDN can end a chunked/HTTP-2 body cleanly before all bytes arrive, so a
  // resolved pipeline doesn't prove the transfer completed. Hashing a short
  // .part would misreport truncation as checksum_mismatch and destroy hours of
  // resumable progress — size-gate first and keep the .part for resume.
  const got = fileSize(partPath);
  if (got < f.sizeBytes) {
    throw new DownloadError(
      'http',
      `Download incomplete for ${f.name}: got ${got} of ${f.sizeBytes} bytes`,
    );
  }

  const streamed = streamHash.digest('hex');
  const actual = await sha256File(partPath);
  if (actual !== f.sha256) {
    await fsp.rm(partPath, { force: true });
    const verdict =
      streamed === actual
        ? 'server delivered wrong bytes'
        : streamed === f.sha256
          ? 'stream was correct but the file on disk differs (write/disk fault)'
          : 'stream and file disagree';
    throw new DownloadError(
      'sha_mismatch',
      `Checksum mismatch for ${f.name}: expected ${f.sha256.slice(0, 12)}…, ` +
        `file ${actual.slice(0, 12)}…, stream ${streamed.slice(0, 12)}… — ${verdict}`,
    );
  }
  await fsp.rename(partPath, finalPath);
  return baseReceived + f.sizeBytes;
}

/** True when every file is present at its exact expected size (cheap boot check). */
export function modelFilesPresent(
  model: ModelDescriptor,
  destDir: string,
): boolean {
  for (const f of model.files) {
    if (fileSize(path.join(destDir, f.name)) !== f.sizeBytes)
      return false;
  }
  return true;
}
