import type { ExtensionSnapshot, UiContribution } from '@shared/contracts';
import { makeExtView } from '@renderer/state/view';
import { ICON_NAMES } from '@shared/web-ui/icon-sprite';
import { contributedNavRows } from '../contributed-nav';

const snap = (
  id: string,
  ui: UiContribution[],
  over: Partial<ExtensionSnapshot> = {},
): ExtensionSnapshot => ({
  id,
  name: id,
  version: '1',
  origin: 'marketplace',
  enabled: true,
  status: 'activated',
  caps: [],
  sourceIds: [],
  oauthSources: [],
  ui,
  ...over,
});

it('one row per contribution of every enabled extension, sorted by order then title', () => {
  const rows = contributedNavRows(
    [
      snap('b.b', [
        { id: 'z', slot: 'screen', title: 'Zed', nav: { order: 10 } },
      ]),
      snap('a.a', [
        {
          id: 'c',
          slot: 'screen',
          title: 'Calendar',
          nav: { order: 40, group: 'Memory', icon: 'calendar' },
        },
        {
          id: 'x',
          slot: 'screen',
          title: 'Alpha',
          nav: { order: 40, group: 'Nope', icon: 'unknown' },
        },
      ]),
      snap('off.off', [{ id: 'q', slot: 'screen', title: 'Hidden' }], {
        enabled: false,
      }),
    ],
    new Set(['calendar']),
  );
  expect(rows).toEqual([
    {
      label: 'Zed',
      view: makeExtView('b.b', 'z'),
      icon: 'puzzle',
      group: 'Memory',
      order: 10,
    },
    {
      label: 'Alpha',
      view: makeExtView('a.a', 'x'),
      icon: 'puzzle',
      group: 'Memory',
      order: 40,
    },
    {
      label: 'Calendar',
      view: makeExtView('a.a', 'c'),
      icon: 'calendar',
      group: 'Memory',
      order: 40,
    },
  ]);
});

it('the System group is honoured; no nav defaults to Memory, order 0', () => {
  const rows = contributedNavRows(
    [
      snap('a.a', [
        { id: 's', slot: 'screen', title: 'S', nav: { group: 'System' } },
        { id: 'n', slot: 'screen', title: 'N' },
      ]),
    ],
    new Set(),
  );
  expect(rows.map((r) => [r.label, r.group, r.order])).toEqual([
    ['N', 'Memory', 0],
    ['S', 'System', 0],
  ]);
});

it('an extension with no ui yields no rows', () => {
  expect(contributedNavRows([snap('a.a', [])], new Set())).toEqual([]);
});

it('ICON_NAMES holds exactly the names <Icon name> accepts', () => {
  expect(ICON_NAMES.has('puzzle')).toBe(true);
  expect(ICON_NAMES.has('i-puzzle')).toBe(false);
});
