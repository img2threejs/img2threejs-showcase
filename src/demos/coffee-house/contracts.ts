// Coffee-house shared types for the migrated gallery scene.
//
// Mirrors the original `src/coffee/contracts.ts` and removes the
// standalone-app-only CoffeeApp/CoffeeSnapshot contracts. The
// gallery adapter only needs the animation settings, effects enum
// and the resources/scene contracts the scene factory exposes to
// the PixiShowcaseArtwork loader.

import type { Container, Graphics, Mesh, MeshGeometry, ParticleContainer, Sprite, Texture } from 'pixi.js';
import type { CatPuppetParts } from './cat-puppet.js';

export const ART_WIDTH = 1536;
export const ART_HEIGHT = 1024;
export const LIGHT_CYCLE_SECONDS = 24;
export const nightAtTime = (seconds: number): number => (1 - Math.cos(seconds * Math.PI * 2 / LIGHT_CYCLE_SECONDS)) / 2;
export const PLACE_IDS = ['cafe', 'cat', 'castle'] as const;
export type PlaceId = typeof PLACE_IDS[number];
export type CoffeePartId = 'environment' | 'water-horizon' | 'water-channel' | PlaceId;
export interface CoffeePart {
  id: CoffeePartId;
  frame: [number, number, number, number];
  origin: [number, number];
}
export interface CoffeeManifest {
  version: 1;
  referenceHash: string;
  artboard: [number, number];
  atlasSize: [number, number];
  parts: CoffeePart[];
}
export type MotionPartId = 'backdrop' | 'sky-mask' | 'sky-day' | 'sky-dusk' | 'sky-night'
  | 'cloud-1' | 'cloud-2' | 'cloud-3' | 'boat-1' | 'boat-2' | 'boat-3' | 'cat-body' | 'cat-tail';
export interface MotionPart { id: MotionPartId; frame: [number, number, number, number]; origin: [number, number]; }
export interface MotionManifest {
  version: 1;
  referenceHash: string;
  atlasSize: [number, number];
  parts: MotionPart[];
  stars: Array<[number, number, number]>;
}
export const EFFECT_IDS = ['clouds', 'boats', 'foliage', 'water', 'cat', 'lamps', 'fireflies'] as const;
export type EffectId = typeof EFFECT_IDS[number];
export interface EffectSetting { enabled: boolean; amount: number; }
export interface AnimationSettings { playbackSpeed: number; effects: Record<EffectId, EffectSetting>; }
export const EFFECTS: Record<EffectId, { label: string; parameter: string; max: number; unit: 'speed' | 'strength' }> = {
  clouds: { label: 'Cloud drift', parameter: 'Drift speed', max: 3, unit: 'speed' },
  boats: { label: 'Sailing boats', parameter: 'Sailing speed', max: 3, unit: 'speed' },
  foliage: { label: 'Foliage sway', parameter: 'Sway strength', max: 2, unit: 'strength' },
  water: { label: 'Water ripples', parameter: 'Ripple strength', max: 2, unit: 'strength' },
  cat: { label: 'Cat tail sway', parameter: 'Sway strength', max: 1, unit: 'strength' },
  lamps: { label: 'Warm lights', parameter: 'Halo brightness', max: 2, unit: 'strength' },
  fireflies: { label: 'Fireflies', parameter: 'Glow brightness', max: 2, unit: 'strength' },
};
export function createAnimationSettings(): AnimationSettings {
  return { playbackSpeed: 1, effects: {
    clouds: { enabled: true, amount: 1 }, boats: { enabled: true, amount: 1 },
    foliage: { enabled: true, amount: 1 }, water: { enabled: true, amount: 1 },
    cat: { enabled: true, amount: 1 }, lamps: { enabled: true, amount: 1 },
    fireflies: { enabled: true, amount: 1 },
  } };
}
export interface CoffeeResources { manifest: CoffeeManifest; texture: Texture; motion: { manifest: MotionManifest; texture: Texture }; }
export interface CoffeeScene {
  root: Container;
  layers: {
    environment: Mesh<MeshGeometry>;
    cafe: Sprite;
    cat: Container;
    castle: Sprite;
    water: Container;
    sky: Container;
    sun: Container;
    moon: Container;
    boats: Container;
    foliage: Container;
    lights: Container;
    lighting: Graphics;
    fireflies: ParticleContainer;
    hotspots: Container;
  };
  waterMeshes: readonly Mesh<MeshGeometry>[];
  waveMeshes: readonly Mesh<MeshGeometry>[];
  cloudSprites: readonly Sprite[];
  boatSprites: readonly Sprite[];
  foliageMeshes: readonly Mesh<MeshGeometry>[];
  catParts: CatPuppetParts;
  catPuppet: Container;
  setEffect(id: EffectId, enabled: boolean, amount: number): void;
  setAmbient(enabled: boolean): void;
  setMarkers(enabled: boolean): void;
  setTime(seconds: number): void;
  select(place: PlaceId | null): void;
  dispose(): void;
}
export const PLACES: Record<PlaceId, { title: string; description: string; point: [number, number] }> = {
  cafe: { title: 'Moonlight Cafe', description: 'The hand-painted wooden sign and warm lanterns retain their original pixels. Select this contextual image region to explore the details.', point: [342, 270] },
  cat: { title: 'A guest on the terrace', description: 'The cat keeps its original painted sitting pose. Its body, head and paws stay still; only the original source tail gently sways. Adjust Cat tail sway in Animation controls, or switch it off to restore the exact static pose. Original retains the entire supplied image.', point: [737, 712] },
  castle: { title: 'The island castle', description: 'The illuminated towers and island retain the original painted details. The surrounding water, sky and moving boats use the approved authored reconstruction, not recovered 3D geometry.', point: [1235, 625] },
};
