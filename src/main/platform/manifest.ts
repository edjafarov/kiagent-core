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
  ConsentedFileRoot,
  DeclaredFileRoot,
  ExtensionId,
  Manifest,
  OAuthProviderId,
  OAuthSourceBinding,
  UiContribution,
} from '@shared/contracts';
import { OAUTH_PROVIDER_IDS } from '@shared/contracts';
import { PLATFORM_API_VERSION } from '@shared/extension-rpc';

export class ManifestError extends Error {}

const ID_RE = /^[a-z0-9-]+\.[a-z0-9-]+$/;
// B3: a contribution id is namespaced into the routed view id as
// `ext:<extension id>/<contribution id>` (src/renderer/state/view.ts's
// `ExtView`). Keep this in lockstep with that file's own copy — neither may
// ever accept '/', or the view id encoding's collision-freedom proof there
// breaks.
const CONTRIBUTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Declared flat param keys become object keys on a `ViewParams`-shaped
// record that crosses IPC and (eventually) attention-action validation —
// restrict to a safe identifier charset, never dotted or namespaced here
// (namespacing, if a product wants it, is the product's key CONTENT, not a
// core-enforced shape).
const PARAM_KEY_RE = /^[a-z][a-zA-Z0-9]{0,63}$/;
// `satisfies readonly Cap[]` fails compile the moment this array drifts
// from the real Cap union (a member added/renamed on one side but not the
// other) instead of silently validating against a stale list.
export const CAPS = [
  'query',
  'net',
  'files',
  'db',
  'ui',
  'commands',
  'inference',
  'events',
  'attention',
  'send',
  'unsafe.mainProcess',
] as const satisfies readonly Cap[];

/** Manifests are validated the same way regardless of where they come from,
 *  except for which caps a tier is allowed to declare. 'external' covers
 *  both marketplace and dev-loaded extensions; 'bundled' is extensions
 *  shipped inside the app package. */
export type ManifestTier = 'external' | 'bundled';

/** Caps only extensions shipped inside the app bundle may declare. */
const PRIVILEGED_CAPS: readonly Cap[] = ['unsafe.mainProcess'];

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
    z.strictObject({ id: sourceIdSchema, oauth: z.enum(OAUTH_PROVIDER_IDS) }),
  ],
  {
    error: `each sources entry must be a source id string or { id, oauth } — oauth must be one of: ${OAUTH_PROVIDER_IDS.join(', ')}`,
  },
);

// B3: `nav` is a SUGGESTION (design spec, decision 2) — strict like every
// other contributes.* shape, so an unrecognized suggestion field is
// rejected rather than silently ignored (the product's override still wins
// regardless of what's declared here).
const uiNavSchema = z.strictObject({
  group: z.string().min(1).optional(),
  order: z.number().optional(),
  icon: z.string().min(1).optional(),
});

const uiContributionSchema = z.strictObject({
  id: z
    .string()
    .regex(
      CONTRIBUTION_ID_RE,
      'contributes.ui id must match ^[a-z0-9][a-z0-9-]{0,31}$',
    ),
  slot: z.enum(['screen'], {
    error: "contributes.ui slot must be 'screen'",
  }),
  title: z.string().min(1),
  nav: uiNavSchema.optional(),
  params: z
    .array(
      z
        .string()
        .regex(
          PARAM_KEY_RE,
          'contributes.ui param keys must match ^[a-z][a-zA-Z0-9]{0,63}$',
        ),
    )
    .optional(),
});

const FILE_ROOT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** `~/<seg>/<seg>…` with no empty, `.` or `..` segment and no NUL — the
 *  lexical half of the containment rule; the reconciler re-checks the
 *  realpath against the home directory at grant time. */
export function isHomeRelativePath(p: string): boolean {
  if (!p.startsWith('~/') || p.includes('\0')) return false;
  const rest = p.slice(2);
  if (rest === '') return false;
  return rest.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** `~/Library` and its direct children (Caches, Keychains, Mail, …) hold
 *  every app's private state; a declared root must name the one app folder
 *  it needs. Case-insensitive, like the macOS filesystem. The reconciler
 *  repeats this on the realpath (a symlink could point there). */
export function isLibraryTop(p: string): boolean {
  const segs = p.toLowerCase().split('/');
  return segs[0] === '~' && segs[1] === 'library' && segs.length <= 3;
}

const fileRootSchema = z
  .strictObject({
    id: z
      .string()
      .regex(FILE_ROOT_ID_RE, 'fileRoots id must match ^[a-z][a-z0-9-]{0,31}$'),
    path: z
      .string()
      .refine(
        isHomeRelativePath,
        "fileRoots path must be '~/<relative path>' without '.', '..' or empty segments",
      ),
    purpose: z.string().min(1).max(200),
  })
  .refine((r) => !isLibraryTop(r.path), {
    path: ['path'],
    message:
      'fileRoots path must not be ~/Library or a folder directly inside it — declare the app folder you need',
  });

// Strict throughout (platform 2.0.0): unknown keys are rejected, never
// silently stripped — a manifest field that does nothing is a lie to the
// author and to the consent surface.
const schema = z.strictObject({
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
  // Required, with an explicit senders list (platform 2.0.0): a manifest
  // states outright whether it ships outbound Senders — [] for none.
  contributes: z.strictObject({
    sources: z.array(sourceEntrySchema).optional(),
    tools: z.array(z.string()).optional(),
    senders: z.array(z.string(), {
      error:
        'contributes.senders is required — the source ids this extension provides an outbound Sender for, or []',
    }),
    commands: z
      .array(z.strictObject({ id: z.string(), title: z.string() }))
      .optional(),
    // B3: renderer screens (design spec's `contributes.ui`) — the cap,
    // tier and duplicate-id/duplicate-param rules below `schema` in
    // parseManifest are enforced AFTER this shape check, same order as the
    // db-descriptor and privileged-caps rules already are.
    ui: z.array(uiContributionSchema).optional(),
  }),
  database: z.strictObject({ schema: z.string().min(1) }).optional(),
  fileRoots: z.array(fileRootSchema).max(8).optional(),
});

export function parseManifest(
  raw: unknown,
  opts: { tier?: ManifestTier } = {},
): Manifest {
  const tier = opts.tier ?? 'external';
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    // A top-level issue (e.g. an unrecognized root key) has an empty path —
    // label it (root) instead of emitting "invalid manifest:  — …".
    const where = first.path.length > 0 ? first.path.join('.') : '(root)';
    throw new ManifestError(`invalid manifest: ${where} — ${first.message}`);
  }
  const m = parsed.data;
  if (m.caps.includes('db') && !m.database) {
    throw new ManifestError(
      'PLUGIN_DB_DESCRIPTOR_REQUIRED: database.schema is required for db-capability plugins',
    );
  }
  if (!semver.satisfies(PLATFORM_API_VERSION, m.engine)) {
    throw new ManifestError(
      `requires platform ${m.engine}; this build is ${PLATFORM_API_VERSION}`,
    );
  }
  const privileged = m.caps.filter((c) =>
    (PRIVILEGED_CAPS as readonly string[]).includes(c),
  );
  if (tier !== 'bundled' && privileged.length > 0) {
    throw new ManifestError(
      `this extension requires ${privileged.join(', ')} — only extensions bundled with the app may use it`,
    );
  }
  const fileRoots = m.fileRoots ?? [];
  if (fileRoots.length > 0) {
    if (!m.caps.includes('files'))
      throw new ManifestError(
        'PLUGIN_FILES_CAP_REQUIRED: the files capability is required for fileRoots',
      );
    if (tier === 'bundled')
      throw new ManifestError(
        'PLUGIN_FILE_ROOTS_TIER_DENIED: fileRoots is for marketplace extensions — bundled extensions use mainApi.grantRoot',
      );
    const seen = new Set<string>();
    for (const r of fileRoots) {
      if (seen.has(r.id))
        throw new ManifestError(
          `invalid manifest: fileRoots — duplicate fileRoots id '${r.id}'`,
        );
      seen.add(r.id);
    }
  }
  const uiContribs = m.contributes.ui ?? [];
  if (uiContribs.length > 0) {
    // B3: same shape as the db-descriptor rule above — a cap declares
    // intent, a contribution exercises it.
    if (!m.caps.includes('ui')) {
      throw new ManifestError(
        'PLUGIN_UI_CAP_REQUIRED: the ui capability is required for contributes.ui',
      );
    }
    // Runtime delivery for the external tier is not implemented — the code
    // must exist when the renderer is built, so a marketplace/dev manifest
    // declaring contributes.ui is rejected outright rather than silently
    // ignored.
    if (tier !== 'bundled') {
      throw new ManifestError(
        'PLUGIN_UI_TIER_DENIED: contributes.ui is available to bundled extensions only — runtime UI delivery is not implemented',
      );
    }
    const seenIds = new Set<string>();
    for (const c of uiContribs) {
      if (seenIds.has(c.id)) {
        throw new ManifestError(
          `invalid manifest: contributes.ui — duplicate contribution id '${c.id}'`,
        );
      }
      seenIds.add(c.id);
      const seenParams = new Set<string>();
      for (const p of c.params ?? []) {
        if (seenParams.has(p)) {
          throw new ManifestError(
            `invalid manifest: contributes.ui['${c.id}'] — duplicate param key '${p}'`,
          );
        }
        seenParams.add(p);
      }
    }
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

/** The source ids this extension declares an outbound Sender for — THE way
 *  to consume `contributes.senders`. */
export function senderContributions(
  manifest: Pick<Manifest, 'contributes'>,
): string[] {
  return manifest.contributes.senders;
}

/** This extension's validated `contributes.ui` entries — THE way to consume
 *  them, defaulting to `[]` (never `undefined`) for a manifest that
 *  declares none. Feeds the lifecycle snapshot directly
 *  (`extension-platform.ts`'s `snapshot()`) — nothing else recomputes this
 *  from the manifest. */
export function uiContributions(
  manifest: Pick<Manifest, 'contributes'>,
): UiContribution[] {
  return manifest.contributes.ui ?? [];
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

/** This extension's declared local folders — THE way to consume
 *  `fileRoots`, defaulting to `[]`. */
export function declaredFileRoots(
  manifest: Pick<Manifest, 'fileRoots'>,
): DeclaredFileRoot[] {
  return manifest.fileRoots ?? [];
}

/** What a consent records of `fileRoots`: the id-sorted `{id, path}` list
 *  (purpose is display copy, excluded). */
export function consentedFileRoots(
  roots: readonly DeclaredFileRoot[] | undefined,
): ConsentedFileRoot[] {
  return [...(roots ?? [])]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => ({ id: r.id, path: r.path }));
}

/** Consent covers a manifest's folders when every declared `{id, path}` was
 *  consented — the same subset rule `consentCovers` applies to caps, so an
 *  update that narrows its folders keeps its consent. */
export function fileRootsCovered(
  declared: readonly DeclaredFileRoot[] | undefined,
  consented: readonly ConsentedFileRoot[],
): boolean {
  return (declared ?? []).every((r) =>
    consented.some((c) => c.id === r.id && c.path === r.path),
  );
}

/** Icons ride AppState pushes as base64 data URIs, so the package file is
 *  capped — official brand marks at UI sizes are a few KB. */
export const MAX_ICON_BYTES = 200 * 1024;
export const MAX_DESCRIPTOR_BYTES = 4 * 1024 * 1024;

function containedRealPath(
  root: string,
  candidate: string,
  label: string,
): string {
  const packageRoot = fs.realpathSync(root);
  const resolved = fs.realpathSync(candidate);
  const rel = path.relative(packageRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel))
    throw new ManifestError(
      `${label} must resolve inside the extension directory`,
    );
  return resolved;
}

export function validateManifestDir(
  dir: string,
  opts: { tier?: ManifestTier } = {},
): {
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
  const manifest = parseManifest(raw, opts);
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
  if (manifest.database) {
    const schemaAbsPath = path.resolve(root, manifest.database.schema);
    const schemaRel = path.relative(root, schemaAbsPath);
    if (schemaRel.startsWith('..') || path.isAbsolute(schemaRel)) {
      throw new ManifestError(
        'database.schema must resolve inside the extension directory',
      );
    }
    if (!fs.existsSync(schemaAbsPath)) {
      throw new ManifestError(
        `database schema not found: ${manifest.database.schema}`,
      );
    }
    const resolvedSchema = containedRealPath(
      root,
      schemaAbsPath,
      'database.schema',
    );
    const schemaStat = fs.statSync(resolvedSchema);
    if (!schemaStat.isFile() || schemaStat.size > MAX_DESCRIPTOR_BYTES)
      throw new ManifestError(
        'database.schema must be a regular file no larger than 4 MiB',
      );
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
