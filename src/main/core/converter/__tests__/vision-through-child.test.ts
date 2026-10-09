/**
 * @jest-environment node
 */
import path from 'node:path';

import type { Change, Document, WorkerSession } from '@shared/contracts';

import {
  createWorkerEnv,
  REPO_ROOT,
} from '../../../db/__tests__/worker-test-env';
import { multiPagePdf } from '../../engine/__tests__/pdf-fixture';
import { forkRunnerChild } from '../../mcp/sql-runner-spawn';
import { pickRasterizer } from '../../../workers/vision/rasterize';
import { createVisionWorker } from '../../../workers/vision/vision-worker';
import { createConverterRunner } from '../runner';

jest.setTimeout(240_000);

const ENTRY = path.join(REPO_ROOT, 'src', 'main', 'converter', 'worker.ts');

it('windowed OCR of a 25-page scanned PDF completes every window through the child', async () => {
  const env = createWorkerEnv('vision-child');
  const converter = createConverterRunner({
    spawn: () =>
      forkRunnerChild(ENTRY, {
        execArgv: env.execArgv,
        cwd: REPO_ROOT,
        serialization: 'advanced',
      }),
    startTimeoutMs: 90_000,
  });
  try {
    const bytes = multiPagePdf(
      Array.from({ length: 25 }, () => ({ scan: true })),
    );
    const worker = createVisionWorker({
      rasterizer: pickRasterizer(null, 'linux', converter),
      laneOpen: () => true,
      parsePdfPages: (b, s) => converter.parsePdfPages(b, s),
    });
    let doc = {
      id: 'd',
      accountId: 'a',
      externalId: 'x',
      type: 'attachment',
      title: 'scan.pdf',
      markdown: null,
      metadata: {
        mime: 'application/pdf',
        sizeBytes: bytes.length,
        conversion: { status: 'text-poor' },
      },
      createdAt: null,
      parentId: null,
      contentHash: 'h',
      seq: 1,
      ingestSeq: 1,
      archivedAt: null,
      languages: [],
      ingestedAt: '2026-01-01',
      updatedAt: '2026-01-01',
      scopeRootId: null,
    } as Document;
    const reads: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const enriched: Array<{
        markdown?: string;
        metadata?: Record<string, unknown>;
      }> = [];
      const session = {
        signal: new AbortController().signal,
        read: async (png: Uint8Array) => {
          reads.push(png.length);
          return 'recognised words on this page '.repeat(3);
        },
        fetchBytes: async () => bytes,
        bump: async () => 1,
        mayBecomeReady: () => false,
        hasProvider: () => true,
        enrich: (e: {
          markdown?: string;
          metadata?: Record<string, unknown>;
        }) => enriched.push(e),
        log: () => {},
      } as unknown as WorkerSession;
      // eslint-disable-next-line no-await-in-loop
      expect(
        await worker.work(
          { seq: run + 1, kind: 'document', document: doc } as Change,
          session,
        ),
      ).toBe('done');
      const e = enriched[0];
      doc = {
        ...doc,
        markdown: e.markdown ?? doc.markdown,
        metadata: JSON.parse(
          JSON.stringify({ ...doc.metadata, ...e.metadata }),
        ),
      };
      if ((doc.metadata as { extraction?: unknown }).extraction) break;
    }
    expect(reads).toHaveLength(25);
    expect(
      (doc.metadata as { extraction?: { engine?: string } }).extraction?.engine,
    ).toBe('local-ocr');
    expect(converter.stats().crashes).toBe(0);
  } finally {
    await converter.stop();
    env.cleanup();
  }
});
