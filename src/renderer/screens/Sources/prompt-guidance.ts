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
