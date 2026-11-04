/**
 * Compile-time gate for the two-instance sync smoke harness.
 *
 * `__KIA_TEST_HOOKS__` is substituted by webpack's DefinePlugin: `true` only
 * when the bundle was built with `KIA_SMOKE_HOOKS=1`, `false` otherwise. It is
 * deliberately NOT read from the environment, a file or `app.isPackaged`, so a
 * shipped artifact cannot be switched on from outside. Where the define is
 * absent (jest, ts-node) the gate is false.
 */
declare const __KIA_TEST_HOOKS__: boolean;

export const KIA_TEST_HOOKS: boolean =
  typeof __KIA_TEST_HOOKS__ !== 'undefined' && __KIA_TEST_HOOKS__ === true;

/** Present in a bundle only when the gate is compiled on: folds to '' when the
 *  constant is false. The test is written against the define itself, not the
 *  exported flag above: the minifier cannot fold across a module export. */
export const KIA_TEST_HOOKS_SENTINEL: string =
  typeof __KIA_TEST_HOOKS__ !== 'undefined' && __KIA_TEST_HOOKS__ === true
    ? 'kia-test-hooks:on'
    : '';
