import React, { useState } from 'react';
import { useAppState } from '@renderer/state/app-state';
import { Button, TextButton, TextField } from '@shared/web-ui/ui';
import type { Identity } from '@shared/contracts';
import { IdentityCard } from './IdentityCard';

/**
 * Account pane — the local identity, editable by hand (core has no
 * sign-in; a product with one shadows this pane with Sign out). App.tsx's
 * identity gate means `identity` is set whenever this renders; the null
 * branch is defensive only.
 */
export function Account(): React.ReactElement {
  const identity = useAppState((s) => s.identity);
  if (!identity) return <div className="set-note">No identity set.</div>;
  return <EditableIdentity identity={identity} />;
}

function EditableIdentity(props: { identity: Identity }): React.ReactElement {
  const { identity } = props;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(identity.name);
  const [emails, setEmails] = useState<string[]>(identity.emails);
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setName(identity.name);
    setEmails(identity.emails.length > 0 ? identity.emails : ['']);
    setEditing(true);
  };

  const save = () => {
    setSaving(true);
    void window.kiagent
      .invoke('identity:set', {
        ...identity,
        name: name.trim(),
        emails: emails.map((e) => e.trim()).filter((e) => e !== ''),
      })
      .then(() => setEditing(false))
      .finally(() => setSaving(false));
  };

  if (!editing)
    return (
      <IdentityCard
        identity={identity}
        action={
          <Button size="sm" onClick={startEdit}>
            Edit
          </Button>
        }
      />
    );

  return (
    <IdentityCard
      identity={identity}
      action={
        <div className="set-actions">
          <Button size="sm" variant="primary" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <TextButton disabled={saving} onClick={() => setEditing(false)}>
            Cancel
          </TextButton>
        </div>
      }
    >
      <div className="set-id-edit">
        <TextField
          aria-label="Name"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {emails.map((email, i) => (
          <div key={i} className="set-actions">
            <TextField
              aria-label={`Email ${i + 1}`}
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) =>
                setEmails((prev) =>
                  prev.map((v, idx) => (idx === i ? e.target.value : v)),
                )
              }
            />
            <TextButton
              aria-label={`Remove email ${i + 1}`}
              onClick={() =>
                setEmails((prev) => prev.filter((_, idx) => idx !== i))
              }
            >
              Remove
            </TextButton>
          </div>
        ))}
        <TextButton onClick={() => setEmails((prev) => [...prev, ''])}>
          + Add email
        </TextButton>
      </div>
    </IdentityCard>
  );
}
