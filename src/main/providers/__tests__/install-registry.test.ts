import { createInstallRegistry } from '../install-registry';

const fake = () => ({
  ensureInstalled: jest.fn(),
  cancelInstall: jest.fn().mockResolvedValue(undefined),
});

describe('createInstallRegistry', () => {
  it('reports installable ids', () => {
    const r = createInstallRegistry({
      'local-llm': fake(),
      'local-asr': fake(),
    });
    expect(r.installable('local-llm')).toBe(true);
    expect(r.installable('local-asr')).toBe(true);
    expect(r.installable('apple-vision')).toBe(false);
  });

  it('install dispatches to the NAMED provider only; unknown id is a no-op', () => {
    const llm = fake();
    const asr = fake();
    const r = createInstallRegistry({ 'local-llm': llm, 'local-asr': asr });
    r.install('local-asr');
    expect(asr.ensureInstalled).toHaveBeenCalledTimes(1);
    expect(llm.ensureInstalled).not.toHaveBeenCalled();
    expect(() => r.install('nope')).not.toThrow();
  });

  it('cancelAll aborts EVERY active installer (global cancel — shared consent, spec §5)', async () => {
    const llm = fake();
    const asr = fake();
    const r = createInstallRegistry({ 'local-llm': llm, 'local-asr': asr });
    await r.cancelAll();
    expect(llm.cancelInstall).toHaveBeenCalledTimes(1);
    expect(asr.cancelInstall).toHaveBeenCalledTimes(1);
  });
});
