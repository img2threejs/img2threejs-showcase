import { Assets, Texture } from 'pixi.js';
import type { ActorAsset, ActorManifest, CharacterManifest, EnvironmentManifest, LayerAsset, Resources } from './types.js';

const base = import.meta.env.BASE_URL;
const referenceHash = 'd071abc0d2308b515e02e3be027b2e420734122408c58038e0c7512d4e9a133b';
let pending: Promise<Resources> | null = null;
let unloading: Promise<void> = Promise.resolve();
let users = 0;
const released = new WeakSet<Resources>();

async function manifest<T>(file: string): Promise<T> {
  const response = await fetch(`${base}greenvale/${file}`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Unable to load ${file}: HTTP ${response.status}`);
  return await response.json() as T;
}

function checkLayers(layers: LayerAsset[], kind: string): void {
  if (!Array.isArray(layers) || !layers.length) throw new Error(`The ${kind} manifest is missing image layers.`);
  const ids = new Set<string>();
  for (const layer of layers) {
    if (!layer || typeof layer.id !== 'string' || ids.has(layer.id) ||
        typeof layer.file !== 'string' || !layer.file.startsWith(`/greenvale/${kind}/`) ||
        layer.file.includes('..') ||
        ![layer.x, layer.y, layer.width, layer.height].every(Number.isFinite) ||
        layer.width <= 0 || layer.height <= 0) throw new Error(`Invalid ${kind} image layer.`);
    ids.add(layer.id);
  }
}

const actorRoles: Record<string, Record<string, string | null>> = {
  guard: { legs: null, upper: null, spear: 'upper', blink: 'upper' },
  farmer: { legs: null, upper: null, arm: 'upper', blink: 'upper' },
  merchant: { body: null, head: null, blink: 'head' },
  dog: { body: null, head: 'body', tail: 'body', blink: 'head' },
  blacksmith: { legs: null, upper: null, arm: 'upper', hammer: 'arm', blink: 'upper' },
  boat: { hull: null },
};

function finitePoint(point: { x: number; y: number } | undefined): boolean {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function finiteRange(range: unknown): boolean {
  return Array.isArray(range) && range.length === 2 && range.every(Number.isFinite) && range[0] <= range[1];
}

function checkActors(actors: ActorManifest): LayerAsset[] {
  if (!Array.isArray(actors.actors) || actors.actors.length !== Object.keys(actorRoles).length) {
    throw new Error('The actors manifest does not list exactly the required actors.');
  }
  const layers: LayerAsset[] = [];
  const seen = new Set<string>();
  for (const actor of actors.actors as ActorAsset[]) {
    const required = actorRoles[actor?.id];
    if (!required || seen.has(actor.id)) throw new Error(`Unexpected or duplicate actor ${String(actor?.id)}.`);
    seen.add(actor.id);
    if (!finitePoint(actor.feet)) throw new Error(`Actor ${actor.id} has invalid feet.`);
    if (typeof actor.host !== 'string' || !actor.host) throw new Error(`Actor ${actor.id} has no host.`);
    if (!Array.isArray(actor.parts)) throw new Error(`Actor ${actor.id} has no parts.`);
    const roles = new Map<string, string | null>();
    const orders = new Set<number>();
    for (const part of actor.parts) {
      if (!part || typeof part.role !== 'string' || roles.has(part.role)) throw new Error(`Actor ${actor.id} has an invalid or duplicate part role.`);
      if (!finitePoint(part.pivot)) throw new Error(`Part ${part.id} has an invalid pivot.`);
      if (!Number.isFinite(part.order) || orders.has(part.order)) throw new Error(`Part ${part.id} has an invalid or duplicate draw order.`);
      if (part.parent !== null && typeof part.parent !== 'string') throw new Error(`Part ${part.id} has an invalid parent.`);
      const o = part.offsetRange;
      if (o && (!finiteRange(o.x) || !finiteRange(o.y))) throw new Error(`Part ${part.id} has an invalid offset range.`);
      if (part.rotationRange && !finiteRange(part.rotationRange)) throw new Error(`Part ${part.id} has an invalid rotation range.`);
      orders.add(part.order);
      roles.set(part.role, part.parent);
    }
    for (const [role, parent] of roles) {
      if (parent !== null) {
        if (!roles.has(parent)) throw new Error(`Part role ${role} of ${actor.id} has a missing parent ${parent}.`);
        let hops = 0;
        for (let p: string | null = parent; p !== null; p = roles.get(p) ?? null) {
          if (p === role || ++hops > roles.size) throw new Error(`Part roles of ${actor.id} form a cycle.`);
        }
      }
    }
    for (const role of Object.keys(required)) {
      if (!roles.has(role)) throw new Error(`Actor ${actor.id} is missing required part ${role}.`);
      if (roles.get(role) !== required[role]) throw new Error(`Part ${role} of ${actor.id} must have parent ${String(required[role])}.`);
    }
    if (actor.id === 'blacksmith' && !(finitePoint(actor.anchors?.impact) && finitePoint(actor.anchors?.forge))) {
      throw new Error('The blacksmith is missing its impact or forge anchor.');
    }
    layers.push(actor.plate, ...actor.parts);
  }
  checkLayers(layers, 'actors');
  return layers;
}

async function fetchResources(): Promise<Resources> {
  const [environment, character, actors] = await Promise.all([
    manifest<EnvironmentManifest>('environment/manifest.json'),
    manifest<CharacterManifest>('character/manifest.json'),
    manifest<ActorManifest>('actors/manifest.json'),
  ]);
  if (environment.referenceHash !== referenceHash || character.referenceHash !== referenceHash ||
      actors.referenceHash !== referenceHash) {
    throw new Error('The image layers do not match the supplied Greenvale reference.');
  }
  checkLayers(environment.layers, 'environment');
  checkLayers(character.parts, 'character');
  const actorLayers = checkActors(actors);
  if (!character.origin || ![character.origin.x, character.origin.y].every(Number.isFinite)) {
    throw new Error('The character manifest is missing its anchor point.');
  }
  const layers = [...environment.layers, ...character.parts, ...actorLayers];
  const paths = [...new Set(layers.map((layer) => `${base}${layer.file.slice(1)}`))];
  const loaded = await Promise.allSettled(paths.map((path) => Assets.load<Texture>(path)));
  const successful = paths.filter((_, i) => loaded[i]!.status === 'fulfilled');
  const failed = loaded.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    await Promise.all(successful.map((path) => Assets.unload(path)));
    throw new Error(`Unable to load Greenvale resources: ${String(failed.reason)}`);
  }
  const textures: Record<string, Texture> = {};
  for (let i = 0; i < paths.length; i++) {
    const result = loaded[i]!;
    if (result.status === 'fulfilled') {
      result.value.source.scaleMode = 'nearest';
      textures[`/${paths[i]!.slice(base.length)}`] = result.value;
    }
  }
  for (const layer of layers) {
    const texture = textures[layer.file]!;
    if (texture.width !== layer.width || texture.height !== layer.height) {
      await Promise.all(successful.map((path) => Assets.unload(path)));
      throw new Error(`The dimensions of ${layer.id} do not match the manifest.`);
    }
  }
  return { environment, character, actors, textures };
}

export async function loadResources(): Promise<Resources> {
  await unloading;
  pending ??= fetchResources().catch((error: unknown) => { pending = null; throw error; });
  const resources = await pending;
  users++;
  return { ...resources };
}

export async function releaseResources(resources: Resources): Promise<void> {
  if (released.has(resources)) return;
  released.add(resources);
  if (--users > 0) return;
  pending = null;
  unloading = Promise.all(Object.keys(resources.textures).map((file) =>
    Assets.unload(`${base}${file.slice(1)}`))).then(() => undefined);
  await unloading;
}
