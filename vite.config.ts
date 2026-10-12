import { defineConfig } from 'vite';
import { sourceArchivesPlugin } from './scripts/source-archives.mjs';

/**
 * Served from the apex domain `img2threejs.io` (see `public/CNAME`), so assets resolve from the
 * root. This was `/img2threejs-showcase/` while the site lived on the github.io project path.
 */
export default defineConfig({
  base: '/',
  plugins: [sourceArchivesPlugin()],
  build: {
    rollupOptions: {
      input: {
        index: 'index.html',
        iphoneDuo: 'iphone-duo.html',
      },
    },
  },
});
