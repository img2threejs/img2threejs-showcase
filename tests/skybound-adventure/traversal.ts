import { pathToFileURL } from "node:url";
import { PHYSICS_DT } from "../../src/demos/skybound-adventure/contracts";
import type { Simulation } from "../../src/demos/skybound-adventure/contracts";
import { createTraversalController } from "./route-controller";
import { createSimulation } from "../../src/demos/skybound-adventure/simulation";

export function runTraversal(maxSeconds = 60): {
  simulation: Simulation;
  frames: number;
} {
  const simulation = createSimulation();
  const control = createTraversalController();
  let frames = 0;
  while (
    frames < maxSeconds / PHYSICS_DT &&
    simulation.state.phase !== "complete"
  ) {
    simulation.step(PHYSICS_DT, control(simulation));
    frames++;
  }
  return { simulation, frames };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { simulation, frames } = runTraversal();
  const { phase, deaths, collected, player } = simulation.state;
  const collectedIds = simulation.state.crystals.filter((coin) => coin.collected).map((coin) => coin.id);
  const missingIds = simulation.state.crystals.filter((coin) => !coin.collected).map((coin) => coin.id);
  console.log(
    JSON.stringify({
      phase,
      frames,
      deaths,
      collected,
      collectedIds,
      missingIds,
      x: player.x,
      y: player.y,
    }),
  );
  if (phase !== "complete" || deaths !== 0 || collected !== 13 || missingIds.length !== 0 || collectedIds.length !== 13)
    process.exitCode = 1;
}
