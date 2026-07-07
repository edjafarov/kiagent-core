import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ConsentModal, ConsentRequest } from '../ConsentModal';
import { CAP_CATALOG } from '../cap-catalog';

function baseRequest(overrides: Partial<ConsentRequest> = {}): ConsentRequest {
  return {
    mode: 'install',
    id: 'ext.foo',
    name: 'Foo Extension',
    version: '1.2.3',
    caps: ['query', 'net'],
    sizeBytes: 2 * 1024 * 1024,
    ref: 'abc123',
    ...overrides,
  };
}

describe('ConsentModal', () => {
  test('renders name, version, and one row per cap with the CAP_CATALOG label', () => {
    render(
      <ConsentModal
        request={baseRequest()}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Foo Extension/)).toBeInTheDocument();
    expect(screen.getByText(/v1\.2\.3/)).toBeInTheDocument();
    expect(screen.getByText(CAP_CATALOG.query.label)).toBeInTheDocument();
    expect(screen.getByText(CAP_CATALOG.net.label)).toBeInTheDocument();
  });

  test('renders the manifest icon as an <img> when iconDataUrl is present, letter glyph otherwise', () => {
    const { container, rerender } = render(
      <ConsentModal
        request={baseRequest({ iconDataUrl: 'data:image/png;base64,AAAA' })}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    const img = container.querySelector('img.ext-glyph-img');
    expect(img).toHaveAttribute('src', 'data:image/png;base64,AAAA');
    expect(
      container.querySelector('.ext-glyph-fallback'),
    ).not.toBeInTheDocument();

    rerender(
      <ConsentModal
        request={baseRequest()}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    expect(
      container.querySelector('img.ext-glyph-img'),
    ).not.toBeInTheDocument();
    expect(container.querySelector('.ext-glyph-fallback')).toHaveTextContent(
      'F',
    );
  });

  test('query row has the elevated class and Elevated tag; net row does not', () => {
    render(
      <ConsentModal
        request={baseRequest()}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    const queryRow = screen
      .getByText(CAP_CATALOG.query.label)
      .closest('.cm-cap-row');
    const netRow = screen
      .getByText(CAP_CATALOG.net.label)
      .closest('.cm-cap-row');

    expect(queryRow).toHaveClass('elevated');
    expect(
      within(queryRow as HTMLElement).getByText('Elevated'),
    ).toBeInTheDocument();

    expect(netRow).not.toHaveClass('elevated');
    expect(
      within(netRow as HTMLElement).queryByText('Elevated'),
    ).not.toBeInTheDocument();
  });

  test('confirm button calls onConfirm, shows the busy label while pending, and disables cancel/Escape while busy', async () => {
    let resolveConfirm: () => void = () => {};
    const onConfirm = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    const onCancel = jest.fn();

    render(
      <ConsentModal
        request={baseRequest()}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    const busyButton = await screen.findByRole('button', {
      name: 'Installing…',
    });
    expect(busyButton).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();

    resolveConfirm();
    await screen.findByRole('button', { name: 'Install' });
  });

  test('Escape calls onCancel when idle', () => {
    const onCancel = jest.fn();
    render(
      <ConsentModal
        request={baseRequest()}
        onCancel={onCancel}
        onConfirm={jest.fn()}
      />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('backdrop click cancels; inner click does not', () => {
    const onCancel = jest.fn();
    const { container } = render(
      <ConsentModal
        request={baseRequest()}
        onCancel={onCancel}
        onConfirm={jest.fn()}
      />,
    );

    const backdrop = container.querySelector('.cm-backdrop') as HTMLElement;
    const modal = container.querySelector('.cm-modal') as HTMLElement;

    fireEvent.click(modal);
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('renders the no-capabilities line when caps is empty', () => {
    render(
      <ConsentModal
        request={baseRequest({ caps: [] })}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(
      screen.getByText('This extension requests no capabilities.'),
    ).toBeInTheDocument();
  });

  test('renders an elevated sign-in row naming the provider and source ids when oauthSources is present', () => {
    render(
      <ConsentModal
        request={baseRequest({
          oauthSources: [{ id: 'google-docs', provider: 'google' }],
        })}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    const label = screen.getByText(
      /Signs in with your Google account \(google-docs\)/,
    );
    const row = label.closest('.cm-cap-row');
    expect(row).toHaveClass('elevated');
    expect(
      within(row as HTMLElement).getByText('Elevated'),
    ).toBeInTheDocument();
    // The other caps still render alongside.
    expect(screen.getByText(CAP_CATALOG.net.label)).toBeInTheDocument();
  });

  test('one sign-in row per provider, listing all of its source ids', () => {
    render(
      <ConsentModal
        request={baseRequest({
          oauthSources: [
            { id: 'google-docs', provider: 'google' },
            { id: 'google-sheets', provider: 'google' },
          ],
        })}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(
      screen.getByText(
        /Signs in with your Google account \(google-docs, google-sheets\)/,
      ),
    ).toBeInTheDocument();
  });

  test('no sign-in row when oauthSources is absent or empty', () => {
    const { rerender } = render(
      <ConsentModal
        request={baseRequest()}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    expect(screen.queryByText(/Signs in with your/)).not.toBeInTheDocument();

    rerender(
      <ConsentModal
        request={baseRequest({ oauthSources: [] })}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    expect(screen.queryByText(/Signs in with your/)).not.toBeInTheDocument();
  });

  test('oauth-only request (no caps) shows the sign-in row, not the no-capabilities line', () => {
    render(
      <ConsentModal
        request={baseRequest({
          caps: [],
          oauthSources: [{ id: 'google-docs', provider: 'google' }],
        })}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(
      screen.getByText(/Signs in with your Google account \(google-docs\)/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('This extension requests no capabilities.'),
    ).not.toBeInTheDocument();
  });
});
