import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { BAD_INPUT, NOT_GITHUB } from '@shared/install-link';
import { AddFromGithubSheet } from '../AddFromGithubSheet';

function sheet(
  props: Partial<React.ComponentProps<typeof AddFromGithubSheet>> = {},
) {
  const onContinue = jest.fn();
  render(
    <AddFromGithubSheet
      busy={false}
      error={null}
      onClose={jest.fn()}
      onContinue={onContinue}
      {...props}
    />,
  );
  return { onContinue };
}

const field = () => screen.getByLabelText('Repository');
const typeIn = (v: string) =>
  fireEvent.change(field(), { target: { value: v } });
const cont = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

describe('AddFromGithubSheet', () => {
  test('a malformed address shows the copy and goes nowhere', () => {
    const { onContinue } = sheet();
    typeIn('a/b/c');
    cont();
    expect(screen.getByRole('alert')).toHaveTextContent(BAD_INPUT);
    expect(onContinue).not.toHaveBeenCalled();
    typeIn('https://gitlab.com/a/b');
    cont();
    expect(screen.getByRole('alert')).toHaveTextContent(NOT_GITHUB);
  });

  test('Continue hands over the github ref, keeping the tag', () => {
    const { onContinue } = sheet();
    typeIn('owner/repo@v1');
    cont();
    expect(onContinue).toHaveBeenCalledWith('github:owner/repo@v1');
  });

  test('Enter submits, and a pasted address-bar URL works', () => {
    const { onContinue } = sheet();
    typeIn('https://github.com/Owner/Repo/');
    fireEvent.submit(field().closest('form')!);
    expect(onContinue).toHaveBeenCalledWith('github:Owner/Repo');
  });

  test('a link prefills the field; nothing runs until Continue', () => {
    const { onContinue } = sheet({ initial: 'edjafarov/sdui-kia-connector' });
    expect(field()).toHaveValue('edjafarov/sdui-kia-connector');
    expect(onContinue).not.toHaveBeenCalled();
  });

  test('a preview error shows under the field; Continue is held while busy', () => {
    sheet({
      error: 'This repository has no release to install yet.',
      busy: true,
      initial: 'o/r',
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This repository has no release to install yet.',
    );
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  });
});
