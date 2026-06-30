import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The build emits ONE self-contained dist/index.html (JS + CSS inlined), so the
// deployed app stays a single file — offline via the browser HTTP cache works the
// same as the old hand-written index.html. The help/ folder is runtime-fetched, so
// it lives in public/ and is copied verbatim to dist/help/ (NOT inlined).
export default defineConfig({
  // GitHub Pages serves this project at /mindmap/. Relative base keeps the few
  // runtime fetches (help/manifest.json) resolving correctly under that subpath.
  base: './',
  publicDir: 'public',
  plugins: [viteSingleFile()],
  build: {
    target: 'es2020',
    // viteSingleFile inlines everything; no separate asset dir needed.
    assetsInlineLimit: Infinity,
  },
});
