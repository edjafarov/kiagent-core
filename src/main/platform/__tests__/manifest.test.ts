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
  senderContributions,
  sourceContributions,
  validateManifestDir,
} from '../manifest';

const GOOD = {
  id: 'test.basic',
  name: 'Basic',
  version: '1.0.0',
  engine: '^2.0.0',
  entry: 'dist/index.js',
  caps: ['net'],
  contributes: { sources: ['basicsrc'], senders: [] },
};

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    const m = parseManifest(GOOD);
    expect(m.id).toBe('test.basic');
    expect(m.caps).toEqual(['net']);
    expect(m.contributes.sources).toEqual(['basicsrc']);
  });

  it('rejects a manifest without contributes (required since 2.0.0)', () => {
    const { contributes: _drop, ...rest } = GOOD;
    expect(() => parseManifest(rest)).toThrow(ManifestError);
  });

  it('rejects contributes without an explicit senders list', () => {
    expect(() =>
      parseManifest({ ...GOOD, contributes: { sources: ['basicsrc'] } }),
    ).toThrow(/contributes\.senders is required/);
  });

  it('rejects unknown keys instead of silently stripping them', () => {
    // Top-level issues carry an empty zod path — the message labels them
    // (root) rather than degrading to "invalid manifest:  — …".
    expect(() => parseManifest({ ...GOOD, hostApi: '1.0' })).toThrow(
      /invalid manifest: \(root\) — .*hostApi/,
    );
    expect(() =>
      parseManifest({
        ...GOOD,
        contributes: { ...GOOD.contributes, workers: ['w'] },
      }),
    ).toThrow(ManifestError);
    expect(() =>
      parseManifest({
        ...GOOD,
        contributes: { ...GOOD.contributes, providers: ['p'] },
      }),
    ).toThrow(ManifestError);
    expect(() =>
      parseManifest({
        ...GOOD,
        contributes: {
          sources: [{ id: 'x', oauth: 'google', scopes: ['mail'] }],
          senders: [],
        },
      }),
    ).toThrow(ManifestError);
  });

  it('rejects unknown caps (legacy silently dropped them — we refuse)', () => {
    expect(() => parseManifest({ ...GOOD, caps: ['net', 'teleport'] })).toThrow(
      ManifestError,
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
    expect(() => parseManifest({ ...GOOD, engine: '^1.2.0' })).toThrow(
      /requires platform/,
    );
    expect(() => parseManifest({ ...GOOD, engine: '^3.0.0' })).toThrow(
      /requires platform/,
    );
  });

  it('accepts the cross-platform range >=1.2.0 <3.0.0', () => {
    expect(parseManifest({ ...GOOD, engine: '>=1.2.0 <3.0.0' }).engine).toBe(
      '>=1.2.0 <3.0.0',
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
      contributes: {
        sources: [{ id: 'google-docs', oauth: 'google' }],
        senders: [],
      },
    });
    expect(m.contributes.sources).toEqual([
      { id: 'google-docs', oauth: 'google' },
    ]);
  });

  it('accepts the object form with oauth: "microsoft"', () => {
    const m = parseManifest({
      ...GOOD,
      contributes: {
        sources: [{ id: 'ms365-mail', oauth: 'microsoft' }],
        senders: [],
      },
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
        senders: [],
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
        contributes: {
          sources: [{ id: 'gh-docs', oauth: 'github' }],
          senders: [],
        },
      }),
    ).toThrow(ManifestError);
    expect(() =>
      parseManifest({
        ...GOOD,
        contributes: {
          sources: [{ id: 'gh-docs', oauth: 'github' }],
          senders: [],
        },
      }),
    ).toThrow(/oauth must be one of: google, microsoft/);
  });

  it('rejects the object form without an id, with a user-facing message', () => {
    expect(() =>
      parseManifest({
        ...GOOD,
        contributes: { sources: [{ oauth: 'google' }], senders: [] },
      }),
    ).toThrow(ManifestError);
    expect(() =>
      parseManifest({
        ...GOOD,
        contributes: { sources: [{ oauth: 'google' }], senders: [] },
      }),
    ).toThrow(/source id string or \{ id, oauth \}/);
  });

  it('rejects an empty-string source id in both forms, with a user-facing message', () => {
    expect(() =>
      parseManifest({ ...GOOD, contributes: { sources: [''], senders: [] } }),
    ).toThrow(ManifestError);
    expect(() =>
      parseManifest({ ...GOOD, contributes: { sources: [''], senders: [] } }),
    ).toThrow(/source id must not be empty/);
    expect(() =>
      parseManifest({
        ...GOOD,
        contributes: { sources: [{ id: '', oauth: 'google' }], senders: [] },
      }),
    ).toThrow(/source id must not be empty/);
  });

  it('sourceContributions normalizes both forms and defaults to []', () => {
    const m = parseManifest({
      ...GOOD,
      contributes: {
        sources: ['plainsrc', { id: 'google-docs', oauth: 'google' }],
        senders: [],
      },
    });
    expect(sourceContributions(m)).toEqual([
      { id: 'plainsrc' },
      { id: 'google-docs', oauth: 'google' },
    ]);
    expect(
      sourceContributions(
        parseManifest({ ...GOOD, contributes: { senders: [] } }),
      ),
    ).toEqual([]);
  });

  it('oauthSourceBindings keeps only oauth-bound sources, as {id, provider}', () => {
    const m = parseManifest({
      ...GOOD,
      contributes: {
        sources: ['plainsrc', { id: 'google-docs', oauth: 'google' }],
        senders: [],
      },
    });
    expect(oauthSourceBindings(m)).toEqual([
      { id: 'google-docs', provider: 'google' },
    ]);
    expect(oauthSourceBindings(parseManifest(GOOD))).toEqual([]);
  });
});

describe('sender contributions', () => {
  it('accepts the send cap and contributes.senders', () => {
    const m = parseManifest({
      ...GOOD,
      caps: ['net', 'send'],
      contributes: { sources: ['slack'], senders: ['slack'] },
    });
    expect(m.caps).toContain('send');
    expect(senderContributions(m)).toEqual(['slack']);
  });

  it('senders default to empty', () => {
    expect(senderContributions(parseManifest(GOOD))).toEqual([]);
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
    engine: '^2.0.0',
    entry: 'index.js',
    caps: ['unsafe.mainProcess'],
    contributes: { senders: [] },
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
