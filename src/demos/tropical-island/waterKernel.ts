import encoded from './waterKernelCode';

const SIZE = 128;
const CELLS = SIZE * SIZE;

interface KernelExports {
  memory: WebAssembly.Memory;
  update_velocities(): void;
  compute_stage(dt: number): number;
  bed_address(): number;
  depth_address(): number;
  momentum_x_address(): number;
  momentum_z_address(): number;
  velocity_x_address(): number;
  velocity_z_address(): number;
  axis_address(): number;
  cell_widths_address(): number;
  grid_size(): number;
  failure_h(): number;
  cfl_signal(): number;
  snapshot_state(): void;
  blend_state(infiltration: number, absorbed: number): number;
  prepare_foam_sources(): number;
  update_foam(dt: number, decay: number, rise: number, fall: number, film: number, full: number): void;
  foam_address(): number;
  wetness_address(): number;
  foam_offset_x_address(): number;
  foam_offset_z_address(): number;
  shore_normal_x_address(): number;
  shore_normal_z_address(): number;
  shore_impulse_x_address(): number;
  shore_impulse_z_address(): number;
  foam_candidates_address(): number;
  foam_compression_address(): number;
  foam_source_step_address(): number;
}

export interface KernelViews {
  bed: Float64Array;
  depth: Float64Array;
  momentumX: Float64Array;
  momentumZ: Float64Array;
  velocityX: Float64Array;
  velocityZ: Float64Array;
  axis: Float32Array;
  cellWidths: Float64Array;
  updateVelocities(): void;
  computeStage(dt: number): void;
  foam: Float64Array;
  wetness: Float64Array;
  foamOffsetX: Float64Array;
  foamOffsetZ: Float64Array;
  shoreNormalX: Float64Array;
  shoreNormalZ: Float64Array;
  shoreImpulseX: Float64Array;
  shoreImpulseZ: Float64Array;
  foamCandidates: Uint32Array;
  foamCompression: Float64Array;
  foamSourceStep: Float64Array;
  cflSignal(): number;
  snapshotState(): void;
  blendState(infiltration: number, absorbed: number): number;
  prepareFoamSources(): number;
  updateFoam(dt: number, decay: number, rise: number, fall: number, film: number, full: number): void;
}

let compiled: WebAssembly.Module | undefined;

/** Compile once; each lake gets private memory and zero-copy field views. */
export function createKernel(): KernelViews {
  if (!compiled) {
    const raw = atob(encoded);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    compiled = new WebAssembly.Module(bytes);
  }
  const kernel = new WebAssembly.Instance(compiled).exports as unknown as KernelExports;
  if (kernel.grid_size() !== SIZE) throw new Error('Tropical Island water-kernel grid size mismatch');
  const buffer = kernel.memory.buffer;
  return {
    bed: new Float64Array(buffer, kernel.bed_address(), CELLS),
    depth: new Float64Array(buffer, kernel.depth_address(), CELLS),
    momentumX: new Float64Array(buffer, kernel.momentum_x_address(), CELLS),
    momentumZ: new Float64Array(buffer, kernel.momentum_z_address(), CELLS),
    velocityX: new Float64Array(buffer, kernel.velocity_x_address(), CELLS),
    velocityZ: new Float64Array(buffer, kernel.velocity_z_address(), CELLS),
    axis: new Float32Array(buffer, kernel.axis_address(), SIZE),
    cellWidths: new Float64Array(buffer, kernel.cell_widths_address(), SIZE),
    updateVelocities: kernel.update_velocities,
    foam: new Float64Array(buffer, kernel.foam_address(), CELLS),
    wetness: new Float64Array(buffer, kernel.wetness_address(), CELLS),
    foamOffsetX: new Float64Array(buffer, kernel.foam_offset_x_address(), CELLS),
    foamOffsetZ: new Float64Array(buffer, kernel.foam_offset_z_address(), CELLS),
    shoreNormalX: new Float64Array(buffer, kernel.shore_normal_x_address(), CELLS),
    shoreNormalZ: new Float64Array(buffer, kernel.shore_normal_z_address(), CELLS),
    shoreImpulseX: new Float64Array(buffer, kernel.shore_impulse_x_address(), CELLS),
    shoreImpulseZ: new Float64Array(buffer, kernel.shore_impulse_z_address(), CELLS),
    foamCandidates: new Uint32Array(buffer, kernel.foam_candidates_address(), CELLS),
    foamCompression: new Float64Array(buffer, kernel.foam_compression_address(), CELLS),
    foamSourceStep: new Float64Array(buffer, kernel.foam_source_step_address(), CELLS),
    cflSignal: kernel.cfl_signal,
    snapshotState: kernel.snapshot_state,
    blendState: kernel.blend_state,
    prepareFoamSources: kernel.prepare_foam_sources,
    updateFoam: kernel.update_foam,
    computeStage(dt) {
      const cell = kernel.compute_stage(dt);
      if (cell !== -1) {
        throw new Error(`Shallow-water positivity failure at cell ${cell}: ${kernel.failure_h()}`);
      }
    },
  };
}
