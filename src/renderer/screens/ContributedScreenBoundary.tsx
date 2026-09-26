import React from 'react';
import {
  ContributedUnavailable,
  type ContributedUnavailableReason,
} from './ContributedUnavailable';

interface Props {
  extensionName: string;
  children: React.ReactNode;
}

interface State {
  threw: boolean;
}

/**
 * B3: EACH contributed screen mounts inside its OWN error boundary — a
 * throwing contribution must not blank the app shell (sidebar/nav keep
 * rendering; only this one screen is replaced). Only a class component can
 * implement `componentDidCatch`; this is the sole class component in
 * core's renderer for exactly that reason.
 *
 * Reset is structural, not stateful: `App.tsx` keys the mounted screen on
 * `${view}:${epoch}`, so navigating away and back always remounts a fresh
 * boundary rather than reusing one that already caught.
 */
export class ContributedScreenBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { threw: false };
  }

  static getDerivedStateFromError(): State {
    return { threw: true };
  }

  componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error(
      `[contributed-screen] ${this.props.extensionName} threw while rendering:`,
      error,
    );
  }

  render(): React.ReactNode {
    if (this.state.threw) {
      const reason: ContributedUnavailableReason = 'error';
      return (
        <ContributedUnavailable
          extensionName={this.props.extensionName}
          reason={reason}
        />
      );
    }
    return this.props.children;
  }
}
