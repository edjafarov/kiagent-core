import React from 'react';
import { Card, CardHeader, Select, TextField } from '@shared/web-ui/ui';
import type { Account, ConfirmMode } from '@shared/contracts';

/**
 * Per-account outbound settings: confirmation-mode override, From address,
 * and SMTP overrides (host/port derived from the IMAP host by default —
 * only unusual providers need these). Rides the DEDICATED
 * accounts:update-outbound channel: accounts:update-config would restart a
 * running sync loop (engine.updateConfig).
 */
export function Outbound(props: { account: Account }): React.ReactElement {
  const { account } = props;
  const cfg = (account.config.outbound ?? {}) as {
    mode?: ConfirmMode;
    fromAddress?: string;
    smtp?: { host?: string; port?: number };
  };

  const update = (outbound: Record<string, unknown>) => {
    void window.kiagent.invoke('accounts:update-outbound', {
      accountId: account.id,
      outbound,
    });
  };

  return (
    <Card>
      <CardHeader label="Sending" />
      <div className="field-row">
        {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
        <label htmlFor="outbound-from" className="lbl">
          From address
        </label>
        <TextField
          className="field-grow"
          id="outbound-from"
          placeholder="defaults to the account's login email"
          defaultValue={cfg.fromAddress ?? ''}
          onBlur={(e) =>
            update({ ...cfg, fromAddress: e.target.value || undefined })
          }
        />
      </div>
      <div className="field-row">
        {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
        <label htmlFor="outbound-mode" className="lbl">
          Send confirmation
        </label>
        <Select
          id="outbound-mode"
          value={cfg.mode ?? ''}
          onChange={(e) =>
            update({
              ...cfg,
              mode:
                e.target.value === ''
                  ? undefined
                  : (e.target.value as ConfirmMode),
            })
          }
        >
          <option value="">App default</option>
          <option value="review">Review page</option>
          <option value="link">One-click confirm link</option>
        </Select>
      </div>
      <div className="field-row">
        {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
        <label htmlFor="outbound-smtp-host" className="lbl">
          SMTP host (optional)
        </label>
        <TextField
          className="field-grow"
          id="outbound-smtp-host"
          placeholder="derived from IMAP host"
          defaultValue={cfg.smtp?.host ?? ''}
          onBlur={(e) =>
            update({
              ...cfg,
              smtp: { ...cfg.smtp, host: e.target.value || undefined },
            })
          }
        />
      </div>
      <div className="field-row">
        {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
        <label htmlFor="outbound-smtp-port" className="lbl">
          SMTP port (optional)
        </label>
        <TextField
          className="field-grow"
          id="outbound-smtp-port"
          placeholder="465"
          defaultValue={cfg.smtp?.port ?? ''}
          onBlur={(e) =>
            update({
              ...cfg,
              smtp: {
                ...cfg.smtp,
                port: e.target.value ? Number(e.target.value) : undefined,
              },
            })
          }
        />
      </div>
    </Card>
  );
}
