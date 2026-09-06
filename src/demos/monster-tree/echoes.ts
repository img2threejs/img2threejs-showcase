import * as THREE from 'three';
import { LIFE_HUE } from './measured';
import type { MonsterTreeRig, RigEcho } from './rig';

/**
 * Phân Thân — the split-body: five copies of the figure, each standing at its own frame of the
 * same clip.
 *
 * WHAT MAKES THESE COPIES AND NOT INSTANCES. Every echo is a real `THREE.SkinnedMesh` over the
 * character's own 101,466-triangle geometry, driven by its own skeleton and its own
 * `AnimationMixer` (see `MonsterTreeRig.makeEcho`). Nothing about the silhouette is approximated:
 * an echo is the character, posed elsewhere in time. Only the bones are duplicated — five copies
 * of ~60 bones against one shared vertex buffer.
 *
 * WHY THEY ARE LAGGED. Locked to the original's playhead, five copies hold one pose in five
 * places and the eye reads a mirror artifact rather than five bodies. Each echo runs the clip a
 * fixed interval BEHIND, so on any frame the fan shows the whole strike sequence at once — the
 * nearest copy where the original was 80 ms ago, the furthest where it was 400 ms ago. That is an
 * afterimage, and it is only possible because each copy owns a skeleton.
 *
 * WHERE THE BEATS COME FROM. Each echo is committed to one measured arrest in `dance_05` — the
 * densest strike sequence in the clip library, 18 arrests in 2.333 s — chosen one per window by
 * `beats()` so they cannot cluster. An echo flares and lands its blow when ITS OWN playhead
 * crosses its arrest, which is its beat plus its own lag. Nothing here is hand-timed.
 */

/**
 * The one colour in the demo that is not this world's green.
 *
 * Still measured, not invented: it is the exact complement of `LIFE_HUE`, the 82.5 degrees taken
 * off the character's iris in the reference photograph — 82.5 + 180 = 262.5, a cold violet. Every
 * other effect in this showcase sits somewhere on the green-through-bark ramp, which is right for
 * a creature made of wood and wrong for the one thing on stage that is NOT the creature. The
 * copies get the complement and nothing else does, so the accent stays a single note.
 */
export const ECHO_RIM = new THREE.Color().setHSL((LIFE_HUE + 0.5) % 1, 0.62, 0.66);

/** The interior, in the character's own life colour: the copies are still made of its sap. */
const ECHO_CORE = new THREE.Color().setHSL(LIFE_HUE, 0.75, 0.22);

/**
 * The ghost surface: a rim-lit shell that dissolves from the ground up.
 *
 * Built by patching `MeshStandardMaterial` rather than writing a shader from scratch, for one
 * specific reason — the material has to skin. Skinning lives in three's own vertex chunks, and a
 * hand-written `ShaderMaterial` would have to reproduce `skinbase_vertex`, `skinnormal_vertex` and
 * `skinning_vertex` correctly or the copies would stand in the bind pose while the original moves.
 *
 * Additive, with `depthWrite` off: a copy is light, so it can never occlude the character it came
 * from, and two overlapping copies brighten rather than z-fight.
 */
function ghostMaterial(): { material: THREE.MeshStandardMaterial; uniforms: Record<string, THREE.IUniform> } {
  const uniforms: Record<string, THREE.IUniform> = {
    uGhost: { value: 0 },
    uRim: { value: ECHO_RIM.clone().convertSRGBToLinear() },
    uCore: { value: ECHO_CORE.clone().convertSRGBToLinear() },
    uDissolve: { value: 0 },
  };

  const material = new THREE.MeshStandardMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
  });
  material.name = 'monster-tree-echo';

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying float vEchoY;\nvoid main() {')
      // `transformed` is post-skinning and, with the identity bind matrix this rig uses, it is in
      // the mesh's own space — which puts the figure's feet at 0 and its crown near 1.9. That is
      // exactly the axis the dissolve sweeps along.
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vEchoY = transformed.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', [
        'varying float vEchoY;',
        'uniform float uGhost;',
        'uniform float uDissolve;',
        'uniform vec3 uRim;',
        'uniform vec3 uCore;',
        'void main() {',
      ].join('\n'))
      .replace('#include <dithering_fragment>', [
        '#include <dithering_fragment>',
        // Fresnel off the view vector: a copy is nearly invisible where it faces the camera and
        // bright where it turns away, which is what draws the silhouette instead of the volume.
        // Without it an additive shell is a flat glowing blob and the pose is unreadable.
        '  float fres = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition))), 1.7);',
        // The copies arrive from the ground up and leave the same way, so an echo appearing is an
        // event with a direction rather than an opacity fade.
        '  float rise = smoothstep(uDissolve - 0.55, uDissolve + 0.12, vEchoY);',
        '  vec3 ghost = mix(uCore, uRim, fres) * (0.34 + fres * 3.1);',
        '  gl_FragColor = vec4(ghost * uGhost * rise, uGhost * rise);',
      ].join('\n'));
  };
  // Two ghosts differ only in uniform values, so they must not share a compiled program keyed on
  // the default cache key — but they must also not each compile their own. One key for all.
  material.customProgramCacheKey = () => 'monster-tree-echo';
  return { material, uniforms };
}

interface Echo {
  rig: RigEcho;
  uniforms: Record<string, THREE.IUniform>;
  /** Seconds this copy runs behind the original. */
  lag: number;
  /** Clip time, on this copy's own playhead, that it strikes on. */
  beat: number;
  /** The hand the sweep found arresting on that beat. The beats alternate; assuming one hand
   * puts a copy's blow at the fist that was NOT throwing it. */
  bone: string;
  /** Where it stands, relative to the character, in figure widths. */
  offset: THREE.Vector2;
  /** 0..1 solidity, driven each frame. */
  ghost: number;
  /** Whether its blow has been thrown this run. */
  struck: boolean;
}

export interface EchoChorusOptions {
  /** The clip the copies run. */
  clip: string;
  /** One measured arrest per copy, in the copy's own frame — from `beats()`. */
  beats: Array<{ at: number; bone: string }>;
  /** Seconds between one copy's playhead and the next's. */
  lagStep?: number;
  /** Ring radius the copies stand on, in figure heights. */
  radius?: number;
}

/**
 * Five copies, built once and reused for every cast.
 *
 * Construction is deferred to the first cast rather than done at load: five skeletons, five
 * mixers and a shader compile is work the page should not do to show an idle figure. After that
 * first cast nothing is allocated again — a copy that is not on stage is `visible = false`, which
 * also keeps it out of the viewer's framing pass.
 */
export class EchoChorus {
  readonly group = new THREE.Group();
  private echoes: Echo[] = [];
  private options: EchoChorusOptions | null = null;
  private active = false;
  private readonly scale: number;

  /** Frames left in the prewarm. See `tick`. */
  private warming = 4;
  /**
   * Where the viewer is, in world space, refreshed every frame.
   *
   * The copies have to know this and there is no host API that hands it over: the gallery drives
   * the model through `userData.tick(dt, elapsed)` and nothing else. Placing them by the
   * CHARACTER's heading instead was measured and it does not work — the figure faces azimuth 75
   * degrees while the showcase camera sits at -4, so an arc opening away from the character opened
   * 79 degrees away from opening away from the viewer, and every copy piled onto the left edge of
   * the frame.
   *
   * `onBeforeRender` is called by three on every object it draws, with the camera. Hanging it on a
   * single always-drawn probe — one degenerate triangle, one draw call — gets the live camera in
   * any host, under any orbit, without the model knowing anything about the renderer.
   */
  private readonly view = new THREE.Vector3(0, 0, 1);

  constructor(
    private readonly rig: MonsterTreeRig,
    private readonly count: number,
    figureHeight: number,
    /** The clip the copies will run, so their actions can be bound before they are needed. */
    warmClip: string,
  ) {
    this.group.name = 'monster-tree-echoes';
    this.group.userData.isHighlight = true;
    this.scale = figureHeight;
    // Built at load, not on the first cast. The skeletons are cheap — sixty bones each against one
    // shared vertex buffer — but the ghost SHADER is not: it is a full MeshStandardMaterial with
    // skinning, and compiling it on the frame the copies appear is a stall of tens of milliseconds
    // landing exactly on the split. So one copy is left visible out of shot with `uGhost` at zero
    // for the first few frames, which compiles the program while the page is still settling and
    // draws nothing anywhere.
    this.build();

    const probe = new THREE.Mesh(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    probe.name = 'vfx:view-probe';
    probe.frustumCulled = false;
    probe.userData.isHighlight = true;
    probe.onBeforeRender = (_renderer, _scene, camera) => {
      camera.getWorldPosition(this.view);
    };
    this.group.add(probe);

    // ALL of them, not just one. The shader program is shared, so one copy would compile it — but
    // each copy also owns a skeleton, and a skeleton uploads its bone texture on the first frame
    // it is rendered. Warming a single copy left the other four to upload theirs on the frame of
    // the split, which measured as a 40 ms stall on the beat even with the program already built.
    for (const echo of this.echoes) {
      echo.rig.object.position.set(0, -60, 0);
      echo.rig.object.scale.setScalar(0.001);
      echo.rig.object.visible = true;
      echo.uniforms.uGhost.value = 0;
      // A culled object is never submitted and never compiles, which would defeat the point of
      // putting it out of shot.
      echo.rig.object.traverse((o) => { o.frustumCulled = false; });
    }
    // Bind the actions now too. `clipAction` resolves one PropertyBinding per track by NAME
    // against the mesh's skeleton, and dance_05 has three tracks on each of sixty bones: doing
    // that for five copies on the frame the split happens measured as a 38 ms stall right on the
    // beat. Seeking each copy once at load pays it while the page is still settling.
    for (const echo of this.echoes) echo.rig.seek(warmClip, 0);
  }

  /**
   * Called every frame, cast or no cast, to close out the prewarm.
   *
   * Separate from `update`, which only runs while the copies are on stage — the whole point of the
   * prewarm is that it happens before any of them are.
   */
  tick(): void {
    if (this.warming <= 0) return;
    this.warming -= 1;
    if (this.warming > 0) return;
    for (const echo of this.echoes) echo.rig.object.visible = false;
  }

  private build(): void {
    if (this.echoes.length) return;
    for (let i = 0; i < this.count; i += 1) {
      const { material, uniforms } = ghostMaterial();
      const echo = this.rig.makeEcho(material);
      echo.object.visible = false;
      echo.object.traverse((o) => { o.userData.isHighlight = true; });
      this.group.add(echo.object);
      this.echoes.push({ rig: echo, uniforms, lag: 0, beat: 0, bone: 'L_Hand', offset: new THREE.Vector2(), ghost: 0, struck: false });
    }
  }

  /**
   * Bring the copies out for one cast.
   *
   * `facing` is the character's own measured heading, so the fan opens around the direction it is
   * actually pointing however the turntable has spun the figure.
   */
  cast(options: EchoChorusOptions, origin: THREE.Vector3, facing: THREE.Vector3): void {
    this.build();
    this.warming = 0;
    this.options = options;
    this.active = true;
    const lagStep = options.lagStep ?? 0.08;
    const radius = (options.radius ?? 0.62) * this.scale;
    // Away from the VIEWER, not away from the character. `facing` still has a job — it breaks the
    // tie when the viewer is directly overhead and the azimuth is undefined — but the arc opens
    // along the line of sight, which is the only direction that decides what is in shot.
    const away = new THREE.Vector3(origin.x - this.view.x, 0, origin.z - this.view.z);
    if (away.lengthSq() < 1e-8) away.set(facing.x, 0, facing.z);
    const heading = Math.atan2(away.x, away.z);

    this.echoes.forEach((echo, i) => {
      echo.lag = lagStep * (i + 1);
      const beat = options.beats[i] ?? options.beats[options.beats.length - 1];
      echo.beat = beat?.at ?? 0;
      echo.bone = beat?.bone ?? 'L_Hand';
      echo.struck = false;
      echo.ghost = 0;
      // AN EVEN RING, not a fan behind. The first version put the copies in an arc opening away
      // from the character's own heading, and measuring where that lands is what killed it: the
      // figure faces azimuth 75 degrees while the showcase camera sits at -4, so "behind the
      // character" is 79 degrees off "behind from here" — every copy stacked up on the left edge
      // of a 628-pixel canvas, on top of the figure and half of them out of shot.
      //
      // A ring cannot be got wrong that way, because it does not depend on which way anything is
      // pointing. Projected on the demo's own canvas a ring at this radius spans px 61 to 562 of
      // 628, so the copies use the full width from any camera, and they still do after the viewer
      // spins the turntable. `heading` only sets where the relay STARTS, so the sequence sweeps
      // out from the direction the character is looking.
      // Spaced evenly ACROSS THE FRAME, not evenly around the ring.
      //
      // Even angles do not give even spacing, and the difference is large enough to ruin the
      // move. The camera sits 7.7 degrees above the floor, so the ring projects as a nearly
      // edge-on ellipse and a copy's horizontal place in frame goes as the SINE of its angle. Five
      // copies spread evenly over an arc landed at sine 0.77, 0.91, 0, -0.91, -0.77 — two pairs
      // almost exactly on top of each other, which is what the first render showed: a violet smear
      // on the left, one copy on the right, and the middle of the frame empty.
      //
      // Inverting it — pick the position in frame, solve for the angle — spreads them at -1, -0.5,
      // 0, +0.5, +1 of the radius across the screen. `asin` also keeps every copy on the half of
      // the ring away from the viewer, so the two at the extremes stand exactly beside the
      // character and nothing is ever in front of it.
      const across = this.count > 1 ? -1 + (2 * i) / (this.count - 1) : 0;
      const angle = heading + Math.asin(Math.max(-1, Math.min(1, across)));
      echo.offset.set(Math.sin(angle), Math.cos(angle));
      echo.rig.object.position.set(origin.x + echo.offset.x * radius, origin.y, origin.z + echo.offset.y * radius);
      // Every copy faces the way the original does. Turning them to look inward would make them a
      // circle of onlookers; they are the same body, doing the same thing, a moment ago.
      echo.rig.object.rotation.y = 0;
      echo.rig.object.scale.setScalar(0.96);
      echo.rig.object.visible = true;
      echo.rig.seek(options.clip, 0);
    });
  }

  /** Send the copies away. Idempotent. */
  dismiss(): void {
    this.active = false;
    for (const echo of this.echoes) {
      echo.ghost = 0;
      echo.rig.object.visible = false;
    }
  }

  get live(): boolean {
    return this.active;
  }

  /**
   * Advance the copies against the ORIGINAL's playhead, and report the ones that struck this frame.
   *
   * Returns world positions, because a copy's blow has to land where that copy's fist is, not
   * where the character's is — the two are up to 0.4 s and a metre apart, and firing the impact at
   * the original is what would make the copies decorative.
   */
  update(time: number, duration: number): THREE.Vector3[] {
    if (!this.active || !this.options) return [];
    const hits: THREE.Vector3[] = [];
    const clip = this.options.clip;

    for (const echo of this.echoes) {
      const local = time - echo.lag;
      if (local <= 0) {
        echo.ghost = 0;
        echo.uniforms.uGhost.value = 0;
        continue;
      }
      echo.rig.seek(clip, local);

      // Solidity: rises into the beat, SPIKES on it, then settles — it does not go away.
      //
      // The first version decayed each copy back to nothing after its own beat, and the arithmetic
      // of that is worth writing down: with beats 0.4s apart and a 0.75s decay, at most two copies
      // were ever lit at the same time. Five copies that are never once on stage together are not
      // five copies. So a copy that has struck settles to half and STAYS, which means the fan
      // fills in as the relay runs and all five are standing by the last beat — and each one still
      // flares hardest on its own frame, so the sequence is still readable inside the crowd.
      const toBeat = local - echo.beat;
      const rise = Math.min(1, Math.max(0, (local - Math.max(0, echo.beat - 0.42)) / 0.42));
      const settle = toBeat <= 0 ? 1 : 0.30 + 0.70 * Math.max(0, 1 - toBeat / 0.9);
      const spike = Math.exp(-((toBeat / 0.10) ** 2)) * 1.3;
      const tail = Math.max(0, 1 - Math.max(0, local - (duration - 0.45)) / 0.45);
      echo.ghost = Math.min(2.2, (rise * settle * 0.72 + spike) * tail);
      echo.uniforms.uGhost.value = echo.ghost;
      // The dissolve line runs up the body as it arrives and back down as it goes, so a copy is
      // never simply switched on.
      echo.uniforms.uDissolve.value = (1 - Math.min(1, rise)) * 2.1 - 0.2;

      if (!echo.struck && local >= echo.beat) {
        echo.struck = true;
        // The striking hand at THIS copy's beat — read off the copy's own skeleton, which is
        // posed at its own frame, so the blow lands at the fist that threw it.
        const bone = echo.rig.mesh.skeleton.getBoneByName(echo.bone) ?? echo.rig.mesh.skeleton.bones[0];
        echo.rig.object.updateMatrixWorld(true);
        hits.push(new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld));
      }
    }
    return hits;
  }

  dispose(): void {
    for (const echo of this.echoes) {
      echo.rig.dispose();
      (echo.rig.mesh.material as THREE.Material).dispose();
    }
    this.echoes = [];
  }
}
