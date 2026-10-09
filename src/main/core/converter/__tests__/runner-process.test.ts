/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PNG } from 'pngjs';

import {
  createWorkerEnv,
  REPO_ROOT,
} from '../../../db/__tests__/worker-test-env';
import { multiPagePdf, PROSE_LINES } from '../../engine/__tests__/pdf-fixture';
import { forkRunnerChild } from '../../mcp/sql-runner-spawn';
import { createInlineConverter, type Converter } from '../converter';
import { createConverterRunner } from '../runner';

jest.setTimeout(180_000);

const ENTRY = path.join(REPO_ROOT, 'src', 'main', 'converter', 'worker.ts');
const SPIN = path.join(__dirname, 'fixtures', 'spinning-converter.cjs');
const FIXTURES = path.join(
  REPO_ROOT,
  'src',
  'main',
  'core',
  'engine',
  '__tests__',
  'fixtures',
);

const MIME: Record<string, string> = {
  msg: 'application/vnd.ms-outlook',
  pdf: 'application/pdf',
  eml: 'message/rfc822',
  html: 'text/html',
  csv: 'text/csv',
  txt: 'text/plain',
};
const mimeOf = (name: string) =>
  MIME[name.split('.').pop() ?? ''] ?? 'application/octet-stream';

function walk(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
}

const settle = <T>(p: Promise<T>) =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e: Error) => ({ ok: false as const, name: e.name, message: e.message }),
  );

/** The parsers' ESM-only deps (mailparser, turndown, …) live in
 *  release/app/node_modules, which jest finds through `moduleDirectories` and
 *  webpack bundles — but a ts-node child resolves `await import()` natively,
 *  and the ESM resolver ignores NODE_PATH. This preload adds the same
 *  fallback jest has, for bare specifiers only. */
function releaseAppResolvePreload(): { path: string; cleanup(): void } {
  const file = path.join(
    os.tmpdir(),
    `kiagent-converter-resolve-${process.pid}-${Date.now()}.js`,
  );
  const base = pathToFileURL(
    path.join(REPO_ROOT, 'release', 'app', 'node_modules', 'x.js'),
  ).href;
  fs.writeFileSync(
    file,
    `const { registerHooks } = require('node:module');
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^[./]|^node:|^file:/.test(specifier)) throw e;
      return next(specifier, { ...context, parentURL: ${JSON.stringify(base)} });
    }
  },
});
`,
  );
  return { path: file, cleanup: () => fs.rmSync(file, { force: true }) };
}

describe('converter over a real child process', () => {
  const env = createWorkerEnv('converter');
  const resolvePreload = releaseAppResolvePreload();
  const spawnReal = () =>
    forkRunnerChild(ENTRY, {
      execArgv: [...env.execArgv, '-r', resolvePreload.path],
      cwd: REPO_ROOT,
      serialization: 'advanced',
    });
  let child: Converter;
  const inline = createInlineConverter();

  beforeAll(() => {
    child = createConverterRunner({ spawn: spawnReal, startTimeoutMs: 90_000 });
  });
  afterAll(async () => {
    await child.stop();
    env.cleanup();
    resolvePreload.cleanup();
  });

  it('every fixture parses identically inline and through the child', async () => {
    const generated: Array<[string, Uint8Array]> = [
      [
        'prose.pdf',
        multiPagePdf([{ text: PROSE_LINES }, { scan: true }, { blank: true }]),
      ],
      ['scan.pdf', multiPagePdf([{ scan: true }])],
      [
        'note.eml',
        Buffer.from('Subject: Hi\r\nFrom: a@b.c\r\n\r\nHello there body\r\n'),
      ],
      ['page.html', Buffer.from('<h1>Title</h1><p>para <b>bold</b></p>')],
      ['t.csv', Buffer.from('a,b\n1,2\n')],
    ];
    const onDisk = walk(FIXTURES).map((f): [string, Uint8Array] => [
      path.basename(f),
      new Uint8Array(fs.readFileSync(f)),
    ]);
    for (const [name, bytes] of [...onDisk, ...generated]) {
      // eslint-disable-next-line no-await-in-loop
      const a = await settle(inline.parseDetailed(bytes, mimeOf(name), name));
      // eslint-disable-next-line no-await-in-loop
      const b = await settle(child.parseDetailed(bytes, mimeOf(name), name));
      expect({ name, ...b }).toEqual({ name, ...a });
    }
  });

  it('rasterizePdf without maxEdge is byte-identical to the in-process 2× render', async () => {
    const pdf = multiPagePdf([{ text: PROSE_LINES }, { scan: true }]);
    const a = await inline.rasterizePdf(pdf, [1, 2]);
    const b = await child.rasterizePdf(pdf, [1, 2]);
    expect(b.pageCount).toBe(a.pageCount);
    expect(b.pages.map((p) => p.page)).toEqual(a.pages.map((p) => p.page));
    for (let i = 0; i < a.pages.length; i += 1)
      expect(
        Buffer.compare(
          Buffer.from(a.pages[i].png),
          Buffer.from(b.pages[i].png),
        ),
      ).toBe(0);
  });

  it('a windowed request reports the document’s total pageCount, and 25 pages complete in windows', async () => {
    const pdf = multiPagePdf(
      Array.from({ length: 25 }, () => ({ scan: true as const })),
    );
    const seen = new Set<number>();
    for (let start = 1; start <= 25; start += 10) {
      const want = Array.from(
        { length: Math.min(10, 26 - start) },
        (_, i) => start + i,
      );
      // eslint-disable-next-line no-await-in-loop
      const r = await child.rasterizePdf(pdf, want);
      expect(r.pageCount).toBe(25);
      for (const p of r.pages) seen.add(p.page);
    }
    expect(seen.size).toBe(25);
  });

  it('with maxEdge it renders at the target edge and matches the 2× render after downscale', async () => {
    const pdf = multiPagePdf([{ text: PROSE_LINES }]);
    const small = PNG.sync.read(
      Buffer.from(
        (await child.rasterizePdf(pdf, [1], { maxEdge: 896 })).pages[0].png,
      ),
    );
    expect(Math.max(small.width, small.height)).toBeGreaterThanOrEqual(894);
    expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(896);
    const big = PNG.sync.read(
      Buffer.from((await child.rasterizePdf(pdf, [1])).pages[0].png),
    );
    // Nearest-neighbour downscale of the old 2× page to the new size, then
    // the mean absolute RGB difference: equal content, different sampling.
    let diff = 0;
    for (let y = 0; y < small.height; y += 1)
      for (let x = 0; x < small.width; x += 1) {
        const sx = Math.min(
          big.width - 1,
          Math.floor((x * big.width) / small.width),
        );
        const sy = Math.min(
          big.height - 1,
          Math.floor((y * big.height) / small.height),
        );
        const s = (y * small.width + x) * 4;
        const b = (sy * big.width + sx) * 4;
        for (let c = 0; c < 3; c += 1)
          diff += Math.abs(small.data[s + c] - big.data[b + c]);
      }
    expect(diff / (small.width * small.height * 3)).toBeLessThan(12);
  });

  it('a spinning child: main keeps ticking, the timeout kills it, the respawned child serves the next job', async () => {
    let spawns = 0;
    const runner = createConverterRunner({
      spawn: () => {
        spawns += 1;
        return spawns === 1
          ? forkRunnerChild(SPIN, { serialization: 'advanced' })
          : spawnReal();
      },
      timeoutMs: 1_500,
      termGraceMs: 500,
      startTimeoutMs: 90_000,
    });
    let ticks = 0;
    const iv = setInterval(() => {
      ticks += 1;
    }, 50);
    const stuck = settle(runner.parsePdfPages(new Uint8Array([1])));
    const r = await stuck;
    clearInterval(iv);
    expect(r).toMatchObject({ ok: false, name: 'ConverterTimeoutError' });
    expect(ticks).toBeGreaterThanOrEqual(15); // ~1.5 s of 50 ms ticks, main never blocked
    const ok = await runner.parseDetailed(
      Buffer.from('plain text body'),
      'text/plain',
      'a.txt',
    );
    expect(ok).toEqual({ markdown: 'plain text body' });
    expect(spawns).toBe(2);
    expect(runner.stats().timeouts).toBe(1);
    await runner.stop();
  });
});
