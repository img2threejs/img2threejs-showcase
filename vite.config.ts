import { defineConfig } from 'vite';
import { sourceArchivesPlugin } from './scripts/source-archives.mjs';

/**
 * Served from the apex domain `img2threejs.io` (see `public/CNAME`), so assets resolve from the
 * root. This was `/img2threejs-showcase/` while the site lived on the github.io project path.
 */
export default defineConfig({
  base: '/',
  plugins: [
    sourceArchivesPlugin(),
    {
      name: 'living-room-directory-index',
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url?.split('?')[0] === '/living-room/') {
            request.url = request.url.replace('/living-room/', '/living-room/index.html');
          }
          next();
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        index: 'index.html',
        iphoneDuo: 'iphone-duo.html',
        greenvale: 'greenvale.html',
        skyboundAdventure: 'skybound-adventure.html',
      },
      output: {
        // Do not hoist shared preload helpers and eagerly load Pixi on 3D routes.
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          if (id.includes('/node_modules/pixi.js/')) return 'pixi-runtime';
        },
      },
    },
  },
});
