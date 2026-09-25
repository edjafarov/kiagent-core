import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Page, TopBar, Split, Columns, Stack } from '..';

describe('TopBar', () => {
  it('shows the title as the page heading, meta and actions', () => {
    render(
      <TopBar
        title="Home"
        meta="Thursday 24 September"
        actions={<button type="button">Record</button>}
      />,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Home' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Thursday 24 September')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record' })).toBeInTheDocument();
  });

  it('shows a breadcrumb that steps back through onBack', () => {
    const onBack = jest.fn();
    render(<TopBar crumb={{ parent: 'Sources', current: 'Gmail', onBack }} />);
    expect(
      screen.getByRole('navigation', { name: 'Breadcrumb' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Gmail' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Sources' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sources' }));
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it('uses onParent for the parent when given', () => {
    const onBack = jest.fn();
    const onParent = jest.fn();
    render(
      <TopBar
        crumb={{ parent: 'Settings', current: 'Logs', onBack, onParent }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onParent).toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });
});

describe('Page and layout', () => {
  it('renders the top bar and a pane with the content', () => {
    const { container } = render(
      <Page title="Sources">
        <Split aside="md" side={<p>panel</p>}>
          <Columns template="1.08fr 1fr .74fr">
            <Stack gap="stack">
              <p>a</p>
            </Stack>
          </Columns>
        </Split>
      </Page>,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Sources' }),
    ).toBeInTheDocument();
    const pane = container.querySelector('.ui-pane')!;
    expect(pane).toContainElement(screen.getByText('panel'));
    const cols = container.querySelector('.ui-cols') as HTMLElement;
    expect(cols.style.getPropertyValue('--ui-cols')).toBe('1.08fr 1fr .74fr');
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });
});
