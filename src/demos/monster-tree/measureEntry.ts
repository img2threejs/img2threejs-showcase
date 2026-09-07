/** Entry point for `tools/measure-rig.mjs` — bundles the demo so node can measure it. */
import { RIG } from './rigData';
import { SURFACE_MODEL, SURFACE_STREAM } from './surfaceData.high';
import { buildRiggedModel } from './meshCodec';
import { buildMonsterTreeRig, type RigOptions } from './rig';

export async function loadRig() {
  return {
    rig: RIG,
    model: SURFACE_MODEL,
    stream: SURFACE_STREAM,
    build: (options: RigOptions = {}) => buildMonsterTreeRig(SURFACE_MODEL, SURFACE_STREAM, RIG, options),
  };
}

/** The export's own rigged builder, so the gate can measure the defect it was fixed for. */
export function codec() {
  return { buildRiggedModel };
}
