import React from 'react';
import type { ConfirmMode } from '@shared/contracts';
import {
  Card,
  CardFooter,
  CardHeader,
  Row,
  Rows,
  TextButton,
} from '@shared/web-ui/ui';
import { Icon } from '@shared/web-ui/icon-sprite';
import { useAppState } from '@renderer/state/app-state';
import { useProductName } from '@renderer/state/product-name';
import { useView } from '@renderer/state/view';

/**
 * Before anything is sent: how new drafts are confirmed — the one global
 * setting (`prefs.outbound.defaultMode`, which the outbound service reads
 * when it freezes a draft's mode). An account's own choice in Sources wins.
 */
export function ConfirmModeCard(): React.ReactElement {
  const mode = useAppState((s) => s.prefs.outbound.defaultMode);
  const product = useProductName();
  const { navigate } = useView();

  const choices: Array<{ mode: ConfirmMode; title: string; sub: string }> = [
    {
      mode: 'review',
      title: `Review in ${product}`,
      sub: 'Read the whole message here, then Send.',
    },
    {
      mode: 'link',
      title: 'One-click link',
      sub: 'Confirm from a short link — handy on your phone.',
    },
    {
      mode: 'chat',
      title: 'Ask in the chat',
      sub: 'Trust the AI app to confirm with you first.',
    },
  ];

  const choose = (next: ConfirmMode) => {
    if (next === mode) return;
    void window.kiagent.invoke('prefs:patch', {
      outbound: { defaultMode: next },
    });
  };

  return (
    <Card>
      <CardHeader label="Before anything is sent" />
      <Rows aria-label="How drafts are confirmed">
        {choices.map((c) => (
          <Row
            key={c.mode}
            size={48}
            selected={c.mode === mode}
            lead={
              <span className="ob-check">
                {c.mode === mode && <Icon name="check" size={14} />}
              </span>
            }
            title={c.title}
            sub={c.sub}
            onClick={() => choose(c.mode)}
            aria-label={c.title}
          />
        ))}
      </Rows>
      {mode === 'chat' && (
        <p className="ob-note is-warn">
          The AI app sends after you agree in the chat — no review first. Sends
          are capped at 30 per hour per account.
        </p>
      )}
      <CardFooter>
        An account can use its own choice — set it on the account in{' '}
        <TextButton onClick={() => navigate('sources')}>Sources</TextButton>.
      </CardFooter>
    </Card>
  );
}
