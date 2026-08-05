import {
  DEFAULT_ELECTRIC_MOUSE_BELLY_TUNE,
  type ElectricMouseBellyTune,
  type ElectricMouseMascotRuntime,
} from './createElectricMouseMascotModel';
import { mountTunePanel, type TuneControl } from '../../ui/tunePanel';

const PANEL_ID = 'electric-mouse-belly-tune';

type TuneKey = Extract<keyof ElectricMouseBellyTune, string>;

const CONTROLS: ReadonlyArray<TuneControl<TuneKey>> = [
  { key: 'creaseOffsetPx', label: 'Crease position', hint: '+ = up', min: -80, max: 80, step: 1 },
  { key: 'creaseWidthPx', label: 'Crease width', hint: 'px', min: 1, max: 30, step: 0.5 },
  { key: 'creaseDepth', label: 'Radial depth', hint: '0–0.45', min: 0, max: 0.45, step: 0.005 },
  { key: 'sidePinchDepth', label: 'Side pinch', hint: '0–0.30', min: 0, max: 0.30, step: 0.005 },
  { key: 'shadowWidthPx', label: 'Shadow width', hint: 'px', min: 1, max: 30, step: 0.5 },
  { key: 'shadowZSpread', label: 'Shadow Z spread', hint: 'body-local', min: 0.1, max: 2, step: 0.01 },
  { key: 'shadowStrength', label: 'Shadow strength', hint: '0–1', min: 0, max: 1, step: 0.01 },
];

/**
 * Belly-crease tuning for the Electric Mouse mascot. The panel itself is the shared
 * `src/ui/tunePanel` component; everything here is the demo-specific configuration — which
 * parameters are editable, their ranges, and how they reach the mascot runtime.
 *
 * Not mounted by the registry yet: this ships in v1.5. Enable it from a demo's `build()` with
 * `mountElectricMouseBellyTunePanel(runtime)` and keep the returned disposer.
 */
export function mountElectricMouseBellyTunePanel(
  runtime: ElectricMouseMascotRuntime,
): () => void {
  return mountTunePanel<ElectricMouseBellyTune>({
    id: PANEL_ID,
    title: 'Electric Mouse · Belly Tune',
    subtitle: 'Only Body_Head_Main crease',
    note: 'Geometry updates live. Positive position moves the crease upward. Shadow center stays fixed.',
    accent: '#ffd51a',
    corner: 'top-right',
    controls: CONTROLS,
    adapter: {
      get: () => runtime.getBellyTune(),
      set: (next) => runtime.setBellyTune(next),
      defaults: DEFAULT_ELECTRIC_MOUSE_BELLY_TUNE,
    },
  });
}
