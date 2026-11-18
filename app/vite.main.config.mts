import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    lib: {
      entry: 'src/main/index.ts',
      // Forge writes every build into a single `.vite/build` directory, so the
      // main and preload entries — both `index.ts` — would otherwise collide
      // on `index.cjs`. Name the outputs after their layer instead.
      fileName: () => 'main.cjs',
      formats: ['cjs'],
    },
    rolldownOptions: {
      // Everything else is bundled, the library included: a packaged app
      // carries no node_modules. `node:sqlite` is named because it exists
      // only with its prefix, so it is not in `builtinModules`.
      external: ['electron', 'node:sqlite', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
});
