import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { importX, createNodeResolver } from 'eslint-plugin-import-x';
import storybook from 'eslint-plugin-storybook';

// Main, preload and the page are three bundles in three environments. None may
// import another's code; what two of them must agree on goes in `src/shared`.
const zone = (target, from, message) => ({ target: `./src/${target}`, from: `./src/${from}`, message });

export default defineConfig(
  { ignores: ['.vite/', 'out/', 'storybook-static/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  storybook.configs['flat/recommended'],
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'import-x': importX },
    settings: { 'import-x/resolver-next': [createNodeResolver({ extensions: ['.ts', '.tsx'] })] },
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          basePath: import.meta.dirname,
          zones: [
            zone('renderer', 'main', 'The page has no Node.js. Reach the main process through the preload bridge.'),
            zone('renderer', 'preload', 'The preload bundle is not importable from the page; its only surface is what `contextBridge` exposes.'),
            zone('main', 'renderer', 'The main process has no DOM. Move anything both sides need into `src/shared`.'),
            zone('main', 'preload', 'Preload and main are separate bundles. Share code through `src/shared` instead.'),
            zone('preload', 'main', 'Preload runs in the page\'s process and must not pull in main-process code.'),
            zone('preload', 'renderer', 'Preload runs before the page does and must not import its code.'),
            zone('shared', 'main', '`src/shared` is bundled into every process, so it can depend on none of them.'),
            zone('shared', 'preload', '`src/shared` is bundled into every process, so it can depend on none of them.'),
            zone('shared', 'renderer', '`src/shared` is bundled into every process, so it can depend on none of them.'),
          ],
        },
      ],
    },
  },
);
