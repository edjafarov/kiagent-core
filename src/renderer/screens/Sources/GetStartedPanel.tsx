import React from 'react';
import { useAppState } from '@renderer/state/app-state';
import { Icon } from '@shared/web-ui/icon-sprite';
import { deriveOnboarding, step1Meta } from './onboarding-steps';

export function GetStartedPanel(props: {
  onOpenConnection: () => void;
}): React.ReactElement | null {
  const onboarding = useAppState((s) => s.prefs.onboarding);
  const accounts = useAppState((s) => s.accounts);
  const d = deriveOnboarding(onboarding);
  if (!d.visible) return null;

  const dismiss = (): void => {
    // Full-object patch (spec-mandated shape). prefs.patch deep-merges, so
    // the other latches survive either way; main re-latches on its own
    // signals, so a stale null here can never permanently regress a latch —
    // and once dismissedAt is set the panel is hidden regardless.
    void window.kiagent.invoke('prefs:patch', {
      onboarding: { ...onboarding, dismissedAt: new Date().toISOString() },
    });
  };

  return (
    <div className="ob-panel" data-testid="get-started-panel">
      <div className="ob-head">
        <div className="ob-head-text">
          <span className="ob-title">Get started with KIAgent</span>
          <span className="ob-sub">
            Add a source, connect your LLM, then try a query — that&rsquo;s it.
          </span>
        </div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn sm"
          data-testid="onboarding-skip"
          onClick={dismiss}
        >
          Skip
        </button>
      </div>
      <div className="ob-checklist">
        <Step
          done={d.step1Done}
          label="Add a source"
          meta={step1Meta(accounts, d.step1Done)}
          testId="onboarding-step-source"
        />
        <Step
          done={d.step2Done}
          label="Connect your LLM"
          meta={
            d.step2Done
              ? 'LLM connected.'
              : 'Point Claude Code · Cursor · VS Code at KIAgent.'
          }
          testId="onboarding-step-mcp"
          action={
            d.step2Done ? undefined : (
              <button
                type="button"
                className="btn primary sm"
                data-testid="onboarding-open-connection"
                onClick={props.onOpenConnection}
              >
                Open Connection tab
                <Icon name="arrow-right" size={12} />
              </button>
            )
          }
        />
        <Step
          done={d.step3Done}
          label="Try a query"
          meta={
            d.step3Done
              ? 'First query received.'
              : 'Ask your connected LLM about your data.'
          }
          testId="onboarding-step-query"
        />
      </div>
    </div>
  );
}

function Step(props: {
  done: boolean;
  label: string;
  meta: string;
  testId: string;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      className={`ob-step${props.done ? ' done' : ''}`}
      data-testid={props.testId}
      data-done={props.done}
    >
      <span className={`ob-step-icon${props.done ? ' done' : ''}`} aria-hidden>
        ✓
      </span>
      <span className="ob-step-body">
        <span className="ob-step-label">{props.label}</span>
        <span className="ob-step-meta">{props.meta}</span>
      </span>
      {props.action}
    </div>
  );
}
