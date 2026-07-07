/**
 * manifest.json validation — the ONLY thing that runs against an extension
 * before consent. Never loads extension code. Rejections are user-facing
 * strings (they surface in the install UI).
 */
import fs from 'fs';
import path from 'path';

import semver from 'semver';
import { z } from 'zod';

import type {
  Cap,
  ExtensionId,
  Manifest,
  OAuthProviderId,
  OAuthSourceBinding,
} from '@shared/contracts';
import { OAUTH_PROVIDER_IDS } from '@shared/contracts';
import { PLATFORM_API_VERSION } from '@shared/extension-rpc';

export class ManifestError extends Error {}

const ID_RE = /^[a-z0-9-]+\.[a-z0-9-]+$/;
// `satisfies readonly Cap[]` fails compile the moment this array drifts
// from the real Cap union (a member added/renamed on one side but not the
// other) instead of silently validating against a stale list.
const CAPS = [
  'query',
  'net',
  'files',
  'db',
  'ui',
  'commands',
  'inference',
  'events',
] as const satisfies readonly Cap[];

// OAUTH_PROVIDER_IDS (contracts.ts) is the single shared list — this
// zod.enum reads it directly rather than keeping a local copy, so the
// registry (oauth-providers.ts) and this validator can't drift from each
// other.
//
// Zod v4 surfaces the single matching branch's own issue for near-miss
// inputs ('' hits the string branch's min(1); { id: '', oauth } hits the
// object branch's), and falls back to the union-level `error` when no
// branch matches at all (unknown provider, missing id, non-string junk).
const sourceIdSchema = z.string().min(1, 'source id must not be empty');
const sourceEntrySchema = z.union(
  [
    sourceIdSchema,
    z.object({ id: sourceIdSchema, oauth: z.enum(OAUTH_PROVIDER_IDS) }),
  ],
  {
    error: `each sources entry must be a source id string or { id, oauth } — oauth must be one of: ${OAUTH_PROVIDER_IDS.join(', ')}`,
  },
);

const schema = z.object({
  id: z.string().regex(ID_RE, "extension id must look like 'publisher.name'"),
  name: z.string().min(1),
  version: z
    .string()
    .refine((v) => semver.valid(v) !== null, 'version must be valid semver'),
  engine: z
    .string()
    .refine(
      (r) => semver.validRange(r) !== null,
      'engine must be a semver range',
    ),
  entry: z.string().min(1),
  icon: z
    .string()
    .min(1)
    .refine((p) => p.toLowerCase().endsWith('.png'), 'icon must be a .png file')
    .optional(),
  caps: z.array(z.enum(CAPS)),
  contributes: z
    .object({
      sources: z.array(sourceEntrySchema).optional(),
      workers: z.array(z.string()).optional(),
      tools: z.array(z.string()).optional(),
      providers: z.array(z.string()).optional(),
      commands: z
        .array(z.object({ id: z.string(), title: z.string() }))
        .optional(),
    })
    .default({}),
});

export function parseManifest(raw: unknown): Manifest {
  if (raw !== null && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const looksLegacy =
      ('hostApi' in o || 'permissions' in o) && !('engine' in o && 'caps' in o);
    if (looksLegacy) {
      throw new ManifestError(
        'This extension was built for the legacy app and is not compatible with this build.',
      );
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ManifestError(
      `invalid manifest: ${first.path.join('.')} — ${first.message}`,
    );
  }
  const m = parsed.data;
  if (!semver.satisfies(PLATFORM_API_VERSION, m.engine)) {
    throw new ManifestError(
      `requires platform ${m.engine}; this build is ${PLATFORM_API_VERSION}`,
    );
  }
  return { ...m, id: m.id as ExtensionId };
}

/** One normalized shape for `contributes.sources` — THE way to consume it.
 *  String entries become `{ id }`; object entries keep their oauth binding. */
export function sourceContributions(
  manifest: Pick<Manifest, 'contributes'>,
): Array<{ id: string; oauth?: OAuthProviderId }> {
  return (manifest.contributes.sources ?? []).map((s) =>
    typeof s === 'string' ? { id: s } : { id: s.id, oauth: s.oauth },
  );
}

/** The oauth-bound subset of `contributes.sources`, in the shape the consent
 *  surfaces (ExtensionPreview/ExtensionSnapshot `oauthSources`) carry. */
export function oauthSourceBindings(
  manifest: Pick<Manifest, 'contributes'>,
): OAuthSourceBinding[] {
  return sourceContributions(manifest).flatMap((s) =>
    s.oauth ? [{ id: s.id, provider: s.oauth }] : [],
  );
}

/** Icons ride AppState pushes as base64 data URIs, so the package file is
 *  capped — official brand marks at UI sizes are a few KB. */
export const MAX_ICON_BYTES = 200 * 1024;

export function validateManifestDir(dir: string): {
  manifest: Manifest;
  entryAbsPath: string;
} {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new ManifestError('no manifest.json found in the extension package');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new ManifestError('manifest.json is not valid JSON');
  }
  const manifest = parseManifest(raw);
  const root = path.resolve(dir);
  const entryAbsPath = path.resolve(root, manifest.entry);
  const rel = path.relative(root, entryAbsPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ManifestError(
      'entry must resolve inside the extension directory',
    );
  }
  if (!fs.existsSync(entryAbsPath)) {
    throw new ManifestError(`entry not found: ${manifest.entry}`);
  }
  if (manifest.icon) {
    const iconAbsPath = path.resolve(root, manifest.icon);
    const iconRel = path.relative(root, iconAbsPath);
    if (iconRel.startsWith('..') || path.isAbsolute(iconRel)) {
      throw new ManifestError(
        'icon must resolve inside the extension directory',
      );
    }
    if (!fs.existsSync(iconAbsPath)) {
      throw new ManifestError(`icon not found: ${manifest.icon}`);
    }
    if (fs.statSync(iconAbsPath).size > MAX_ICON_BYTES) {
      throw new ManifestError('icon must be 200 KB or smaller');
    }
  }
  return { manifest, entryAbsPath };
}

/** The manifest icon as a data:image/png;base64 URI, or undefined when the
 *  manifest declares none or the file is unreadable/oversized (an installed
 *  dir predating validation, or mutated after it). Never throws — a broken
 *  icon degrades to the letter glyph, it doesn't break the extension. */
export function loadIconDataUrl(
  dir: string,
  manifest: Pick<Manifest, 'icon'>,
): string | undefined {
  if (!manifest.icon) return undefined;
  try {
    const abs = path.resolve(dir, manifest.icon);
    const rel = path.relative(path.resolve(dir), abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const bytes = fs.readFileSync(abs);
    if (bytes.length > MAX_ICON_BYTES) return undefined;
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return undefined;
  }
}
