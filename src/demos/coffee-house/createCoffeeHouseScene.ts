// Adapter: returns a PixiShowcaseArtwork for the coffee-house scene. The
// scene is presentation-only and always shows the live ambient motion; the
// adapter guarantees the borrowed atlas source is released on both the
// happy path and on setup failure.
//
// Static imports keep the per-route tree-shake boundary clean: the
// Three.js bundle never has to load the PixiJS scene module.

import { loadCoffeeResources, releaseCoffeeResources } from './resources';
import { createCoffeeScene } from './scene';
import type { CoffeeScene } from './contracts';
import type { PixiShowcaseArtwork } from '../../pixi/showcase';

export async function loadCoffeeHouseArtwork(): Promise<PixiShowcaseArtwork> {
  const resources = await loadCoffeeResources();
  let scene: CoffeeScene | undefined;
  try {
    scene = createCoffeeScene(resources);
    return {
      root: scene.root,
      setTime: scene.setTime,
      async dispose() {
        // Framed textures/geometry belong to the scene; Assets owns the borrowed atlas sources.
        if (scene) {
          scene.dispose();
          scene = undefined;
        }
        await releaseCoffeeResources(resources);
      },
    };
  } catch (error) {
    // Release any completed scene and its atlas leases before propagating the setup failure.
    if (scene) {
      try { scene.dispose(); } catch { /* swallow teardown noise; rethrow original */ }
    }
    await releaseCoffeeResources(resources);
    throw error;
  }
}
