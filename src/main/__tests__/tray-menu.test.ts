import { createTrayMenuController } from '../tray-menu';

describe('createTrayMenuController', () => {
  const base = () => [
    { label: 'Open KIAgent' },
    { label: 'Sync now' },
    { type: 'separator' as const },
    { label: 'Quit KIAgent' },
  ];

  it('rebuilds with the bare base template when nothing is registered', () => {
    const rebuilds: unknown[] = [];
    createTrayMenuController(base(), (t) => rebuilds.push(t));
    expect(rebuilds).toHaveLength(1);
    expect((rebuilds[0] as { label?: string }[]).map((i) => i.label)).toEqual([
      'Open KIAgent',
      'Sync now',
      undefined,
      'Quit KIAgent',
    ]);
  });

  it('splices added items before the trailing quit item and rebuilds', () => {
    const rebuilds: { label?: string; type?: string }[][] = [];
    const controller = createTrayMenuController(base(), (t) =>
      rebuilds.push(t as { label?: string; type?: string }[]),
    );
    rebuilds.length = 0; // drop the initial construction-time rebuild

    controller.addItems([{ label: 'Extension item' }]);

    expect(rebuilds).toHaveLength(1);
    const labels = rebuilds[0].map((i) => i.label ?? i.type);
    expect(labels.indexOf('Extension item')).toBeGreaterThan(
      labels.indexOf('Sync now'),
    );
    expect(labels.indexOf('Extension item')).toBeLessThan(
      labels.indexOf('Quit KIAgent'),
    );
  });

  it('the disposer removes the items and rebuilds without them', () => {
    const rebuilds: { label?: string; type?: string }[][] = [];
    const controller = createTrayMenuController(base(), (t) =>
      rebuilds.push(t as { label?: string; type?: string }[]),
    );

    const dispose = controller.addItems([{ label: 'Extension item' }]);
    rebuilds.length = 0;

    dispose();

    expect(rebuilds).toHaveLength(1);
    const labels = rebuilds[0].map((i) => i.label ?? i.type);
    expect(labels).not.toContain('Extension item');
    expect(labels).toEqual([
      'Open KIAgent',
      'Sync now',
      'separator',
      'Quit KIAgent',
    ]);
  });

  it('supports multiple independent groups from different callers', () => {
    const rebuilds: { label?: string; type?: string }[][] = [];
    const controller = createTrayMenuController(base(), (t) =>
      rebuilds.push(t as { label?: string; type?: string }[]),
    );

    const disposeA = controller.addItems([{ label: 'A item' }]);
    controller.addItems([{ label: 'B item' }]);
    rebuilds.length = 0;

    disposeA();

    const labels = rebuilds[rebuilds.length - 1].map((i) => i.label ?? i.type);
    expect(labels).not.toContain('A item');
    expect(labels).toContain('B item');
  });
});
