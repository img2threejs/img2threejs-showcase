import type { Container } from "pixi.js";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface InputFrame {
  left: boolean;
  right: boolean;
  jumpPressed: boolean;
  jumpHeld: boolean;
  dashPressed: boolean;
  restartPressed: boolean;
}
export const NO_INPUT: InputFrame = {
  left: false,
  right: false,
  jumpPressed: false,
  jumpHeld: false,
  dashPressed: false,
  restartPressed: false,
};
export type PlayerAnimation =
  | "idle"
  | "run"
  | "jump"
  | "fall"
  | "dash"
  | "hurt"
  | "dead"
  | "complete";
export interface PlayerState extends Rect {
  vx: number;
  vy: number;
  facing: -1 | 1;
  grounded: boolean;
  wallSide: -1 | 0 | 1;
  jumpsUsed: number;
  health: number;
  invulnerable: number;
  dashTime: number;
  dashCooldown: number;
  animation: PlayerAnimation;
  riding: string | null;
}
export interface Platform extends Rect {
  id: string;
  kind: "solid" | "moving";
  /** World-space pieces for static terrain; enclosing bounds are broad phase only. */
  collisionRects?: readonly Rect[];
  travelX?: number;
  travelY?: number;
  period?: number;
}
export interface MovingPlatform extends Rect {
  id: string;
  dx: number;
  dy: number;
}
export interface Enemy extends Rect {
  id: string;
  minX: number;
  maxX: number;
  speed: number;
  facing: -1 | 1;
  alive: boolean;
}
export interface Crystal extends Rect {
  id: string;
  collected: boolean;
}
export interface Checkpoint extends Rect {
  id: string;
  active: boolean;
  spawnX: number;
  spawnY: number;
}
export interface LevelDefinition {
  width: number;
  height: number;
  spawn: { x: number; y: number };
  platforms: Platform[];
  enemies: Enemy[];
  crystals: Crystal[];
  spikes: Rect[];
  checkpoints: Checkpoint[];
  portal: Rect;
  name: string;
}
export interface GameState {
  time: number;
  tick: number;
  phase: "playing" | "respawning" | "complete";
  player: PlayerState;
  movers: MovingPlatform[];
  enemies: Enemy[];
  crystals: Crystal[];
  checkpoints: Checkpoint[];
  collected: number;
  deaths: number;
  respawnTime: number;
  checkpointId: string | null;
  message: string;
}
export interface Simulation {
  readonly state: GameState;
  readonly level: LevelDefinition;
  step(dt: number, input: InputFrame): void;
  restart(): void;
}
export interface SceneHandle {
  root: Container;
  owners: Record<string, Container>;
  update(
    state: GameState,
    dt: number,
    viewportWidth: number,
    viewportHeight: number,
  ): void;
  resetCamera(): void;
  dispose(): void;
  getCamera(): { x: number; y: number; scale: number };
  /** Absolute local visual overrides; an empty object clears the edit, restoring normal authored/state motion. */
  setOwnerTransform(
    id: string,
    transform: { visible?: boolean; x?: number; y?: number },
  ): void;
}
export const PHYSICS_DT = 1 / 120;
