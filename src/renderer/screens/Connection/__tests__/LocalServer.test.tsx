import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { LocalServer } from '../LocalServer';

test('online: the endpoint, who can use it, and the three snippets', () => {
  render(<LocalServer port={7421} />);
  expect(screen.getByText('Online')).toBeInTheDocument();
  expect(
    screen.getAllByText('http://127.0.0.1:7421/mcp')[0],
  ).toBeInTheDocument();
  expect(screen.getByText(/no sign-in/)).toBeInTheDocument();
  expect(screen.getByText(/"mcpServers"/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }));
  expect(
    screen.getByText(/claude mcp add --transport http/),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'VS Code' }));
  expect(screen.getByText(/"servers"/)).toBeInTheDocument();
  expect(screen.getByText(/start the server themselves/)).toBeInTheDocument();
});

test('no port yet: Not ready, no endpoint and no snippet', () => {
  render(<LocalServer port={null} />);
  expect(screen.getByText('Not ready')).toBeInTheDocument();
  expect(screen.queryByRole('tab')).toBeNull();
  expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull();
  expect(screen.getByText(/hasn’t reported a port yet/)).toBeInTheDocument();
});
