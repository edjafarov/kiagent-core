import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsLayout, SettingsGroup, SettingsRow, Toggle } from '..';

const PANES = [
  { key: 'general', label: 'General' },
  { key: 'about', label: 'About' },
];

describe('SettingsLayout', () => {
  it('shows the Settings title, the pane list and the active pane', () => {
    const onSelect = jest.fn();
    render(
      <SettingsLayout
        panes={PANES}
        active="about"
        onSelect={onSelect}
        title="About"
      >
        <p>version</p>
      </SettingsLayout>,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Settings' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'About' }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(onSelect).toHaveBeenCalledWith('general');
    expect(screen.getByText('version')).toBeInTheDocument();
  });

  it('prints no pane title when none is given', () => {
    render(
      <SettingsLayout panes={PANES} active="general" onSelect={() => {}}>
        <p>legacy</p>
      </SettingsLayout>,
    );
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
  });
});

describe('SettingsLayout nav foot', () => {
  it('pins a build item under the pane list, inside the nav', () => {
    render(
      <SettingsLayout
        panes={PANES}
        active="general"
        onSelect={() => {}}
        navFoot={<button type="button">Log out</button>}
      >
        <p>body</p>
      </SettingsLayout>,
    );
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    const out = screen.getByRole('button', { name: 'Log out' });
    expect(nav).toContainElement(out);
    expect(out.parentElement).toHaveClass('ui-set-foot');
    // It comes after every pane.
    expect(nav.lastElementChild).toBe(out.parentElement);
  });

  it('renders no foot when a build passes none', () => {
    const { container } = render(
      <SettingsLayout panes={PANES} active="general" onSelect={() => {}}>
        <p>body</p>
      </SettingsLayout>,
    );
    expect(container.querySelector('.ui-set-foot')).toBeNull();
  });
});

describe('SettingsLayout pane icons', () => {
  it('draws a pane icon when given one', () => {
    const { container } = render(
      <SettingsLayout
        panes={[
          { key: 'about', label: 'About', icon: 'info' },
          { key: 'plain', label: 'Plain' },
        ]}
        active="about"
        onSelect={() => {}}
      >
        <p>pane</p>
      </SettingsLayout>,
    );
    const items = container.querySelectorAll('.ui-set-item');
    expect(items[0].querySelector('svg')).not.toBeNull();
    expect(items[1].querySelector('svg')).toBeNull();
  });
});

describe('SettingsGroup and SettingsRow', () => {
  it('renders the row title, description and control', () => {
    render(
      <SettingsGroup title="Startup">
        <SettingsRow
          title="Launch at login"
          description="Starts quietly in the menu bar."
          control={
            <Toggle aria-label="Launch at login" checked onChange={() => {}} />
          }
        />
      </SettingsGroup>,
    );
    expect(screen.getByText('Startup')).toBeInTheDocument();
    expect(
      screen.getByText('Starts quietly in the menu bar.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Launch at login' }),
    ).toBeInTheDocument();
  });

  it('prints the group meta after the title', () => {
    render(
      <SettingsGroup title="Devices" meta="that can reach your memory">
        <span>row</span>
      </SettingsGroup>,
    );
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(
      'Devicesthat can reach your memory',
    );
  });
});
