import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** Stamp a unique id into sw.js on every build, so installed apps notice new versions. */
function stampServiceWorker(): Plugin {
  return {
    name: 'stamp-sw',
    apply: 'build',
    closeBundle() {
      const file = resolve(__dirname, 'dist/sw.js');
      writeFileSync(file, readFileSync(file, 'utf8').replace('__BUILD_ID__', Date.now().toString(36)));
    },
  };
}

// `base: './'` makes the build work from any sub-path (GitHub Pages serves it
// under /<repo-name>/).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), stampServiceWorker()],
});
