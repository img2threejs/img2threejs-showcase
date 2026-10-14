import type { Container, Texture } from 'pixi.js';

export const WIDTH = 1536;
export const HEIGHT = 1024;
export type Skill = 'heal' | 'ice' | 'fire';
export type Attack = 'slash' | 'combo' | 'thrust' | 'spin' | 'dash' | 'ground';
export const ATTACKS: Record<Attack, { label: string; key: string; code: string }> = {
  slash: { label: 'Slash', key: 'J', code: 'KeyJ' },
  combo: { label: 'Combo', key: 'K', code: 'KeyK' },
  thrust: { label: 'Thrust', key: 'L', code: 'KeyL' },
  spin: { label: 'Spin', key: 'U', code: 'KeyU' },
  dash: { label: 'Dash', key: 'I', code: 'KeyI' },
  ground: { label: 'Ground Strike', key: 'O', code: 'KeyO' },
};
/** Hero body actions. Movement input is ignored until the action's duration elapses. */
export type Action = Skill | Attack;
export const ACTION_SECONDS: Record<Action, number> = {
  heal: 0.36, ice: 0.36, fire: 0.36,
  slash: 0.4, combo: 1.2, thrust: 0.44, spin: 0.76, dash: 0.5, ground: 0.94,
};
export type Gait = 'idle' | 'walk' | 'run';
export interface LayerAsset { id: string; file: string; x: number; y: number; width: number; height: number }
export interface EnvironmentManifest { layers: LayerAsset[]; referenceHash: string; inference: string[] }
export interface CharacterManifest { parts: LayerAsset[]; origin: { x: number; y: number }; referenceHash: string; inference: string[] }
export interface ActorPartAsset extends LayerAsset {
  role: string; pivot: { x: number; y: number }; parent: string | null; order: number;
  overlay?: boolean; authored?: boolean;
  offsetRange?: { x: [number, number]; y: [number, number] }; rotationRange?: [number, number];
}
export interface ActorAsset {
  id: string; feet: { x: number; y: number }; host: string; plate: LayerAsset;
  parts: ActorPartAsset[]; anchors?: Record<string, { x: number; y: number }>;
}
export interface ActorManifest { actors: ActorAsset[]; referenceHash: string; inference: string[] }
export interface Resources { environment: EnvironmentManifest; character: CharacterManifest; actors: ActorManifest; textures: Record<string, Texture> }
export interface GameState {
  x: number; y: number; facing: number; gait: Gait; time: number; night: number; paused: boolean;
  hp: number; mana: number; herbs: number; elderTalked: boolean; message: string;
  cooldowns: Record<Skill, number>; collected: boolean[];
  /** Current hero action and seconds since it started; null when free to move. */
  action: Action | null; actionTime: number;
}
export interface Movement { x: number; y: number; run: boolean }
export interface World {
  state: GameState;
  update(dt: number, movement: Movement): void;
  interact(): void;
  cast(skill: Skill): boolean;
  attack(action: Attack): boolean;
  reset(): void;
  canStand(x: number, y: number): boolean;
}
export interface Character {
  root: Container; parts: Record<string, Container>;
  update(state: GameState): void;
  reset(): void;
  dispose(): void;
}
export interface Actors {
  nodes: Record<string, Container>;
  plates: Record<string, Container>;
  emissive: Container;
  update(state: GameState): void;
  setEnabled(enabled: boolean): void;
  reset(): void;
  dispose(): void;
}
export interface Effects {
  root: Container;
  update(dt: number, state: GameState): void;
  cast(skill: Skill, x: number, y: number, facing: number): void;
  attack(action: Attack, x: number, y: number, facing: number): void;
  setEnabled(enabled: boolean): void;
  reset(): void;
  dispose(): void;
}
export interface Hud {
  root: Container;
  update(state: GameState): void;
  dispose(): void;
}
export interface Scene {
  root: Container; owners: Record<string, Container>; world: World; character: Character; effects: Effects; actors: Actors; hud: Hud;
  update(dt: number, movement: Movement): void;
  cast(skill: Skill): void;
  attack(action: Attack): void;
  reset(): void;
  dispose(): void;
}
