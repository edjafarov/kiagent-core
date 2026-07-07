import React, { useState } from 'react';
import { useAppState } from '@renderer/state/app-state';
import type { Identity } from '@shared/contracts';

/**
 * Account pane — identity display + edit. Per the rebuild's contracts.ts
 * there is no per-window "signed in / signed out" auth object (App.tsx's
 * gate 2 already guarantees `state.identity !== null` for every screen that
 * can render, Settings included) — so unlike the legacy Account.tsx this
 * pane has nothing to branch on: it always shows the current identity plus
 * an edit form. Preferences (launchAtLogin/showInMenuBar/etc.) live on the
 * Advanced pane per the task brief, not here.
 */
export function Account(): React.ReactElement {
  const identity = useAppState((s) => s.identity);

  return (
    <>
      <div>
        <h2 className="h-screen">Account</h2>
        <div className="t-meta">Your KIAgent identity.</div>
      </div>
      <div className="div-h" />
      {identity ? <IdentityPanel identity={identity} /> : <NoIdentityPanel />}
    </>
  );
}

function NoIdentityPanel(): React.ReactElement {
  // Defensive only — App.tsx's gate 2 means this should be unreachable in
  // practice (identity === null shows the full-window SignIn screen instead
  // of any routed view), but render something honest rather than crash if a
  // future refactor ever gets here.
  return <div className="t-meta">No identity set.</div>;
}

function IdentityPanel(props: { identity: Identity }): React.ReactElement {
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

  const cancel = () => setEditing(false);

  const save = () => {
    setSaving(true);
    const cleanedEmails = emails.map((e) => e.trim()).filter((e) => e !== '');
    void window.kiagent
      .invoke('identity:set', {
        ...identity,
        name: name.trim(),
        emails: cleanedEmails,
      })
      .then(() => setEditing(false))
      .finally(() => setSaving(false));
  };

  const initial = (
    identity.name.trim()[0] ??
    identity.emails[0]?.trim()[0] ??
    '?'
  ).toUpperCase();
  const primary = identity.name || identity.emails[0] || '—';
  const secondary =
    identity.name && identity.emails.length > 0
      ? identity.emails.join(', ')
      : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="lbl-section">Identity</div>

      {!editing ? (
        <div className="acct-row">
          <span className="avatar" data-testid="account-avatar">
            {identity.avatarUrl ? (
              <img src={identity.avatarUrl} alt="" />
            ) : (
              <span aria-hidden="true">{initial}</span>
            )}
          </span>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
              flex: 1,
              minWidth: 0,
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 500 }}>{primary}</span>
            {secondary ? (
              <span
                className="mono"
                style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}
              >
                {secondary}
              </span>
            ) : null}
          </div>
          <button type="button" className="btn sm" onClick={startEdit}>
            Edit
          </button>
        </div>
      ) : (
        <div className="acct-edit">
          <label className="field-row" style={{ gap: 8 }}>
            <span className="lbl" style={{ minWidth: 80 }}>
              Name
            </span>
            <input
              type="text"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ flex: 1 }}
            />
          </label>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="lbl" style={{ fontSize: 12 }}>
              Emails
            </span>
            {emails.map((email, i) => (
              <div key={i} style={{ display: 'flex', gap: 6 }}>
                <input
                  type="email"
                  className="input mono-text"
                  value={email}
                  onChange={(e) =>
                    setEmails((prev) =>
                      prev.map((v, idx) => (idx === i ? e.target.value : v)),
                    )
                  }
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn ghost sm icon-only"
                  aria-label="Remove email"
                  onClick={() =>
                    setEmails((prev) => prev.filter((_, idx) => idx !== i))
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setEmails((prev) => [...prev, ''])}
              >
                + Add email
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button
              type="button"
              className="btn primary sm"
              disabled={saving}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={saving}
              onClick={cancel}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
