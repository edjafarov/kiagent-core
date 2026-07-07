import fs from 'node:fs';
import fsp, { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { downloadModel, modelFilesPresent, DownloadError } from '../downloader';
import type { ModelDescriptor } from '../models';

describe('downloader', () => {
  let destDir: string;

  beforeEach(async () => {
    destDir = await mkdtemp(path.join(tmpdir(), 'downloader-test-'));
  });

  afterEach(async () => {
    // Clean up test directory
    await fsp.rm(destDir, { recursive: true, force: true });
  });

  /**
   * Create a mock fetch function that returns a Response-like object
   * with a body that can be consumed as a web stream.
   */
  function createMockFetch(scenarios: Record<string, any>) {
    return async (url: string, opts?: any) => {
      const scenario = scenarios[url];
      if (!scenario) {
        throw new Error(`No mock scenario for ${url}`);
      }

      if (scenario.expectHeaders) {
        for (const [key, value] of Object.entries(scenario.expectHeaders)) {
          if (opts?.headers?.[key] !== value) {
            throw new Error(
              `Expected header ${key}: ${value}, got ${opts?.headers?.[key]}`,
            );
          }
        }
      }

      const { body } = scenario;
      const status = scenario.status || 200;
      const headers = scenario.headers || {};

      // Create a web stream from the buffer
      const readable = Readable.from([Buffer.from(body)]);
      const webStream = Readable.toWeb(readable) as any;

      return {
        ok: status >= 200 && status < 300,
        status,
        body: webStream,
        headers: {
          get: (key: string) => headers[key.toLowerCase()],
        },
      };
    };
  }

  /**
   * Test 1: Happy path — full body, 200 → file exists at final name, no `.part`, progress reached (total, total).
   */
  it('happy path: downloads full model with 200 status', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

    const model: ModelDescriptor = {
      id: 'test-model',
      label: 'Test Model',
      files: [
        {
          name: 'model.gguf',
          url: 'http://example.com/model.gguf',
          sha256,
          sizeBytes: payload.length,
        },
      ],
    };

    const progressCalls: Array<[number, number]> = [];

    const fetchImpl = createMockFetch({
      'http://example.com/model.gguf': {
        body: payload,
        status: 200,
      },
    });

    await downloadModel(model, destDir, {
      onProgress: (received, total) => {
        progressCalls.push([received, total]);
      },
      fetchImpl: fetchImpl as any,
    });

    const finalPath = path.join(destDir, 'model.gguf');
    const partPath = `${finalPath}.part`;

    expect(fs.existsSync(finalPath)).toBe(true);
    expect(fs.existsSync(partPath)).toBe(false);
    expect(progressCalls).toContainEqual([payload.length, payload.length]);
  });

  /**
   * Test 2: Resume — pre-write the first half as `<name>.part`; fetch asserts `Range: bytes=<half>-`, replies 206 with the second half.
   */
  it('resume: resumes partial download with 206 status', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
    const half = Math.floor(payload.length / 2);

    const model: ModelDescriptor = {
      id: 'test-model',
      label: 'Test Model',
      files: [
        {
          name: 'model.gguf',
          url: 'http://example.com/model.gguf',
          sha256,
          sizeBytes: payload.length,
        },
      ],
    };

    const finalPath = path.join(destDir, 'model.gguf');
    const partPath = `${finalPath}.part`;

    // Pre-write first half as .part
    await fsp.writeFile(partPath, payload.slice(0, half));

    const fetchImpl = createMockFetch({
      'http://example.com/model.gguf': {
        body: payload.slice(half),
        status: 206,
        headers: {
          'content-range': `bytes ${half}-${payload.length - 1}/${payload.length}`,
        },
        expectHeaders: {
          Range: `bytes=${half}-`,
        },
      },
    });

    await downloadModel(model, destDir, {
      fetchImpl: fetchImpl as any,
    });

    expect(fs.existsSync(finalPath)).toBe(true);
    expect(fs.existsSync(partPath)).toBe(false);
  });

  /**
   * Test 3: SHA mismatch — correct size, wrong bytes → rejects with `DownloadError` code `sha_mismatch`, `.part` deleted.
   */
  it('sha mismatch: rejects with correct error and deletes .part', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const correctSha256 = crypto
      .createHash('sha256')
      .update(payload)
      .digest('hex');
    const wrongPayload = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);

    const model: ModelDescriptor = {
      id: 'test-model',
      label: 'Test Model',
      files: [
        {
          name: 'model.gguf',
          url: 'http://example.com/model.gguf',
          sha256: correctSha256,
          sizeBytes: payload.length,
        },
      ],
    };

    const fetchImpl = createMockFetch({
      'http://example.com/model.gguf': {
        body: wrongPayload,
        status: 200,
      },
    });

    const err = await downloadModel(model, destDir, {
      fetchImpl: fetchImpl as any,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect(err.code).toBe('sha_mismatch');

    const partPath = path.join(destDir, 'model.gguf.part');
    expect(fs.existsSync(partPath)).toBe(false);
  });

  /**
   * Test 4: Disk preflight — free disk < 1.5× total size → rejects `disk_full`, no fetch call.
   */
  it('disk preflight: rejects disk_full and skips fetch', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

    const model: ModelDescriptor = {
      id: 'test-model',
      label: 'Test Model',
      files: [
        {
          name: 'model.gguf',
          url: 'http://example.com/model.gguf',
          sha256,
          sizeBytes: payload.length,
        },
      ],
    };

    const fetchImpl = jest.fn();

    const err = await downloadModel(model, destDir, {
      freeDiskBytes: async () => payload.length, // < 1.5 × payload.length
      fetchImpl: fetchImpl as any,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect(err.code).toBe('disk_full');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * Test 5: Idempotent — run twice; second run must not call fetch (correctly-sized final file skipped).
   */
  it('idempotent: skips correctly-sized file on second run', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

    const model: ModelDescriptor = {
      id: 'test-model',
      label: 'Test Model',
      files: [
        {
          name: 'model.gguf',
          url: 'http://example.com/model.gguf',
          sha256,
          sizeBytes: payload.length,
        },
      ],
    };

    const fetchImpl = jest.fn(
      createMockFetch({
        'http://example.com/model.gguf': {
          body: payload,
          status: 200,
        },
      }),
    );

    // First download
    await downloadModel(model, destDir, {
      fetchImpl: fetchImpl as any,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Reset mock
    fetchImpl.mockClear();

    // Second download (should skip)
    await downloadModel(model, destDir, {
      fetchImpl: fetchImpl as any,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * Test 6: Disk preflight with non-existent destDir — mkdir should happen before statfs.
   */
  it('downloads to non-existent nested directory without ENOENT error', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

    const model: ModelDescriptor = {
      id: 'test-model',
      label: 'Test Model',
      files: [
        {
          name: 'model.gguf',
          url: 'http://example.com/model.gguf',
          sha256,
          sizeBytes: payload.length,
        },
      ],
    };

    const fetchImpl = createMockFetch({
      'http://example.com/model.gguf': {
        body: payload,
        status: 200,
      },
    });

    // Use a nested path that doesn't exist yet
    const nestedDir = path.join(destDir, 'not-yet-created', 'nested');

    await downloadModel(model, nestedDir, {
      fetchImpl: fetchImpl as any,
    });

    const finalPath = path.join(nestedDir, 'model.gguf');
    expect(fs.existsSync(finalPath)).toBe(true);
  });

  /**
   * Test 7: `modelFilesPresent` — true/false by exact size match.
   */
  it('modelFilesPresent: checks file existence and size', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

    const model: ModelDescriptor = {
      id: 'test-model',
      label: 'Test Model',
      files: [
        {
          name: 'model.gguf',
          url: 'http://example.com/model.gguf',
          sha256,
          sizeBytes: payload.length,
        },
      ],
    };

    // Before download, should be false
    expect(modelFilesPresent(model, destDir)).toBe(false);

    // Create file with correct size
    const finalPath = path.join(destDir, 'model.gguf');
    await fsp.writeFile(finalPath, payload);

    // After creating file, should be true
    expect(modelFilesPresent(model, destDir)).toBe(true);

    // Create file with wrong size
    const wrongPayload = new Uint8Array([1, 2, 3]);
    await fsp.writeFile(finalPath, wrongPayload);

    // With wrong size, should be false
    expect(modelFilesPresent(model, destDir)).toBe(false);
  });
});
