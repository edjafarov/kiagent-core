import type { SourceDescriptor, SourceOption } from './contracts';

export const MAX_SOURCE_OPTIONS = 8;
const KEY = /^[a-z][A-Za-z0-9]{0,39}$/;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The effective value of a declared option: the stored boolean at
 *  `config.options[key]`, else the declared default. `undefined` when the
 *  descriptor does not declare `key`. */
export function optionValue(
  descriptor: Pick<SourceDescriptor, 'options'> | undefined,
  config: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const opt = descriptor?.options?.find((o) => o.key === key);
  if (!opt) return undefined;
  const stored = isPlainObject(config?.options)
    ? config.options[key]
    : undefined;
  return typeof stored === 'boolean' ? stored : opt.default;
}

/** null when valid, else a one-line reason. */
export function validateSourceOptions(options: unknown): string | null {
  if (options === undefined) return null;
  if (!Array.isArray(options)) return 'options must be an array';
  if (options.length > MAX_SOURCE_OPTIONS)
    return `at most ${MAX_SOURCE_OPTIONS} options`;
  const seen = new Set<string>();
  for (const o of options as Array<Partial<SourceOption>>) {
    if (!isPlainObject(o)) return 'each option must be an object';
    if (typeof o.key !== 'string' || !KEY.test(o.key))
      return `option key '${String(o.key)}' is invalid`;
    if (seen.has(o.key)) return `option key '${o.key}' is duplicated`;
    seen.add(o.key);
    if (o.type !== 'boolean') return `option '${o.key}' must have type 'boolean'`;
    if (typeof o.default !== 'boolean')
      return `option '${o.key}' needs a boolean default`;
    if (
      typeof o.label !== 'string' ||
      o.label.length === 0 ||
      o.label.length > 60
    )
      return `option '${o.key}' label must be 1–60 characters`;
    if (
      o.description !== undefined &&
      (typeof o.description !== 'string' || o.description.length > 200)
    )
      return `option '${o.key}' description must be ≤ 200 characters`;
  }
  return null;
}
