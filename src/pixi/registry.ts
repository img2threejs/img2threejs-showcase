import type { DemoMetadata } from '../demos/registry';
import type { PixiShowcaseArtwork } from './showcase';

export type PixiDemoMetadata = Pick<DemoMetadata,
  'id' | 'title' | 'subjectClass' | 'blurb' | 'referenceImage' | 'sourcePath' | 'sourceUrl'
  | 'generatedWith' | 'author' | 'authorUrl' | 'status'> & {
  renderer: 'pixi';
  referenceAlt: string;
  fullReferenceImage: string;
  artboard: readonly [number, number];
  loadArtwork(): Promise<PixiShowcaseArtwork>;
  loadRenderer(): Promise<typeof import('../pages/pixi-demo')>;
};

const BASE = import.meta.env.BASE_URL;
const REPO = 'https://github.com/img2threejs/img2threejs-showcase/blob/main';

/** Dedicated 2D experiences share the archive, not the Three.js model/camera contract. */
export const pixiDemos: PixiDemoMetadata[] = [
  {
    id: 'coffee-house',
    renderer: 'pixi',
    title: 'Moonlight Cafe',
    subjectClass: 'object',
    blurb: 'A quiet café above a coastal town, brought to life from a single 2D artwork. Clouds drift across a changing sky, boats cross the bay, and warm lights reflect on the water. The seated cat stays in its original painted pose, gently swaying only its tail.',
    referenceImage: `${BASE}references/coffee-house.webp`,
    fullReferenceImage: `${BASE}coffee-house/reference.png`,
    referenceAlt: 'Original Moonlight Cafe artwork: a sunset over a coastal town, a café terrace on the left, and a seated black cat overlooking the bay.',
    artboard: [1536, 1024],
    sourcePath: 'src/demos/coffee-house/scene.ts',
    sourceUrl: `${REPO}/src/demos/coffee-house/scene.ts`,
    generatedWith: 'img2pixijs · PixiJS 8.22.0',
    author: 'Hoài Nhớ',
    authorUrl: 'https://github.com/hoainho',
    status: 'final',
    loadRenderer() {
      // Route-selected renderer plugin: static imports would load PixiJS on every Three.js page.
      return import('../pages/pixi-demo');
    },
    async loadArtwork() {
      // Runtime registry plugin: only the selected 2D exhibit loads its scene and atlas code.
      const { loadCoffeeHouseArtwork } = await import('../demos/coffee-house/createCoffeeHouseScene');
      return loadCoffeeHouseArtwork();
    },
  },
];

export function getPixiDemo(id: string): PixiDemoMetadata | undefined {
  return pixiDemos.find(demo => demo.id === id);
}
