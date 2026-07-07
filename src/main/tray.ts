import { Menu, Tray, nativeImage } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

import { createTrayMenuController } from './tray-menu';
import type { TrayMenuController } from './tray-menu';

export interface TrayActions {
  openWindow: () => void;
  syncNow: () => void;
  quit: () => void;
}

/**
 * Menu template split from the Tray wiring so it stays unit-testable
 * without an Electron runtime.
 */
export function buildTrayMenuTemplate(
  actions: TrayActions,
): MenuItemConstructorOptions[] {
  return [
    { label: 'Open KIAgent', click: actions.openWindow },
    { label: 'Sync now', click: actions.syncNow },
    { type: 'separator' },
    { label: 'Quit KIAgent', click: actions.quit },
  ];
}

/**
 * Static menu-bar icon with a live context menu. Deliberately minimal
 * compared to the legacy tray (no activity animation, no per-account
 * status): the app keeps running after the window closes (see
 * window-all-closed in main.ts), and this is the affordance that shows
 * that and offers a way out. The caller must hold the returned Tray in a
 * long-lived reference or GC destroys the icon.
 *
 * The returned `menu` controller is what `MainProcessApi.ui
 * .addTrayMenuItems` (main-api.ts) delegates to — bundled extensions splice
 * items into this same live menu, spliced before the trailing Quit item.
 */
export function createTray(
  iconPath: string,
  actions: TrayActions,
): { tray: Tray; menu: TrayMenuController } {
  const icon = nativeImage.createFromPath(iconPath);
  // Black+alpha template image: macOS recolors it for light/dark menu bars.
  icon.setTemplateImage(true);
  const tray = new Tray(icon);
  tray.setToolTip('KIAgent');
  const menu = createTrayMenuController(buildTrayMenuTemplate(actions), (t) =>
    tray.setContextMenu(Menu.buildFromTemplate(t)),
  );
  return { tray, menu };
}
