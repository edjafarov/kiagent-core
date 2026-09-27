import React, { useState } from 'react';
import { Button, TextField } from '@shared/web-ui/ui';
import { GateLayout } from '@renderer/components/GateLayout';

/**
 * Full-window gate shown whenever `state.identity === null` (see App.tsx).
 *
 * Identity is `{name, emails, phones}` set directly via `identity:set` — no
 * provider, no OAuth in core. So "sign in" here is collecting a name and an
 * email and handing them to main. A product build shadows this screen with
 * its own form on the same `GateLayout`.
 */
export function SignIn(): React.ReactElement {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim() !== '' && email.trim() !== '' && !busy;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await window.kiagent.invoke('identity:set', {
        name: name.trim(),
        emails: [email.trim()],
        phones: [],
      });
      // On success main re-broadcasts push:app-state with identity set,
      // which flips <App/>'s gate to the main app and unmounts this screen —
      // this screen never navigates itself.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <GateLayout
      tagline={
        <>
          Your knowledge,
          <br />
          indexed locally.
        </>
      }
      blurb="Everything is read and kept on this machine. Your name and email only label what's yours."
    >
      <h1 className="gate-title">Sign in</h1>
      <p className="gate-lead">No password — just a name and an email.</p>
      <form className="gate-form" onSubmit={(e) => void submit(e)}>
        <label className="gate-field">
          Name
          <TextField
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ada Lovelace"
            disabled={busy}
            // first-run screen with a single form — focusing its first
            // field is the expected starting point, not a focus steal
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          />
        </label>
        <label className="gate-field">
          Email
          <TextField
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ada@example.com"
            disabled={busy}
          />
        </label>
        {error && (
          <div className="gate-err" role="alert">
            Couldn&apos;t sign you in — {error}
          </div>
        )}
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </GateLayout>
  );
}
