/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_PAGE_BYTES,
  ManifestError,
  parseManifest,
  uiContributions,
  validateManifestDir,
} from '../manifest';

// B3: `contributes.ui` — item 2 of the plan. A separate file from
// manifest.test.ts so the pre-existing suite there needs zero edits.
const GOOD = {
  id: 'test.basic',
  name: 'Basic',
  version: '1.0.0',
  engine: '^2.0.0',
  entry: 'dist/index.js',
  caps: ['ui'],
  contributes: {
    sources: [],
    senders: [],
    ui: [{ id: 'main', slot: 'screen', title: 'Main Screen' }],
  },
};

describe('contributes.ui manifest validation', () => {
  it('accepts a valid bundled contributes.ui entry', () => {
    const m = parseManifest(GOOD, { tier: 'bundled' });
    expect(m.contributes.ui).toEqual([
      { id: 'main', slot: 'screen', title: 'Main Screen' },
    ]);
  });

  it('accepts every optional field (nav suggestion, params)', () => {
    const m = parseManifest(
      {
        ...GOOD,
        contributes: {
          ...GOOD.contributes,
          ui: [
            {
              id: 'main',
              slot: 'screen',
              title: 'Main Screen',
              nav: { group: 'everyday', order: 10, icon: 'star' },
              params: ['anchor', 'month'],
            },
          ],
        },
      },
      { tier: 'bundled' },
    );
    expect(m.contributes.ui).toEqual([
      {
        id: 'main',
        slot: 'screen',
        title: 'Main Screen',
        nav: { group: 'everyday', order: 10, icon: 'star' },
        params: ['anchor', 'month'],
      },
    ]);
  });

  it('uiContributions defaults to [] for a manifest declaring none, never undefined', () => {
    const m = parseManifest({
      ...GOOD,
      caps: [],
      contributes: { sources: [], senders: [] },
    });
    expect(uiContributions(m)).toEqual([]);
    expect(uiContributions(m)).not.toBeUndefined();
  });

  it('an empty contributes.ui array does not require the ui cap', () => {
    expect(() =>
      parseManifest({
        ...GOOD,
        caps: [],
        contributes: { ...GOOD.contributes, ui: [] },
      }),
    ).not.toThrow();
  });

  it('accepts contributes.ui without the ui capability (the consent row is the gate)', () => {
    expect(() =>
      parseManifest({ ...GOOD, caps: [] }, { tier: 'bundled' }),
    ).not.toThrow();
  });

  it('accepts contributes.ui for the external tier', () => {
    expect(() => parseManifest(GOOD)).not.toThrow();
    expect(() => parseManifest(GOOD, { tier: 'external' })).not.toThrow();
  });

  it('rejects an unknown slot', () => {
    expect(() =>
      parseManifest(
        {
          ...GOOD,
          contributes: {
            ...GOOD.contributes,
            ui: [{ id: 'main', slot: 'sidebar-item', title: 'Main' }],
          },
        },
        { tier: 'bundled' },
      ),
    ).toThrow(/invalid manifest/);
  });

  it('rejects duplicate contribution ids within one manifest', () => {
    expect(() =>
      parseManifest(
        {
          ...GOOD,
          contributes: {
            ...GOOD.contributes,
            ui: [
              { id: 'main', slot: 'screen', title: 'Main' },
              { id: 'main', slot: 'screen', title: 'Main Again' },
            ],
          },
        },
        { tier: 'bundled' },
      ),
    ).toThrow(/duplicate contribution id 'main'/);
  });

  it('rejects a contribution id outside the allowed charset', () => {
    for (const badId of ['Main', 'main_screen', '-main', 'ma in', '']) {
      expect(() =>
        parseManifest(
          {
            ...GOOD,
            contributes: {
              ...GOOD.contributes,
              ui: [{ id: badId, slot: 'screen', title: 'Main' }],
            },
          },
          { tier: 'bundled' },
        ),
      ).toThrow(/invalid manifest/);
    }
  });

  it('rejects duplicate param keys within one contribution', () => {
    expect(() =>
      parseManifest(
        {
          ...GOOD,
          contributes: {
            ...GOOD.contributes,
            ui: [
              {
                id: 'main',
                slot: 'screen',
                title: 'Main',
                params: ['anchor', 'anchor'],
              },
            ],
          },
        },
        { tier: 'bundled' },
      ),
    ).toThrow(/duplicate param key 'anchor'/);
  });

  it('rejects an unsafe param key charset', () => {
    for (const badKey of ['Anchor', 'an-chor', '1anchor', 'an.chor']) {
      expect(() =>
        parseManifest(
          {
            ...GOOD,
            contributes: {
              ...GOOD.contributes,
              ui: [
                {
                  id: 'main',
                  slot: 'screen',
                  title: 'Main',
                  params: [badKey],
                },
              ],
            },
          },
          { tier: 'bundled' },
        ),
      ).toThrow(/invalid manifest/);
    }
  });

  it('rejects an unknown field on a contribution (strict, like the other contributes.* entries)', () => {
    expect(() =>
      parseManifest(
        {
          ...GOOD,
          contributes: {
            ...GOOD.contributes,
            ui: [
              {
                id: 'main',
                slot: 'screen',
                title: 'Main',
                entry: 'ui/index.tsx',
              },
            ],
          },
        },
        { tier: 'bundled' },
      ),
    ).toThrow(ManifestError);
  });

  it('rejects an unknown nav suggestion field', () => {
    expect(() =>
      parseManifest(
        {
          ...GOOD,
          contributes: {
            ...GOOD.contributes,
            ui: [
              {
                id: 'main',
                slot: 'screen',
                title: 'Main',
                nav: { group: 'everyday', gate: 'always' },
              },
            ],
          },
        },
        { tier: 'bundled' },
      ),
    ).toThrow(ManifestError);
  });
});

function extDir(files: Record<string, string | Buffer>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-page-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(GOOD));
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, GOOD.entry), 'module.exports={}');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

describe('page file (dist/ui/<id>.js)', () => {
  const pageId = GOOD.contributes.ui[0].id;

  it('passes when the page bundle exists', () => {
    expect(() =>
      validateManifestDir(
        extDir({ [`dist/ui/${pageId}.js`]: 'export default 1' }),
      ),
    ).not.toThrow();
  });

  it('fails when the page bundle is missing', () => {
    expect(() => validateManifestDir(extDir({}))).toThrow(/dist\/ui\/main\.js/);
  });

  it('fails when the page bundle is larger than 5 MiB', () => {
    const big = Buffer.alloc(MAX_PAGE_BYTES + 1, 32);
    expect(() =>
      validateManifestDir(extDir({ [`dist/ui/${pageId}.js`]: big })),
    ).toThrow(/5 MiB/);
  });

  it('fails when the page bundle is a symlink escaping the package', () => {
    const dir = extDir({});
    fs.mkdirSync(path.join(dir, 'dist/ui'), { recursive: true });
    const outside = path.join(os.tmpdir(), `kia-outside-${Date.now()}.js`);
    fs.writeFileSync(outside, 'x');
    fs.symlinkSync(outside, path.join(dir, `dist/ui/${pageId}.js`));
    expect(() => validateManifestDir(dir)).toThrow(ManifestError);
  });
});
