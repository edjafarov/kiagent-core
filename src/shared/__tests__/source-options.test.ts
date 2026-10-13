import { isPlainObject, optionValue, validateSourceOptions } from '../source-options';
import type { SourceOption } from '../contracts';

const opt = (o: Partial<SourceOption> = {}): SourceOption => ({
  key: 'skipSubagents',
  label: 'Skip subagent sessions',
  type: 'boolean',
  default: true,
  ...o,
});

describe('optionValue', () => {
  const d = { options: [opt()] };
  it('falls back to the default when unset', () =>
    expect(optionValue(d, {}, 'skipSubagents')).toBe(true));
  it('reads config.options.<key> when boolean', () =>
    expect(
      optionValue(d, { options: { skipSubagents: false } }, 'skipSubagents'),
    ).toBe(false));
  it('ignores a non-boolean stored value', () =>
    expect(
      optionValue(d, { options: { skipSubagents: 'no' } }, 'skipSubagents'),
    ).toBe(true));
  it('ignores a non-object options', () =>
    expect(optionValue(d, { options: null }, 'skipSubagents')).toBe(true));
  it('ignores a top-level key of the same name', () =>
    expect(optionValue(d, { skipSubagents: false }, 'skipSubagents')).toBe(
      true,
    ));
  it('is undefined for an undeclared key', () =>
    expect(optionValue(d, {}, 'other')).toBeUndefined());
  it('is undefined with no descriptor', () =>
    expect(optionValue(undefined, {}, 'skipSubagents')).toBeUndefined());
});

describe('validateSourceOptions', () => {
  it('accepts undefined and a valid list', () => {
    expect(validateSourceOptions(undefined)).toBeNull();
    expect(
      validateSourceOptions([opt(), opt({ key: 'b', description: 'x' })]),
    ).toBeNull();
  });
  it.each([
    ['not an array', {}],
    [
      'more than 8',
      Array.from({ length: 9 }, (_, i) => opt({ key: `k${i}` })),
    ],
    ['duplicate key', [opt(), opt()]],
    ['bad key pattern', [opt({ key: 'Skip' })]],
    ['bad key pattern (proto)', [opt({ key: '__proto__' })]],
    ['non-boolean type', [{ ...opt(), type: 'string' }]],
    ['non-boolean default', [{ ...opt(), default: 'yes' }]],
    ['long label', [opt({ label: 'x'.repeat(61) })]],
    ['empty label', [opt({ label: '' })]],
    ['long description', [opt({ description: 'x'.repeat(201) })]],
  ])('rejects %s', (_name, input) =>
    expect(validateSourceOptions(input)).toEqual(expect.any(String)),
  );
});

it('isPlainObject', () => {
  expect(isPlainObject({})).toBe(true);
  expect(isPlainObject(null)).toBe(false);
  expect(isPlainObject([])).toBe(false);
  expect(isPlainObject('x')).toBe(false);
});
