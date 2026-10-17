import type { Application, Ticker } from "pixi.js";
import { PHYSICS_DT } from "./contracts";
import type {
  GameState,
  InputFrame,
  LevelDefinition,
  SceneHandle,
} from "./contracts";
import { createSimulation } from "./simulation";
import { createScene, loadSceneAssets } from "./scene";
import { LEVEL } from "./level";

export interface GameOptions {
  paused?: boolean;
  onState?: (state: GameState) => void;
  keyboard?: Window;
}
export interface GameHandle {
  scene: SceneHandle;
  level: LevelDefinition;
  getSnapshot(): GameState;
  setPaused(value: boolean): void;
  readonly paused: boolean;
  restart(): void;
  dispose(): void;
}
export async function mountGame(
  app: Application,
  options: GameOptions = {},
): Promise<GameHandle> {
  await loadSceneAssets();
  const simulation = createSimulation(LEVEL);
  const scene = createScene(LEVEL);
  app.stage.addChild(scene.root);
  const target = options.keyboard ?? window;
  const input: InputFrame = {
    left: false,
    right: false,
    jumpPressed: false,
    jumpHeld: false,
    dashPressed: false,
    restartPressed: false,
  };
  const held = new Set<string>();
  let disposed = false;
  let paused = options.paused ?? false;
  let accumulator = 0;
  let previousTick = 0;
  const controlCodes: Record<string, true> = {
    KeyA: true,
    KeyD: true,
    ArrowLeft: true,
    ArrowRight: true,
    Space: true,
    ShiftLeft: true,
    ShiftRight: true,
    KeyR: true,
  };
  function clearInput() {
    held.clear();
    input.left =
      input.right =
      input.jumpHeld =
      input.jumpPressed =
      input.dashPressed =
      input.restartPressed =
        false;
    accumulator = 0;
  }
  function keydown(event: KeyboardEvent) {
    if (!controlCodes[event.code]) return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest(
        'button, input, textarea, select, a[href], [contenteditable="true"]',
      )
    )
      return;
    event.preventDefault();
    if (paused || event.repeat || held.has(event.code)) return;
    held.add(event.code);
    if (event.code === "Space") input.jumpPressed = true;
    if (event.code === "ShiftLeft" || event.code === "ShiftRight")
      input.dashPressed = true;
    if (event.code === "KeyR") input.restartPressed = true;
  }
  function keyup(event: KeyboardEvent) {
    held.delete(event.code);
  }
  function visibility() {
    if (document.hidden) clearInput();
  }
  target.addEventListener("keydown", keydown);
  target.addEventListener("keyup", keyup);
  target.addEventListener("blur", clearInput);
  document.addEventListener("visibilitychange", visibility);
  function update(ticker: Ticker) {
    if (disposed) return;
    const elapsed = Math.min(Math.max(ticker.deltaMS / 1000, 0), 0.1);
    if (!paused && !document.hidden) {
      accumulator += elapsed;
      input.left = held.has("KeyA") || held.has("ArrowLeft");
      input.right = held.has("KeyD") || held.has("ArrowRight");
      input.jumpHeld = held.has("Space");
      let steps = 0;
      while (accumulator + 1e-9 >= PHYSICS_DT && steps < 12) {
        simulation.step(PHYSICS_DT, input);
        input.jumpPressed = input.dashPressed = input.restartPressed = false;
        accumulator -= PHYSICS_DT;
        steps++;
      }
    }
    if (simulation.state.tick < previousTick) scene.resetCamera();
    previousTick = simulation.state.tick;
    scene.update(
      simulation.state,
      paused ? 0 : elapsed,
      app.screen.width,
      app.screen.height,
    );
    options.onState?.(simulation.state);
  }
  app.ticker.add(update);
  scene.update(simulation.state, 0, app.screen.width, app.screen.height);
  options.onState?.(simulation.state);
  return {
    scene,
    level: LEVEL,
    getSnapshot: () => structuredClone(simulation.state),
    setPaused(value: boolean) {
      paused = value;
      clearInput();
    },
    get paused() {
      return paused;
    },
    restart() {
      simulation.restart();
      scene.resetCamera();
      previousTick = 0;
      clearInput();
      options.onState?.(simulation.state);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      app.ticker.remove(update);
      target.removeEventListener("keydown", keydown);
      target.removeEventListener("keyup", keyup);
      target.removeEventListener("blur", clearInput);
      document.removeEventListener("visibilitychange", visibility);
      clearInput();
      scene.dispose();
    },
  };
}
