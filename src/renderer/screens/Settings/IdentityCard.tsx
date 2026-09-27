import React from 'react';
import { Avatar, Card } from '@shared/web-ui/ui';
import type { Identity } from '@shared/contracts';

/** Who is signed in: avatar, name, emails, and the one action a build
 *  offers (Edit in core, Sign out in a product with sign-in). `children`
 *  replaces the name block while the action has something to show. */
export function IdentityCard(props: {
  identity: Identity;
  action?: React.ReactNode;
  children?: React.ReactNode;
}): React.ReactElement {
  const { identity } = props;
  const primary = identity.name || identity.emails[0] || '—';
  const secondary =
    identity.name && identity.emails.length > 0
      ? identity.emails.join(', ')
      : null;
  return (
    <Card>
      <div className="set-id">
        <Avatar name={primary} imageUrl={identity.avatarUrl} />
        <div className="set-id-body">
          {props.children ?? (
            <>
              <div className="set-id-name">{primary}</div>
              {secondary && <div className="set-id-mail">{secondary}</div>}
            </>
          )}
        </div>
        {props.action}
      </div>
    </Card>
  );
}
