import js from '@eslint/js';
import globals from 'globals';

// Plain JS, no type checker: lint exists mainly to catch undefined references
// and dead code before they ship (e.g. a helper deleted but still called).
export default [
  { ignores: ['node_modules/', 'dist/', 'out/', 'renderer/vendor/'] },
  js.configs.recommended,
  {
    // Electron main process, preload, build scripts, tests: CommonJS on Node.
    files: ['src/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: globals.node },
  },
  {
    // Renderer: browser ES module (xterm globals are declared in-file via /* globals */).
    files: ['renderer/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.browser },
  },
  {
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // A terminal app parses escape sequences; \x1b in a regex is intended.
      'no-control-regex': 'off',
    },
  },
];
