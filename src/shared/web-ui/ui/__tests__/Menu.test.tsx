import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Menu, type MenuEntry } from '..';

function Harness(props: { items: MenuEntry[]; footer?: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLButtonElement>(null);
  return (
    <div className="ac">
      <button
        ref={ref}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Account menu
      </button>
      <button type="button">Elsewhere</button>
      <Menu
        open={open}
        anchorRef={ref}
        onClose={() => setOpen(false)}
        aria-label="Account"
        placement="top-start"
        items={props.items}
        footer={props.footer}
      />
    </div>
  );
}

const settings = jest.fn();
const logout = jest.fn();
const ITEMS: MenuEntry[] = [
  { key: 'settings', label: 'Settings', icon: 'settings', onSelect: settings },
  { key: 'disabled', label: 'Disabled', disabled: true, onSelect: jest.fn() },
  'separator',
  {
    key: 'logout',
    label: 'Log out',
    icon: 'log-out',
    danger: true,
    keepOpen: true,
    onSelect: logout,
  },
];

beforeEach(() => {
  settings.mockReset();
  logout.mockReset();
});

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
  return screen.getByRole('menu', { name: 'Account' });
}

describe('Menu', () => {
  it('opens with menu roles and focuses the first item', () => {
    render(<Harness items={ITEMS} />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    openMenu();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    expect(screen.getByRole('separator')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
  });

  it('moves with arrows, skipping disabled items and wrapping', () => {
    render(<Harness items={ITEMS} />);
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toHaveFocus();
  });

  it('closes on Esc and returns focus to the trigger', () => {
    render(<Harness items={ITEMS} />);
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account menu' })).toHaveFocus();
  });

  it('closes on an outside press', () => {
    render(<Harness items={ITEMS} />);
    openMenu();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes then selects; keepOpen items stay open', () => {
    render(<Harness items={ITEMS} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    expect(settings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('renders the footer inside the menu', () => {
    render(<Harness items={ITEMS} footer={<p role="alert">network down</p>} />);
    const menu = openMenu();
    expect(menu).toContainElement(screen.getByRole('alert'));
  });
});
