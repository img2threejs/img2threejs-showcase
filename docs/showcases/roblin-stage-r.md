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
8. **The bolt's glow was being done by the bloom pass, not by the effect.** The halo was a plain
   additive sphere; under bloom it read as a glow, and in the gallery build — which renders with no
   post-processing — the identical sphere was a hard-edged flat disc. The falloff now lives in the
   material: rendered back-side, `-dot(N, V)` is 1 at the centre of the sphere and 0 at its rim,
   which is the orb profile for one dot product. The bolt's travelling point light came down with
   it, from `7 + 70r` to `5 + 46r`; at the old strength it washed the figure to near-white as it
   passed, which bloom had been hiding.
9. **The feet were being sliced off by the floor they stood on.** Invisible at gallery framing and
   obvious the moment you zoom in. The stage disc and the shadow catcher are both TRANSPARENT
   materials, both were writing depth, and both sat at y ≈ 0 — the same plane the toes are grounded
   to. A transparent surface that writes depth occludes whatever is drawn after it at its own
   plane. Both now have `depthWrite: false` and sit a few millimetres below zero. `minDistance` came
   down from 1.0 to 0.25 in the same pass: at 1.0 the camera could not reach the feet at all.
10. **Every effect was aimed down the TORSO, not the limb.** This is what the whole
    `motion.ts` / `cueScan.ts` rework exists for — see the section below.

The debug handle that made most of this measurable is left in place on `window.roblin`
(`pause()`, `resume()`, `steps()`, plus the scene, camera, controls, sockets, animator, motion,
trails, cues and the gate report).

---

## Aiming at the limb instead of at the body

The first effect layer fired everything along the body's forward axis. That is wrong the moment a
clip does anything, and it showed.

`src/roblin/motion.ts` measures two things per socket, every frame, from bone world matrices:

* **axis** — where the limb POINTS: the direction from a named parent bone through the socket. For a
  hand that is the forearm running out through the palm; for a foot, the ankle out through the toe.
  Each socket names its own parent in `axisFrom`.
* **velocity** — where the limb is GOING: the socket's world displacement per second, smoothed,
  because a raw frame difference on a 60Hz clip is far too noisy to aim with.

`aim` blends them by speed, with a **cap** that depends on the caller. A trail wants the travel
direction — it is drawing the path. A projectile wants where the arm points, so casting caps the
velocity term at 0.3. That cap is not a preference: measured on a real jab, an uncapped blend threw
the bolt **21 degrees above horizontal**, because at the strike the hand is still rising even while
the arm is extended level.

Three defects fell out of building it, none visible in a still:

* **A clip change reads as a teleport.** Cutting between clips snaps the pose, and differencing
  across that snap measured **9.2 units per second** on a kick whose real peak is 7.5 — enough to
  fire a full-strength trail out of a cut. Any single-frame displacement over a third of the figure
  height is now dropped rather than smoothed.
* **The scanner and the runtime disagreed.** They used different velocity windows and different
  caps, so a cue that scanned as level launched skyward. They now share both.
* **The scanner's last samples were garbage.** The forward difference clamped its second seek to the
  clip end and still divided by the whole step, inflating speed to **28.9 units per second** at
  t = 0.987 on a clip whose real peak is 4.4.

### Cue times are scanned, not guessed

`src/roblin/cueScan.ts` seeks each clip — the same instrument as Gate R1, and for the same reason:
sampling a *playing* clip against wall time is at the mercy of cross-fades and frame pacing, and
measurements taken that way disagreed with themselves between runs.

It scores each sample as *pointing forward × moving fast × not aimed at the sky*, and reports the
best separated strikes per clip and per hand. The results retargeted every skill:

```
box_03  L at 0.226  fwd 0.896  up  0.007  3.67 u/s   -> Toxic Bolt
box_02  R at 0.277  fwd 0.960  up -0.212  3.03 u/s   -> Ember Volley, first of a one-two
box_02  L at 0.289  fwd 0.976  up -0.017  3.55 u/s   -> twelve thousandths later
box_02  R at 0.686  fwd 0.989  up  0.191  4.40 u/s   -> the cross, fastest hand in the clip
```

**And it found a real problem with the clip the skill was named after.** `preset:biped:fire`
produces **zero** candidates: across its whole duration the hand holds a fixed aim about 42 degrees
above horizontal and never moves — it is a static aiming POSE, not a firing motion. Gate R1 had
already reported it with by far the lowest inter-sample delta of the sixteen clips and it was
flagged as "the clip a denser probe should look at first"; this is what a denser probe found. Toxic
Bolt now runs on `box_03`, which contains an actual strike.

Verified at the call site rather than inferred: wrapping `vfx.bolt` and comparing the direction
passed in against `motion.aim` at that instant gives **0.0 degrees**, while the same direction sits
**9 to 16 degrees off the torso axis**. The bolts follow the hands.

### Trails

`src/roblin/vfx/limbTrails.ts` puts a wake on both hands and both feet. Nothing about it is keyed to
a clip name or a cue: it watches the measured speed, and when a limb exceeds a threshold it draws a
ribbon along the path the limb is actually travelling and sheds sparks backwards down it, carrying a
fraction of the limb's own velocity. A punch, a kick, a cast wind-up and a dance flourish all get
the right streak for free; a limb standing still gets nothing.

Thresholds are in figure heights per second, and they were set against measured peaks:

| clip | fastest hand | fastest foot | trail |
|---|---|---|---|
| idle | 0.10 | 0.01 | none |
| run_upstairs | 2.36 | 2.64 | 0.46 |
| box_02 | 6.09 | 4.42 | 1.00 |
| front_kick_01 | 6.76 | 7.48 | 0.99 |

### The particle system, rewritten

Three rounds of colour and parameter work did not fix how the effects read, because the problem was
not the parameters. **Everything in the showcase was drawn as the same shape.** `THREE.Points` gives
you one primitive — an axis-aligned square sprite — so a spark, a spore, a gob of bile and a puff of
dirt were all the same soft circle at different sizes and tints. No amount of tuning makes that look
like anything but bokeh.

`vfx/particles.ts` is now instanced quads, billboarded in the vertex shader. Three things a point
sprite cannot do, and all three are what separate an effect from confetti:

* **Stretch.** A spark leaving an impact at thirteen units per second is a LINE pointing where it is
  going. The quad is aligned to the screen-space projection of its own velocity and elongated along
  it, so speed becomes shape for free — a fast spark is a streak and the same particle rounds off as
  it slows, with no second system.
* **Rotation.** Point sprites cannot spin, so identical un-rotated puffs read as a repeated stamp.
* **Mass.** Smoke and dust need ALPHA blending to occlude what is behind them. Additive can only
  brighten, which is why every impact so far had light but no weight. There are now two meshes over
  one CPU simulation — an additive `light` layer and an alpha-blended `matter` layer — two draw
  calls for the whole showcase.

Sizes were converted rather than re-tuned by eye, so every previously-reviewed effect kept its
proportions. A point sprite was drawn at `aSize * uScale / depth` pixels with `uScale = 0.32 * H`;
its world width is that times the world-per-pixel at its depth, and both the depth and the viewport
height cancel out to `aSize * 0.64 * tan(fov/2)`.

Three defects surfaced while building it, none of them visible in the code:

1. **Alpha-blended smoke on a black backdrop is invisible by construction.** The first dust layer
   was darkened toward the shadow colour, which is exactly the wrong direction: real dust is visible
   because it CATCHES light. It had to be mixed up toward a warm grey — but only a sixth of the way,
   because at a third it came out pale pink and read as cotton wool.
2. **The stretch factor was three times too small.** At 0.09 a spark elongated to twice its width,
   which is not a line. 0.28 is.
3. **The smoke puffs read as popcorn rings.** `smoothstep(0, 0.85, falloff)` holds full opacity
   across the inner 40% of the quad and then drops, giving every puff a defined edge — and a cloud
   whose parts have edges is a pile of discs, not a volume. A plain `pow(falloff, 1.5)` with more
   puffs at lower opacity merges into one mass.

### Effects that belong to this character

The first two passes gave Roblin **wizard effects**: polished emissive spheres, then fire — expanding
flame shells, rising embers, a burn mark on the floor. Neither belongs to him. He is a barefoot
goblin skirmisher in rotting leather with crude steel strapped to his shins, and there is no fire
anywhere in his design. Worse, the `ember` hue that carried the whole fire pass was **measured off
his leather**: a dirt colour doing duty as a flame colour.

The palette did not change — it is still measured, and every derivation still holds. What changed is
what those colours are asked to represent:

| | was | is |
|---|---|---|
| primary | Toxic Bolt — an emissive orb | **Bile Lob** — a thrown glob that splatters and leaves a puddle |
| secondary | Ember Volley — a fireball combination | **Scrap Volley** — flung scavenged metal, sparks and dust |
| ambient | motes rising off the chest | a **swarm of gnats** orbiting him |
| footfall | a glowing toxic ring | dull displaced dust — he is barefoot |

Four new pieces carry it, all hand-written against plain three like the rest:

* **`vfx/glob.ts`** — the projectile is no longer a sphere. A seeded radial deformation makes each
  one a different lump; it is squashed along its own velocity the way a thrown droplet is, and it is
  **rim-shaded rather than flat-emissive**, so it reads as a translucent sac catching light at its
  edge instead of as a light bulb. The scrap variant is flat-shaded, much darker in the body, spins
  eight times faster, and glows only on the edge that is biting the air.
* **`vfx/pool.ts`** — bile leaves a caustic puddle that spreads fast, bubbles the whole time it is
  eating the floor, and sinks away. The bubbling is three layers of animated value noise thresholded
  against each other, so blisters appear and pop at different rates with no texture involved.
* **`vfx/swarm.ts`** — ninety gnats, each integrating a wander force toward a personal target that
  re-rolls every fifth of a second. That is what produces nervous, non-repeating darting; a sine
  orbit cannot. They thicken when he moves or casts.
* The scrap impact is **sparks and dust, nothing else**: a thin fast fan of steel that arcs and
  dies, and a slow dull puff of leather-coloured dirt that outlives it. That contrast is what makes
  a strike feel like it hit something.

Two GPU bugs fell out of writing the ground decals, and both were invisible in code review:

1. **The pool rendered as a hard SQUARE.** Its noise seed was offset by up to 40 units, and `sin()`
   of an argument that large loses enough precision on some drivers to return NaN. NaN fails every
   comparison, so `d > edge` was false everywhere, the `discard` never fired, and the shader painted
   its own bounding quad. The hash now wraps its input and the seed is small.
2. **Two `smoothstep` calls were inverted** — `smoothstep(edge, edge * 0.2, d)`, with edge0 greater
   than edge1. GLSL leaves that undefined and drivers disagree on the result. Written as
   `1.0 - smoothstep(lo, hi, d)`.

And one that was only visible on screen: the glob was **almost invisible in flight**. Additive
blending cannot darken, so a rim-lit body contributes nearly nothing across its middle and reads as
a faint wire ring. The belly term had to carry real weight — and then be measured back down again,
because at the first value the glob plus its halo plus its travelling light clipped to white.

### Ember Volley — superseded

The fire pass below is kept for the record; `Scrap Volley` replaced it for the reasons above. The
machinery it introduced — the wake gradient, the guttering, the directional flare — all survived and
is used by the effects that replaced it.


The volley started life as the toxic bolt recoloured orange, and looked it. It now has its own
vocabulary, built out of four additions that the rest of the effect layer inherited:

* **A gradient along the wake.** `Ribbon` carries a head and a tail colour and cools between them,
  with the hot centreline cooling more slowly than the edges — which is what a flame does. A single
  flat colour down the strip is what made an ember trail look like a plastic tube.
* **Guttering.** Particles carry a `flicker` amount and a per-particle seed, and pulse on two
  detuned sines. The bolt core, its halo and its light gutter on the same rule. A field of perfectly
  steady dots reads as confetti, not fire.
* **Embers that RISE.** The shed sparks take a negative gravity, so the wake sheds upward-drifting
  embers instead of falling gravel.
* **A scorch that outlives the blast** (`vfx/scorch.ts`) — a ragged, noise-broken mark that cools
  from the ember hue to nothing over about a second and a half, so a three-punch combination lands
  on ground its earlier hits have already marked.

The three punches **escalate** — 0.55, 0.68, then 1.05 — and the cross gets a visible quarter-clip
wind-up of embers gathering around the fist, swirled about the hand's own axis so it wraps the fist
rather than drifting near it.

Four things had to be corrected by looking at it:

1. **`EMBER_WHITE` was 78% white.** Every hot part of the volley — wake head, muzzle, impact shell —
   rendered as white confetti with an orange fringe. Fire's hottest visible part is still distinctly
   warm; it is now 62% of the way to the ember hue.
2. **The flare was a flat white wedge.** A linear across-term inside the quad gave it hard edges
   that additive blending clipped. Sharper taper, softer falloff, and it now fades out before the
   quad's own border — without that last part the round variant shows a rectangle around itself.
3. **The scorch out-glowed the explosion.** It spent most of its life at its hot colour and was
   laid down under airbursts too, where it is a metre-wide mark on ground the blast never touched —
   and with the camera angled down it landed mostly below the frame. It now cools much faster, at
   half the alpha, and only appears when something actually hit the floor.
4. **The hands trailed toxic green through a fire attack.** The limb trails are keyed to limb speed
   and know nothing about which skill is casting, so a cast can now tint them for its own duration.

An airburst also got its own signature — a ROUND flare alongside the directional one. The volley
detonates at chest height, so it never triggers the ground rings, and without it the impact was a
cloud of particles with no event at its centre.

The ribbon shader gained a hot centreline in the same pass. It had been varying alpha along the
length only, never across the width, so every pixel of the strip got the same colour and a wake
rendered as a flat painted band.

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
