import type { PlayerAnimation } from "./contracts";

/** Registered in unscaled 2051 × 767 full-map source coordinates. */
export type ArtMotion =
  | "still"
  | "cloud"
  | "foliage"
  | "flag"
  | "lantern"
  | "water"
  | "airship"
  | "flying"
  | "portal"
  | "crystal"
  | "player"
  | "enemy"
  | "idle"
  | "spikes"
  | "mover"
  | "chain";

export interface ReferenceLayer {
  id: string;
  texture: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  motion: ArtMotion;
  /** Logical physics ID for a mover, enemy, crystal or portal. */
  binding?: string;
  /** Local attachment point; omission means the top-left source origin. */
  pivot?: { x: number; y: number };
  /** Source-derived seamless flow tile; required for water owners. */
  flowTexture?: string;
}

export interface ReferenceActorAtlas {
  texture: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  anchor: { x: number; y: number };
  animations: Record<PlayerAnimation, number[]>;
}

export interface ReferenceMapManifest {
  version: 1;
  width: number;
  height: number;
  referenceHash: string;
  layers: ReferenceLayer[];
  player: ReferenceActorAtlas;
  hud: { portrait: string; heart: string; crystal: string };
}
