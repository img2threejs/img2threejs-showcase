import * as THREE from 'three';

import type { NoteEvent } from '../music/ScoreLoader';

const AXIS_Z = new THREE.Vector3(0, 0, 1);
const EPSILON = 1e-9;

/** A deliberately small fixed pool keeps replay and song switching bounded. */
export const MAX_DRUM_IMPACT_EFFECTS = 12;
export const DRUM_IMPACT_DURATION_SECONDS = 0.34;

export interface DrumImpactSurface {
  readonly id: string;
  /** Object whose local transform carries the membrane/cymbal motion. */
  readonly object: THREE.Object3D;
  /** Point on the actual rendered surface, in object-local coordinates. */
  readonly pointLocal: THREE.Vector3;
  /** Outward surface normal in object-local coordinates. */
  readonly normalLocal: THREE.Vector3;
  /** Base radius of the visible ring in metres. */
  readonly radius: number;
  /** Small outward lift that avoids depth fighting with the surface. */
  readonly offset: number;
}

export interface DrumImpactEffects {
  readonly pool: readonly THREE.Group[];
  readonly maxPoolSize: number;
  apply(timeSeconds: number, notes: readonly NoteEvent[], reducedMotion?: boolean): void;
}

interface DrumImpactVisual {
  readonly group: THREE.Group;
  readonly ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  readonly glow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
}

function finiteTime(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothStep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function supportedDrumHits(
  notes: readonly NoteEvent[],
  surfaces: ReadonlyMap<string, DrumImpactSurface>,
): NoteEvent[] {
  return notes
    .filter((note) => {
      if (note.instrumentId !== 'drums' || !surfaces.has(note.componentId)) return false;
      return note.stickId === 'left' || note.stickId === 'right' || note.stickId === 'pedal';
    })
    .slice()
    .sort((a, b) => a.onsetSeconds - b.onsetSeconds || a.id.localeCompare(b.id));
}

function createVisual(
  index: number,
  rippleGeometry: THREE.RingGeometry,
  glowGeometry: THREE.CircleGeometry,
): DrumImpactVisual {
  const group = new THREE.Group();
  group.name = `drums.impact.${index}`;
  group.visible = false;
  // Hidden pooled meshes still participate in Box3.setFromObject in Three.js;
  // park their tiny bootstrap bounds above the floor until a hit positions
  // them on a real surface.
  group.position.y = 0.08;
  group.scale.setScalar(1e-6);
  group.userData.decorativeImpact = true;
  group.userData.poolIndex = index;

  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xf0c48c,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
  });
  const ring = new THREE.Mesh(
    rippleGeometry,
    ringMaterial,
  );
  ring.name = `drums.impact.${index}.ripple`;
  ring.renderOrder = 3;
  group.add(ring);

  const glowMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd9a7,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
  });
  const glow = new THREE.Mesh(glowGeometry, glowMaterial);
  glow.name = `drums.impact.${index}.glow`;
  glow.renderOrder = 2;
  group.add(glow);

  return { group, ring, glow };
}

/**
 * Create deterministic, absolute-time impact feedback for the authored kit.
 * The pool is attached to the drum root so the normal transform and model
 * disposal remain owned by the model, while each frame is recomputed from
 * score time rather than from accumulated animation state.
 */
export function createDrumImpactEffects(
  root: THREE.Group,
  surfaces: ReadonlyMap<string, DrumImpactSurface>,
): DrumImpactEffects {
  const rippleGeometry = new THREE.RingGeometry(0.034, 0.072, 24);
  const glowGeometry = new THREE.CircleGeometry(0.05, 24);
  const visuals = Array.from({ length: MAX_DRUM_IMPACT_EFFECTS }, (_, index) => {
    const visual = createVisual(index, rippleGeometry, glowGeometry);
    root.add(visual.group);
    return visual;
  });
  const pool = visuals.map((visual) => visual.group);

  const apply = (
    timeSeconds: number,
    notes: readonly NoteEvent[],
    reducedMotion = false,
  ): void => {
    const time = finiteTime(timeSeconds);
    if (reducedMotion) {
      for (const visual of visuals) {
        visual.group.visible = false;
        visual.ring.material.opacity = 0;
        visual.glow.material.opacity = 0;
      }
      return;
    }

    const hits = supportedDrumHits(notes, surfaces).filter((note) => {
      const age = time - note.onsetSeconds;
      return age >= -EPSILON && age <= DRUM_IMPACT_DURATION_SECONDS;
    });
    // Newest hits occupy the first slots; sorting and slicing are pure, so a
    // backward seek cannot inherit a stale slot assignment from the old time.
    const recent = hits.slice(Math.max(0, hits.length - MAX_DRUM_IMPACT_EFFECTS)).reverse();
    root.updateMatrixWorld(true);

    for (let index = 0; index < visuals.length; index += 1) {
      const visual = visuals[index]!;
      const note = recent[index];
      const surface = note && surfaces.get(note.componentId);
      if (!note || !surface) {
        visual.group.visible = false;
        visual.ring.material.opacity = 0;
        visual.glow.material.opacity = 0;
        continue;
      }

      const age = clamp01((time - note.onsetSeconds) / DRUM_IMPACT_DURATION_SECONDS);
      const ease = smoothStep(age);
      const velocity = clamp01(note.velocity);
      const radius = Math.max(0.001, surface.radius);
      // RingGeometry is authored in a 7.2 cm unit radius. Normalize that
      // radius against each surface so a crash ripple reads at roughly the
      // same visual proportion as a snare ripple while still expanding.
      const scale = (radius * (0.20 + 0.35 * ease + 0.05 * velocity)) / 0.072;
      const ringOpacity = (0.26 + 0.30 * velocity) * (1 - ease);
      const glowOpacity = (0.085 + 0.15 * velocity) * (1 - ease) * (1 - ease);

      const worldPoint = surface.object.localToWorld(surface.pointLocal.clone());
      const worldNormalPoint = surface.object.localToWorld(
        surface.pointLocal.clone().add(surface.normalLocal),
      );
      const worldNormal = worldNormalPoint.sub(worldPoint).normalize();
      if (!worldNormal.lengthSq() || !worldNormal.toArray().every(Number.isFinite)) {
        visual.group.visible = false;
        visual.ring.material.opacity = 0;
        visual.glow.material.opacity = 0;
        continue;
      }
      const localPoint = root.worldToLocal(worldPoint.clone());
      const localNormal = root
        .worldToLocal(worldPoint.clone().add(worldNormal))
        .sub(localPoint)
        .normalize();
      if (!localNormal.lengthSq() || !localNormal.toArray().every(Number.isFinite)) {
        visual.group.visible = false;
        visual.ring.material.opacity = 0;
        visual.glow.material.opacity = 0;
        continue;
      }

      visual.group.visible = ringOpacity > 0.0001;
      visual.group.position.copy(localPoint).addScaledVector(localNormal, surface.offset);
      visual.group.quaternion.setFromUnitVectors(AXIS_Z, localNormal);
      visual.group.scale.setScalar(scale);
      visual.ring.material.opacity = ringOpacity;
      visual.glow.material.opacity = glowOpacity;
      visual.group.userData.eventId = note.id;
      visual.group.userData.surfaceId = surface.id;
      visual.group.userData.velocity = velocity;
      visual.group.userData.ageSeconds = Math.max(0, time - note.onsetSeconds);
    }
  };

  return {
    pool,
    maxPoolSize: MAX_DRUM_IMPACT_EFFECTS,
    apply,
  };
}
