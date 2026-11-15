import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['**/dist/', '**/node_modules/', 'server/logs/'] },
  js.configs.recommended,
  {
    files: ['client/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
    },
  },
  {
    // The shared simulation runs in the browser AND in Node: browser globals are fine (EventTarget
    // and CustomEvent exist in both), Node modules and the DOM-less rules are enforced.
    files: ['shared/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'ws'],
              message: 'shared/ must run in the browser too',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'determinism: use the seeded rng',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'determinism: time is passed in as dt',
        },
      ],
    },
  },
  {
    files: [
      '**/scripts/**/*.mjs',
      '**/test/**/*.js',
      'client/tools/**/*.js',
      'shared/test/**/*.js',
      '**/*.config.js',
      'server/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    // The puzzles run both in Node (npm test) and in the browser (puzzles/index.html).
    files: ['client/public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: 'error',
    },
  },
  prettier,
];
