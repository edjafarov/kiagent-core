import React from 'react';

export function GoogleGlyph(props: { size?: number } = {}): React.ReactElement {
  const size = props.size ?? 18;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      style={{ background: '#fff', padding: 1 }}
      aria-hidden="true"
    >
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.79 2.72v2.26h2.9c1.7-1.56 2.69-3.87 2.69-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.36 0-4.36-1.6-5.07-3.74H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.93 10.68A5.4 5.4 0 0 1 3.64 9c0-.58.1-1.15.29-1.68V4.99H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.01l2.97-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A9 9 0 0 0 9 0 9 9 0 0 0 .96 4.99l2.97 2.33C4.64 5.18 6.64 3.58 9 3.58z"
      />
    </svg>
  );
}

export function MicrosoftGlyph(
  props: { size?: number } = {},
): React.ReactElement {
  const size = props.size ?? 18;
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <rect width="8" height="8" fill="#F25022" />
      <rect width="8" height="8" x="10" fill="#7FBA00" />
      <rect width="8" height="8" y="10" fill="#00A4EF" />
      <rect width="8" height="8" x="10" y="10" fill="#FFB900" />
    </svg>
  );
}
