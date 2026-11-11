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
    files: [
      '**/scripts/**/*.mjs',
      '**/test/**/*.js',
      'client/tools/**/*.js',
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
