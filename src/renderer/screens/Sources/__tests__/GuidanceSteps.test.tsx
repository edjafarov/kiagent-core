import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GuidanceSteps } from '../GuidanceSteps';

const STEPS = [
  {
    title: 'Create the Slack app',
    body: 'Create New App → From a manifest → paste this:',
    link: 'https://api.slack.com/apps?new_app=1',
    copy: 'display_information:\n  name: KIAgent\n',
  },
  {
    title: 'Install to your workspace',
    body: 'Install App → Install to Workspace.',
  },
];

describe('GuidanceSteps', () => {
  test('renders numbered titles and bodies', () => {
    render(<GuidanceSteps steps={STEPS} />);
    expect(screen.getByText('Create the Slack app')).toBeInTheDocument();
    expect(screen.getByText('Install to your workspace')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  test('Open button opens the link in a new window', () => {
    const openSpy = jest.spyOn(window, 'open').mockReturnValue(null);
    render(<GuidanceSteps steps={STEPS} />);
    const opens = screen.getAllByRole('button', { name: /open/i });
    expect(opens).toHaveLength(1); // only the step with a link
    fireEvent.click(opens[0]);
    expect(openSpy).toHaveBeenCalledWith(
      'https://api.slack.com/apps?new_app=1',
      '_blank',
    );
    openSpy.mockRestore();
  });

  test('Copy button writes the content and shows Copied ✓', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<GuidanceSteps steps={STEPS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Copied ✓' }),
      ).toBeInTheDocument(),
    );
    expect(writeText).toHaveBeenCalledWith(
      'display_information:\n  name: KIAgent\n',
    );
  });

  test('renders nothing for an empty steps array', () => {
    const { container } = render(<GuidanceSteps steps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
