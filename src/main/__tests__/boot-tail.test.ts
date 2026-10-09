/** @jest-environment node */
import type { FactoryResetOutcome } from '@shared/ipc';

import { bootTail, formatInProcess, type BootTailDeps } from '../boot-tail';
import type { InProcessStartReport } from '../platform/extension-platform';

const flush = () => new Promise((r) => setTimeout(r, 0));

function deps(journal = false) {
  const calls: string[] = [];
  const step = (name: string) =>
    jest.fn(async () => {
      calls.push(name);
    });
  const d = {
    journalPending: () => journal,
    finishInterruptedReset: jest.fn(
      async (): Promise<FactoryResetOutcome | null> => {
        calls.push('finish-reset');
        return null;
      },
    ),
    loadExtensions: step('load'),
    armQueue: jest.fn(() => {
      calls.push('arm');
    }),
    startInProcess: jest.fn(async (): Promise<InProcessStartReport> => {
      calls.push('in-process');
      return { activatedMs: { 'kiagent.remote-mcp': 120 }, pending: [] };
    }),
    startAllExtensions: step('start-all'),
    resumeAll: step('resume-all'),
    startScheduler: jest.fn(() => {
      calls.push('scheduler');
    }),
    registerActivate: jest.fn(() => {
      calls.push('activate-handler');
    }),
    createWindow: step('window'),
    startBackground: step('background'),
    mark: jest.fn(),
    logError: jest.fn(),
  } satisfies BootTailDeps;
  return { d, calls };
}

describe('bootTail', () => {
  it('normal path: load → arm → in-process start → window → background', async () => {
    const { d, calls } = deps();
    await expect(bootTail(d)).resolves.toBeNull();
    expect(calls).toEqual([
      'load',
      'arm',
      'in-process',
      'activate-handler',
      'window',
      'background',
    ]);
    expect(d.resumeAll).not.toHaveBeenCalled();
    expect(d.startScheduler).not.toHaveBeenCalled(); // background owns it
    expect(d.mark).toHaveBeenCalledWith(
      'in-process extensions active',
      'kiagent.remote-mcp 120ms',
    );
  });

  it('the window is created before any utility activation settles', async () => {
    const { d, calls } = deps();
    d.startBackground.mockImplementation(() => {
      calls.push('background'); // recorded at invocation; the promise never settles
      return new Promise<void>(() => {});
    });
    await bootTail(d); // resolves although the background never settles
    expect(calls.indexOf('window')).toBeGreaterThan(-1);
    expect(calls.indexOf('window')).toBeLessThan(calls.indexOf('background'));
  });

  it('the journal path stays fully sequential, and extensions start even after a failed reset', async () => {
    const { d, calls } = deps(true);
    d.finishInterruptedReset.mockImplementationOnce(async () => {
      calls.push('finish-reset');
      return { ok: false, coreWiped: false, failed: [], error: 'EACCES' };
    });
    const outcome = await bootTail(d);
    expect(outcome?.ok).toBe(false);
    expect(calls).toEqual([
      'finish-reset',
      'start-all',
      'resume-all',
      'scheduler',
      'activate-handler',
      'window',
    ]);
    expect(d.startBackground).not.toHaveBeenCalled();
    expect(d.armQueue).not.toHaveBeenCalled();
  });

  it('a discovery failure still opens the window with zero extensions, and does not reject', async () => {
    const { d, calls } = deps();
    d.loadExtensions.mockRejectedValueOnce(new Error('ENOTDIR: extensions'));
    d.startInProcess.mockRejectedValueOnce(new Error('ENOTDIR: extensions'));
    await expect(bootTail(d)).resolves.toBeNull(); // handleBootFailure is the .catch — never reached
    expect(calls).toContain('window');
    expect(d.logError).toHaveBeenCalledTimes(2);
  });

  it('an in-process extension that errors before first paint still opens the window', async () => {
    const { d, calls } = deps();
    d.startInProcess.mockResolvedValueOnce({ activatedMs: {}, pending: [] });
    await bootTail(d);
    expect(calls).toContain('window');
  });

  it('a rejecting background chain is logged, never unhandled', async () => {
    const { d } = deps();
    d.startBackground.mockRejectedValueOnce(new Error('late'));
    await bootTail(d);
    await flush();
    expect(d.logError).toHaveBeenCalledWith(new Error('late'));
  });
});

describe('formatInProcess', () => {
  it('lists per-extension ms and the pending ones', () => {
    expect(
      formatInProcess({
        activatedMs: { 'kiagent.remote-mcp': 120, 'kiagent.meetings': 80 },
        pending: ['kiagent.assistant'],
      }),
    ).toBe(
      'kiagent.remote-mcp 120ms, kiagent.meetings 80ms; pending: kiagent.assistant',
    );
  });
});
