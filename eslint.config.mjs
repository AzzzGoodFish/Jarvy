import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/** Correctness-focused ESLint config for Jarvy (no formatting or style-preference rules).
 * Catches core JS/TS bugs, type-aware async mistakes, and React Hooks violations while staying
 * silent on formatting and Jarvy's deliberate idioms. */
export default tseslint.config(
  { ignores: ['dist/**', 'desktop/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.web.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Type-aware async & runtime safety.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/only-throw-error': ['error', { allowThrowingUnknown: true }],
      // Dead code & classic JS footguns.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'eqeqeq': ['error', 'smart'],
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Disable style-only or false-positive defaults (ANSI/control-char sanitizers, forward-declared `let`).
      'no-control-regex': 'off',
      'prefer-const': 'off',
    },
  },
  {
    files: ['src/server/**/*.ts', 'src/connect/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/web/**/*.ts', 'src/web/**/*.tsx'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // Disabled repo-wide: Jarvy passes inline callbacks and scopes effects to explicit trigger keys.
      'react-hooks/exhaustive-deps': 'off',
    },
  },
);
