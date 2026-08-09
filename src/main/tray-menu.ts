import type { MenuItemConstructorOptions } from 'electron';

/**
 * Live tray-menu assembly, split out so it stays unit-testable without an
 * Electron runtime (no `Menu`/`Tray` import here — just template arrays and
 * a caller-supplied rebuild callback). Owns the set of extension-contributed
 * item groups (`ui.addTrayMenuItems` in main-api.ts) on top of the app's own
 * fixed base template, and re-applies the whole menu on every add/dispose.
 */
export interface TrayMenuController {
  /** Splices `items` into the tray menu and rebuilds immediately.
   *  `position: 'bottom'` (default) inserts before the trailing (assumed
   *  last) base-template item — i.e. before Quit. `position: 'top'` renders
   *  the group before the entire base template (status-style rows).
   *  Returns a disposer that removes this group and rebuilds again. */
  addItems(
    items: MenuItemConstructorOptions[],
    opts?: { position?: 'top' | 'bottom' },
  ): () => void;
}

export function createTrayMenuController(
  baseTemplate: MenuItemConstructorOptions[],
  rebuild: (template: MenuItemConstructorOptions[]) => void,
): TrayMenuController {
  const topGroups: MenuItemConstructorOptions[][] = [];
  const bottomGroups: MenuItemConstructorOptions[][] = [];

  function apply(): void {
    if (topGroups.length === 0 && bottomGroups.length === 0) {
      rebuild(baseTemplate);
      return;
    }
    const last = baseTemplate[baseTemplate.length - 1];
    const withoutLast = baseTemplate.slice(0, -1);
    rebuild([
      ...topGroups.flat(),
      ...withoutLast,
      ...bottomGroups.flat(),
      last,
    ]);
  }

  apply();

  return {
    addItems(items, opts) {
      const groups = opts?.position === 'top' ? topGroups : bottomGroups;
      groups.push(items);
      apply();
      return () => {
        const idx = groups.indexOf(items);
        if (idx !== -1) groups.splice(idx, 1);
        apply();
      };
    },
  };
}
