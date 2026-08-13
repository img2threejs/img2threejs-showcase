import { defineConfig } from 'vite';
import { computeRenderEpoch } from './scripts/provenance.mjs';

export default defineConfig(() => {
  // Bake the exact pixel-producing source epoch into the served application. The capture process
  // compares this value with its own checkout before writing any PNG, so a stale dev server or a
  // server running from another checkout fails closed. Hashing HTTP responses is not equivalent:
  // Vite transforms TypeScript modules before serving them, so their response bytes cannot match
  // the source bytes used by provenance.
  //
  // The epoch, not the full provenance record: that record is anchored to a single demo's review
  // plan and model sources, so calling it here made `vite build` fail closed the moment that demo
  // was retired. The served build only needs to identify its own checkout.
  const provenance = computeRenderEpoch({ label: 'vite-source-epoch' });
  return {
    base: '/img2threejs-showcase/',
    // The character compiler is a linked local package with its own Three.js dependency.
    // Force both package graphs onto the showcase copy so renderer/class identity stays stable.
    resolve: {
      dedupe: ['three'],
    },
    define: {
      __IMG2THREEJS_RENDER_EPOCH__: JSON.stringify(provenance.renderHash),
    },
  };
});
