// Scene-owned prop factory. Each call constructs a fresh THREE.Group with measured
// geometry / material; no GLB / texture / UV is read at runtime.
//
// Data modules are loaded via literal dynamic imports so each role enters the
// bundler's chunk graph only on the tropical-island route, and the 10+ MB of
// per-role gzip bytes arrive in their own per-role segments — see surfaceCodec.ts
// `loadCompressedSurface` and the per-role `prepareRole` for the actual decode.
import type * as THREE from 'three';

export type IslandPropRole = 'house' | 'palm' | 'dock' | 'boat' | 'rocks' | 'redRock' | 'crate' | 'barrel' | 'campfire' | 'lamp';

interface RoleModule {
  prepareRole: () => Promise<void>;
  buildRole: () => THREE.Group;
}

const ROLE_LOADERS: Record<IslandPropRole, () => Promise<RoleModule>> = {
  house: () => import('./data_house'),
  palm: () => import('./data_palm'),
  dock: () => import('./data_dock'),
  boat: () => import('./data_boat'),
  rocks: () => import('./data_rocks'),
  redRock: () => import('./data_redRock'),
  crate: () => import('./data_crate'),
  barrel: () => import('./data_barrel'),
  campfire: () => import('./data_campfire'),
  lamp: () => import('./data_lamp'),
};

const ROLES = Object.keys(ROLE_LOADERS) as ReadonlyArray<IslandPropRole>;

let preloadPromise: Promise<void> | null = null;
let published: Record<IslandPropRole, RoleModule> | null = null;

export function preloadMeasuredProps(): Promise<void> {
  if (preloadPromise) return preloadPromise;
  const pending: Partial<Record<IslandPropRole, RoleModule>> = {};
  preloadPromise = Promise.all(ROLES.map(async (role) => {
    const mod = await ROLE_LOADERS[role]();
    await mod.prepareRole();
    pending[role] = mod;
  })).then(() => {
    // Atomic publish: createMeasuredProp must never observe a partial map.
    published = pending as Record<IslandPropRole, RoleModule>;
  }).catch((error: unknown) => {
    preloadPromise = null;
    published = null;
    throw error;
  });
  return preloadPromise;
}

export function createMeasuredProp(role: IslandPropRole): THREE.Group {
  const map = published;
  if (!map) {
    throw new Error(`tropical-island/measured/props: call preloadMeasuredProps() and await it before createMeasuredProp(${String(role)}) — the role's data is loaded on demand`);
  }
  const mod = map[role];
  if (!mod) {
    throw new Error(`tropical-island/measured/props: unknown role ${String(role)}`);
  }
  return mod.buildRole();
}
