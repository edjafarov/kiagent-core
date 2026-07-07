# Guided Add-Source Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the bare add-source prompt form into a guided wizard card (schema-embedded setup steps, links, copyable content, placeholders), make Cancel visible, and make the top-bar Sources button always return to the list.

**Architecture:** Guidance rides on the JSON schema connectors already send through `auth.prompt(schema)` — new OPTIONAL conventions (`x-steps`, `description`, `examples`) parsed best-effort in the renderer; no contract/IPC change. The flow panel becomes a centered `.card` wizard. `navigate()` bumps an epoch so same-view nav clicks remount the screen. `setWindowOpenHandler` routes https links to the system browser. Slack/Notion connectors release new versions carrying their guidance.

**Tech Stack:** React 18 + TypeScript (Electron renderer), jest + @testing-library/react (jsdom), plain CSS design tokens; connector repos build with esbuild + `npm pack` → GitHub releases.

**Spec:** `docs/superpowers/specs/2026-07-06-guided-add-source-design.md`

## Global Constraints

- Repo: `/Users/edjafarov/work/kiagent-core`, branch `greenfield` (Tasks 1–6). Tasks 7–8 run in `/Users/edjafarov/work/slack-kia-connector` and `/Users/edjafarov/work/notion-kia-connector`.
- NEVER print, quote, or modify `src/main/sources/gmail/client-credentials.ts` (any repo). Never use a real API token anywhere — test tokens must be obvious fakes (`xoxp-test-deadbeef`, `ntn_test`).
- Released assets are NEVER mutated — connector behavior changes require a version bump and a NEW GitHub release.
- Typecheck: `npm run typecheck` (bare `tsc` gives false errors). Lint TS/TSX only: `npx cross-env NODE_ENV=development eslint <files>` (never .css files).
- Token scan before every kiagent-core commit: `git grep -cE "(xox[pbo]-|IGQ|EAA|ntn_|secret_|GOCSPX)[A-Za-z0-9-]{10,}" -- ':!package-lock.json'` — do NOT pipe through `head`. Known pre-existing hits: `src/main/core/mcp/server-icon.ts`, `src/main/sources/gmail/client-credentials.ts`. Truncated placeholders like `xoxp-…` / `ntn_…` do not match (fewer than 10 trailing chars) and are fine.
- jest gotcha: the `^@renderer/(.*)$` moduleNameMapper rule beats the css→identity-obj-proxy rule, so any CSS import in a file loaded by tests must be RELATIVE. New components in this plan import NO CSS (styles live in `Sources.css`, imported by `screens/Sources/index.tsx`).
- Non-https `x-steps` links must never render — extension-supplied content must not open arbitrary protocols.
- Commits end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_019uWSRjNqDNAX1JQzshht8f`

---

### Task 1: Prompt-guidance schema parsing module

**Files:**
- Create: `src/renderer/screens/Sources/prompt-guidance.ts`
- Modify: `src/renderer/screens/Sources/AddSourcePanel.tsx` (delete its local `schemaFields`/`humanizeKey`, lines 46–78, and import from the new module)
- Test: `src/renderer/screens/Sources/__tests__/prompt-guidance.test.ts`

**Interfaces:**
- Consumes: nothing new (pure module).
- Produces: `schemaGuidance(schema: unknown): { intro?: string; steps: GuideStep[] }` with `GuideStep = { title: string; body?: string; link?: string; copy?: string }`; `schemaFields(schema: unknown): PromptField[]` with `PromptField = { key: string; label: string; secret: boolean; folder: boolean; folderPaths: boolean; placeholder?: string; help?: string }`. Tasks 2–3 import both.

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/screens/Sources/__tests__/prompt-guidance.test.ts
import { schemaGuidance, schemaFields } from '../prompt-guidance';

describe('schemaGuidance', () => {
  test('parses intro and well-formed x-steps', () => {
    const g = schemaGuidance({
      type: 'object',
      description: 'Paste a token from your own internal Slack app.',
      'x-steps': [
        {
          title: 'Create the Slack app',
          body: 'Create New App → From a manifest → paste this:',
          link: 'https://api.slack.com/apps?new_app=1',
          copy: 'display_information:\n  name: KIAgent\n',
        },
        { title: 'Install to your workspace' },
      ],
    });
    expect(g.intro).toBe('Paste a token from your own internal Slack app.');
    expect(g.steps).toEqual([
      {
        title: 'Create the Slack app',
        body: 'Create New App → From a manifest → paste this:',
        link: 'https://api.slack.com/apps?new_app=1',
        copy: 'display_information:\n  name: KIAgent\n',
      },
      { title: 'Install to your workspace', body: undefined, link: undefined, copy: undefined },
    ]);
  });

  test('skips steps without a string title', () => {
    const g = schemaGuidance({
      'x-steps': [{ body: 'no title' }, 'nonsense', null, { title: '   ' }, { title: 'Ok' }],
    });
    expect(g.steps.map((s) => s.title)).toEqual(['Ok']);
  });

  test('drops non-https links', () => {
    const g = schemaGuidance({
      'x-steps': [
        { title: 'A', link: 'http://insecure.example' },
        { title: 'B', link: 'javascript:alert(1)' },
        { title: 'C', link: 'https://ok.example' },
      ],
    });
    expect(g.steps.map((s) => s.link)).toEqual([undefined, undefined, 'https://ok.example']);
  });

  test('tolerates junk: non-object schema, non-array x-steps, missing description', () => {
    expect(schemaGuidance(null)).toEqual({ intro: undefined, steps: [] });
    expect(schemaGuidance('x')).toEqual({ intro: undefined, steps: [] });
    expect(schemaGuidance({ 'x-steps': 'not-an-array' }).steps).toEqual([]);
    expect(schemaGuidance({ description: 42 }).intro).toBeUndefined();
  });
});

describe('schemaFields', () => {
  test('keeps existing conventions: title label, password format/heuristic, folder formats', () => {
    const fields = schemaFields({
      properties: {
        password: { type: 'string', title: 'User OAuth Token (xoxp-…)', format: 'password' },
        apiToken: { type: 'string' },
        dir: { type: 'string', format: 'folder-path' },
        dirs: { type: 'array', format: 'folder-paths' },
        plainField: { type: 'string' },
      },
    });
    expect(fields).toHaveLength(5);
    expect(fields[0]).toMatchObject({ key: 'password', label: 'User OAuth Token (xoxp-…)', secret: true });
    expect(fields[1]).toMatchObject({ key: 'apiToken', label: 'Api Token', secret: true });
    expect(fields[2]).toMatchObject({ key: 'dir', folder: true });
    expect(fields[3]).toMatchObject({ key: 'dirs', folderPaths: true });
    expect(fields[4]).toMatchObject({ key: 'plainField', label: 'Plain Field', secret: false });
  });

  test('examples[0] becomes placeholder, description becomes help', () => {
    const [f] = schemaFields({
      properties: {
        host: {
          type: 'string',
          title: 'IMAP server hostname',
          description: 'Ask your email provider if unsure.',
          examples: ['imap.example.com'],
        },
      },
    });
    expect(f.placeholder).toBe('imap.example.com');
    expect(f.help).toBe('Ask your email provider if unsure.');
  });

  test('non-string examples[0] and description are ignored', () => {
    const [f] = schemaFields({
      properties: { port: { type: 'number', examples: [993], description: 7 } },
    });
    expect(f.placeholder).toBeUndefined();
    expect(f.help).toBeUndefined();
  });

  test('returns [] for junk schemas', () => {
    expect(schemaFields(null)).toEqual([]);
    expect(schemaFields({ properties: 'x' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/edjafarov/work/kiagent-core && npx jest src/renderer/screens/Sources/__tests__/prompt-guidance.test.ts`
Expected: FAIL — "Cannot find module '../prompt-guidance'"

- [ ] **Step 3: Write the module**

```ts
// src/renderer/screens/Sources/prompt-guidance.ts
/**
 * Optional guidance conventions a source may embed in the JSON-Schema-ish
 * object it hands to `auth.prompt()` (contracts.ts AuthChannel) — parsed
 * best-effort so a schema without them (or with malformed entries) renders
 * exactly as before: fields only. Spec:
 * docs/superpowers/specs/2026-07-06-guided-add-source-design.md §1.
 */

/** One numbered setup step from a schema's `x-steps` array. */
export interface GuideStep {
  title: string;
  body?: string;
  /** https-only — non-https links are dropped, never rendered. */
  link?: string;
  /** Preformatted copyable content (e.g. a Slack app-manifest YAML). */
  copy?: string;
}

export interface PromptField {
  key: string;
  label: string;
  secret: boolean;
  folder: boolean;
  folderPaths: boolean;
  placeholder?: string;
  help?: string;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v : undefined;

export function schemaGuidance(schema: unknown): {
  intro?: string;
  steps: GuideStep[];
} {
  if (typeof schema !== 'object' || schema === null) {
    return { intro: undefined, steps: [] };
  }
  const s = schema as { description?: unknown; 'x-steps'?: unknown };
  const raw = Array.isArray(s['x-steps']) ? s['x-steps'] : [];
  const steps: GuideStep[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const title = str(e.title);
    if (!title) continue; // a step without a title is skipped, not an error
    const link = str(e.link);
    steps.push({
      title,
      body: str(e.body),
      // Extension-supplied content must not open arbitrary protocols.
      link: link !== undefined && /^https:\/\//i.test(link) ? link : undefined,
      copy: str(e.copy),
    });
  }
  return { intro: str(s.description), steps };
}

/** Best-effort read of a JSON-Schema-ish `{properties: {...}}` shape so the
 *  prompt form can render one input per declared field without fully
 *  validating the (intentionally `unknown`) schema. */
export function schemaFields(schema: unknown): PromptField[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const { properties } = schema as { properties?: unknown };
  if (typeof properties !== 'object' || properties === null) return [];
  return Object.entries(properties as Record<string, unknown>).map(
    ([key, def]) => {
      const d =
        typeof def === 'object' && def !== null
          ? (def as {
              format?: unknown;
              title?: unknown;
              description?: unknown;
              examples?: unknown;
            })
          : {};
      const secret =
        d.format === 'password' || /password|secret|token/i.test(key);
      const folder = d.format === 'folder-path';
      const folderPaths = d.format === 'folder-paths';
      const label = typeof d.title === 'string' ? d.title : humanizeKey(key);
      const placeholder = Array.isArray(d.examples)
        ? str(d.examples[0])
        : undefined;
      return {
        key,
        label,
        secret,
        folder,
        folderPaths,
        placeholder,
        help: str(d.description),
      };
    },
  );
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
```

- [ ] **Step 4: Point AddSourcePanel at the module**

In `src/renderer/screens/Sources/AddSourcePanel.tsx`: delete the local `schemaFields` function (lines 46–73) and `humanizeKey` (lines 75–78), and add to the imports:

```ts
import { schemaFields } from './prompt-guidance';
```

(No behavior change yet — the moved function is a superset: existing callers ignore the new `placeholder`/`help` fields.)

- [ ] **Step 5: Run tests + typecheck**

Run: `cd /Users/edjafarov/work/kiagent-core && npx jest src/renderer/screens/Sources/ && npm run typecheck`
Expected: prompt-guidance tests PASS, existing Sources tests PASS, typecheck clean.

- [ ] **Step 6: Lint + commit**

```bash
cd /Users/edjafarov/work/kiagent-core
npx cross-env NODE_ENV=development eslint src/renderer/screens/Sources/prompt-guidance.ts src/renderer/screens/Sources/AddSourcePanel.tsx src/renderer/screens/Sources/__tests__/prompt-guidance.test.ts
git grep -cE "(xox[pbo]-|IGQ|EAA|ntn_|secret_|GOCSPX)[A-Za-z0-9-]{10,}" -- ':!package-lock.json'
git add src/renderer/screens/Sources/prompt-guidance.ts src/renderer/screens/Sources/AddSourcePanel.tsx src/renderer/screens/Sources/__tests__/prompt-guidance.test.ts
git commit -m "feat: prompt-schema guidance conventions (x-steps, examples, description)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019uWSRjNqDNAX1JQzshht8f"
```

Token scan expected: only the two known pre-existing hits (`server-icon.ts`, `client-credentials.ts`).

---

### Task 2: GuidanceSteps component

**Files:**
- Create: `src/renderer/screens/Sources/GuidanceSteps.tsx`
- Test: `src/renderer/screens/Sources/__tests__/GuidanceSteps.test.tsx`

**Interfaces:**
- Consumes: `GuideStep` from `./prompt-guidance` (Task 1).
- Produces: `GuidanceSteps(props: { steps: GuideStep[] }): React.ReactElement | null` — returns `null` for an empty array. Uses CSS classes `.as-steps/.as-step/.as-step-num/.as-step-body/.as-step-title/.as-copy` (styles land in Task 3; the component imports NO CSS). Task 3 renders it above the prompt form.

- [ ] **Step 1: Write the failing test**

```tsx
// src/renderer/screens/Sources/__tests__/GuidanceSteps.test.tsx
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GuidanceSteps } from '../GuidanceSteps';

const STEPS = [
  {
    title: 'Create the Slack app',
    body: 'Create New App → From a manifest → paste this:',
    link: 'https://api.slack.com/apps?new_app=1',
    copy: 'display_information:\n  name: KIAgent\n',
  },
  { title: 'Install to your workspace', body: 'Install App → Install to Workspace.' },
];

describe('GuidanceSteps', () => {
  test('renders numbered titles and bodies', () => {
    render(<GuidanceSteps steps={STEPS} />);
    expect(screen.getByText('Create the Slack app')).toBeInTheDocument();
    expect(screen.getByText('Install to your workspace')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  test('Open button opens the link in a new window', () => {
    const openSpy = jest.spyOn(window, 'open').mockReturnValue(null);
    render(<GuidanceSteps steps={STEPS} />);
    const opens = screen.getAllByRole('button', { name: /open/i });
    expect(opens).toHaveLength(1); // only the step with a link
    fireEvent.click(opens[0]);
    expect(openSpy).toHaveBeenCalledWith('https://api.slack.com/apps?new_app=1', '_blank');
    openSpy.mockRestore();
  });

  test('Copy button writes the content and shows Copied ✓', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<GuidanceSteps steps={STEPS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copied ✓' })).toBeInTheDocument(),
    );
    expect(writeText).toHaveBeenCalledWith('display_information:\n  name: KIAgent\n');
  });

  test('renders nothing for an empty steps array', () => {
    const { container } = render(<GuidanceSteps steps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/renderer/screens/Sources/__tests__/GuidanceSteps.test.tsx`
Expected: FAIL — "Cannot find module '../GuidanceSteps'"

- [ ] **Step 3: Write the component**

```tsx
// src/renderer/screens/Sources/GuidanceSteps.tsx
import React, { useEffect, useRef, useState } from 'react';
import type { GuideStep } from './prompt-guidance';

/**
 * Numbered setup steps parsed from a prompt schema's `x-steps` (see
 * prompt-guidance.ts) — the "where to click, what to copy" walkthrough shown
 * above the connect form. Presentational except for the transient
 * copied-feedback state. Links are https-only (enforced at parse time) and
 * open via window.open → main's setWindowOpenHandler → system browser.
 */
export function GuidanceSteps(props: {
  steps: GuideStep[];
}): React.ReactElement | null {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (props.steps.length === 0) return null;

  const copy = async (idx: number, content: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      return; // clipboard unavailable — button just stays "Copy"
    }
    setCopiedIdx(idx);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopiedIdx(null), 2000);
  };

  return (
    <ol className="as-steps">
      {props.steps.map((step, idx) => (
        // Steps are render-only and the array never reorders — index keys are fine.
        // eslint-disable-next-line react/no-array-index-key
        <li key={idx} className="as-step">
          <span className="as-step-num" aria-hidden="true">
            {idx + 1}
          </span>
          <div className="as-step-body">
            <span className="as-step-title">{step.title}</span>
            {step.body && <span className="t-meta">{step.body}</span>}
            {step.link && (
              <button
                type="button"
                className="btn sm"
                onClick={() => window.open(step.link, '_blank')}
              >
                Open ↗
              </button>
            )}
            {step.copy !== undefined && (
              <>
                <pre className="as-copy">{step.copy}</pre>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => void copy(idx, step.copy as string)}
                >
                  {copiedIdx === idx ? 'Copied ✓' : 'Copy'}
                </button>
              </>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/renderer/screens/Sources/__tests__/GuidanceSteps.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx cross-env NODE_ENV=development eslint src/renderer/screens/Sources/GuidanceSteps.tsx src/renderer/screens/Sources/__tests__/GuidanceSteps.test.tsx
git grep -cE "(xox[pbo]-|IGQ|EAA|ntn_|secret_|GOCSPX)[A-Za-z0-9-]{10,}" -- ':!package-lock.json'
git add src/renderer/screens/Sources/GuidanceSteps.tsx src/renderer/screens/Sources/__tests__/GuidanceSteps.test.tsx
git commit -m "feat: GuidanceSteps — numbered setup steps with Open/Copy actions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019uWSRjNqDNAX1JQzshht8f"
```

---

### Task 3: AddSourcePanel wizard-card redesign

**Files:**
- Modify: `src/renderer/screens/Sources/AddSourcePanel.tsx` (the `if (flow)` return, lines ~382–533, and the grid head's Cancel, line ~541)
- Modify: `src/renderer/screens/Sources/Sources.css` (append after `.as-field`, ~line 245)
- Test: `src/renderer/screens/Sources/__tests__/AddSourcePanel.test.tsx`

**Interfaces:**
- Consumes: `schemaGuidance`, `schemaFields` (with `placeholder`/`help`) from `./prompt-guidance` (Task 1); `GuidanceSteps` from `./GuidanceSteps` (Task 2); existing `SourceIcon`, `sourceLabel`, `useSourceDescriptors`.
- Produces: no new exports — UI change only. Button copy: primary submit is **Connect** (was "Submit"); footer **Cancel** is a plain bordered `btn sm` (not ghost).

- [ ] **Step 1: Write the failing integration test**

```tsx
// src/renderer/screens/Sources/__tests__/AddSourcePanel.test.tsx
import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { AppState } from '@shared/contracts';
import { AddSourcePanel } from '../AddSourcePanel';
import { SourceDescriptorsProvider } from '../sources-registry';

jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) =>
    sel({ extensions: [], accounts: [] } as unknown as AppState),
}));

const DESCRIPTORS = [
  {
    id: 'slack',
    name: 'Slack',
    documentTypes: ['slack.day'],
    auth: 'password',
    multiAccount: true,
    cadence: { every: '15m' },
  },
];

const ENRICHED_SCHEMA = {
  type: 'object',
  required: ['password'],
  description: 'Paste a token from your own internal Slack app.',
  'x-steps': [
    {
      title: 'Create the Slack app',
      body: 'Create New App → From a manifest → paste this:',
      link: 'https://api.slack.com/apps?new_app=1',
      copy: 'display_information:\n  name: KIAgent\n',
    },
  ],
  properties: {
    password: {
      type: 'string',
      title: 'User OAuth Token',
      format: 'password',
      description: 'From OAuth & Permissions after installing the app.',
      examples: ['xoxp-…'],
    },
  },
};

let pushHandler: ((evt: unknown) => void) | null = null;

beforeEach(() => {
  pushHandler = null;
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke: jest.fn((channel: string) => {
      if (channel === 'sources:list') return Promise.resolve(DESCRIPTORS);
      if (channel === 'accounts:add') return Promise.resolve({ flowId: 'f1' });
      if (channel === 'accounts:prompt-answer') return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected invoke: ${channel}`));
    }),
    on: jest.fn((_channel: string, handler: (evt: unknown) => void) => {
      pushHandler = handler;
      return () => {};
    }),
  };
});

async function openSlackPrompt(onDone = jest.fn()): Promise<jest.Mock> {
  render(
    <SourceDescriptorsProvider>
      <AddSourcePanel onDone={onDone} />
    </SourceDescriptorsProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /slack/i }));
  // accounts:add resolves (flow state set), then the prompt event arrives.
  await act(async () => {});
  act(() => {
    pushHandler!({
      flowId: 'f1',
      kind: 'prompt',
      requestId: 'r1',
      schema: ENRICHED_SCHEMA,
    });
  });
  return onDone;
}

describe('AddSourcePanel wizard card', () => {
  test('renders heading, intro, steps, placeholder, helper text, and footer buttons', async () => {
    await openSlackPrompt();
    expect(screen.getByText('Connect Slack')).toBeInTheDocument();
    expect(
      screen.getByText('Paste a token from your own internal Slack app.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Create the Slack app')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('xoxp-…')).toBeInTheDocument();
    expect(
      screen.getByText('From OAuth & Permissions after installing the app.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveClass('btn', 'sm');
    expect(cancel).not.toHaveClass('ghost');
  });

  test('Connect submits the answers for the prompt requestId', async () => {
    await openSlackPrompt();
    fireEvent.change(screen.getByPlaceholderText('xoxp-…'), {
      target: { value: 'xoxp-test-deadbeef' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await act(async () => {});
    expect(
      (window as unknown as { kiagent: { invoke: jest.Mock } }).kiagent.invoke,
    ).toHaveBeenCalledWith('accounts:prompt-answer', {
      requestId: 'r1',
      answers: { password: 'xoxp-test-deadbeef' },
    });
  });

  test('footer Cancel exits the panel', async () => {
    const onDone = await openSlackPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDone).toHaveBeenCalled();
  });

  test('tile-grid Cancel is a visible bordered button', async () => {
    render(
      <SourceDescriptorsProvider>
        <AddSourcePanel onDone={jest.fn()} />
      </SourceDescriptorsProvider>,
    );
    await screen.findByRole('button', { name: /slack/i });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveClass('btn', 'sm');
    expect(cancel).not.toHaveClass('ghost');
  });

  test('schema without conventions still renders the plain form', async () => {
    const plain = {
      type: 'object',
      properties: { password: { type: 'string', title: 'Token', format: 'password' } },
    };
    render(
      <SourceDescriptorsProvider>
        <AddSourcePanel onDone={jest.fn()} />
      </SourceDescriptorsProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /slack/i }));
    await act(async () => {});
    act(() => {
      pushHandler!({ flowId: 'f1', kind: 'prompt', requestId: 'r1', schema: plain });
    });
    expect(screen.getByText('Connect Slack')).toBeInTheDocument();
    expect(screen.getByText('Token')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument(); // no steps <ol>
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/renderer/screens/Sources/__tests__/AddSourcePanel.test.tsx`
Expected: FAIL — no "Connect Slack" heading (current UI renders the old "Add a source" head + Submit button).

- [ ] **Step 3: Rewrite the `if (flow)` return in AddSourcePanel.tsx**

Add imports at the top:

```ts
import { schemaFields, schemaGuidance } from './prompt-guidance';
import { GuidanceSteps } from './GuidanceSteps';
```

(Task 1 already imports `schemaFields`; merge into one import.)

Replace the entire `if (flow) { ... }` block (from `if (flow) {` through its closing `}` before the final grid return) with:

```tsx
  if (flow) {
    // Computed once per render (rather than inline in the ternaries below) so
    // the classic-form branch isn't a re-parse of the same schema.
    const promptFields = flow.prompt ? schemaFields(flow.prompt.schema) : null;
    const guidance = flow.prompt ? schemaGuidance(flow.prompt.schema) : null;
    const folderPathsPrompt =
      promptFields !== null &&
      promptFields.length === 1 &&
      promptFields[0].folderPaths;

    // Modal branches render outside the wizard card (they overlay the app).
    if (picker && pickerAdapter) {
      return (
        // AuthChannel.pickFolders — the same modal, served by the SOURCE's
        // tree callbacks over the accounts:picker-* invokes. Confirm maps
        // the synthetic paths back to FolderNodes and resolves the flow's
        // pending pickFolders; an unconfirmed close cancels it (connect()
        // throws, the flow's own error event renders below).
        <FolderPickerModal
          key={picker.requestId}
          multiSelect={picker.multiSelect}
          dataSource={pickerAdapter.dataSource}
          onConfirm={(paths) => {
            pickerConfirmedForRef.current = picker.requestId;
            // A confirm racing a flow that already settled (extension
            // crash) rejects with "unknown picker request"; the flow's own
            // error event is what the user sees — just log it.
            void pickerAdapter.confirm(paths).catch((err) => {
              // eslint-disable-next-line no-console
              console.warn('folder picker: confirm failed', err);
            });
            setFlow((prev) => (prev ? { ...prev, picker: undefined } : prev));
          }}
          onClose={() => {
            if (pickerConfirmedForRef.current !== picker.requestId) {
              void pickerAdapter.cancel().catch(() => {});
            }
            setFlow((prev) => (prev ? { ...prev, picker: undefined } : prev));
          }}
        />
      );
    }
    if (flow.prompt && folderPathsPrompt) {
      return (
        // Exactly one `folder-paths` (array) field — skip the classic form
        // entirely and open the multi-select picker directly (no
        // "Choose…" step); a multi-field schema (Gmail, IMAP, or a
        // singular folder-path field alongside others) always falls
        // through to the wizard card below, which renders
        // FolderPickerField for any singular folder-path field it contains.
        <FolderPickerModal
          multiSelect
          existingPaths={existingPaths}
          onConfirm={(paths) => {
            confirmedRef.current = true;
            void submitFolderPaths(paths);
          }}
          onClose={() => {
            if (!confirmedRef.current) props.onDone();
          }}
        />
      );
    }

    return (
      <div className="as-panel">
        <div className="as-wizard card">
          <div className="as-wizard-head">
            <SourceIcon sourceId={flow.sourceId} size={28} />
            <span className="h-section">
              Connect {sourceLabel(flow.sourceId, descriptors)}
            </span>
          </div>

          {flow.done ? (
            <>
              <div className="as-flow-msg">
                <Icon
                  name="check-circle"
                  size={14}
                  style={{ color: 'var(--live-solid)' }}
                />
                Connected: <span className="mono">{flow.done.identifier}</span>
              </div>
              <div className="as-wizard-foot">
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() => props.onDone(flow.done?.id)}
                >
                  Done
                </button>
              </div>
            </>
          ) : flow.error ? (
            <>
              <div className="as-flow-msg err">
                <Icon name="alert-circle" size={14} />
                {flow.error}
              </div>
              <div className="as-wizard-foot">
                <button
                  type="button"
                  className="btn sm"
                  onClick={cancelFlow}
                >
                  ← Back
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => props.onDone()}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : flow.prompt ? (
            <form
              className="as-wizard-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submitPrompt();
              }}
            >
              {guidance?.intro && (
                <p className="t-meta as-wizard-intro">{guidance.intro}</p>
              )}
              <GuidanceSteps steps={guidance?.steps ?? []} />
              {(promptFields ?? []).map(
                ({ key, label, secret, folder, placeholder, help }) =>
                  folder ? (
                    // A <label> wrapping both a text input AND a button would
                    // make a label click ambiguous (which control should it
                    // focus/activate?) — use a plain field wrapper instead.
                    <div key={key} className="as-field">
                      <span className="kg-label">{label}</span>
                      <FolderPickerField
                        value={answers[key] ?? ''}
                        onChange={(v) =>
                          setAnswers((a) => ({ ...a, [key]: v }))
                        }
                      />
                      {help && <span className="as-field-help">{help}</span>}
                    </div>
                  ) : (
                    <label key={key} className="as-field">
                      <span className="kg-label">{label}</span>
                      <input
                        className="input"
                        type={secret ? 'password' : 'text'}
                        placeholder={placeholder}
                        value={answers[key] ?? ''}
                        onChange={(e) =>
                          setAnswers((a) => ({ ...a, [key]: e.target.value }))
                        }
                      />
                      {help && <span className="as-field-help">{help}</span>}
                    </label>
                  ),
              )}
              <div className="as-wizard-foot">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => props.onDone()}
                >
                  Cancel
                </button>
                <button type="submit" className="btn primary sm">
                  Connect
                </button>
              </div>
            </form>
          ) : flow.qr ? (
            <>
              <div className="t-meta">Scan this code with your device:</div>
              <QrCode data={flow.qr} />
              <div className="as-wizard-foot">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => props.onDone()}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="as-flow-msg">
                <span className="spinner" />
                {flow.status ?? 'Connecting…'}
              </div>
              <div className="as-wizard-foot">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => props.onDone()}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }
```

Then in the remaining tile-grid return, change the head Cancel's class from `btn ghost sm` to `btn sm`:

```tsx
        <button
          type="button"
          className="btn sm"
          onClick={() => props.onDone()}
        >
          Cancel
        </button>
```

Note: the panel-level doc comment at the top of the file mentions the old layout — extend it with one line: `Flow states render as a centered wizard card; guidance steps come from the schema's x-steps (prompt-guidance.ts).`

- [ ] **Step 4: Append wizard CSS to Sources.css (after `.as-field`, before `.si-error`)**

```css
.as-field-help {
  font-size: 11px;
  color: var(--text-secondary);
}

/* ── Guided connect wizard (AddSourcePanel flow states) ───────────── */

.as-wizard {
  align-self: center;
  width: 100%;
  max-width: 560px;
  margin-top: 12px;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.as-wizard-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.as-wizard-head .h-section {
  margin: 0;
}
.as-wizard-intro {
  margin: 0;
}
.as-wizard-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.as-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.as-step {
  display: flex;
  gap: 10px;
}
.as-step-num {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-subtle);
  color: var(--accent-text);
  font-size: 11px;
  font-weight: 700;
}
.as-step-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.as-step-body .btn {
  align-self: flex-start;
}
.as-step-title {
  font-size: 12.5px;
  font-weight: 600;
}
.as-copy {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--bg-muted);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  margin: 0;
  max-height: 180px;
  overflow-y: auto;
}
.as-wizard-foot {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 4px;
}
```

- [ ] **Step 5: Run the Sources test suite + typecheck**

Run: `npx jest src/renderer/screens/Sources/ && npm run typecheck`
Expected: all PASS (new AddSourcePanel tests + prompt-guidance + GuidanceSteps + pre-existing connect-picker-adapter/onboarding-steps/SourceIcon), typecheck clean.

- [ ] **Step 6: Full renderer test sweep, lint, commit**

```bash
npx jest src/renderer
npx cross-env NODE_ENV=development eslint src/renderer/screens/Sources/AddSourcePanel.tsx src/renderer/screens/Sources/__tests__/AddSourcePanel.test.tsx
git grep -cE "(xox[pbo]-|IGQ|EAA|ntn_|secret_|GOCSPX)[A-Za-z0-9-]{10,}" -- ':!package-lock.json'
git add src/renderer/screens/Sources/AddSourcePanel.tsx src/renderer/screens/Sources/Sources.css src/renderer/screens/Sources/__tests__/AddSourcePanel.test.tsx
git commit -m "feat: guided add-source wizard card — steps, placeholders, visible Cancel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019uWSRjNqDNAX1JQzshht8f"
```

Note: the test file contains `xoxp-test-deadbeef` — an obvious fake, and under 10 trailing chars per segment it still may match the scan regex (`test-deadbeef` is 13 chars). If the scan reports `AddSourcePanel.test.tsx`, verify with `git grep -hoE ...` that the only hit is `xoxp-test-deadbeef` and proceed — same precedent as the slack connector's own tests.

---

### Task 4: Top-bar Sources click resets the screen (nav epoch)

**Files:**
- Modify: `src/renderer/state/view.ts` (add `ResolvedView` + `nextResolved`)
- Modify: `src/renderer/App.tsx:20-55,94-106` (use them; key the screen)
- Test: `src/renderer/state/__tests__/view.test.ts`

**Interfaces:**
- Consumes: existing `View`, `ViewParams` from `state/view.ts`.
- Produces: `interface ResolvedView { view: View; params?: ViewParams; epoch: number }` and `nextResolved(prev: ResolvedView | null, to: View, params?: ViewParams): { next: ResolvedView; push: boolean }` — both exported from `@renderer/state/view`. `App.tsx` re-exports `ResolvedView` no longer (it was only used locally; the interface moves).

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/state/__tests__/view.test.ts
import { nextResolved, type ResolvedView } from '../view';

describe('nextResolved', () => {
  test('first navigation starts at epoch 1 and pushes nothing', () => {
    expect(nextResolved(null, 'sources')).toEqual({
      next: { view: 'sources', params: undefined, epoch: 1 },
      push: false,
    });
  });

  test('cross-view navigation bumps epoch and pushes history', () => {
    const prev: ResolvedView = { view: 'sources', epoch: 3 };
    expect(nextResolved(prev, 'marketplace')).toEqual({
      next: { view: 'marketplace', params: undefined, epoch: 4 },
      push: true,
    });
  });

  test('same-view re-navigation bumps epoch but does NOT push history', () => {
    const prev: ResolvedView = { view: 'sources', epoch: 3 };
    const { next, push } = nextResolved(prev, 'sources');
    expect(next.epoch).toBe(4); // key change → screen remounts → add panel resets
    expect(push).toBe(false); // no duplicate back stop
  });

  test('params ride along', () => {
    const { next } = nextResolved(null, 'connection', { anchor: 'mcp' });
    expect(next.params).toEqual({ anchor: 'mcp' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/renderer/state/__tests__/view.test.ts`
Expected: FAIL — "nextResolved is not a function" (module has no such export).

- [ ] **Step 3: Add to `src/renderer/state/view.ts`** (below the `ViewContextValue` interface)

```ts
/** A concrete navigation target plus a monotonically increasing `epoch`.
 *  App keys the rendered screen on `${view}:${epoch}`, so re-navigating to
 *  the CURRENT view (clicking "Sources" while already there) remounts the
 *  screen and resets its in-screen state — the add-source panel, the
 *  source-detail sub-view. */
export interface ResolvedView {
  view: View;
  params?: ViewParams;
  epoch: number;
}

/** Pure navigate transition: every call bumps `epoch`; same-view
 *  re-navigation is NOT pushed onto the back history (no duplicate stops). */
export function nextResolved(
  prev: ResolvedView | null,
  to: View,
  params?: ViewParams,
): { next: ResolvedView; push: boolean } {
  return {
    next: { view: to, params, epoch: (prev?.epoch ?? 0) + 1 },
    push: prev !== null && prev.view !== to,
  };
}
```

- [ ] **Step 4: Wire it into `src/renderer/App.tsx`**

Replace the import line and the local interface + navigate callback (lines 9, 20–23, 45–50):

```ts
import {
  ViewContext,
  nextResolved,
  type ResolvedView,
  type View,
  type ViewParams,
} from '@renderer/state/view';
```

Delete the local `export interface ResolvedView { ... }` block, then:

```ts
  const navigate = useCallback((to: View, params?: ViewParams) => {
    setResolved((prev) => {
      const { next, push } = nextResolved(prev, to, params);
      if (push && prev !== null) historyRef.current.push(prev);
      return next;
    });
  }, []);
```

And `back()`'s fallback gains an epoch:

```ts
  const back = useCallback(() => {
    const prev = historyRef.current.pop() ?? {
      view: 'sources' as const,
      epoch: 0,
    };
    setResolved(prev);
  }, []);
```

Finally key the rendered screen (the `{screen}` expression at line ~104):

```tsx
        {screenRegistry.usesTopBar(view) && <TopBar />}
        <React.Fragment key={`${view}:${resolved?.epoch ?? 0}`}>
          {screen}
        </React.Fragment>
```

- [ ] **Step 5: Verify no other importers broke**

Run: `grep -rn "ResolvedView" src/ --include="*.ts*"`
Expected: only `state/view.ts` (definition) and `App.tsx` (import). Then:

Run: `npx jest src/renderer/state/__tests__/view.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Lint + commit**

```bash
npx cross-env NODE_ENV=development eslint src/renderer/state/view.ts src/renderer/App.tsx src/renderer/state/__tests__/view.test.ts
git add src/renderer/state/view.ts src/renderer/App.tsx src/renderer/state/__tests__/view.test.ts
git commit -m "fix: top-bar nav click always resets the screen (epoch-keyed remount)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019uWSRjNqDNAX1JQzshht8f"
```

---

### Task 5: External links open in the system browser

**Files:**
- Modify: `src/main/main.ts:161-166` (inside `createWindow`, after the `new BrowserWindow(...)` call)

**Interfaces:**
- Consumes: `shell` (already imported from 'electron' at `main.ts:12`).
- Produces: app-wide window-open policy — `window.open`/`target="_blank"` with an `https:` URL opens the system browser; everything else is denied; in-window navigation away from the app HTML is blocked. No exports.

No unit test: `createWindow` is not covered by the existing test harness (it runs only under a real Electron `app`). Verification is typecheck + lint + the Task 3 integration test exercising `window.open` in jsdom + manual smoke at the end of the plan.

- [ ] **Step 1: Add the handlers**

Insert after `mainWindow.on('closed', ...)` (line ~165), before `await mainWindow.loadURL(...)`:

```ts
  // Guidance-step "Open ↗" buttons (and marketplace README links) call
  // window.open — route https to the system browser, never spawn a child
  // BrowserWindow. Deny everything else (extension-supplied URLs are
  // filtered to https at parse time, but this is the backstop).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Block in-window navigation away from the app (e.g. a dragged link).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(resolveHtmlPath('').split('index.html')[0])) {
      event.preventDefault();
      if (url.startsWith('https://')) void shell.openExternal(url);
    }
  });
```

Simpler and safer equivalent for the `will-navigate` guard (use this if `resolveHtmlPath` string-splitting reads awkwardly in context — check how `resolveHtmlPath` is implemented in `src/main/util.ts` first):

```ts
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) {
      event.preventDefault();
      if (url.startsWith('https://')) void shell.openExternal(url);
    }
  });
```

Pick ONE of the two `will-navigate` variants — prefer the second (URL-equality) unless it breaks the dev-server reload flow (`npm start` HMR does not use `will-navigate`, so it should not).

- [ ] **Step 2: Typecheck + lint + commit**

```bash
npm run typecheck
npx cross-env NODE_ENV=development eslint src/main/main.ts
git add src/main/main.ts
git commit -m "feat: open external https links in the system browser

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019uWSRjNqDNAX1JQzshht8f"
```

---

### Task 6: Builtin IMAP schema enrichment

**Files:**
- Modify: `src/main/sources/imap/source.ts:94-104` (the `auth.prompt` schema)
- Test: existing `src/main/sources/imap/__tests__/` suite must stay green (the schema is opaque to the source's own logic; no new test needed — the renderer conventions are covered by Task 1's tests).

**Interfaces:**
- Consumes: the field conventions from Task 1 (`examples[0]` → placeholder, `description` → helper text).
- Produces: nothing new — data-only change.

- [ ] **Step 1: Enrich the schema**

Replace the `auth.prompt({...})` argument at `src/main/sources/imap/source.ts:94-104` with:

```ts
      const answers = await auth.prompt({
        type: 'object',
        required: ['host', 'user', 'password'],
        description:
          'Connect any IMAP mailbox. Read-only; the password is stored in your OS keychain.',
        properties: {
          host: {
            type: 'string',
            title: 'IMAP server hostname',
            examples: ['imap.example.com'],
            description: 'Ask your email provider if unsure.',
          },
          port: {
            type: 'number',
            title: 'Port (defaults to 993 for TLS, 143 for STARTTLS)',
            examples: ['993'],
          },
          secure: { type: 'boolean', title: 'Use TLS', default: true },
          user: {
            type: 'string',
            title: 'Username / email address',
            examples: ['you@example.com'],
          },
          password: {
            type: 'string',
            title: 'Password or app-password',
            format: 'password',
            description:
              'Providers with 2FA (Gmail, Fastmail, iCloud) require an app-password, not your login password.',
          },
        },
      });
```

- [ ] **Step 2: Run the imap tests + typecheck**

Run: `npx jest src/main/sources/imap && npm run typecheck`
Expected: PASS (schema shape is not asserted by the source tests; if one does assert the exact schema object, update that assertion to the new schema verbatim).

- [ ] **Step 3: Lint + commit**

```bash
npx cross-env NODE_ENV=development eslint src/main/sources/imap/source.ts
git add src/main/sources/imap/source.ts
git commit -m "feat: guided-setup hints in the builtin IMAP prompt schema

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019uWSRjNqDNAX1JQzshht8f"
```

---

### Task 7: Slack connector v2.0.2 — guidance release

**Repo:** `/Users/edjafarov/work/slack-kia-connector` (branch main, remote org `kia-plugins`)

**Files:**
- Modify: `src/source.ts` (the `auth.prompt` schema at ~line 796; add `SLACK_APP_MANIFEST` near `SLACK_USER_SCOPES` at ~line 80)
- Modify: `manifest.json` (`"version": "2.0.2"`), `package.json` (`"version": "2.0.2"`)
- Test: `src/__tests__/source.test.ts` (extend the connect test if it asserts the prompt schema; otherwise add one assertion)

**Interfaces:**
- Consumes: renderer conventions from Task 1 (deployed app renders them; older apps ignore unknown schema keys — no engine bump).
- Produces: GitHub release `v2.0.2` with the packed tgz. Released assets are never mutated.

- [ ] **Step 1: Add the app-manifest constant** (next to `SLACK_USER_SCOPES`, ~line 80 of `src/source.ts`)

```ts
const SCOPE_LINES = SLACK_USER_SCOPES.map((s) => `        - ${s}`).join('\n');

/** The internal-app manifest the user pastes at api.slack.com — an internal,
 *  customer-built app keeps Slack's standard (non-Marketplace) rate limits;
 *  never bundle OAuth (see README "Connect your workspace"). Shown as a
 *  copyable block in the connect wizard's x-steps. */
export const SLACK_APP_MANIFEST = `display_information:
  name: KIAgent
  description: Personal digital memory indexing (runs locally on your Mac)
oauth_config:
  scopes:
    user:
${SCOPE_LINES}
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;
```

- [ ] **Step 2: Enrich the prompt schema** (~line 796)

```ts
      const answers = await auth.prompt({
        type: 'object',
        required: ['password'],
        description:
          'Slack indexing uses a token from an internal Slack app you create yourself — this keeps standard rate limits and stays read-only.',
        'x-steps': [
          {
            title: 'Create the Slack app',
            body: 'api.slack.com/apps → Create New App → From a manifest → pick your workspace → paste this:',
            link: 'https://api.slack.com/apps?new_app=1',
            copy: SLACK_APP_MANIFEST,
          },
          {
            title: 'Install to your workspace',
            body: 'On the app page: Install App → Install to Workspace, then copy the User OAuth Token from OAuth & Permissions.',
          },
        ],
        properties: {
          password: {
            type: 'string',
            title: 'User OAuth Token',
            format: 'password',
            examples: ['xoxp-…'],
            description: 'Starts with xoxp- (a user token, not the xoxb- bot token).',
          },
        },
      });
```

- [ ] **Step 3: Assert the guidance in the connect test**

In `src/__tests__/source.test.ts`, find the existing connect test that stubs `auth.prompt` and add (or extend the stub to capture the schema):

```ts
    // The schema carries the guided-setup conventions the app renders.
    const promptSchema = authPromptMock.mock.calls[0][0] as {
      'x-steps': Array<{ title: string; link?: string; copy?: string }>;
      properties: { password: { examples: string[] } };
    };
    expect(promptSchema['x-steps']).toHaveLength(2);
    expect(promptSchema['x-steps'][0].link).toBe('https://api.slack.com/apps?new_app=1');
    expect(promptSchema['x-steps'][0].copy).toContain('- channels:history');
    expect(promptSchema.properties.password.examples[0]).toBe('xoxp-…');
```

(Adapt the mock-capture name to the test file's existing pattern — read the test's connect block first; if no connect test stubs `auth.prompt`, add a minimal one following the file's existing helper style.)

- [ ] **Step 4: Bump versions**

`manifest.json` and `package.json`: `"version": "2.0.1"` → `"version": "2.0.2"` (plain Edit on both — do NOT reformat with `node -e` this time; two one-line edits).

- [ ] **Step 5: Build, test, pack, verify**

```bash
cd /Users/edjafarov/work/slack-kia-connector
npm run build && npx jest
npm pack
tar -tzf kia.slack-2.0.2.tgz | head -20
```

Expected: tests pass (was 60, now 60–61), tarball contains `manifest.json`, `dist/`, `README.md`, `icon.png`.

- [ ] **Step 6: Token scan, commit, push, release**

```bash
git grep -cE "(xox[pbo]-|IGQ|EAA|ntn_|secret_|GOCSPX)[A-Za-z0-9-]{10,}"
# expected hits: only test fakes xoxb-test-cafebabe / xoxp-test-deadbeef — verify with -hoE if new files appear
git add src/source.ts src/__tests__/source.test.ts manifest.json package.json
git commit -m "feat: guided-setup steps in the connect prompt (v2.0.2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019uWSRjNqDNAX1JQzshht8f"
git push
gh release create v2.0.2 kia.slack-2.0.2.tgz --title "v2.0.2 — guided connect setup" --notes "The connect prompt now ships step-by-step setup guidance (create the internal app from a copyable manifest, install, paste the xoxp- token) rendered by KIAgent's guided add-source wizard. No functional changes to sync."
rm kia.slack-2.0.2.tgz
```

---

### Task 8: Notion connector v2.1.2 — guidance release

**Repo:** `/Users/edjafarov/work/notion-kia-connector` (branch main, remote org `kia-plugins`)

**Files:**
- Modify: `src/source.ts` (the `auth.prompt` schema at ~line 326)
- Modify: `manifest.json` (`"version": "2.1.2"`), `package.json` (`"version": "2.1.2"`)
- Test: `src/__tests__/source.test.ts` (same pattern as Task 7 Step 3)

**Interfaces:**
- Consumes: renderer conventions from Task 1.
- Produces: GitHub release `v2.1.2` with the packed tgz.

- [ ] **Step 1: Enrich the prompt schema** (~line 326)

```ts
      const answers = await auth.prompt({
        type: 'object',
        required: ['password'],
        description:
          'Notion indexing uses an internal integration you create in your workspace — read-only, no OAuth app involved.',
        'x-steps': [
          {
            title: 'Create an integration',
            body: 'New integration → pick your workspace → copy the Internal Integration Secret.',
            link: 'https://www.notion.so/my-integrations',
          },
          {
            title: 'Share pages with it',
            body: 'In Notion, open each page or database to index → ••• → Connections → add your integration.',
          },
        ],
        properties: {
          password: {
            type: 'string',
            title: 'Internal Integration Secret',
            format: 'password',
            examples: ['ntn_…'],
            description: 'Starts with ntn_ (older integrations: secret_).',
          },
        },
      });
```

- [ ] **Step 2: Assert the guidance in the connect test**

Same pattern as Task 7 Step 3, with:

```ts
    expect(promptSchema['x-steps']).toHaveLength(2);
    expect(promptSchema['x-steps'][0].link).toBe('https://www.notion.so/my-integrations');
    expect(promptSchema.properties.password.examples[0]).toBe('ntn_…');
```

- [ ] **Step 3: Bump versions**

`manifest.json` and `package.json`: `"version": "2.1.1"` → `"version": "2.1.2"`.

- [ ] **Step 4: Build, test, pack, verify**

```bash
cd /Users/edjafarov/work/notion-kia-connector
npm run build && npx jest
npm pack
tar -tzf kia.notion-2.1.2.tgz | head -20
```

Expected: tests pass (was 55, now 55–56), tarball contains `manifest.json`, `dist/`, `README.md`, `icon.png`.

- [ ] **Step 5: Token scan, commit, push, release**

```bash
git grep -cE "(xox[pbo]-|IGQ|EAA|ntn_|secret_|GOCSPX)[A-Za-z0-9-]{10,}"
# the schema's ntn_… / secret_… placeholders are truncated (no 10+ trailing chars) — expected clean or test-fake-only
git add src/source.ts src/__tests__/source.test.ts manifest.json package.json
git commit -m "feat: guided-setup steps in the connect prompt (v2.1.2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019uWSRjNqDNAX1JQzshht8f"
git push
gh release create v2.1.2 kia.notion-2.1.2.tgz --title "v2.1.2 — guided connect setup" --notes "The connect prompt now ships step-by-step setup guidance (create the internal integration, share pages, paste the ntn_ secret) rendered by KIAgent's guided add-source wizard. No functional changes to sync."
rm kia.notion-2.1.2.tgz
```

---

### Final verification (after all tasks)

```bash
cd /Users/edjafarov/work/kiagent-core
npx jest            # full suite; extension-e2e.test.ts is a known cold-cache load flake — rerun in isolation if it's the only failure
npm run typecheck
```

Manual smoke (user-side, dev app restart required): Add Sources → Slack (after updating the installed connector to v2.0.2 via the marketplace Update button) shows the wizard with steps/Open/Copy/placeholder; Open lands in the system browser; top-bar Sources click exits the panel; Cancel is clearly visible.
