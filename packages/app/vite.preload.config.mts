import { defaultClientConditions, defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  // The library's packages are read as source, not as their builds, so an
  // edit to one needs no build to reach the app: see `exports` in their
  // package.json.
  // Naming any condition replaces Vite's own, so those are named too.
  resolve: { conditions: [...defaultClientConditions, '@ai-idioms/source'] },
  build: {
    rolldownOptions: {
      output: {
        // See the note in `vite.main.config.mts`: both entries are `index.ts`
        // and both land in `.vite/build`, so the name has to be explicit.
        entryFileNames: 'preload.cjs',
      },
    },
  },
});
