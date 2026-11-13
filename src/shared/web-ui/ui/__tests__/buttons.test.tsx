import '@testing-library/jest-dom';
import React from 'react';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import { Button, IconButton, TextButton, useCopy } from '..';

describe('Button', () => {
  it('is a type=button with its variant and optional icon', () => {
    const onClick = jest.fn();
    render(
      <Button variant="primary" icon="plus" onClick={onClick}>
        Add source
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Add source' });
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn).toHaveClass('is-primary');
    expect(btn.querySelector('use')).toHaveAttribute('href', '#i-plus');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it('defaults to secondary and forwards refs and disabled', () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(
      <Button ref={ref} disabled>
        Save
      </Button>,
    );
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Save' }));
    expect(ref.current).toHaveClass('is-secondary');
    expect(ref.current).toBeDisabled();
  });
});

describe('IconButton', () => {
  it('is named by its label', () => {
    render(<IconButton icon="settings" label="Settings" />);
    const btn = screen.getByRole('button', { name: 'Settings' });
    expect(btn).toHaveAttribute('title', 'Settings');
    expect(btn.querySelector('use')).toHaveAttribute('href', '#i-settings');
  });
});

describe('TextButton', () => {
  it('is an inline text button', () => {
    const onClick = jest.fn();
    render(<TextButton onClick={onClick}>See all</TextButton>);
    fireEvent.click(screen.getByRole('button', { name: 'See all' }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe('onAction / busy / done', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function deferred(): {
    promise: Promise<unknown>;
    resolve: () => void;
    reject: (e: Error) => void;
  } {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = () => res(undefined);
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('is disabled + aria-busy while pending; spinner only after 200 ms', async () => {
    const d = deferred();
    const onAction = jest.fn(() => d.promise);
    render(<Button onAction={onAction}>Go</Button>);
    const btn = screen.getByRole('button', { name: 'Go' });
    fireEvent.click(btn);
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn.querySelector('.spinner')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(199);
    });
    expect(btn.querySelector('.spinner')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(btn.querySelector('.spinner')).not.toBeNull();
    await act(async () => {
      d.resolve();
    });
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute('aria-busy');
    expect(btn.querySelector('.spinner')).toBeNull();
  });

  it('ignores a second click while pending', () => {
    const d = deferred();
    const onAction = jest.fn(() => d.promise);
    render(<TextButton onAction={onAction}>Go</TextButton>);
    const btn = screen.getByRole('button', { name: 'Go' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('recovers after a rejection without an unhandled rejection', async () => {
    const d = deferred();
    const seen = jest.fn();
    const onAction = (): Promise<unknown> => {
      const p = d.promise;
      p.catch(seen); // the caller's own handling
      return p;
    };
    render(<IconButton icon="plus" label="Add" onAction={onAction} />);
    const btn = screen.getByRole('button', { name: 'Add' });
    fireEvent.click(btn);
    await act(async () => {
      d.reject(new Error('no'));
    });
    expect(seen).toHaveBeenCalled();
    expect(btn).not.toBeDisabled();
  });

  it('done shows a check only after a resolve, for about a second', async () => {
    const d = deferred();
    render(
      <Button icon="plus" done onAction={() => d.promise}>
        Save
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(btn);
    expect(btn.querySelector('use')).toHaveAttribute('href', '#i-plus');
    await act(async () => {
      d.resolve();
    });
    expect(btn.querySelector('use')).toHaveAttribute('href', '#i-check');
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(btn.querySelector('use')).toHaveAttribute('href', '#i-plus');
  });

  it('done shows no check after a reject', async () => {
    const d = deferred();
    render(
      <Button icon="plus" done onAction={() => d.promise}>
        Save
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(btn);
    await act(async () => {
      d.reject(new Error('no'));
      await d.promise.catch(() => undefined);
    });
    expect(btn.querySelector('use')).toHaveAttribute('href', '#i-plus');
  });

  it('onAction wins over onClick; onClick alone is unchanged', async () => {
    const onClick = jest.fn();
    const onAction = jest.fn(() => Promise.resolve());
    const { rerender } = render(
      <Button onClick={onClick} onAction={onAction}>
        Go
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await act(async () => undefined);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    rerender(<Button onClick={onClick}>Go</Button>);
    const btn = screen.getByRole('button', { name: 'Go' });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(btn).not.toHaveAttribute('aria-busy');
  });

  it('sets no state and logs no warning when unmounted while pending', async () => {
    const err = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const d = deferred();
    const { unmount } = render(<Button onAction={() => d.promise}>Go</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    unmount();
    await act(async () => {
      d.resolve();
    });
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('busy prop renders the same pending state', () => {
    render(<Button busy>Go</Button>);
    const btn = screen.getByRole('button', { name: 'Go' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn.querySelector('.spinner')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(btn.querySelector('.spinner')).not.toBeNull();
  });
});

describe('useCopy', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('is copied for about 1.5 s after a successful write', async () => {
    const write = jest.fn(() => Promise.resolve());
    const { result } = renderHook(() => useCopy(write));
    expect(result.current.copied).toBe(false);
    await act(async () => {
      await result.current.copy('abc');
    });
    expect(write).toHaveBeenCalledWith('abc');
    expect(result.current.copied).toBe(true);
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(result.current.copied).toBe(false);
  });

  it('stays false when the clipboard refuses', async () => {
    const write = jest.fn(() => Promise.reject(new Error('denied')));
    const { result } = renderHook(() => useCopy(write));
    await act(async () => {
      await result.current.copy('abc');
    });
    expect(result.current.copied).toBe(false);
  });
});
