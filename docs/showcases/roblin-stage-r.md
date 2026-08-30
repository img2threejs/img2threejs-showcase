# Roblin — Stage R report

`--profile animated-character`, built on top of the playground export `roblin-img2threejs.zip`.
No geometry was rebuilt: the export had already measured it.

The reference image is `img2threejs-assets/rolbin.jpeg` (the brief said `roblin.png`; the file on
disk is `rolbin.jpeg`, and it is the same image the export shipped as `showcase/reference.jpg`).

---

## What was already done, and what was not

| | in the export | added here |
|---|---|---|
| surface | 113,338 triangles, quantised, embedded | untouched |
| materials | per-vertex colour, measured roughness 0.4431 / metalness 0.0353 | untouched |
| rig | 41 bones + skin weights + 16 clips in `src/rigData.ts` | used as-is |
| clip playback | `buildRiggedModel` with cross-fade | one-shots, return-to-base, mixer-clock cues |
| sockets | **none** | 10, derived from real bones |
| destruction groups | **none** | still none — see below |
| effects | none | particle field, ribbon trail, shockwave, floor pool, projectile |
| lights | neutral three-point look-dev rig | palette-driven rig |

The four generated files — `createMonster1Model.ts`, `meshCodec.ts`, `rigData.ts`,
`surfaceData.high.ts` — are **unmodified**. Everything new is in `src/roblin/`, `src/gate/` and
`main.ts`.

---

## RIG

`src/rigData.ts` is present, so the skeleton, the skin weights and all 16 clips are embedded and
were used directly. No skeleton was derived from the component tree.

**Bone names are the rig's own.** All 41 come out of `rigData.ts`: `Root`, `Hip`, `Pelvis`,
`L_Thigh`, `L_Calf`, `L_Foot`, `L_ToeBase`, the twist chains, `Waist`, `Spine01`, `Spine02`,
`NeckTwist01/02`, `Head`, and the mirrored arm chains. They carry **no** hypothesis caveat. The
one thing in this model that *is* a hypothesis is the single part label `body-shell`, at
confidence 0.20, which came from measured bounds — and it is the mesh, not the skeleton.

**One shell, one level of detail, no decimation.** The model is a single skinned mesh, not
separable parts. `skinIndex` and `skinWeight` are per-vertex arrays indexed in lockstep with
`position`, so a quadric collapse leaves weights addressing vertices that no longer exist and the
figure tears open the moment a clip runs — while still looking perfectly fine in a static
screenshot. That is why `assertBindingIntact()` in `src/roblin/animator.ts` throws rather than
warns, and why only `surfaceData.high` ships.

### The measured body frame — and a spec that was wrong

The spec's `coordinateFrame` says *"subject faces -z (toward the default camera)"*. That is wrong
for this export, and following it would have aimed every ranged attack sideways.

The measured world bounds are **0.45 wide × 1.90 tall × 2.11 deep**. A 2.11-unit "depth" on a
1.9-tall figure is a T-pose **arm span**, not a body depth. So `z` is the lateral axis and the body
faces `x`. `src/roblin/rigFrame.ts` measures it from named bones in the bind pose instead of
reading the prose:

```
left    (-0.029,  0.000, -1.000)   from L_Hand - R_Hand
up      (-0.069,  0.998,  0.002)   from Head - Hip, orthogonalised against left
forward ( 0.997,  0.069, -0.029)   = left × up   (right-handed: left +X, up +Y, forward +Z)

figureHeight 1.502   armSpan 1.678   forearm 0.305   clavicle spacing 0.085
```

The consequence: the export's own `MONSTER_1_CAMERA`, which sits on `+z`, looks straight at the
character's right ear. `frameCamera()` builds the view from the measured basis instead.

---

## ANIMATION

16 embedded clips, driven by a `THREE.AnimationMixer`.

* **Cross-fade on every transition.** Cutting between two looping clips pops on the first frame,
  because the two poses have no reason to agree there.
* **`update` takes a DELTA.** A mixer integrates what it is handed; give it elapsed seconds and it
  fast-forwards by the whole session every frame.
* **`play(name | index, fade)`** and **`once(clip, { fade, returnTo, timeScale, cues })`** are
  exposed. `once` returns to the clip it interrupted so an attack does not become the new idle.
* **Cues run off the action's own clock**, not `setTimeout`, so a projectile leaves the hand on the
  frame the arm extends even if the clip is time-scaled or the frame rate drops.

### Gate R1 — clip binding probe

> *A clip that exists is not a clip that runs.*

Each clip is seeked to **7** times across its duration (the gate refuses fewer than 5). At each
seek, **913** evenly-spaced vertices are pushed through `applyBoneTransform` — the same maths the
shader runs — and compared with the true bind pose from `Skeleton.pose()`. Two numbers come out:

* `maxSampledBindingDelta` — how far the skin moves away from bind. Zero means the clip does not
  drive this binding at all.
* `maxInterSampleDelta` — how far the skin moves *between* consecutive seeks. A clip can park the
  figure in a fixed non-bind pose and score well on the first number while being frozen; this is
  the number that catches it.

Run it yourself: `npm run gate:r1` (Node, no browser). It also runs in the page at boot and prints
to the console; the badge in the top right opens the full table.

```
  skeleton 41 bones, figure height 1.5023
  bind pose spans 2.110 laterally against 1.896 tall — a T-pose. Lowering the arms alone
  displaces a fingertip by about 1.05 units, so a bindDelta over 100% of figure height is
  expected and is not a defect.
  pass threshold: skin must leave bind by 0.5% of figure height

  clip                              dur    trk     bindΔ      %h     stepΔ  verdict
  preset:biped:run_upstairs        0.83 123/123    1.3911   92.60    0.7377  pass
  preset:biped:standing_relax     17.63 123/123    1.2371   82.35    0.2987  pass
  preset:biped:box_01              2.25 123/123    1.8795  125.11    0.8722  pass
  preset:biped:box_02              2.83 123/123    1.7766  118.26    1.4441  pass
  preset:biped:box_03              2.58 123/123    1.5813  105.26    0.9749  pass
  preset:biped:defeat_03           5.58 123/123    2.3158  154.15    2.1419  pass
  preset:biped:fire                1.54 123/123    1.3017   86.65    0.0477  pass
  preset:biped:front_kick_01       2.54 123/123    2.8320  188.51    2.1907  pass
  preset:biped:front_kick_02       1.42 123/123    1.7871  118.96    2.0812  pass
  preset:biped:dance_01           23.21 123/123    2.1681  144.32    2.0884  pass
  preset:biped:dance_02           12.83 123/123    1.7084  113.72    0.8493  pass
  preset:biped:dance_03           12.83 123/123    1.7245  114.79    1.6754  pass
  preset:biped:dance_04           10.83 123/123    1.3385   89.10    1.3168  pass
  preset:biped:dance_05            2.92 123/123    1.5455  102.87    0.9493  pass
  preset:biped:dance_06           10.92 123/123    1.3648   90.85    0.9370  pass
  preset:biped:idle               15.38 123/123    1.2388   82.46    0.2940  pass

  maxSampledBindingDelta = 2.832009 world units (188.5% of figure height)
  16 pass, 0 fail, 0 unevaluated
```

**`maxSampledBindingDelta = 2.832009`** world units, on `preset:biped:front_kick_01`.

Read that number with the bind-pose note beside it. This rig binds in a **T-pose**, so a clip that
merely lowers the arms already displaces a fingertip by half an arm span — deltas above 100% of
figure height are normal here and are not evidence of anything wrong. The discriminating column is
`stepΔ`. `preset:biped:fire` is the interesting one: 0.0477 is an order of magnitude below the
others, because at 7 seeks across 1.54s the sampled poses happen to be similar. It still passes
both tests, but it is the clip a denser probe should look at first.

Nothing is `unevaluated`: all 16 clips resolve 123/123 tracks to bones in this skeleton, and every
one was measurable. There is no default-pass branch in `src/gate/clipProbe.ts` — a clip that cannot
be measured is reported `unevaluated` with the input it lacked.

Machine-readable evidence: `.gate/gate-r1.json`.

---

## VFX

**The skill has no particle subsystem.** It has no trail renderer, no shockwave and no
impact-flash primitive either. Everything in `src/roblin/vfx/` is written by hand for this
showcase against plain three — no new dependency, no texture file, no fetch:

| file | what it is |
|---|---|
| `particles.ts` | fixed-capacity additive point-sprite field, CPU-integrated, soft disc drawn procedurally in the fragment shader |
| `ribbon.ts` | camera-facing ribbon trail re-extruded per frame against the view direction |
| `shockwave.ts` | expanding ground ring whose band narrows as it grows |
| `groundGlow.ts` | additive radial floor pool with a slow breath and a faint ripple |
| `projectile.ts` | pooled bolt: core, halo, travelling point light, ribbon wake, spark emission |
| `vfxSystem.ts` | the orchestrator, plus pooled impact flashes |
| `rng.ts` | seeded mulberry32 — two runs of the same cast are identical, so a screenshot review means something |

Post-processing is `UnrealBloomPass` from `three/examples`, which is inside the `three` package —
still no new dependency. Its threshold is set above the lit skin so the **figure** never blooms,
only the effects and the rim.

### Anchoring — and the sockets the export did not have

The brief asked for effects anchored to `actionProfile.sockets` and `destructionGroups` "already in
the spec". **Neither was there.** The exported `object-sculpt-spec.json` has no `actionProfile` at
all; its `interaction-pass` is `pending-authoring`, and its only anchors are the root group and one
pivot at the body-shell bounds centre.

What *is* real is 41 named bones. So ten sockets were derived from them, each as
*(real bone) + (offset as a multiple of a measured body length, along a measured body axis)*. **No
literal world coordinate appears anywhere in the effect code.** They are written back into the spec
as `actionProfile.sockets` with `provenance: "derived-from-rig-bones"`.

```
effect:cast-primary    R_Hand       (0.55, 0.12, 0) × forearm     muzzle of a ranged cast
effect:cast-secondary  L_Hand       (0.55, 0.12, 0) × forearm     second muzzle, for volleys
effect:core            Spine02      (0.07, 0, 0)    × height      chest emitter
effect:crown           Head         (0, 0.11, 0)    × height      rising motes, nova column
effect:shoulder-l/r    L/R_Clavicle (0, 0.03, 0.075)× height      shoulder wisps
grip:left/right        L/R_Hand     (0, 0, 0)       × forearm     held props
attachment:step-l/r    L/R_ToeBase  (0, 0, 0)       × forearm     ground contact
```

Offsets are given in the body frame as `(forward, up, outward)`, where `outward` is signed by the
bone's own side — which makes each left/right pair a **reflection** by construction rather than a
rotated copy.

Two notes on the units. Clavicle-to-clavicle measures **0.085** on this rig — the clavicle bones sit
almost on the spine, so "shoulder width" here is a bone spacing, not a body width; torso and head
sockets multiply figure height instead. And effects are **not parented** to sockets: the skinned
mesh carries the rig's normalisation scale of 2.113, so anything parented into the skeleton inherits
it and a 10-centimetre spark becomes a 21-centimetre one. Effects live at the scene root and read
socket world positions each frame.

**No destruction groups.** A rigged model here is one merged skinned shell with a single material
and a single draw call — there is nothing separable to declare. Adding groups would need the
pre-rig segmented parts or a re-cut of the shell, and neither is in this download.

### The palette — measured, then boosted

Two independent measurements, in `src/roblin/palette.ts`:

1. **The reference photo**, downsampled to 512×512. A green-dominant mask selected **3,878 of
   262,144** pixels — the exposed skin. Median `#697042` (hsl 69.1, 26%, 35%), p90 `#91995e`
   (hsl 68.1, 24%, 48%). Leather and hardware were point-sampled.
2. **The model's own vertex colours**, 62,956 of them, k-means k=6 with a deterministic seed:
   `#342816` 29.3%, `#463922` 24.9%, `#59572a` 18.0%, `#6d673b` 12.8%, `#181106` 10.5%,
   `#807e77` 4.4%. The 4.4% near-neutral cluster is the steel hardware; the 12.8% cluster sits at
   mean height fraction 0.73 — head and shoulders — and is lit skin.

They agree on the thing that matters: Roblin is **yellow-green**, hue 47–69°, not the pure green
the word "goblin" suggests.

An emissive cannot be measured off a diffuse photo — a photo contains no emitters. What *is*
measured is the hue; saturation and lightness are boosted, and every colour records the boost it
applied:

| | hex | from | change |
|---|---|---|---|
| `toxic` | `#d3f52c` | lit skin `#91995e` | hue 68.1 → 72.1, sat 24→95%, lum 48→56% |
| `venom` | `#7c9108` | median skin `#697042` | hue held, sat 26→90%, lum 35→30% |
| `spore` | `#e6f19d` | lit skin `#91995e` | hue held, sat 24→75%, lum 48→78% |
| `ember` | `#f68e23` | leather strap `#6e6354` | hue 34.6 → 30.6, sat 13→92%, lum 38→55% |
| `ember-deep` | `#b36d05` | leather shadow `#342816` | hue held, sat 41→95%, lum 15→36% |
| `bounce` | `#3f2e12` | crevice `#181106` | hue held, sat 60→55%, lum 6→16% |
| `steel` | `#cfe4ee` | steel `#807e77` | **authored hue** — see below |

`steel` is the one exception and the file says so in as many words: the hardware measures **4%
saturation**, which carries no usable hue at all, so boosting it would amplify whatever the
sampling noise left behind. It was shifted to a cool 200° on purpose, so metal sparks separate from
the toxic green.

### The light rig

The download shipped `createMonster1LookDevLights()` — a neutral three-point rig the generator
writes for every model, explicitly labelled "replace with a look-dev rig when you have one". This is
that rig, and every colour in it comes from the table above. Positions are multiples of the measured
figure height, so it rescales with the subject.

* **key** `#f8f6f3` — the leather hue lerped 86% to white, intensity 3.1. Nearly neutral on
  purpose: tint the key and the character's own albedo stops being readable.
* **rim** `#d3f52c` `toxic`, spot, behind and across from the key, intensity 96. This is the light
  doing the most work — a saturated back-rim in the character's own hue is what separates a dark
  green figure from a dark background, which no amount of front light achieves. It also pre-lights
  the figure in the colour the effects fire in, so a cast introduces no hue the scene has not shown.
* **fill** `#f68e23` `ember`, low and frontal, intensity 1.35 — the only thing stopping a green rim
  over a green figure from collapsing into one hue.
* **bounce** `#3f2e12`, floor level, standing in for the light a real floor returns.
* **hemisphere** toxic over bounce at 0.42.

A cast briefly pushes the rim toward its own colour, so the scene reacts to the effect instead of
the effect floating on a scene that never noticed.

---

## Defects found by measuring, not by looking

Every one of these looked fine, or nearly fine, in a still.

1. **The bolt flew off the left edge.** Screen-right resolves to `0.39·left − 0.91·forward` for a
   camera on the character's left, so `+forward` runs to screen *left*. Moving the camera to the
   character's right flips that term to `+0.91·forward`. The camera side is not a taste decision.
2. **The detonation was off-screen.** Sampling the flight frame by frame and projecting to
   normalised device coordinates put the impact at **ndc.x = 1.11**. Reach was cut until it landed
   near 0.5.
3. **The sprint flew the figure into the air.** The measured forward axis is
   `(0.997, 0.069, -0.029)` — it carries a small *upward* component, because the bind pose's
   hand-to-hand baseline is not perfectly level. Used raw as a travel direction it lifted the figure
   at ~0.12 units per second: invisible for a few seconds, **four units up** after a minute. Fixed by
   projecting the travel direction onto the ground.
4. **The left foot never made a footstep.** Four seconds of running produced *zero* left-foot
   events. Measuring the clip explained it: `preset:biped:run_upstairs` is a **stair climb**, and
   over one cycle the right toe drops to 0.073 while the left never comes below **0.335**. An
   absolute floor band can only ever see one of this character's two feet. The detector now tracks
   each toe's own arc and calls the bottom of it, and reports the clearance so a foot that plants
   high throws proportionally less dust.
5. **The sprint walked out of its own lighting.** Translating the figure took it off a light rig
   anchored at the origin and past the lit part of the stage disc. It now runs in place with the
   floor grid scrolling underneath, and its stair-climb rise is cancelled by a slowly-relaxing
   running minimum of the lowest toe — which preserves the airborne phase, where pinning the lowest
   foot to the floor every frame would have flattened it.
6. **Spore Nova whited out the frame.** Reading the live scene showed the rim spot at **195**
   against its resting 96: the cast surge multiplier was 1.35, which more than doubled a
   96-intensity spot. Capped at 0.4, and the eight simultaneous bolts got their own light budget.
7. **The bolt read as a laser.** 26 ribbon segments at that speed laid down four units of additive
   ribbon that bloom welded into a continuous white beam with the core invisible inside it.

The debug handle that made most of this measurable is left in place on `window.roblin`
(`pause()`, `resume()`, `steps()`, plus the scene, sockets, animator and gate report).

---

## Running it

```bash
npm install
npm run dev          # the showcase
npm run gate:r1      # Gate R1 in Node, writes .gate/gate-r1.json, non-zero exit on fail/unevaluated
npm run build        # typecheck + bundle
```

Controls: drag to orbit, `1`–`3` cast, space sprints, the clip dropdown plays any of the 16 clips,
the badge top-right opens the Gate R1 table.
