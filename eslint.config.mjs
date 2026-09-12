// Flat ESLint config, shared by every workspace package (WP-001).
//
// `verify:lint` runs `turbo run lint -- --max-warnings 0` across every workspace
// package, then `pnpm exec eslint scripts eslint.config.mjs --max-warnings 0` over
// the root `scripts/` folder and this config file itself, which sit outside every
// workspace package. Both clauses are chained with `&&`, so a warning anywhere is a
// failure at the gate. That is deliberate: a rule set with a standing warning count
// teaches everyone to read past warnings.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      // Not product code, and not this package's to lint.
      'planning/**',
      'agentops/**',
      'docs/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // Feature code never reaches a provider SDK directly; every AI call goes
      // through packages/ai (builder standing prompt s4). The gateway package
      // itself is the one place the import is legitimate, and it opts out with a
      // reviewable, per-file disable rather than a hole in this config.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@anthropic-ai/sdk',
              message: 'Route AI calls through packages/ai, never a provider SDK directly.',
            },
            {
              name: 'openai',
              message: 'Route AI calls through packages/ai, never a provider SDK directly.',
            },
          ],
        },
      ],
    },
  },

  // Untyped JavaScript. `recommendedTypeChecked` above applies to EVERY file, but
  // the type-aware parser is scoped to `**/*.{ts,tsx,mts,cts}` in the block above,
  // so a .js/.mjs/.cjs file has no TypeScript program and the first type-aware
  // rule to run aborts the whole ESLint invocation with "rule requires type
  // information" - the run fails before it lints a single line. Switching those
  // rules off here is what makes a Node-side script lintable at all. This block
  // sits AFTER the typed configs so it wins for JavaScript, and it changes nothing
  // for TypeScript: its `files` pattern does not match .ts/.tsx/.mts/.cts, so the
  // typed rule set above stays exactly as it was.
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },

  // Node-side build and gate scripts: plain ESM, no type-aware program.
  // The `files` globs are `**/`-prefixed because flat-config patterns are relative
  // to the config file's directory: 'scripts/**/*.mjs' matched only the root
  // scripts/ folder and missed packages/<pkg>/scripts/*.mjs, which a package lint
  // task does reach.
  {
    files: ['**/scripts/**/*.mjs', '**/*.config.mjs', 'evals/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // `no-undef` comes from js.configs.recommended and knows no environments in
      // flat config, so every global a Node script legitimately uses has to be
      // spelled out. The `globals` package would supply these, but it is not a
      // dependency of this workspace and adding it would touch package.json and
      // the lockfile - both outside this change - so the list is explicit:
      // process/console for I/O and exit codes; the timers any script that waits
      // or polls needs; and the WHATWG/Node globals a gate script uses to build a
      // URL, hold bytes, and call a service with a timeout.
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
);
