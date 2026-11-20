import { defaultClientConditions, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Forge's renderer config preserves symlinks, so a workspace package is
  // served from its `node_modules` link, which the watcher skips, and an edit
  // to it never reaches the window. Following the link serves it from
  // `packages/`, where it is watched.
  //
  // The library's packages are read as source, not as their builds, so an
  // edit to one needs no build to reach the app: see `exports` in their
  // package.json.
  // Naming any condition replaces Vite's own, so those are named too.
  resolve: {
    preserveSymlinks: false,
    conditions: [...defaultClientConditions, '@ai-idioms/source'],
  },
  // A workspace package is source, not a dependency: pre-bundled, it is
  // cached under a hash of the lockfile, so an edit to it never reaches the
  // window.
  optimizeDeps: { exclude: ['@ai-patterns/core', '@ai-patterns/anthropic-provider', '@ai-agent-library/tree'] },
});
