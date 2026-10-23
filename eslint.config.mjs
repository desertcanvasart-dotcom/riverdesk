import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Rule 1 (one write path): apps reach the database only through @vs/engine.
const appImportRules = {
  'no-restricted-imports': [
    'error',
    {
      paths: [
        { name: 'pg', message: 'Apps must not open database connections; use @vs/engine.' },
        { name: 'kysely', message: 'Apps must not query the database; use @vs/engine.' },
        { name: '@vs/db', message: 'Apps must not use @vs/db; use @vs/engine.' },
      ],
      patterns: [{ group: ['@vs/db/*'], message: 'Apps must not use @vs/db; use @vs/engine.' }],
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/next-env.d.ts',
      'packages/db/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/*/src/**/*.{ts,tsx}'],
    rules: appImportRules,
  },
);
