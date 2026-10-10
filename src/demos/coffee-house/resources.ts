// The host owns original and authored-motion Assets atlas leases. Scene factories borrow their sources
// and own only manifest-framed Texture wrappers.

import { Assets, Texture } from 'pixi.js';

import { ART_HEIGHT, ART_WIDTH } from './contracts.js';
import type { CoffeeManifest, CoffeePart, CoffeePartId, CoffeeResources, MotionManifest, MotionPartId } from './contracts.js';

// Static JSON imports replace the original fetch()-based manifest loading.
// The manifests are co-located with this module and bundled at build time
// (resolveJsonModule is enabled in tsconfig), so the gallery never makes a
// network call for the metadata.
import rawManifest from './manifest.json';
import rawMotionManifest from './motion-manifest.json';

const ATLAS_PATH = 'coffee-house/atlas.png';
const MOTION_ATLAS_PATH = 'coffee-house/motion-atlas.png';
const MOTION_IDS: readonly MotionPartId[] = ['backdrop', 'sky-mask', 'sky-day', 'sky-dusk', 'sky-night',
  'cloud-1', 'cloud-2', 'cloud-3', 'boat-1', 'boat-2', 'boat-3', 'cat-body', 'cat-tail'];

const PART_IDS: ReadonlyArray<CoffeePartId> = [
  'environment',
  'water-horizon',
  'water-channel',
  'cafe',
  'cat',
  'castle',
];

const PART_ID_ALLOWED: Record<CoffeePartId, true> = {
  environment: true, 'water-horizon': true, 'water-channel': true,
  cafe: true, cat: true, castle: true,
};

const releasedResources = new WeakSet<CoffeeResources>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePart(raw: unknown, index: number, atlasW: number, atlasH: number): CoffeePart {
  if (!isObject(raw)) {
    throw new Error(`Coffee manifest.parts[${index}] must be an object`);
  }
  const { id, frame, origin } = raw;
  if (typeof id !== 'string' || !(id in PART_ID_ALLOWED)) {
    throw new Error(`Coffee manifest.parts[${index}].id must be one of ${PART_IDS.join(', ')}, received ${String(id)}`);
  }
  const partId = id as CoffeePartId;
  if (!Array.isArray(frame) || frame.length !== 4 ||
      !frame.every((v) => Number.isInteger(v) && v >= 0)) {
    throw new Error(`Coffee manifest.parts[${index}] ("${partId}") frame must be 4 non-negative ints`);
  }
  const fx = frame[0] as number;
  const fy = frame[1] as number;
  const fw = frame[2] as number;
  const fh = frame[3] as number;
  if (fw <= 0 || fh <= 0) {
    throw new Error(`Coffee manifest.parts[${index}] ("${partId}") frame width/height must be positive`);
  }
  if (fx + fw > atlasW || fy + fh > atlasH) {
    throw new Error(`Coffee manifest.parts[${index}] ("${partId}") frame extends past atlas bounds`);
  }
  if (!Array.isArray(origin) || origin.length !== 2 ||
      typeof origin[0] !== 'number' || !Number.isFinite(origin[0]) ||
      typeof origin[1] !== 'number' || !Number.isFinite(origin[1])) {
    throw new Error(`Coffee manifest.parts[${index}] ("${partId}") origin must be finite [x,y]`);
  }
  return {
    id: partId,
    frame: [fx, fy, fw, fh],
    origin: [origin[0] as number, origin[1] as number],
  };
}

function validateManifest(raw: unknown): CoffeeManifest {
  if (!isObject(raw)) {
    throw new Error('Coffee manifest must be a JSON object');
  }
  if (raw.version !== 1) {
    throw new Error(`Coffee manifest version must be 1, received ${String(raw.version)}`);
  }
  if (typeof raw.referenceHash !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.referenceHash)) {
    throw new Error('Coffee manifest.referenceHash must be a 64-char hex string');
  }
  if (!Array.isArray(raw.artboard) || raw.artboard.length !== 2 ||
      raw.artboard[0] !== ART_WIDTH || raw.artboard[1] !== ART_HEIGHT) {
    throw new Error(
      `Coffee manifest.artboard must be [${ART_WIDTH}, ${ART_HEIGHT}], received ${JSON.stringify(raw.artboard)}`,
    );
  }
  if (!Array.isArray(raw.atlasSize) || raw.atlasSize.length !== 2 ||
      !Number.isInteger(raw.atlasSize[0]) || raw.atlasSize[0] <= 0 ||
      !Number.isInteger(raw.atlasSize[1]) || raw.atlasSize[1] <= 0) {
    throw new Error('Coffee manifest.atlasSize must be [positive-int-w, positive-int-h]');
  }
  const atlasW = raw.atlasSize[0] as number;
  const atlasH = raw.atlasSize[1] as number;
  if (!Array.isArray(raw.parts) || raw.parts.length !== PART_IDS.length) {
    const len = (raw.parts as { length?: unknown } | undefined)?.length;
    throw new Error(`Coffee manifest.parts must contain ${PART_IDS.length} entries, received ${String(len)}`);
  }
  const seen = new Set<CoffeePartId>();
  const parts: CoffeePart[] = (raw.parts as unknown[]).map((entry, index) => {
    const part = parsePart(entry, index, atlasW, atlasH);
    if (seen.has(part.id)) {
      throw new Error(`Coffee manifest has duplicate part id "${part.id}"`);
    }
    seen.add(part.id);
    return part;
  });
  for (const partId of PART_IDS) {
    if (!seen.has(partId)) {
      throw new Error(`Coffee manifest missing required part "${partId}"`);
    }
  }
  return {
    version: 1,
    referenceHash: (raw.referenceHash as string).toLowerCase(),
    artboard: [ART_WIDTH, ART_HEIGHT],
    atlasSize: [atlasW, atlasH],
    parts,
  };
}

function validateMotionManifest(raw: unknown): MotionManifest {
  if (!isObject(raw) || raw.version !== 1 || typeof raw.referenceHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(raw.referenceHash) || !Array.isArray(raw.atlasSize)
    || raw.atlasSize.length !== 2 || !raw.atlasSize.every(v => Number.isInteger(v) && v > 0)
    || !Array.isArray(raw.parts) || raw.parts.length !== MOTION_IDS.length) {
    throw new Error('Animation manifest has invalid version, reference, atlas size or parts');
  }
  const seen = new Set<string>();
  for (const part of raw.parts) {
    if (!isObject(part) || !MOTION_IDS.includes(part.id as MotionPartId) || seen.has(String(part.id))
      || !Array.isArray(part.frame) || part.frame.length !== 4
      || !part.frame.every(v => Number.isInteger(v) && v >= 0) || part.frame[2] <= 0 || part.frame[3] <= 0
      || part.frame[0] + part.frame[2] > raw.atlasSize[0] || part.frame[1] + part.frame[3] > raw.atlasSize[1]
      || !Array.isArray(part.origin) || part.origin.length !== 2 || !part.origin.every(Number.isFinite)) {
      throw new Error('Animation manifest contains a missing, duplicate or invalid frame');
    }
    seen.add(String(part.id));
  }
  const backdrop = raw.parts.find(part => part.id === 'backdrop');
  if (backdrop.frame[2] !== ART_WIDTH || backdrop.frame[3] !== ART_HEIGHT
    || !Array.isArray(raw.stars) || !raw.stars.every(star => Array.isArray(star) && star.length === 3
      && star.every(Number.isFinite) && star[0] >= 0 && star[0] < ART_WIDTH
      && star[1] >= 0 && star[1] < 480 && star[2] > 0)) {
    throw new Error('Animation backdrop or star coordinates are invalid');
  }
  return raw as unknown as MotionManifest;
}

function inspectAtlasTexture(texture: Texture, manifest: { atlasSize: [number, number]; parts: readonly { id: string; frame: [number, number, number, number] }[] }): void {
  const source = texture.source;
  if (!source) {
    throw new Error('Atlas texture has no source');
  }
  const actualWidth = source.pixelWidth ?? texture.width;
  const actualHeight = source.pixelHeight ?? texture.height;
  if (!Number.isInteger(actualWidth) || actualWidth <= 0 ||
      !Number.isInteger(actualHeight) || actualHeight <= 0) {
    throw new Error(`Atlas texture has non-positive dimensions: ${actualWidth}x${actualHeight}`);
  }
  if (actualWidth !== manifest.atlasSize[0] || actualHeight !== manifest.atlasSize[1]) {
    throw new Error(
      `Atlas texture ${actualWidth}x${actualHeight} does not match manifest ${manifest.atlasSize[0]}x${manifest.atlasSize[1]}`,
    );
  }
  for (const part of manifest.parts) {
    const [fx, fy, fw, fh] = part.frame;
    if (fx < 0 || fy < 0 || fx + fw > actualWidth || fy + fh > actualHeight) {
      throw new Error(
        `Part "${part.id}" frame ${part.frame.join(',')} extends past atlas ${actualWidth}x${actualHeight}`,
      );
    }
  }
}

const BASE = import.meta.env.BASE_URL;

function atlasUrl(name: string): string {
  const base = BASE.endsWith('/') ? BASE : `${BASE}/`;
  return `${base}${name}`;
}

export async function loadCoffeeResources(): Promise<CoffeeResources> {
  const manifest = validateManifest(rawManifest);
  const motionManifest = validateMotionManifest(rawMotionManifest);
  if (motionManifest.referenceHash !== manifest.referenceHash) {
    throw new Error('Animation assets do not match the admitted artwork');
  }
  const atlasUrlPath = atlasUrl(ATLAS_PATH);
  let texture: Texture;
  try {
    texture = await Assets.load<Texture>({ alias: atlasUrlPath, src: atlasUrlPath });
  } catch (err) {
    throw new Error(`Assets.load failed for atlas at ${atlasUrlPath}: ${(err as Error).message}`);
  }
  if (!(texture instanceof Texture)) {
    throw new Error(`Assets.load did not return a Texture for atlas at ${atlasUrlPath}`);
  }
  const motionUrlPath = atlasUrl(MOTION_ATLAS_PATH);
  let motionTexture: Texture | undefined;
  try {
    inspectAtlasTexture(texture, manifest);
    motionTexture = await Assets.load<Texture>({ alias: motionUrlPath, src: motionUrlPath });
    if (!(motionTexture instanceof Texture)) throw new Error('Animation atlas did not load as a texture');
    inspectAtlasTexture(motionTexture, motionManifest);
  } catch (err) {
    if (motionTexture) await Assets.unload(motionUrlPath);
    await Assets.unload(atlasUrlPath);
    throw err;
  }
  return { manifest, texture, motion: { manifest: motionManifest, texture: motionTexture } };
}

export async function releaseCoffeeResources(resources: CoffeeResources): Promise<void> {
  if (releasedResources.has(resources)) return;
  releasedResources.add(resources);
  const atlasUrlPath = atlasUrl(ATLAS_PATH);
  try {
    await Promise.all([Assets.unload(atlasUrlPath), Assets.unload(atlasUrl(MOTION_ATLAS_PATH))]);
  } catch (err) {
    throw new Error(`Assets.unload failed for atlas at ${atlasUrlPath}: ${(err as Error).message}`);
  }
}
