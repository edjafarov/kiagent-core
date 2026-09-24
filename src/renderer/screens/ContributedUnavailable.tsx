import React from 'react';

/**
 * B3: the ONE shared screen for every way a contributed view (`ExtView`)
 * can fail to render — the design spec's "one screen state with different
 * causes" (§"A dead link shows an explicit 'unavailable' screen", merged
 * with the build-consistency placeholder and the availability table).
 * Never a silent redirect and never a blank pane: every reason below NAMES
 * the extension.
 */
export type ContributedUnavailableReason =
  /** No `ExtensionSnapshot` for this extension id at all — not installed,
   *  or the id in the view was never real. */
  | 'not-installed'
  /** Installed but disabled, or activating/awaiting consent. */
  | 'disabled'
  | 'activating'
  /** The extension's own activation failed. */
  | 'failed'
  /** The page bundle is being fetched and imported. */
  | 'loading'
  /** Fetching or importing the page bundle failed (logged with the cause). */
  | 'load-failed'
  /** The page itself threw while rendering — caught by this contribution's
   *  own error boundary. */
  | 'error';

const REASON_COPY: Record<
  ContributedUnavailableReason,
  { headline: string; detail: string }
> = {
  'not-installed': {
    headline: 'unavailable',
    detail: 'is not installed, or this link no longer points at a real screen.',
  },
  disabled: {
    headline: 'is turned off',
    detail: 'is currently disabled. Turn it on to open this screen.',
  },
  activating: {
    headline: 'is starting',
    detail: 'is still starting up. This screen will be ready shortly.',
  },
  failed: {
    headline: 'failed to start',
    detail: 'failed to activate. Check the extension for details.',
  },
  loading: {
    headline: 'is loading',
    detail: 'is loading this screen.',
  },
  'load-failed': {
    headline: "couldn't load this screen",
    detail: 'could not load its page. Check Logs for the error.',
  },
  error: {
    headline: 'hit an error',
    detail: 'ran into a problem rendering this screen.',
  },
};

const CONTAINER_STYLE: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: 24,
  textAlign: 'center',
};

/** Always names the extension — `extensionName` is the manifest's `name`
 *  when known, falling back to the raw extension id when the extension
 *  isn't installed at all (there is no name to show). */
export function ContributedUnavailable(props: {
  extensionName: string;
  reason: ContributedUnavailableReason;
}): React.ReactElement {
  const { extensionName, reason } = props;
  const copy = REASON_COPY[reason];
  return (
    <div
      className="kg-contributed-unavailable"
      style={CONTAINER_STYLE}
      role="status"
    >
      <span style={{ fontWeight: 600 }}>
        {extensionName} {copy.headline}
      </span>
      <span style={{ opacity: 0.7, maxWidth: 420 }}>
        {extensionName} {copy.detail}
      </span>
    </div>
  );
}
