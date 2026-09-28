import type { NativeAsset } from "./schema";
import type { NativeDecodedImages } from "./constructors";
import characterDataUrl from "./data/character.mjs?url";
import gateDataUrl from "./data/gate.mjs?url";
import houseDataUrl from "./data/house.mjs?url";
import rockDataUrl from "./data/rock.mjs?url";
import treeDataUrl from "./data/tree.mjs?url";
import idleDataUrl from "./data/idle.mjs?url";
import walkDataUrl from "./data/walk.mjs?url";
import runDataUrl from "./data/run.mjs?url";
import boxingDataUrl from "./data/boxing.mjs?url";
import campfireDataUrl from "./data/campfire.mjs?url";

export type NativeRole = "character" | "gate" | "house" | "rock" | "tree" | "idle" | "walk" | "run" | "boxing" | "campfire";
export type NativeCoreRole = Exclude<NativeRole, "campfire">;

export interface PreparedNativeRole {
  readonly asset: NativeAsset;
  /** ImageBitmaps are owned by the module cache and must not be closed by model ownership. */
  readonly images: NativeDecodedImages;
}

type NativeRoleModule = Record<string, NativeAsset>;
type RoleLoader = () => Promise<NativeAsset>;

async function importRoleAsset(url: string, exportName: string): Promise<NativeAsset> {
  const module = await import(/* @vite-ignore */ url) as NativeRoleModule;
  return module[exportName];
}

// URL imports leave each generated multi-megabyte payload out of Rollup's JavaScript transform;
// each role module is still imported only when its existing loader is requested.
const ROLE_LOADERS: Record<NativeRole, RoleLoader> = {
  character: () => importRoleAsset(characterDataUrl, "CHARACTER_DATA"),
  gate: () => importRoleAsset(gateDataUrl, "GATE_DATA"),
  house: () => importRoleAsset(houseDataUrl, "HOUSE_DATA"),
  rock: () => importRoleAsset(rockDataUrl, "ROCK_DATA"),
  tree: () => importRoleAsset(treeDataUrl, "TREE_DATA"),
  idle: () => importRoleAsset(idleDataUrl, "IDLE_DATA"),
  walk: () => importRoleAsset(walkDataUrl, "WALK_DATA"),
  run: () => importRoleAsset(runDataUrl, "RUN_DATA"),
  boxing: () => importRoleAsset(boxingDataUrl, "BOXING_DATA"),
  campfire: () => importRoleAsset(campfireDataUrl, "CAMPFIRE_DATA"),
};

const CORE_ROLES: readonly NativeCoreRole[] = ["character", "gate", "house", "rock", "tree", "idle", "walk", "run", "boxing"];
const rolePromises = new Map<NativeRole, Promise<PreparedNativeRole>>();
const readyRoles: Partial<Record<NativeRole, PreparedNativeRole>> = {};
const imagePromises = new Map<string, Promise<ImageBitmap>>();
let corePromise: Promise<Readonly<Record<NativeCoreRole, PreparedNativeRole>>> | undefined;
let campfirePromise: Promise<PreparedNativeRole> | undefined;

function causedError(message: string, cause: unknown): Error {
  const error = new Error(message);
  Object.defineProperty(error, "cause", { configurable: true, value: cause });
  return error;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeImage(asset: NativeAsset, imageIndex: number): Promise<ImageBitmap> {
  const image = asset.effective.images[imageIndex];
  if (!image) return Promise.reject(new Error(`Native ${asset.role}: missing image ${imageIndex}`));
  const payload = asset.payloads.images[image.sha256];
  if (!payload) return Promise.reject(new Error(`Native ${asset.role}: missing SHA-keyed image payload ${image.sha256}`));
  if (payload.sha256 !== image.sha256 || payload.mimeType !== image.mimeType || payload.byteLength !== image.byteLength) {
    return Promise.reject(new Error(`Native ${asset.role}: image ${imageIndex} payload metadata mismatch`));
  }
  const key = `${image.mimeType}:${image.sha256}`;
  const cached = imagePromises.get(key);
  if (cached) return cached;

  const decoding = (async () => {
    if (typeof createImageBitmap !== "function" || typeof Blob !== "function") {
      throw new Error("Native image decoding requires browser ImageBitmap APIs (createImageBitmap and Blob)");
    }
    const bytes = decodeBase64(payload.base64);
    if (bytes.byteLength !== image.byteLength) throw new Error(`Native ${asset.role}: image ${imageIndex} payload length mismatch`);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return createImageBitmap(new Blob([buffer], { type: image.mimeType }), { ...image.decodeOptions });
  })();
  imagePromises.set(key, decoding);
  void decoding.catch(() => {
    if (imagePromises.get(key) === decoding) imagePromises.delete(key);
  });
  return decoding;
}

function loadRole(role: NativeRole): Promise<PreparedNativeRole> {
  const cached = rolePromises.get(role);
  if (cached) return cached;
  const loading = (async () => {
    try {
      const asset = await ROLE_LOADERS[role]();
      const entries = await Promise.all(Object.keys(asset.effective.images).map(async (rawIndex) => {
        const index = Number(rawIndex);
        return [index, await decodeImage(asset, index)] as const;
      }));
      const images: Record<number, ImageBitmap> = {};
      for (const [index, bitmap] of entries) images[index] = bitmap;
      const prepared = { asset, images };
      readyRoles[role] = prepared;
      return prepared;
    } catch (cause) {
      throw causedError(`Failed to preload native role "${role}"`, cause);
    }
  })();
  rolePromises.set(role, loading);
  void loading.catch(() => {
    if (rolePromises.get(role) === loading) rolePromises.delete(role);
  });
  return loading;
}

/** Load and decode the independent scene roles. Campfire is intentionally excluded. */
export function prewarmNativeCore(): Promise<Readonly<Record<NativeCoreRole, PreparedNativeRole>>> {
  if (!corePromise) {
    const warming = Promise.all(CORE_ROLES.map(async (role) => [role, await loadRole(role)] as const)).then((entries) => {
      return Object.fromEntries(entries) as Record<NativeCoreRole, PreparedNativeRole>;
    });
    corePromise = warming;
    void warming.catch(() => {
      if (corePromise === warming) corePromise = undefined;
    });
  }
  return corePromise;
}

/** Load campfire on its own lifecycle so its decoder/import failure cannot reject core readiness. */
export function preloadNativeCampfire(): Promise<PreparedNativeRole> {
  if (!campfirePromise) {
    const warming = loadRole("campfire");
    campfirePromise = warming;
    void warming.catch(() => {
      if (campfirePromise === warming) campfirePromise = undefined;
    });
  }
  return campfirePromise;
}

/** Return an already-prewarmed role; callers cannot accidentally use generated data too early. */
export function getPreparedNativeRole(role: NativeRole): PreparedNativeRole {
  const prepared = readyRoles[role];
  if (!prepared) throw new Error(`Native role "${role}" is not ready; await its prewarm operation first`);
  return prepared;
}
