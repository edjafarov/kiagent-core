import React, { useId, useRef, useState } from 'react';
import { Button, Sheet, TextField } from '@shared/web-ui/ui';
import { parseRepoInput, toGithubRef } from '@shared/install-link';
import './InstallSheet.css';

/**
 * Add from GitHub: one field for a repository address. Nothing is fetched
 * until Continue; a `kiagent://install` link only prefills the field.
 * Continue hands the parsed `github:` ref to the caller's install flow,
 * whose errors (not found, no release, …) come back as `error`.
 */
export function AddFromGithubSheet(props: {
  initial?: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onContinue: (ref: string) => void;
}): React.ReactElement {
  const { busy, onClose, onContinue } = props;
  const [text, setText] = useState(props.initial ?? '');
  const [parseError, setParseError] = useState<string | null>(null);
  // The install flow's error is shared with the catalog: show it only once
  // this sheet has asked for something, never one left from elsewhere.
  const [submitted, setSubmitted] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const errId = useId();
  const error = parseError ?? (submitted ? props.error : null);

  const submit = (): void => {
    const r = parseRepoInput(text);
    if ('error' in r) {
      setParseError(r.error);
      return;
    }
    setParseError(null);
    setSubmitted(true);
    onContinue(toGithubRef(r));
  };

  return (
    <Sheet
      title="Add from GitHub"
      onClose={onClose}
      busy={busy}
      initialFocus={field}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || text.trim() === ''}
            onClick={submit}
          >
            {busy ? 'Checking…' : 'Continue'}
          </Button>
        </>
      }
    >
      <p className="ext-sheet-desc">
        Paste the repository’s address. You’ll see what it can do before
        anything is installed.
      </p>
      <form
        className="ext-add-gh"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) submit();
        }}
      >
        <label className="ext-add-gh-label" htmlFor={`${hintId}-in`}>
          Repository
        </label>
        <TextField
          id={`${hintId}-in`}
          ref={field}
          value={text}
          placeholder="https://github.com/owner/repo"
          spellCheck={false}
          autoComplete="off"
          aria-describedby={error ? errId : hintId}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setParseError(null);
          }}
        />
        {error ? (
          <p id={errId} role="alert" className="ext-add-gh-err">
            {error}
          </p>
        ) : (
          <p id={hintId} className="ext-add-gh-hint">
            Also accepts <code className="mono">owner/repo</code> or{' '}
            <code className="mono">owner/repo@v1.2.0</code>
          </p>
        )}
      </form>
    </Sheet>
  );
}
