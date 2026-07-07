import { buildTrayMenuTemplate } from '../tray';

jest.mock('electron', () => ({
  Menu: { buildFromTemplate: jest.fn() },
  Tray: jest.fn(),
  nativeImage: { createFromPath: jest.fn() },
}));

describe('buildTrayMenuTemplate', () => {
  it('lists Open, Sync now, separator, Quit in order', () => {
    const template = buildTrayMenuTemplate({
      openWindow: () => {},
      syncNow: () => {},
      quit: () => {},
    });
    expect(template.map((item) => item.label ?? item.type)).toEqual([
      'Open KIAgent',
      'Sync now',
      'separator',
      'Quit KIAgent',
    ]);
  });

  it('wires each item to its action', () => {
    const calls: string[] = [];
    const template = buildTrayMenuTemplate({
      openWindow: () => calls.push('open'),
      syncNow: () => calls.push('sync'),
      quit: () => calls.push('quit'),
    });
    const click = (index: number) => (template[index].click as () => void)();
    click(0);
    click(1);
    click(3);
    expect(calls).toEqual(['open', 'sync', 'quit']);
  });
});
