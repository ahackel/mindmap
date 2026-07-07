import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import pkg from './package.json' with { type: 'json' };

// The deploy workflow injects APP_VERSION (2.0.<GitHub run number>), so the version only
// bumps on actual deploys. Local/dev builds are marked as such instead of counting.
const appVersion = process.env.APP_VERSION || `${pkg.version}-dev`;

// The build emits ONE self-contained dist/index.html (JS + CSS inlined), so the
// deployed app stays a single file — offline via the browser HTTP cache works the
// same as the old hand-written index.html. The help notes (public/help/*.md) are
// embedded into the bundle at build time (see src/boot.ts) so the help mindmap works
// even when index.html is opened directly from a file:// path (fetch() is blocked there).
export default defineConfig({
  // GitHub Pages serves this project at /mindmap/. Relative base keeps asset URLs
  // resolving correctly under that subpath.
  base: './',
  publicDir: 'public',
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [viteSingleFile()],
  build: {
    target: 'es2020',
    // viteSingleFile inlines everything; no separate asset dir needed.
    assetsInlineLimit: Infinity,
  },
});
