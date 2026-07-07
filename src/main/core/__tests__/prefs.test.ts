import fs from 'fs';
import os from 'os';
import path from 'path';

import { createPrefs, DEFAULT_PREFS, markOnboardingOnce } from '../prefs';

describe('prefs.models', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prefs-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('defaults to auto + autoInstall', () => {
    expect(DEFAULT_PREFS.models).toEqual({ override: 'auto', autoInstall: true });
    expect(createPrefs(dir).get().models).toEqual({ override: 'auto', autoInstall: true });
  });

  it('patch deep-merges and survives reload', async () => {
    const p = createPrefs(dir);
    await p.patch({ models: { ...p.get().models, autoInstall: false } });
    expect(createPrefs(dir).get().models).toEqual({ override: 'auto', autoInstall: false });
  });

  it('sanitize rejects garbage', () => {
    fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ models: { override: 42 } }));
    expect(createPrefs(dir).get().models).toEqual({ override: 'auto', autoInstall: true });
  });
});

describe('prefs.onboarding', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prefs-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('defaults all onboarding latches to null', () => {
    expect(createPrefs(dir).get().onboarding).toEqual({
      sourceBackfilledAt: null,
      mcpConnectedAt: null,
      firstQueryAt: null,
      dismissedAt: null,
    });
  });

  it('sanitizes garbage onboarding values to null and keeps valid strings', () => {
    fs.writeFileSync(
      path.join(dir, 'prefs.json'),
      JSON.stringify({
        onboarding: {
          sourceBackfilledAt: 42,
          mcpConnectedAt: '',
          firstQueryAt: '2026-07-06T00:00:00.000Z',
        },
      }),
    );
    const loaded = createPrefs(dir).get().onboarding;
    expect(loaded.sourceBackfilledAt).toBeNull();
    expect(loaded.mcpConnectedAt).toBeNull();
    expect(loaded.firstQueryAt).toBe('2026-07-06T00:00:00.000Z');
    expect(loaded.dismissedAt).toBeNull();
  });

  it('patch deep-merges onboarding without clobbering sibling latches', async () => {
    const p = createPrefs(dir);
    await p.patch({ onboarding: { ...p.get().onboarding, mcpConnectedAt: 'A' } });
    await p.patch({ onboarding: { ...p.get().onboarding, firstQueryAt: 'B' } });
    expect(p.get().onboarding.mcpConnectedAt).toBe('A');
    expect(p.get().onboarding.firstQueryAt).toBe('B');
  });

  it('markOnboardingOnce sets when null, no-ops when set', async () => {
    const p = createPrefs(dir);
    expect(await markOnboardingOnce(p, 'firstQueryAt', 'T1')).toBe(true);
    expect(await markOnboardingOnce(p, 'firstQueryAt', 'T2')).toBe(false);
    expect(p.get().onboarding.firstQueryAt).toBe('T1');
  });

  it('patch with explicit nulls clears all latches (the factory-reset path)', async () => {
    const p = createPrefs(dir);
    await markOnboardingOnce(p, 'sourceBackfilledAt', 'T1');
    await markOnboardingOnce(p, 'mcpConnectedAt', 'T2');
    await markOnboardingOnce(p, 'dismissedAt', 'T3');
    await p.patch({
      onboarding: {
        sourceBackfilledAt: null,
        mcpConnectedAt: null,
        firstQueryAt: null,
        dismissedAt: null,
      },
    });
    expect(p.get().onboarding).toEqual({
      sourceBackfilledAt: null,
      mcpConnectedAt: null,
      firstQueryAt: null,
      dismissedAt: null,
    });
    // ...and the cleared state survives reload.
    expect(createPrefs(dir).get().onboarding.mcpConnectedAt).toBeNull();
  });
});
