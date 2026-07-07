/// <reference types="vite/client" />

// Injected at build time by the `define` block in vite.config.js:
// "major.minor" from package.json + git commit count as the patch number.
declare const __APP_VERSION__: string;
