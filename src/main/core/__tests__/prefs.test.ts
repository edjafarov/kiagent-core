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
    expect(DEFAULT_PREFS.models).toEqual({
      override: 'auto',
      autoInstall: true,
    });
    expect(createPrefs(dir).get().models).toEqual({
      override: 'auto',
      autoInstall: true,
    });
  });

  it('patch deep-merges and survives reload', async () => {
    const p = createPrefs(dir);
    await p.patch({ models: { ...p.get().models, autoInstall: false } });
    expect(createPrefs(dir).get().models).toEqual({
      override: 'auto',
      autoInstall: false,
    });
  });

  it('sanitize rejects garbage', () => {
    fs.writeFileSync(
      path.join(dir, 'prefs.json'),
      JSON.stringify({ models: { override: 42 } }),
    );
    expect(createPrefs(dir).get().models).toEqual({
      override: 'auto',
      autoInstall: true,
    });
  });
});

describe('prefs.launchAtLogin', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prefs-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('defaults to true on fresh installs', () => {
    expect(DEFAULT_PREFS.launchAtLogin).toBe(true);
    expect(createPrefs(dir).get().launchAtLogin).toBe(true);
  });

  it('treats an absent key as true', () => {
    fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({}));
    expect(createPrefs(dir).get().launchAtLogin).toBe(true);
  });

  it('keeps an explicit false (users who turned it off stay off)', async () => {
    const p = createPrefs(dir);
    await p.patch({ launchAtLogin: false });
    expect(createPrefs(dir).get().launchAtLogin).toBe(false);
  });
});

describe('prefs.outbound', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prefs-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('defaults outbound.defaultMode to review and sanitizes junk', async () => {
    const prefs = createPrefs(dir);
    expect(prefs.get().outbound).toEqual({ defaultMode: 'review' });
    await prefs.patch({
      outbound: { defaultMode: 'bogus' as unknown as 'review' },
    });
    expect(prefs.get().outbound.defaultMode).toBe('review');
    await prefs.patch({ outbound: { defaultMode: 'link' } });
    expect(prefs.get().outbound.defaultMode).toBe('link');
  });

  it('accepts chat as the global outbound default (mode C, decision 2026-07-27)', async () => {
    const prefs = createPrefs(dir);
    await prefs.patch({ outbound: { defaultMode: 'chat' } });
    expect(prefs.get().outbound.defaultMode).toBe('chat');
  });

  it('still sanitizes junk modes to review', async () => {
    const prefs = createPrefs(dir);
    await prefs.patch({
      outbound: { defaultMode: 'bogus' as unknown as 'review' },
    });
    expect(prefs.get().outbound.defaultMode).toBe('review');
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
    await p.patch({
      onboarding: { ...p.get().onboarding, mcpConnectedAt: 'A' },
    });
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
