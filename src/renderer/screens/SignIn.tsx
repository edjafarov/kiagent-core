import React, { useState } from 'react';
import { Icon } from '@shared/web-ui/icon-sprite';
import { Spark } from '@shared/web-ui/Spark';
import './SignIn.css';

/**
 * Full-window gate shown whenever `state.identity === null` (see App.tsx).
 *
 * The legacy SignIn screen drove Google/Microsoft OAuth ("sign in with
 * Gmail") plus a "use kia locally" skip. Neither concept exists in the new
 * contract: there's no `auth.localMode`, and identity is just
 * `{name, emails, phones}` set directly via `identity:set` — no provider,
 * no OAuth dance in the renderer. So "sign in" here is literally collecting
 * a name + email and handing it to main.
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
    <div className="si-canvas">
      <div className="si-brand" aria-hidden="true">
        <Spark size="hero" />
        <div className="si-brand-copy">
          <div className="si-brand-title">
            Your knowledge,
            <br />
            indexed locally.
          </div>
          <div className="si-brand-sub">
            Mail and docs are read on this machine. We keep only a small account
            so your remote endpoint stays yours.
          </div>
        </div>
      </div>

      <div className="si-pane">
        <div className="si-pane-head">
          <div className="si-title">Sign in</div>
          <div className="t-meta" style={{ fontSize: 12 }}>
            Tell kia who you are — no password, just a name and email.
          </div>
        </div>

        <form className="si-actions" onSubmit={(e) => void submit(e)}>
          <label className="si-field">
            <span className="kg-label">Name</span>
            <input
              className="input"
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

          <label className="si-field">
            <span className="kg-label">Email</span>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ada@example.com"
              disabled={busy}
            />
          </label>

          {error && (
            <div className="si-error" role="alert">
              Couldn&apos;t sign you in — {error}
            </div>
          )}

          <button
            type="submit"
            className="btn primary"
            disabled={!canSubmit}
            style={{ alignSelf: 'flex-start' }}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="si-foot">
          <Icon name="shield" size={12} />
          <span>No telemetry · your data stays local</span>
        </div>
      </div>
    </div>
  );
}
