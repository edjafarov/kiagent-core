import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen, act } from '@testing-library/react';
import { TextField, Select, TextArea, CopyField, CodeBlock } from '..';

describe('TextField', () => {
  it('is a labelled textbox; search adds the icon', () => {
    const onChange = jest.fn();
    render(
      <TextField
        search
        aria-label="Search"
        value=""
        onChange={onChange}
        placeholder="Search"
      />,
    );
    const box = screen.getByRole('textbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: 'inv' } });
    expect(onChange).toHaveBeenCalled();
    expect(box.parentElement!.querySelector('use')).toHaveAttribute(
      'href',
      '#i-search',
    );
  });
});

describe('Select and TextArea', () => {
  it('render native controls', () => {
    render(
      <>
        <Select aria-label="Language" defaultValue="en">
          <option value="en">English</option>
          <option value="de">German</option>
        </Select>
        <TextArea aria-label="Notes" defaultValue="hi" />
      </>,
    );
    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveValue(
      'en',
    );
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('hi');
  });
});

describe('CopyField', () => {
  it('copies the value and confirms', async () => {
    const copy = jest.fn().mockResolvedValue(undefined);
    render(
      <CopyField
        aria-label="Server URL"
        value="http://127.0.0.1:7421/mcp"
        copy={copy}
      />,
    );
    expect(screen.getByText('http://127.0.0.1:7421/mcp')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Server URL' }));
    });
    expect(copy).toHaveBeenCalledWith('http://127.0.0.1:7421/mcp');
    expect(
      screen.getByRole('button', { name: 'Copy Server URL' }),
    ).toHaveTextContent('Copied');
  });

  it('stays on Copy when the clipboard refuses', async () => {
    const copy = jest.fn().mockRejectedValue(new Error('denied'));
    render(<CopyField aria-label="Token" value="abc" copy={copy} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Token' }));
    });
    expect(
      screen.getByRole('button', { name: 'Copy Token' }),
    ).toHaveTextContent('Copy');
  });
});

describe('CodeBlock', () => {
  it('keeps whitespace', () => {
    const { container } = render(<CodeBlock>{'a\n  b'}</CodeBlock>);
    expect(container.querySelector('pre')!.textContent).toBe('a\n  b');
  });
});
