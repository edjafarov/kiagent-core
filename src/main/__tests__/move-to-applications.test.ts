import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  maybeOfferMoveToApplications,
  type MoveToApplicationsDeps,
} from '../move-to-applications';

const noopLog = { info: jest.fn(), warn: jest.fn() };

function makeDeps(
  overrides: Partial<MoveToApplicationsDeps> = {},
): MoveToApplicationsDeps {
  return {
    platform: 'darwin',
    isPackaged: true,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'move-apps-')),
    productName: 'KIAgent',
    isInApplicationsFolder: () => false,
    moveToApplicationsFolder: jest.fn(() => true),
    showMessageBox: jest.fn(async () => ({
      response: 0,
      checkboxChecked: false,
    })),
    log: noopLog,
    ...overrides,
  };
}

describe('maybeOfferMoveToApplications', () => {
  it('skips on non-mac, unpackaged, or already-installed apps', async () => {
    expect(
      await maybeOfferMoveToApplications(makeDeps({ platform: 'win32' })),
    ).toBe('not-applicable');
    expect(
      await maybeOfferMoveToApplications(makeDeps({ isPackaged: false })),
    ).toBe('not-applicable');
    expect(
      await maybeOfferMoveToApplications(
        makeDeps({ isInApplicationsFolder: () => true }),
      ),
    ).toBe('not-applicable');
  });

  it('treats an isInApplicationsFolder throw as not-applicable (fail-soft)', async () => {
    const deps = makeDeps({
      isInApplicationsFolder: () => {
        throw new Error('nope');
      },
    });
    expect(await maybeOfferMoveToApplications(deps)).toBe('not-applicable');
    expect(deps.showMessageBox).not.toHaveBeenCalled();
  });

  it('moves when accepted and reports moving (caller must halt boot)', async () => {
    const deps = makeDeps();
    expect(await maybeOfferMoveToApplications(deps)).toBe('moving');
    expect(deps.moveToApplicationsFolder).toHaveBeenCalledTimes(1);
  });

  it('conflictHandler replaces a stale copy but aborts on a running one', async () => {
    const deps = makeDeps();
    await maybeOfferMoveToApplications(deps);
    const { conflictHandler } = (deps.moveToApplicationsFolder as jest.Mock)
      .mock.calls[0][0];
    expect(conflictHandler('exists')).toBe(true);
    expect(conflictHandler('existsAndRunning')).toBe(false);
  });

  it('declines without persisting when the checkbox is unticked', async () => {
    const deps = makeDeps({
      showMessageBox: jest.fn(async () => ({
        response: 1,
        checkboxChecked: false,
      })),
    });
    expect(await maybeOfferMoveToApplications(deps)).toBe('declined');
    // Asks again next launch.
    expect(await maybeOfferMoveToApplications(deps)).toBe('declined');
    expect(deps.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('persists the opt-out when "Don\'t ask again" is ticked', async () => {
    const deps = makeDeps({
      showMessageBox: jest.fn(async () => ({
        response: 1,
        checkboxChecked: true,
      })),
    });
    expect(await maybeOfferMoveToApplications(deps)).toBe('declined');
    expect(await maybeOfferMoveToApplications(deps)).toBe('suppressed');
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('falls back to a manual-move notice when the move fails or throws', async () => {
    for (const moveImpl of [
      jest.fn(() => false),
      jest.fn(() => {
        throw new Error('translocated');
      }),
    ]) {
      const shown: string[] = [];
      const deps = makeDeps({
        moveToApplicationsFolder: moveImpl,
        showMessageBox: jest.fn(async (opts: { message: string }) => {
          shown.push(opts.message);
          return { response: 0, checkboxChecked: false };
        }),
      });
      expect(await maybeOfferMoveToApplications(deps)).toBe('failed');
      expect(shown).toHaveLength(2);
      expect(shown[1]).toMatch(/Couldn't move/);
    }
  });
});
