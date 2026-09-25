import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import {
  AppShell,
  SidebarFrame,
  NavGroup,
  NavItem,
  HostFrame,
  detectPlatform,
} from '..';

describe('detectPlatform', () => {
  it.each([
    ['MacIntel', 'mac'],
    ['Win32', 'win'],
    ['Linux x86_64', 'linux'],
    ['', 'linux'],
  ])('%s → %s', (p, want) => {
    expect(detectPlatform(p)).toBe(want);
  });
});

describe('AppShell', () => {
  it('is the .ac root with a platform class, a sidebar and one main', () => {
    const { container } = render(
      <AppShell
        platform="win"
        sidebar={
          <SidebarFrame brand="KIAgent" foot={<span>foot</span>}>
            nav
          </SidebarFrame>
        }
      >
        <HostFrame title="Sources">
          <div>legacy screen</div>
        </HostFrame>
      </AppShell>,
    );
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass('ac', 'ui-shell', 'is-win');
    expect(screen.getByRole('complementary')).toBeInTheDocument();
    expect(screen.getByRole('main')).toContainElement(
      screen.getByText('legacy screen'),
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Sources' }),
    ).toBeInTheDocument();
    expect(screen.getByText('legacy screen').parentElement).toHaveClass(
      'ui-legacy',
    );
    expect(screen.getByRole('navigation', { name: 'Main' })).toHaveTextContent(
      'nav',
    );
  });

  it('reserves room for window controls in the stylesheet', () => {
    const css = fs.readFileSync(
      path.resolve(__dirname, '../../ui.css'),
      'utf8',
    );
    expect(css).toMatch(
      /\.ui-shell\.is-win \.ui-top,\s*\.ui-shell\.is-linux \.ui-top\s*\{\s*padding-right:\s*140px;/,
    );
    expect(css).toMatch(
      /\.ui-shell\.is-mac \.ui-sidebar-head\s*\{\s*padding-left:\s*90px;/,
    );
  });
});

describe('NavItem', () => {
  it('names a count and marks the active item', () => {
    const onClick = jest.fn();
    render(
      <NavGroup label="System">
        <NavItem
          label="Outbox"
          icon="mail"
          active
          count={120}
          onClick={onClick}
          title="May be incomplete"
        />
      </NavGroup>,
    );
    expect(screen.getByRole('group', { name: 'System' })).toBeInTheDocument();
    const item = screen.getByRole('button', { name: 'Outbox, 120 needs you' });
    expect(item).toHaveAttribute('aria-current', 'page');
    expect(item).toHaveTextContent('99+');
    expect(item).toHaveAttribute('title', 'May be incomplete');
    fireEvent.click(item);
    expect(onClick).toHaveBeenCalled();
  });

  it('names a dot, and never shows the dot with a count', () => {
    const { rerender } = render(
      <NavItem
        label="Connection"
        icon="link"
        active={false}
        dot={{ tone: 'ok', label: 'online' }}
        onClick={() => {}}
      />,
    );
    const item = screen.getByRole('button', { name: 'Connection online' });
    expect(item).not.toHaveAttribute('aria-current');
    expect(item.querySelector('.ui-nav-dot')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    rerender(
      <NavItem
        label="Incoming"
        icon="folder"
        active={false}
        count={2}
        countLabel="couldn't be sorted"
        dot={{ tone: 'err', label: 'offline' }}
        onClick={() => {}}
      />,
    );
    const counted = screen.getByRole('button', {
      name: "Incoming, 2 couldn't be sorted",
    });
    expect(counted.querySelector('.ui-nav-dot')).toBeNull();
  });

  it('shows neither for a zero count', () => {
    render(
      <NavItem
        label="Outbox"
        icon="mail"
        active={false}
        count={0}
        onClick={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Outbox' })).toBeInTheDocument();
  });
});
