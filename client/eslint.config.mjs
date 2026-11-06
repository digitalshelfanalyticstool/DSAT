import js from '@eslint/js';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';
import nextPlugin from '@next/eslint-plugin-next';
import sonarjsPlugin from 'eslint-plugin-sonarjs';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

/**
 * Flat ESLint config for Next.js 16 + React 19.
 *
 * Adds eslint-plugin-jsx-a11y (lint-time a11y enforcement) and a
 * project-local rule banning direct apiClient.getSession()/getBrands() calls
 * outside src/providers/, which bypass SessionProvider/ConfigProvider caches.
 */
export default [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'a11y/.auth/**',
      'next-env.d.ts',
      'public/**',
    ],
  },
  js.configs.recommended,
  sonarjsPlugin.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        React: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'jsx-a11y': jsxA11yPlugin,
      '@next/next': nextPlugin,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      // Baseline TypeScript — keep loose; this is incremental adoption, not greenfield.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
      'no-undef': 'off', // TS handles this
      'no-empty': ['error', { allowEmptyCatch: true }],

      // React
      'react/jsx-key': 'error',
      'react/jsx-no-undef': 'error',
      'react/no-children-prop': 'error',
      'react/no-danger': 'error',
      'react/self-closing-comp': 'warn',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Next.js
      '@next/next/no-html-link-for-pages': 'error',
      '@next/next/no-img-element': 'error',
      '@next/next/no-sync-scripts': 'error',

      // SonarJS — Sonar-equivalent rules without the cloud dependency. Quality
      // smells are 'warn' (so CI doesn't fail), security-relevant rules are 'error'.
      // Deferred refactors (cognitive-complexity, no-nested-functions, no-nested-conditional)
      // surface as warnings and should be addressed in dedicated PRs rather than bundled.
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
      'sonarjs/unused-import': 'off', // covered by @typescript-eslint/no-unused-vars

      // jsx-a11y — recommended set, but downgraded to warn where v4.7.0 has documented exceptions.
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/anchor-has-content': 'error',
      'jsx-a11y/anchor-is-valid': 'error',
      'jsx-a11y/aria-activedescendant-has-tabindex': 'error',
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-proptypes': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/aria-unsupported-elements': 'error',
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/heading-has-content': 'error',
      'jsx-a11y/iframe-has-title': 'error',
      'jsx-a11y/img-redundant-alt': 'error',
      'jsx-a11y/interactive-supports-focus': 'warn',
      'jsx-a11y/label-has-associated-control': ['error', { assert: 'either' }],
      'jsx-a11y/no-redundant-roles': 'error',
      'jsx-a11y/role-has-required-aria-props': 'error',
      'jsx-a11y/role-supports-aria-props': 'error',
      'jsx-a11y/scope': 'error',
      'jsx-a11y/tabindex-no-positive': 'error',

      // ── Project-local guardrails ──
      // text-gray-400 on white fails 1.4.3.
      // Allowlist specific call sites in component code (icons, dark surfaces) via
      // // eslint-disable-next-line no-restricted-syntax with a justification.
      'no-restricted-syntax': [
        'warn',
        {
          selector: "Literal[value=/\\btext-gray-400\\b/]",
          message:
            'Contrast guardrail: `text-gray-400` (#94a3b8) is 2.84:1 on white — fails WCAG 1.4.3 for body text. ' +
            'Use `text-gray-500` for body, `text-gray-600` for emphasis. ' +
            'Allowed only on dark surfaces (sidebar, dark tooltip) and decorative SVG icons (must be aria-hidden=true). ' +
            'Document exceptions with `// eslint-disable-next-line no-restricted-syntax -- <reason>`.',
        },
        {
          selector: "TemplateElement[value.raw=/\\btext-gray-400\\b/]",
          message:
            'Contrast guardrail (template literal): same rule as above. ' +
            'Use `text-gray-500` for body / `text-gray-600` for emphasis. Document exceptions with eslint-disable + reason.',
        },
        {
          // Bans direct apiClient.getSession() / getBrands() / getSites() calls.
          // These bypass SessionProvider (60s TTL) / ConfigProvider (5min TTL) caches.
          selector:
            "CallExpression[callee.object.name='apiClient'][callee.property.name=/^(getSession|getBrands|getSites)$/]",
          message:
            'Cache-bypass guardrail: do not call `apiClient.getSession()`, `apiClient.getBrands()` or `apiClient.getSites()` directly — ' +
            'these bypass SessionProvider/ConfigProvider caches and add a redundant network round-trip. ' +
            'Use `useSession()` from @/providers/SessionProvider or `useConfig()` from @/providers/ConfigProvider. ' +
            'The providers themselves (in src/providers/) are exempt; if you have a genuine reason to bypass, ' +
            'document it with `// eslint-disable-next-line no-restricted-syntax -- <reason>`.',
        },
      ],
    },
  },
  {
    // Providers and primitives are allowed to call apiClient directly — they ARE the cache layer.
    files: ['src/providers/**/*.{ts,tsx}', 'src/lib/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        // Keep the gray-400 rule (still applies inside providers/lib if any UI is rendered there).
        {
          selector: "Literal[value=/\\btext-gray-400\\b/]",
          message:
            'Contrast guardrail: `text-gray-400` fails WCAG 1.4.3 on white. Use gray-500/600 or document exception.',
        },
      ],
    },
  },
];
