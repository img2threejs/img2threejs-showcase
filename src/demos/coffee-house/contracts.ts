// Coffee-house shared types for the gallery scene.
//
// Holds the artboard/clock constants, manifest shapes, and the
// resources/scene contracts the scene factory exposes to the
// PixiShowcaseArtwork loader.

import type { Container, Texture } from 'pixi.js';

export const ART_WIDTH = 1536;
export const ART_HEIGHT = 1024;
export const LIGHT_CYCLE_SECONDS = 24;
export const nightAtTime = (seconds: number): number => (1 - Math.cos(seconds * Math.PI * 2 / LIGHT_CYCLE_SECONDS)) / 2;
export type CoffeePartId = 'environment' | 'water-horizon' | 'water-channel' | 'cafe' | 'cat' | 'castle';
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
export interface CoffeeResources { manifest: CoffeeManifest; motion: { manifest: MotionManifest; texture: Texture } }
export interface CoffeeScene {
  root: Container;
  setTime(seconds: number): void;
  dispose(): void;
}
