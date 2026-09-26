import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CAP_CATALOG } from '@renderer/components/cap-catalog';
import { InstallSheet } from '../InstallSheet';
import type { InstallRequest } from '../use-extension-install';

// react-markdown is ESM-only; ts-jest cannot load it.
jest.mock(
  'react-markdown',
  () =>
    function (p: { children: string }) {
      return <div data-testid="md">{p.children}</div>;
    },
);

function request(overrides: Partial<InstallRequest> = {}): InstallRequest {
  return {
    mode: 'install',
    token: 't1',
    id: 'ext.foo',
    name: 'Foo Extension',
    version: '1.2.3',
    caps: ['query', 'net'],
    sizeBytes: 2 * 1024 * 1024,
    ref: 'github:acme/foo-kia-connector',
    ...overrides,
  };
}

function sheet(
  overrides: Partial<InstallRequest> = {},
  props: Partial<React.ComponentProps<typeof InstallSheet>> = {},
): ReturnType<typeof render> {
  return render(
    <InstallSheet
      request={request(overrides)}
      onClose={jest.fn()}
      onConfirm={jest.fn()}
      {...props}
    />,
  );
}

function rowOf(text: string | RegExp): HTMLElement {
  return screen.getByText(text).closest('li') as HTMLElement;
}

describe('InstallSheet', () => {
  test('names the extension, where it comes from and its version', () => {
    sheet({}, { description: 'Brings in foo.' });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Foo Extension')).toBeInTheDocument();
    expect(
      within(dialog).getByText('From the store · v1.2.3'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Brings in foo.')).toBeInTheDocument();
  });

  test('one row per cap; elevated rows say so and why, others do not', () => {
    sheet();
    const list = screen.getByRole('list', { name: 'It will be able to' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    const query = rowOf(CAP_CATALOG.query.label);
    expect(within(query).getByText('Elevated')).toBeInTheDocument();
    expect(
      within(query).getByText(CAP_CATALOG.query.description),
    ).toBeInTheDocument();
    const net = rowOf(CAP_CATALOG.net.label);
    expect(within(net).queryByText('Elevated')).not.toBeInTheDocument();
  });

  test('confirm shows the busy label and holds Cancel and Escape until it settles', async () => {
    let settle: () => void = () => {};
    const onConfirm = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const onClose = jest.fn();
    sheet({}, { onConfirm, onClose });

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole('button', { name: 'Installing…' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    settle();
    await screen.findByRole('button', { name: 'Install' });
  });

  test('Escape closes when idle', () => {
    const onClose = jest.fn();
    sheet({}, { onClose });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('primary label follows the mode and can be overridden', () => {
    const { unmount } = sheet({ mode: 'update' });
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
    unmount();
    const r = sheet({ mode: 'review' });
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    r.unmount();
    sheet({}, { confirmLabel: 'Install & connect' });
    expect(
      screen.getByRole('button', { name: 'Install & connect' }),
    ).toBeInTheDocument();
  });

  test('says it needs no special access when nothing is requested', () => {
    sheet({ caps: [] });
    expect(screen.getByText('It needs no special access.')).toBeInTheDocument();
  });

  test('one sign-in row per provider, listing its source ids', () => {
    sheet({
      caps: [],
      oauthSources: [
        { id: 'google-docs', provider: 'google' },
        { id: 'google-sheets', provider: 'google' },
      ],
    });
    const row = rowOf(
      /Signs in with your Google account \(google-docs, google-sheets\)/,
    );
    expect(within(row).getByText('Elevated')).toBeInTheDocument();
    expect(
      screen.queryByText('It needs no special access.'),
    ).not.toBeInTheDocument();
  });

  test('the pages row shows only when the extension adds pages', () => {
    const { unmount } = sheet({ caps: [], addsPages: true });
    expect(screen.getByText(/Add pages to KIAgent/)).toBeInTheDocument();
    unmount();
    sheet();
    expect(screen.queryByText(/Add pages to KIAgent/)).toBeNull();
  });

  test('developer details hold the facts and the README, closed at first', async () => {
    sheet({ integrity: 'sha512-abc' }, { readme: '# Foo\n\nReadme body.' });
    expect(screen.queryByText(/Readme body\./)).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: /Details from the developer/ }),
    );
    expect(await screen.findByText(/Readme body\./)).toBeInTheDocument();
    expect(screen.getByText('2.0 MB')).toBeInTheDocument();
    expect(screen.getByText('sha512-abc')).toBeInTheDocument();
    expect(
      screen.getByText('github:acme/foo-kia-connector'),
    ).toBeInTheDocument();
  });
});
