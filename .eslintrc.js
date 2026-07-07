module.exports = {
  extends: 'erb',
  plugins: ['@typescript-eslint'],
  rules: {
    // A temporary hack related to IDE not resolving correct package.json
    'import/no-extraneous-dependencies': 'off',
    'react/react-in-jsx-scope': 'off',
    'react/jsx-filename-extension': 'off',
    'import/extensions': 'off',
    'import/no-unresolved': 'off',
    'import/no-import-module-exports': 'off',
    'no-shadow': 'off',
    '@typescript-eslint/no-shadow': 'error',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],

    // erb defaults turned off where they conflict with this codebase's
    // deliberate, consistent conventions (named exports, props.x access,
    // for...of, sequential async, `void promise` fire-and-forget, etc.).
    'no-use-before-define': 'off',
    '@typescript-eslint/no-use-before-define': 'off',
    'import/prefer-default-export': 'off',
    'react/destructuring-assignment': 'off',
    'react/require-default-props': 'off',
    'no-restricted-syntax': 'off',
    'no-await-in-loop': 'off',
    'no-void': 'off',
    'no-console': 'off',
    'no-plusplus': 'off',
    'no-continue': 'off',
    'no-underscore-dangle': 'off',
    'no-nested-ternary': 'off',
    'no-lonely-if': 'off',
    camelcase: 'off',
    'func-names': 'off',
    'global-require': 'off',
    'max-classes-per-file': 'off',
    'no-promise-executor-return': 'off',
    'no-return-await': 'off',
    'no-useless-constructor': 'off',
    '@typescript-eslint/no-useless-constructor': 'off',
    'no-loop-func': 'off',
    'no-empty-function': 'off',
    '@typescript-eslint/no-empty-function': 'off',
    'promise/param-names': 'off',
    'promise/always-return': 'off',
    'promise/no-nesting': 'off',
    'promise/catch-or-return': 'off',
    'no-alert': 'off',
    // TypeScript already resolves identifiers; the lint rule only produces
    // false positives for globals like globalThis/RequestInit/NodeJS/Electron.
    'no-undef': 'off',
    // Still catches accidental `if (x = y)`, but allows the idiomatic
    // parenthesised `while ((m = re.exec(s)) !== null)` regex loop.
    'no-cond-assign': ['error', 'except-parens'],

    // jsx-a11y defaults relaxed: KIAgent is a single-user Electron desktop
    // app, not a public web page, so keyboard/ARIA enforcement is noise here.
    'jsx-a11y/click-events-have-key-events': 'off',
    'jsx-a11y/no-static-element-interactions': 'off',
    'jsx-a11y/no-noninteractive-element-interactions': 'off',
    'jsx-a11y/label-has-associated-control': 'off',

    // More erb/react defaults the codebase deliberately and consistently
    // works against (prop spreading into presentational wrappers, inline
    // handlers, index keys on stable lists).
    'react/jsx-props-no-spreading': 'off',
    'react/jsx-no-bind': 'off',
    'react/no-array-index-key': 'off',
    // Redundant with TypeScript: prop usage is checked by the prop interface.
    'react/no-unused-prop-types': 'off',
    'class-methods-use-this': 'off',
    'no-bitwise': 'off',
    // Consistent with the other promise/* relaxations above (callback/promise
    // bridging is used deliberately at the IPC and OAuth boundaries).
    'promise/no-promise-in-callback': 'off',
    'promise/no-callback-in-promise': 'off',
    // Allow the idiomatic `while (true) { ...; break; }` loop.
    'no-constant-condition': ['error', { checkLoops: false }],
    // Tests assert via shared helpers and inside TS discriminated-union
    // narrowing (`if (!r.ok) expect(r.reason)...`), both of which these
    // rules flag as false positives.
    'jest/expect-expect': 'off',
    'jest/no-conditional-expect': 'off',
  },
  overrides: [
    {
      // react-hooks rules only make sense for renderer components. The hits
      // here are false positives: the main process has a `useBuiltAssets()`
      // helper and Playwright fixtures call `use()` — neither is a React hook.
      // `no-empty-pattern` flags Playwright's `async ({}, use) => {}` form.
      files: ['src/main/**', 'tests/**'],
      rules: {
        'react-hooks/rules-of-hooks': 'off',
        'no-empty-pattern': 'off',
      },
    },
    {
      // DB repository-boundary editor-time hint (mirrors the AUTHORITATIVE jest
      // guard at src/__tests__/db-repository-boundary-guard.test.ts). Raw
      // owned-table SQL must live behind src/main/db/repositories/**. This is a
      // best-effort early warning in the editor; the jest guard (AST-based,
      // also covers template literals + multiline batches) remains the gate.
      //
      // Scoped to src/main/** EXCEPT the allowlist (repositories/** +
      // migrations.ts) and test files — those legitimately hold owned-table SQL.
      // Selector limitation (ACCEPTED): `Literal[value=/.../]` matches only
      // plain string literals, NOT template literals — the jest guard catches
      // those. Mirrors the jest guard's FLAGGED_TABLES (13 base tables; the FTS
      // shadows documents_fts/documents_tri are excluded, and the `\b` word
      // boundary keeps `documents` from matching `documents_fts`).
      files: ['src/main/**'],
      excludedFiles: [
        'src/main/db/repositories/**',
        'src/main/oidc/**',
        'src/main/db/migrations.ts',
        '**/*.test.ts',
        '**/__tests__/**',
      ],
      rules: {
        'no-restricted-syntax': [
          'warn',
          {
            selector:
              'CallExpression[callee.property.name=/^(run|all|batch|exec)$/] Literal[value=/\\b(documents|document_languages|document_embeddings|annotations|inference_jobs|inference_meta|accounts|sync_state|connector_cadence|tracked_roots|drive_folder_index|imap_message_index|oidc_payload)\\b/]',
            message:
              'Raw owned-table SQL outside the repository layer — route it through a repository in src/main/db/repositories/. See db-repository-boundary-guard.test.ts (authoritative).',
          },
        ],
      },
    },
  ],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  settings: {
    'import/resolver': {
      // See https://github.com/benmosher/eslint-plugin-import/issues/1396#issuecomment-575727774 for line below
      node: {
        extensions: ['.js', '.jsx', '.ts', '.tsx'],
        moduleDirectory: ['node_modules', 'src/'],
      },
      webpack: {
        config: require.resolve('./.erb/configs/webpack.config.eslint.ts'),
      },
      typescript: {},
    },
    'import/parsers': {
      '@typescript-eslint/parser': ['.ts', '.tsx'],
    },
  },
};
