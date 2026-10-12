declare module "*.mjs" {
  import type { NativeAsset } from "./schema";
  export const CHARACTER_DATA: NativeAsset;
  export const GATE_DATA: NativeAsset;
  export const HOUSE_DATA: NativeAsset;
  export const ROCK_DATA: NativeAsset;
  export const TREE_DATA: NativeAsset;
  export const IDLE_DATA: NativeAsset;
  export const WALK_DATA: NativeAsset;
  export const RUN_DATA: NativeAsset;
  export const BOXING_DATA: NativeAsset;
  export const CAMPFIRE_DATA: NativeAsset;
}
