import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { Note } from '..';

test('a note is a paragraph a field can point at', () => {
  render(<Note id="hint">Kept on this computer.</Note>);
  const note = screen.getByText('Kept on this computer.');
  expect(note.tagName).toBe('P');
  expect(note).toHaveAttribute('id', 'hint');
});

test('an error note can announce itself', () => {
  render(
    <Note tone="error" role="alert">
      Could not save.
    </Note>,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Could not save.');
});

test('inside a row a note is a span', () => {
  render(
    <div>
      <Note as="span">Saved</Note>
    </div>,
  );
  expect(screen.getByText('Saved').tagName).toBe('SPAN');
});
