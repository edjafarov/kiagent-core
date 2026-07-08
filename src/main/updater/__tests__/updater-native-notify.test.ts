/** @jest-environment node */
import { createUpdateNotifier } from '@main/updater/native-notify';
import type {
  NotifyOptions,
  UpdateNotifierDeps,
} from '@main/updater/native-notify';
import type { UpdateState } from '@main/updater/types';

function makeDeps(over: Partial<UpdateNotifierDeps> = {}) {
  const calls: NotifyOptions[] = [];
  const quitAndInstall = jest.fn();
  const warn = jest.fn();
  const deps: UpdateNotifierDeps = {
    notify: (opts) => calls.push(opts),
    quitAndInstall,
    log: { warn } as unknown as UpdateNotifierDeps['log'],
    ...over,
  };
  return { deps, calls, quitAndInstall, warn };
}

const state = (over: Partial<UpdateState> = {}): UpdateState => ({
  status: 'idle',
  currentVersion: '0.38.0',
  version: null,
  ...over,
});

describe('createUpdateNotifier', () => {
  it('fires a native notification when an update finishes downloading', () => {
    const { deps, calls } = makeDeps();
    createUpdateNotifier(deps).handle(
      state({ status: 'downloaded', version: '0.39.0' }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toContain('0.39.0');
  });

  it('the notification click restarts and installs', () => {
    const { deps, calls, quitAndInstall } = makeDeps();
    createUpdateNotifier(deps).handle(
      state({ status: 'downloaded', version: '0.39.0' }),
    );
    calls[0].onClick();
    expect(quitAndInstall).toHaveBeenCalled();
  });

  it('does not re-notify for the same version (gentle, once per version)', () => {
    const { deps, calls } = makeDeps();
    const n = createUpdateNotifier(deps);
    const downloaded = state({ status: 'downloaded', version: '0.39.0' });
    n.handle(downloaded);
    n.handle(downloaded); // a repeat emit (the 6h re-check loop) must not re-nag
    expect(calls).toHaveLength(1);
  });

  it('notifies again when a newer version downloads', () => {
    const { deps, calls } = makeDeps();
    const n = createUpdateNotifier(deps);
    n.handle(state({ status: 'downloaded', version: '0.39.0' }));
    n.handle(state({ status: 'downloaded', version: '0.40.0' }));
    expect(calls.map((c) => c.title)).toEqual([
      expect.stringContaining('0.39.0'),
      expect.stringContaining('0.40.0'),
    ]);
  });

  it('stays silent on every non-downloaded status', () => {
    const { deps, calls } = makeDeps();
    const n = createUpdateNotifier(deps);
    for (const s of [
      'idle',
      'checking',
      'available',
      'downloading',
      'up-to-date',
      'error',
      'disabled',
    ] as const) {
      n.handle(state({ status: s, version: '0.39.0' }));
    }
    expect(calls).toHaveLength(0);
  });

  it('ignores a downloaded event with no version', () => {
    const { deps, calls } = makeDeps();
    createUpdateNotifier(deps).handle(
      state({ status: 'downloaded', version: null }),
    );
    expect(calls).toHaveLength(0);
  });

  it('never throws when notify fails', () => {
    const { deps, warn } = makeDeps({
      notify: () => {
        throw new Error('no notification daemon');
      },
    });
    expect(() =>
      createUpdateNotifier(deps).handle(
        state({ status: 'downloaded', version: '0.39.0' }),
      ),
    ).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
