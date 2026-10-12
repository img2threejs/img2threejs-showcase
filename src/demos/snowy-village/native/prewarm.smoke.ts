import {
  getPreparedNativeRole,
  prewarmNativeCore,
  preloadNativeCampfire,
  type NativeCoreRole,
} from "./prewarm";
import { createNativeModel } from "./constructors";
import type { NativeAsset } from "./schema";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function meshObjectNames(role: NativeCoreRole): string[] {
  const prepared = getPreparedNativeRole(role);
  const model = createNativeModel(prepared.asset, prepared.images);
  const names: string[] = [];
  model.root.traverse((object) => {
    if ((object as { isMesh?: boolean }).isMesh) names.push(object.name);
  });
  model.ownership.dispose();
  return names;
}

// Runtime-selected imports intentionally exercise the generated role-module boundary used by prewarm.
const campfireModule = await import("./data/campfire.mjs") as { CAMPFIRE_DATA: NativeAsset };
const campfireAsset = campfireModule.CAMPFIRE_DATA;
const coreRoles: NativeCoreRole[] = ["character", "gate", "house", "rock", "tree", "idle", "walk", "run", "boxing"];
const coreImageKeys = new Set<string>();
for (const role of coreRoles) {
  const assetModule = await import(`./data/${role}.mjs`) as Record<string, NativeAsset>;
  const asset = assetModule[`${role.toUpperCase()}_DATA`];
  for (const image of Object.values(asset.effective.images)) coreImageKeys.add(`${image.mimeType}:${image.sha256}`);
}
const targetCampfireImage = Object.values(campfireAsset.effective.images).find((image) => !coreImageKeys.has(`${image.mimeType}:${image.sha256}`));
assert(targetCampfireImage, "campfire fixture needs one image not shared with core roles");
const targetCampfirePayload = campfireAsset.payloads.images[targetCampfireImage.sha256];
const targetBytes = atob(targetCampfirePayload.base64);
let decodedCount = 0;
let failCampfire = true;
Object.defineProperty(globalThis, "createImageBitmap", {
  configurable: true,
  value: async (blob: Blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const isCampfireTarget = bytes.length === targetBytes.length && bytes.every((byte, index) => byte === targetBytes.charCodeAt(index));
    if (failCampfire && isCampfireTarget) throw new Error("injected campfire decoder failure");
    decodedCount++;
    return { width: 1, height: 1 } as ImageBitmap;
  },
});

let earlyUseRejected = false;
try {
  getPreparedNativeRole("character");
} catch (error) {
  earlyUseRejected = error instanceof Error && error.message.includes("not ready");
}
assert(earlyUseRejected, "role access before prewarm must be rejected");

const ready = await prewarmNativeCore();
assert(Object.keys(ready).length === coreRoles.length, "all nine core roles must become ready");
for (const role of coreRoles) {
  const prepared = getPreparedNativeRole(role);
  assert(prepared === ready[role], `${role} must be available from the prepared-role cache`);
  const expectedIndices = Object.keys(prepared.asset.effective.images).map(Number).sort((a, b) => a - b);
  const actualIndices = Object.keys(prepared.images).map(Number).sort((a, b) => a - b);
  assert(JSON.stringify(actualIndices) === JSON.stringify(expectedIndices), `${role} images must resolve at every source image index`);
  for (const image of Object.values(prepared.asset.effective.images)) {
    const payload = prepared.asset.payloads.images[image.sha256];
    assert(payload?.sha256 === image.sha256 && payload.mimeType === image.mimeType, `${role} must resolve image payload by SHA key`);
    assert(prepared.images[image.sourceIndex], `${role} image ${image.sourceIndex} must have a decoded bitmap`);
  }
}
const characterMeshNames = meshObjectNames("character");
assert(characterMeshNames.includes("hyper3d_mesh_297a4bb9-ceab-4c9f-940d-fd78631b1cec:0"), "the named character mesh keeps its Hyper3D identity");
const houseMeshNames = meshObjectNames("house");
assert(houseMeshNames.includes("hyper3d_mesh_f5ae0d3a-9839-44ac-a100-c4761df806a5:0"), "the named house mesh keeps its Hyper3D identity");
const rockMeshNames = meshObjectNames("rock");
assert(rockMeshNames.length > 0 && rockMeshNames.every((name) => name.startsWith("procedural-img2threejs_mesh_")), "non-exempt native meshes receive procedural names");
assert(decodedCount > 0, "the injected image decoder must be exercised");

let campfireRejected = false;
try {
  await preloadNativeCampfire();
} catch (error) {
  campfireRejected = error instanceof Error
    && error.message.includes("campfire")
    && (error as Error & { cause?: unknown }).cause instanceof Error
    && ((error as Error & { cause: Error }).cause.message === "injected campfire decoder failure");
}
assert(campfireRejected, "the campfire decode error and cause must remain observable");
assert(getPreparedNativeRole("character") === ready.character, "campfire failure must leave core roles ready");

failCampfire = false;
const retriedCampfire = await preloadNativeCampfire();
assert(await preloadNativeCampfire() === retriedCampfire, "a successful campfire retry must be cached");
assert(getPreparedNativeRole("character") === ready.character, "campfire retry must not change core role readiness");
console.log(`native prewarm smoke passed: ${coreRoles.length} core roles; ${decodedCount} images decoded; campfire failure isolated and retried`);
