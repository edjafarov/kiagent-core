import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import {
  Card,
  CardHeader,
  CardFooter,
  Panel,
  KeyValue,
  EmptyState,
  cx,
} from '..';

describe('cx', () => {
  it('joins truthy parts', () => {
    expect(cx('a', false, null, undefined, 'b', '')).toBe('a b');
  });
});

describe('Card', () => {
  it('renders a named section with a header, body and footer', () => {
    render(
      <Card aria-label="Recent">
        <CardHeader
          label="Recent"
          count="12"
          meta="today"
          action={<button type="button">See all</button>}
        />
        <p>body</p>
        <CardFooter>Updated 11:50</CardFooter>
      </Card>,
    );
    expect(screen.getByRole('region', { name: 'Recent' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Recent' }),
    ).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('today')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See all' })).toBeInTheDocument();
    expect(screen.getByText('Updated 11:50')).toBeInTheDocument();
  });
});

describe('Panel and KeyValue', () => {
  it('renders the panel title and the pairs in order', () => {
    const { container } = render(
      <Panel title="Gmail">
        <KeyValue
          items={[
            { label: 'Account', value: 'alex@northwind.test' },
            { label: 'Last sync', value: '11:48' },
          ]}
        />
      </Panel>,
    );
    expect(
      screen.getByRole('heading', { level: 3, name: 'Gmail' }),
    ).toBeInTheDocument();
    const terms = Array.from(container.querySelectorAll('dt')).map(
      (d) => d.textContent,
    );
    const values = Array.from(container.querySelectorAll('dd')).map(
      (d) => d.textContent,
    );
    expect(terms).toEqual(['Account', 'Last sync']);
    expect(values).toEqual(['alex@northwind.test', '11:48']);
  });
});

describe('EmptyState', () => {
  it('shows the sentence and the one action', () => {
    render(
      <EmptyState action={<button type="button">Add a source</button>}>
        Nothing here yet.
      </EmptyState>,
    );
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add a source' }),
    ).toBeInTheDocument();
  });
});
