import React, { useState } from 'react';
import { Icon } from '@shared/web-ui/icon-sprite';

/**
 * Collapsible manual-setup block — ported near-verbatim from the legacy
 * renderer's `screens/Connection/ManualSetup.tsx` (kiagent-ref): a
 * `.conn-manual-trigger` disclosure button (chevron rotates 90° when open)
 * reading "Manual setup — {summary}"; children (the copyable snippet
 * content) render in `.conn-manual-body` only while expanded.
 */
export function ManualSetup(props: {
  summary: string;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="conn-manual">
      <button
        type="button"
        className="conn-manual-trigger"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="chev-right" size={12} className="chev" />
        Manual setup — {props.summary}
      </button>
      {open && <div className="conn-manual-body">{props.children}</div>}
    </div>
  );
}
