// @ts-check

import importPlugin from 'eslint-plugin-import'
import prettierPlugin from 'eslint-plugin-prettier'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import { defineConfig } from 'eslint/config'
import neostandard from 'neostandard'

const baseRules = neostandard({
  semi: false,
  ts: true,
  ignores: ['dist', 'node_modules', 'coverage', 'out', '**/out/**'],
})

export default defineConfig([
  ...baseRules,
  {
    plugins: {
      import: importPlugin,
      prettier: prettierPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      react: { version: 'detect' },
      'import/internal-regex': '^@boardlab/',
    },
    rules: {
      curly: 'warn',
      eqeqeq: 'warn',
      '@stylistic/comma-dangle': 'off',
      '@stylistic/brace-style': 'off',
      '@stylistic/generator-star-spacing': 'off',
      '@stylistic/indent': 'off',
      '@stylistic/no-tabs': 'off',
      '@stylistic/rest-spread-spacing': 'off',
      '@stylistic/space-before-function-paren': [
        'error',
        { anonymous: 'always', named: 'never', asyncArrow: 'always' },
      ],
      'generator-star-spacing': 'off',
      '@stylistic/jsx-quotes': ['error', 'prefer-double'],
      'import/first': 'error',
      'import/order': [
        'error',
        {
          'newlines-between': 'always',
          groups: [
            'builtin',
            'external',
            'internal',
            ['parent', 'sibling', 'index'],
          ],
        },
      ],
      'import/newline-after-import': 'error',
      'prettier/prettier': ['warn', { proseWrap: 'always' }],
      // React Hooks plugin (ensure rule is defined to avoid missing-rule errors)
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // Browser globals for webview code
  {
    files: ['packages/webviews/**/src/**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        getComputedStyle: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLStyleElement: 'readonly',
        Element: 'readonly',
        HTMLTableRowElement: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
      },
    },
  },
  // Loosen JSX stylistic rules in webviews TSX to avoid noisy indentation/ternary errors
  {
    files: ['packages/webviews/**/src/**/*.{tsx,jsx}'],
    rules: {
      '@stylistic/multiline-ternary': 'off',
      '@stylistic/jsx-indent': 'off',
      '@stylistic/jsx-indent-props': 'off',
      '@stylistic/jsx-closing-tag-location': 'off',
      '@stylistic/jsx-closing-bracket-location': 'off',
    },
  },
])
