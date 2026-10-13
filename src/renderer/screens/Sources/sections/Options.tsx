import React, { useState } from 'react';
import { Card, CardHeader, SettingsRow, Toggle } from '@shared/web-ui/ui';
import type { Account, SourceDescriptor } from '@shared/contracts';
import { optionValue } from '@shared/source-options';

const BUSY = /already running|transition/i;

/**
 * Connector-declared boolean options (spec source-options §3.5). Values live
 * in account.config.options and are written ONLY via accounts:set-option,
 * which restarts a running sync so the connector sees the new value. While a
 * write is in flight the toggle shows the requested value and is disabled;
 * on failure it reverts and the reason is shown inline.
 */
export function Options(props: {
  account: Account;
  descriptor: SourceDescriptor;
}): React.ReactElement | null {
  const { account, descriptor } = props;
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  if (!descriptor.options?.length) return null;

  const set = async (key: string, value: boolean) => {
    setError(null);
    setPending((p) => ({ ...p, [key]: value }));
    try {
      await window.kiagent.invoke('accounts:set-option', {
        accountId: account.id,
        key,
        value,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        BUSY.test(msg)
          ? 'Finishing the current sync step — try again in a moment'
          : msg,
      );
    } finally {
      setPending(({ [key]: _done, ...rest }) => rest);
    }
  };

  return (
    <Card>
      <CardHeader label="Options" />
      {descriptor.options.map((o) => {
        const inFlight = Object.prototype.hasOwnProperty.call(pending, o.key);
        const checked = inFlight
          ? pending[o.key]
          : (optionValue(descriptor, account.config, o.key) ?? o.default);
        return (
          <SettingsRow
            key={o.key}
            title={o.label}
            description={o.description}
            control={
              <Toggle
                aria-label={o.label}
                checked={checked}
                disabled={inFlight}
                onChange={(next) => {
                  void set(o.key, next);
                }}
              />
            }
          />
        );
      })}
      {error && (
        <p role="alert" className="src-cat-err">
          {error}
        </p>
      )}
    </Card>
  );
}
