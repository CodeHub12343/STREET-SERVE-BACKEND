/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: ['./tsconfig.json'],
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
    'prettier',
  ],
  env: { node: true, es2022: true },
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', '*.cjs', '*.js'],
  rules: {
    // Correctness guards the blueprint mandates:
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': 'error', // use the pino logger, never console
    // Adapter isolation boundary: nothing outside integrations/* may import a third-party SDK directly.
    'no-restricted-imports': [
      'error',
      {
        paths: [
          { name: 'stripe', message: 'Import Stripe only inside src/integrations/stripe.' },
        ],
      },
    ],
  },
  overrides: [
    {
      files: ['test/**/*.ts', '**/*.test.ts'],
      rules: {
        // Supertest response bodies are untyped `any`; relax unsafe-* in tests only.
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
      },
    },
    {
      files: ['src/integrations/**/*.ts'],
      rules: { 'no-restricted-imports': 'off' },
    },
  ],
};
