import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `base: './'` makes the build work from any sub-path (GitHub Pages serves it
// under /<repo-name>/).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
});
