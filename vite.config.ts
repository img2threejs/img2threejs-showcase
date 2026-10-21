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
      // Independent workspace showcases are built to public/<id>/; serve their index in dev.
      name: 'workspace-showcase-directory-index',
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          const directory = request.url?.split('?')[0];
          if (directory === '/living-room/' || directory === '/modern-house/') {
            request.url = request.url!.replace(directory, `${directory}index.html`);
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
