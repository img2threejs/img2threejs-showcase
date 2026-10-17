import { Application, TextureStyle } from "pixi.js";
import "./style.css";
import "./showcase-shell.css";
import { mountFullscreenControls } from "./fullscreen";
import { mountGame } from "./game";
import type { GameHandle } from "./game";
import type { GameState } from "./contracts";
import referenceArt from "../../../public/skybound-adventure/reference-map/manifest.json" with { type: "json" };

const host = document.querySelector<HTMLDivElement>("#canvas-host")!;
const startScreen = document.querySelector<HTMLElement>("#start-screen")!;
const completeScreen = document.querySelector<HTMLElement>("#complete-screen")!;
const hearts = document.querySelector<HTMLElement>("#hearts")!;
const count = document.querySelector<HTMLElement>("#crystal-count")!;
const total = document.querySelector<HTMLElement>("#crystal-total")!;
const checkpoint = document.querySelector<HTMLElement>("#checkpoint-status")!;
const dashFill = document.querySelector<HTMLElement>("#dash-fill")!;
const dashLabel = document.querySelector<HTMLElement>("#dash-label")!;
const toast = document.querySelector<HTMLElement>("#toast")!;
const completeStats = document.querySelector<HTMLElement>("#completion-stats")!;
let lastHealth = -1;
let lastCollected = -1;
let lastMessage = "";
let messageAt = 0;
let lastTotal = -1;
let lastCheckpoint: string | null | undefined;
let lastDash = -1;
let lastPhase: GameState["phase"] | undefined;
const app = new Application();
function updateHud(state: GameState) {
  const player = state.player;
  if (lastHealth !== player.health) {
    for (let i = 0; i < hearts.children.length; i++)
      hearts.children[i]!.classList.toggle("empty", i >= player.health);
    hearts.parentElement!.setAttribute(
      "aria-label",
      `Health: ${player.health} of 3`,
    );
    lastHealth = player.health;
  }
  if (lastCollected !== state.collected) {
    count.textContent = String(state.collected).padStart(2, "0");
    lastCollected = state.collected;
  }
  if (lastTotal !== state.crystals.length) {
    total.textContent = `/ ${String(state.crystals.length).padStart(2, "0")}`;
    lastTotal = state.crystals.length;
  }
  if (lastCheckpoint !== state.checkpointId) {
    checkpoint.textContent = state.checkpointId
      ? "Checkpoint secured · Keep climbing"
      : "Find the ancient sky gate";
    lastCheckpoint = state.checkpointId;
  }
  if (lastDash !== player.dashCooldown) {
    const readiness = Math.max(0, Math.min(1, 1 - player.dashCooldown / 0.65));
    dashFill.style.transform = `scaleX(${readiness})`;
    if (lastDash <= 0 || player.dashCooldown <= 0)
      dashLabel.textContent =
        player.dashCooldown <= 0 ? "DASH READY" : "RECHARGING";
    lastDash = player.dashCooldown;
  }
  if (state.time < messageAt) {
    messageAt = 0;
    lastMessage = "";
  }
  if (state.message !== lastMessage) {
    lastMessage = state.message;
    messageAt = state.time;
    toast.textContent = state.message;
  }
  toast.classList.toggle(
    "visible",
    Boolean(state.message) && state.time - messageAt < 3.4,
  );
  if (lastPhase !== state.phase) {
    completeScreen.hidden = state.phase !== "complete";
    if (state.phase === "complete")
      completeStats.textContent = `${state.collected} / ${state.crystals.length} crystals · ${state.deaths} falls · ${Math.floor(state.time / 60)}:${String(Math.floor(state.time % 60)).padStart(2, "0")}`;
    document.body.dataset.phase = state.phase;
    lastPhase = state.phase;
  }
}
async function boot() {
  const hudImages = document.querySelectorAll<HTMLImageElement>("img[data-art]");
  for (const image of hudImages) {
    const name = image.dataset.art as keyof typeof referenceArt.hud;
    image.src = referenceArt.hud[name];
  }
  await Promise.all(Array.from(hudImages, (image) => image.decode()));
  await document.fonts.load('16px "Press Start 2P"');
  if (!document.fonts.check('16px "Press Start 2P"'))
    throw new Error("The bundled pixel font failed to load.");
  TextureStyle.defaultOptions.scaleMode = "nearest";
  await app.init({
    resizeTo: host,
    backgroundColor: 0x80c5ef,
    antialias: false,
    resolution: 1,
    autoDensity: true,
    preference: "webgl",
  });
  app.canvas.setAttribute("aria-label", "Skybound Adventure game canvas");
  app.canvas.setAttribute("tabindex", "0");
  host.appendChild(app.canvas);
  const game = await mountGame(app, { paused: true, onState: updateHud });
  const disposeFullscreenControls = mountFullscreenControls(app.canvas);
  const begin = () => {
    startScreen.hidden = true;
    game.setPaused(false);
    app.canvas.focus();
  };
  const restart = () => {
    startScreen.hidden = true;
    completeScreen.hidden = true;
    game.restart();
    game.setPaused(false);
    app.canvas.focus();
  };
  document.querySelector("#start-button")!.addEventListener("click", begin);
  document.querySelector("#restart")!.addEventListener("click", restart);
  document.querySelector("#play-again")!.addEventListener("click", restart);
  document.querySelector("#loading")!.remove();
  window.skybound = {
    ready: true,
    snapshot: () => game.getSnapshot(),
    camera: () => game.scene.getCamera(),
    owners: () => Object.keys(game.scene.owners),
    editOwner: (id, transform) => game.scene.setOwnerTransform(id, transform),
    pause: (value) => game.setPaused(value),
  };
  if (import.meta.env.DEV) window.skybound.debug = { app, game };
  if (import.meta.hot)
    import.meta.hot.dispose(() => {
      disposeFullscreenControls();
      game.dispose();
      document
        .querySelector("#start-button")
        ?.removeEventListener("click", begin);
      document.querySelector("#restart")?.removeEventListener("click", restart);
      document
        .querySelector("#play-again")
        ?.removeEventListener("click", restart);
      app.destroy(true, {
        children: true,
        texture: false,
        textureSource: false,
      });
      delete window.skybound;
    });
}
void boot().catch((error) => {
  const loading = document.querySelector("#loading");
  if (loading)
    loading.textContent = `Unable to start: ${error instanceof Error ? error.message : String(error)}`;
  console.error(error);
});
declare global {
  interface Window {
    skybound?: {
      ready: boolean;
      snapshot(): GameState;
      camera(): { x: number; y: number; scale: number };
      owners(): string[];
      editOwner(
        id: string,
        transform: { visible?: boolean; x?: number; y?: number },
      ): void;
      pause(value: boolean): void;
      /** Development-only inspector; production exposes snapshots and visual edits, never simulation setters. */
      debug?: { app: Application; game: GameHandle };
    };
  }
}
