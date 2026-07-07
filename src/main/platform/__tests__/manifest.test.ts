/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  MAX_ICON_BYTES,
  ManifestError,
  loadIconDataUrl,
  oauthSourceBindings,
  parseManifest,
  sourceContributions,
  validateManifestDir,
} from '../manifest';

const GOOD = {
  id: 'test.basic',
  name: 'Basic',
  version: '1.0.0',
  engine: '^1.0.0',
  entry: 'dist/index.js',
  caps: ['net'],
  contributes: { sources: ['basicsrc'] },
};

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    const m = parseManifest(GOOD);
    expect(m.id).toBe('test.basic');
    expect(m.caps).toEqual(['net']);
    expect(m.contributes.sources).toEqual(['basicsrc']);
  });

  it('defaults contributes to {}', () => {
    const { contributes: _drop, ...rest } = GOOD;
    expect(parseManifest(rest).contributes).toEqual({});
  });

  it('rejects unknown caps (legacy silently dropped them — we refuse)', () => {
    expect(() => parseManifest({ ...GOOD, caps: ['net', 'teleport'] })).toThrow(
      ManifestError,
    );
  });

  it('rejects a legacy-format manifest with the exact message', () => {
    const legacy = {
      id: 'kia.notion',
      displayName: 'Notion',
      version: '1.2.0',
      hostApi: '^2.0.0',
      entry: 'dist/index.js',
      permissions: ['net'],
    };
    expect(() => parseManifest(legacy)).toThrow(
      'This extension was built for the legacy app and is not compatible with this build.',
    );
  });

  it('rejects bad ids (must be publisher.name)', () => {
    expect(() => parseManifest({ ...GOOD, id: 'gmail' })).toThrow(
      ManifestError,
    );
    expect(() => parseManifest({ ...GOOD, id: 'Test.Basic' })).toThrow(
      ManifestError,
    );
  });

  it('rejects an engine range this platform does not satisfy', () => {
    expect(() => parseManifest({ ...GOOD, engine: '^2.0.0' })).toThrow(
      /requires platform/,
    );
  });

  it('rejects invalid semver version and invalid engine range', () => {
    expect(() => parseManifest({ ...GOOD, version: 'one' })).toThrow(
      ManifestError,
    );
    expect(() => parseManifest({ ...GOOD, engine: 'not-a-range' })).toThrow(
      ManifestError,
    );
  });
});

describe('source contributions (string | { id, oauth })', () => {
  it('accepts the object form with oauth: "google"', () => {
    const m = parseManifest({
      ...GOOD,
      contributes: { sources: [{ id: 'google-docs', oauth: 'google' }] },
    });
    expect(m.contributes.sources).toEqual([
      { id: 'google-docs', oauth: 'google' },
    ]);
  });

  it('accepts the object form with oauth: "microsoft"', () => {
    const m = parseManifest({
      ...GOOD,
      contributes: { sources: [{ id: 'ms365-mail', oauth: 'microsoft' }] },
    });
    expect(m.contributes.sources).toEqual([
      { id: 'ms365-mail', oauth: 'microsoft' },
    ]);
  });

  it('accepts mixed string and object entries', () => {
    const m = parseManifest({
      ...GOOD,
      contributes: {
        sources: ['plainsrc', { id: 'google-docs', oauth: 'google' }],
      },
    });
    expect(m.contributes.sources).toEqual([
      'plainsrc',
      { id: 'google-docs', oauth: 'google' },
    ]);
  });

  it('rejects an unknown oauth provider with a user-facing message', () => {
    expect(() =>
      parseManifest({
        ...GOOD,
        contributes: { sources: [{ id: 'gh-docs', oauth: 'github' }] },
      }),
    ).toThrow(ManifestError);
    expect(() =>
      parseManifest({
        ...GOOD,
        contributes: { sources: [{ id: 'gh-docs', oauth: 'github' }] },
      }),
    ).toThrow(/oauth must be one of: google, microsoft/);
  });

  it('rejects the object form without an id, with a user-facing message', () => {
    expect(() =>
      parseManifest({
        ...GOOD,
        contributes: { sources: [{ oauth: 'google' }] },
      }),
    ).toThrow(ManifestError);
    expect(() =>
      parseManifest({
        ...GOOD,
        contributes: { sources: [{ oauth: 'google' }] },
      }),
    ).toThrow(/source id string or \{ id, oauth \}/);
  });

  it('rejects an empty-string source id in both forms, with a user-facing message', () => {
    expect(() =>
      parseManifest({ ...GOOD, contributes: { sources: [''] } }),
    ).toThrow(ManifestError);
    expect(() =>
      parseManifest({ ...GOOD, contributes: { sources: [''] } }),
    ).toThrow(/source id must not be empty/);
    expect(() =>
      parseManifest({
        ...GOOD,
        contributes: { sources: [{ id: '', oauth: 'google' }] },
      }),
    ).toThrow(/source id must not be empty/);
  });

  it('sourceContributions normalizes both forms and defaults to []', () => {
    const m = parseManifest({
      ...GOOD,
      contributes: {
        sources: ['plainsrc', { id: 'google-docs', oauth: 'google' }],
      },
    });
    expect(sourceContributions(m)).toEqual([
      { id: 'plainsrc' },
      { id: 'google-docs', oauth: 'google' },
    ]);
    const { contributes: _drop, ...rest } = GOOD;
    expect(sourceContributions(parseManifest(rest))).toEqual([]);
  });

  it('oauthSourceBindings keeps only oauth-bound sources, as {id, provider}', () => {
    const m = parseManifest({
      ...GOOD,
      contributes: {
        sources: ['plainsrc', { id: 'google-docs', oauth: 'google' }],
      },
    });
    expect(oauthSourceBindings(m)).toEqual([
      { id: 'google-docs', provider: 'google' },
    ]);
    expect(oauthSourceBindings(parseManifest(GOOD))).toEqual([]);
  });
});

describe('validateManifestDir', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-manifest-'));
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(
      path.join(dir, 'dist', 'index.js'),
      'module.exports = {};',
    );
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(GOOD));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns the manifest and absolute entry path', () => {
    const { manifest, entryAbsPath } = validateManifestDir(dir);
    expect(manifest.id).toBe('test.basic');
    expect(entryAbsPath).toBe(path.join(dir, 'dist', 'index.js'));
  });

  it('rejects an entry escaping the directory', () => {
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ ...GOOD, entry: '../outside.js' }),
    );
    expect(() => validateManifestDir(dir)).toThrow(
      /inside the extension directory/,
    );
  });

  it('rejects a missing entry file and a missing manifest.json', () => {
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ ...GOOD, entry: 'nope.js' }),
    );
    expect(() => validateManifestDir(dir)).toThrow(/entry not found/);
    fs.rmSync(path.join(dir, 'manifest.json'));
    expect(() => validateManifestDir(dir)).toThrow(/manifest.json/);
  });

  it('accepts a manifest with a valid icon', () => {
    fs.writeFileSync(
      path.join(dir, 'icon.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ ...GOOD, icon: 'icon.png' }),
    );
    expect(validateManifestDir(dir).manifest.icon).toBe('icon.png');
  });

  it('rejects a non-png icon declaration', () => {
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ ...GOOD, icon: 'icon.svg' }),
    );
    expect(() => validateManifestDir(dir)).toThrow(/icon must be a \.png/);
  });

  it('rejects an icon escaping the directory, a missing icon file, and an oversized icon', () => {
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ ...GOOD, icon: '../outside.png' }),
    );
    expect(() => validateManifestDir(dir)).toThrow(/icon must resolve inside/);

    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ ...GOOD, icon: 'icon.png' }),
    );
    expect(() => validateManifestDir(dir)).toThrow(/icon not found/);

    fs.writeFileSync(
      path.join(dir, 'icon.png'),
      Buffer.alloc(MAX_ICON_BYTES + 1),
    );
    expect(() => validateManifestDir(dir)).toThrow(/200 KB or smaller/);
  });
});

describe('privileged caps by tier', () => {
  const base = {
    id: 'pub.priv',
    name: 'Priv',
    version: '1.0.0',
    engine: '^1.0.0',
    entry: 'index.js',
    caps: ['unsafe.mainProcess'],
  };

  it('rejects unsafe.mainProcess for the default (external) tier', () => {
    expect(() => parseManifest(base)).toThrow(/unsafe\.mainProcess.*bundled/i);
  });

  it('rejects unsafe.mainProcess for an explicit external tier', () => {
    expect(() => parseManifest(base, { tier: 'external' })).toThrow(
      ManifestError,
    );
  });

  it('accepts unsafe.mainProcess for the bundled tier', () => {
    const m = parseManifest(base, { tier: 'bundled' });
    expect(m.caps).toContain('unsafe.mainProcess');
  });
});

describe('loadIconDataUrl', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-icon-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns a png data URI for a declared icon', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fs.writeFileSync(path.join(dir, 'icon.png'), bytes);
    expect(loadIconDataUrl(dir, { icon: 'icon.png' })).toBe(
      `data:image/png;base64,${bytes.toString('base64')}`,
    );
  });

  it('returns undefined for no declaration, a missing file, an escaping path, and an oversized file', () => {
    expect(loadIconDataUrl(dir, {})).toBeUndefined();
    expect(loadIconDataUrl(dir, { icon: 'icon.png' })).toBeUndefined();
    expect(loadIconDataUrl(dir, { icon: '../outside.png' })).toBeUndefined();
    fs.writeFileSync(
      path.join(dir, 'icon.png'),
      Buffer.alloc(MAX_ICON_BYTES + 1),
    );
    expect(loadIconDataUrl(dir, { icon: 'icon.png' })).toBeUndefined();
  });
});
