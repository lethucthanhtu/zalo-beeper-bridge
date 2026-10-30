// Flat config: recommended TypeScript rules over src/, spike/ and the desktop scripts.
// Formatting is Prettier's job (.prettierrc.json) — eslint-config-prettier turns off
// every ESLint rule that would fight it.
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'spike/**/*.ts'],
    // Type-aware linting, for the promise rules below
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      // An un-awaited, un-voided promise loses its error: every fire-and-forget is explicit
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // .catch callbacks get unknown, like catch clauses: anything can be thrown (use errorMessage())
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // House style: object shapes are `type` aliases, never `interface`
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        WebAssembly: 'readonly',
      },
    },
  },
  prettier,
  { ignores: ['node_modules/', 'plans/', 'docs/', 'graphify-out/', '.claude/'] },
);
