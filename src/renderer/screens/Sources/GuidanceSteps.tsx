import React, { useEffect, useRef, useState } from 'react';
import type { GuideStep } from './prompt-guidance';

/**
 * Numbered setup steps parsed from a prompt schema's `x-steps` (see
 * prompt-guidance.ts) — the "where to click, what to copy" walkthrough shown
 * above the connect form. Presentational except for the transient
 * copied-feedback state. Links are https-only (enforced at parse time) and
 * open via window.open → main's setWindowOpenHandler → system browser.
 */
export function GuidanceSteps(props: {
  steps: GuideStep[];
}): React.ReactElement | null {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (props.steps.length === 0) return null;

  const copy = async (idx: number, content: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      return; // clipboard unavailable — button just stays "Copy"
    }
    setCopiedIdx(idx);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopiedIdx(null), 2000);
  };

  return (
    <ol className="as-steps">
      {props.steps.map((step, idx) => (
        // Steps are render-only and the array never reorders — index keys are fine.
        // eslint-disable-next-line react/no-array-index-key
        <li key={idx} className="as-step">
          <span className="as-step-num" aria-hidden="true">
            {idx + 1}
          </span>
          <div className="as-step-body">
            <span className="as-step-title">{step.title}</span>
            {step.body && <span className="t-meta">{step.body}</span>}
            {step.link && (
              <button
                type="button"
                className="btn sm"
                onClick={() => window.open(step.link, '_blank')}
              >
                Open ↗
              </button>
            )}
            {step.copy !== undefined && (
              <>
                <pre className="as-copy">{step.copy}</pre>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => void copy(idx, step.copy as string)}
                >
                  {copiedIdx === idx ? 'Copied ✓' : 'Copy'}
                </button>
              </>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
