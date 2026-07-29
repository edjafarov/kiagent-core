import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_PRODUCT_NAME } from '@shared/product';
import { About } from '../About';

/**
 * The About pane's brand name is product-supplied (product.json → `app:info`),
 * not a source literal — that is what lets a product build re-brand without
 * patching core's source. Both surfaces that name the product (the title and
 * the copyright footer) must move together.
 */

const invoke = jest.fn();

function mockBridge(info: Record<string, unknown> | null): void {
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    // `info === null` models the frame before main has answered: NO invoke
    // settles, so the render under test is purely the fallback path.
    if (info === null) return new Promise(() => {});
    if (channel === 'app:info') return Promise.resolve(info);
    if (channel === 'update:get-state') {
      return Promise.resolve({ status: 'idle' });
    }
    return Promise.resolve(undefined);
  });
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke,
    on: () => () => {},
  };
}

function appInfo(productName: string) {
  return { version: '1.2.3', platform: 'darwin', productName };
}

describe('About brand name', () => {
  it('renders the product name supplied by app:info', async () => {
    mockBridge(appInfo('Acme Assistant'));
    render(<About />);
    await waitFor(() =>
      expect(screen.getByText('Acme Assistant')).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/© 2026 Acme Assistant contributors\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(DEFAULT_PRODUCT_NAME)).not.toBeInTheDocument();
  });

  it('falls back to the default name before app:info resolves', () => {
    mockBridge(null);
    render(<About />);
    expect(screen.getByText(DEFAULT_PRODUCT_NAME)).toBeInTheDocument();
    expect(
      screen.getByText(
        new RegExp(`© 2026 ${DEFAULT_PRODUCT_NAME} contributors\\.`),
      ),
    ).toBeInTheDocument();
  });

  it('renders the default name when the build ships no product config', async () => {
    mockBridge(appInfo(DEFAULT_PRODUCT_NAME));
    render(<About />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(screen.getByText(DEFAULT_PRODUCT_NAME)).toBeInTheDocument();
    expect(
      screen.getByText(
        new RegExp(`© 2026 ${DEFAULT_PRODUCT_NAME} contributors\\.`),
      ),
    ).toBeInTheDocument();
  });

  it('keeps the repository identity independent of the product name', async () => {
    // Re-branding the app must NOT re-brand the OSS repo links/labels.
    mockBridge(appInfo('Acme Assistant'));
    render(<About />);
    await waitFor(() =>
      expect(screen.getByText('Acme Assistant')).toBeInTheDocument(),
    );
    expect(
      screen.getByText('github.com/edjafarov/kiagent-core'),
    ).toBeInTheDocument();
  });
});
