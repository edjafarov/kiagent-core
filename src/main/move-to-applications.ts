/**
 * First-run "Move to Applications" guard (macOS, packaged builds only).
 *
 * Why this exists: the very first launch of a fresh install typically runs
 * quarantine-TRANSLOCATED (from the DMG or ~/Downloads), and the first
 * keystore touch creates the "<name> Safe Storage" login-keychain item with
 * its ACL tied to that throwaway app identity. Every later launch from
 * /Applications then fails the ACL check and macOS demands the login-keychain
 * password. Offering the move BEFORE the first keystore touch means the item
 * is created from the app's permanent identity and no prompt ever appears.
 */
import fs from 'fs';
import path from 'path';

export type MoveConflict = 'exists' | 'existsAndRunning';

export type MoveOutcome =
  /** Not macOS / not packaged / already in /Applications. */
  | 'not-applicable'
  /** User previously checked "Don't ask again". */
  | 'suppressed'
  /** User picked "Not Now" (flag persisted iff the checkbox was ticked). */
  | 'declined'
  /** Move accepted and underway — the app is about to quit and relaunch. */
  | 'moving'
  /** Move failed or was blocked; manual-move notice shown, boot continues. */
  | 'failed';

export interface MoveToApplicationsDeps {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** app.getPath('userData') — the "don't ask again" flag lives here. */
  userDataDir: string;
  /** User-facing name for dialog copy (ProductConfig.productName). */
  productName: string;
  isInApplicationsFolder: () => boolean;
  /** app.moveToApplicationsFolder — on success the app quits + relaunches. */
  moveToApplicationsFolder: (opts: {
    conflictHandler: (conflictType: MoveConflict) => boolean;
  }) => boolean;
  /** dialog.showMessageBox (no BrowserWindow exists yet). */
  showMessageBox: (opts: {
    type: string;
    message: string;
    detail: string;
    buttons?: string[];
    defaultId?: number;
    cancelId?: number;
    checkboxLabel?: string;
  }) => Promise<{ response: number; checkboxChecked: boolean }>;
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}

const FLAG_FILE = 'skip-move-to-applications.json';

export async function maybeOfferMoveToApplications(
  deps: MoveToApplicationsDeps,
): Promise<MoveOutcome> {
  const { productName, log } = deps;
  if (deps.platform !== 'darwin' || !deps.isPackaged) return 'not-applicable';

  let inApplications: boolean;
  try {
    inApplications = deps.isInApplicationsFolder();
  } catch (e) {
    // Fail-soft: an API error must never block boot.
    log.warn('[move-to-applications] isInApplicationsFolder failed:', e);
    return 'not-applicable';
  }
  if (inApplications) return 'not-applicable';

  const flagPath = path.join(deps.userDataDir, FLAG_FILE);
  if (fs.existsSync(flagPath)) return 'suppressed';

  const { response, checkboxChecked } = await deps.showMessageBox({
    type: 'question',
    message: `Move ${productName} to the Applications folder?`,
    detail:
      `${productName} is running from outside the Applications folder. ` +
      'Moving it now keeps macOS from repeatedly asking for your keychain ' +
      'password and lets automatic updates work reliably. The app will ' +
      'restart from its new location.',
    buttons: ['Move to Applications', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: "Don't ask again",
  });

  if (response !== 0) {
    if (checkboxChecked) {
      try {
        fs.writeFileSync(flagPath, JSON.stringify({ suppressed: true }));
      } catch (e) {
        log.warn('[move-to-applications] could not persist opt-out:', e);
      }
    }
    log.info('[move-to-applications] declined', { checkboxChecked });
    return 'declined';
  }

  let moved = false;
  try {
    moved = deps.moveToApplicationsFolder({
      // A stale copy at the destination is replaced; a RUNNING copy aborts
      // the move (returning false makes Electron give up cleanly).
      conflictHandler: (conflictType) => conflictType === 'exists',
    });
  } catch (e) {
    log.warn('[move-to-applications] move threw:', e);
  }

  if (moved) {
    // Electron quits this instance and relaunches from /Applications; the
    // caller must stop booting (especially: no keystore touch).
    log.info('[move-to-applications] moving — app will relaunch');
    return 'moving';
  }

  log.warn('[move-to-applications] move failed — asking for a manual move');
  await deps.showMessageBox({
    type: 'info',
    message: `Couldn't move ${productName} automatically`,
    detail:
      `Please quit ${productName} and drag it into the Applications ` +
      'folder yourself, then reopen it.',
    buttons: ['OK'],
  });
  return 'failed';
}
