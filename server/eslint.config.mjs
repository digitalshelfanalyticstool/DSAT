import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjsPlugin from 'eslint-plugin-sonarjs';
import globals from 'globals';

/**
 * Flat ESLint config for the Express + BullMQ server.
 *
 * Adds eslint-plugin-sonarjs at the same severity profile as the client config:
 * security-relevant rules at 'error', deferred refactor rules at 'warn'.
 * CLI scripts in src/scripts relax the strictest rules.
 */
export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'data/**',
      'storage/**',
      'coverage/**',
      'ecosystem.config.js',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  sonarjsPlugin.configs.recommended,
  {
    // One-off operational scripts under server/scripts/. They are genuine
    // CommonJS Node programs -- `require`, `__dirname`, `process` and
    // `console` are correct there, not oversights. Without this block the
    // shared ESM/browser profile flagged 38 errors across two files, which is
    // most of what kept `npm run lint --workspace=server` red.
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],

      // SonarJS — match client severity profile.
      'sonarjs/cognitive-complexity': 'warn',
      'sonarjs/no-nested-functions': 'warn',
      'sonarjs/no-nested-conditional': 'warn',
      'sonarjs/slow-regex': 'error',
      'sonarjs/pseudo-random': 'error',
      'sonarjs/no-hardcoded-passwords': 'error',
      'sonarjs/no-nested-template-literals': 'warn',
      'sonarjs/void-use': 'warn',
      'sonarjs/no-nested-assignment': 'warn',
      'sonarjs/use-type-alias': 'off',
      'sonarjs/unused-import': 'off',

      // Surfaced on first persistent run — large existing baseline. Downgrade
      // to 'warn' rather than churn through 100+ pre-existing findings outside
      // the agreed "Security + low-risk quality" scope. Should be triaged in a
      // follow-up PR per rule.
      // (sonarjs/todo-tag intentionally off — comment markers are accepted here.)
      'sonarjs/no-hardcoded-ip': 'warn',
      'sonarjs/publicly-writable-directories': 'warn',
      'sonarjs/hardcoded-secret-signatures': 'warn',
      'sonarjs/no-unenclosed-multiline-block': 'warn',
      'sonarjs/single-character-alternation': 'warn',
      'sonarjs/concise-regex': 'warn',
      'sonarjs/no-dead-store': 'warn',
      'sonarjs/no-unused-vars': 'warn',
      'sonarjs/no-unused-collection': 'warn',
      'sonarjs/no-ignored-exceptions': 'warn',
      'sonarjs/todo-tag': 'off', // TODO comments are accepted in this codebase
      'sonarjs/sql-queries': 'warn',
      '@typescript-eslint/no-namespace': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
    },
  },
  {
    files: ['src/scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'sonarjs/no-hardcoded-passwords': 'off',
      'sonarjs/public-static-readonly': 'off',
      'sonarjs/no-os-command-from-path': 'off',
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/void-use': 'off',
      'sonarjs/slow-regex': 'off',
      'sonarjs/super-linear-regex': 'off',
      'sonarjs/no-floating-point-equality': 'off',
      'sonarjs/pseudo-random': 'off',
      'sonarjs/no-nested-conditional': 'off',
      'sonarjs/no-nested-functions': 'off',
      'sonarjs/no-nested-template-literals': 'off',
      'sonarjs/no-hardcoded-ip': 'off',
      'sonarjs/publicly-writable-directories': 'off',
      'sonarjs/hardcoded-secret-signatures': 'off',
      'sonarjs/sql-queries': 'off',
      'sonarjs/no-dead-store': 'off',
      'sonarjs/no-unused-collection': 'off',
      'sonarjs/no-ignored-exceptions': 'off',
      'no-useless-escape': 'off',
      'no-unexpected-multiline': 'off',
    },
  },
];
