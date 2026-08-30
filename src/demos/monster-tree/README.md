# Monster Tree — img2threejs `animated-character`, Stage R

A treant rebuilt from `public/references/monster-tree.jpg`, built **on top of** the playground's
own export rather than re-deriving it. The geometry was already measured; nothing here re-sculpts
it. What this stage adds is the rig work, the costume separation, the effects and the lighting —
and a measurement harness for all of it.

Open it with `npm run build && npm run preview`, then `/showcase.html`.
Run the numbers with `node scripts/measure-monster-tree-rig.mjs` (add `--json` for the machine-readable form).

---

## What the export already had

| | |
|---|---|
| surface | 64,307 vertices · 115,350 triangles, quantised and embedded as code |
| rig | 41 bones, root `Root`, skin binding for every vertex |
| clips | 16, retargeted, keyframes unquantised |
| parts | **1** — rigging merges the mesh, so the export is one skinned shell |
| levels of detail | 1 |

`glb-parts.json` labels that single part a `body-shell` "hypothesis" at confidence 0.20. That
warning is about the **part label**. It does **not** apply to the bone names: `L_Forearm`,
`R_ToeBase`, `Spine02` and the other 38 are the rig's own names out of the GLB, and everything in
this demo anchors to them directly.

### One level of detail, on purpose

`skinIndex`/`skinWeight` address vertices by their position in the buffer. A decimation pass
collapses vertices, so the binding would end up pointing at vertices that no longer exist and the
figure would tear open the moment a clip ran. For a skinned shell a second LOD is not a quality
trade — it is a correctness bug. There is one level and there should be.

---

## Three defects in the export's rig path

Each was **measured**, not assumed. A fourth suspect was measured and cleared, which is why the
measuring came first.

### 1. The authored bind pose was being thrown away

`buildRiggedModel` calls `mesh.bind(skeleton)` with no bind matrix. three responds by running
`skeleton.calculateInverses()`, which overwrites the GLB's authored `inverseBind` matrices that
`buildSkeleton` had just passed in, re-deriving them from whatever rest pose the bones are in.

Those are not the same matrices here. Measured across all 41 bones, the authored inverse bind and
the inverse of the rest-pose bone world differ by a **uniform 4.43e-3 rig units** — 8.8 mm after the
normalise scale — on every single bone. So the export skins the figure against a bind pose the GLB
does not declare. `rig.ts` passes an explicit identity bind matrix, which keeps the authored
inverses.

### 2. The documented update call froze the animation

The export's README says:

```ts
updateMonster1(model, clock.getElapsedTime());
```

which reaches `group.userData.update = (_elapsed, delta) => mixer.update(delta ?? 0)` — a second
argument nothing passes. Measured: after 60 calls covering one second, `mixer.time` is **0.0000**.
The clip never advances. This build differences the elapsed value it is given, and the same 60
calls leave `mixer.time` at **0.9833**.

### 3. The costume was skinned, so the leather stretched

Covered in full below.

### Cleared: the double-scale that wasn't

The export sets `mesh.scale` **after** `mesh.bind()`, which looks like a textbook double-transform:
the bind matrix is captured at scale 1 while the bone world matrices carry the 1.9899× normalise
scale. It is not one. In three's default `AttachedBindMode` the renderer recomputes
`bindMatrixInverse = meshWorld⁻¹` every frame, and that fresh inverse cancels the stale bind
matrix. Gate **R0** measures the export's own builder at a median skin scale of **1.98986** —
applied 1.0×, rendered height 1.9, exactly right.

This build still puts the normalise scale on a group above the bones instead. Not because the
export is broken, but because relying on that cancellation hides the scale from the expression that
actually drives the skin:

```
world = meshWorld · bindMatrixInverse · (boneWorld · boneInverse) · bindMatrix · v
      = boneWorld · boneInverse · bindMatrix · v          (meshWorld cancels)
```

The skin follows the **skeleton's** place in the scene graph, not the mesh's.

---

## The costume: separate meshes that cannot stretch

The export ships the leather bracers and gauntlets baked into the same skinned shell as the bark.
Smooth-skinning a stiff leather sleeve across the elbow and the wrist shears it. Measured, with the
costume left fused, as the largest change in a vertex pair's distance across all 16 clips:

| piece | shear when fused | shear when split |
|---|---|---|
| `bracer-l` | **21.3%** of the pair's rest length | **0** |
| `bracer-r` | **29.2%** | **0** |
| `glove-l` | 5.2% | **0** |
| `glove-r` | 0.0% | **0** |

Exactly zero, by construction — one rotation, one translation, one constant scale, applied once to
every vertex, so no two vertices in a piece **can** change their distance.

### Which triangles are leather

There are no material IDs in the export to appeal to, so the band was measured. Taking the median
`R − G` of each vertex colour along each arm axis independently, the leather fraction rises from
~5% on the upper arm to **23–40%** over arm-axis `|z| ∈ [0.258, 0.425]`, then falls back past the
glove cuff — and it does so at the *same* arm coordinate on the left and the right. That agreement
is what makes it a feature rather than noise. The wrist cut at 0.335 is where the hand bone takes
over as dominant bone. 13,884 triangles move; 101,466 stay on the shell.

This is a hypothesis confirmed by symmetry and by the render. It is not a labelled asset.

### How a piece is driven

Not by its nearest bone, and not by a blend of its bones. By a **per-frame least-squares rigid
fit** to the motion its own vertices would have had if they had stayed skinned. Measured as the
largest distance between a piece vertex and that skinned position, over all 16 clips:

| piece | nearest bone | blend of its 4 bones | least-squares fit |
|---|---|---|---|
| `bracer-l` | 0.0881 | 0.2424 | **0.0532** |
| `bracer-r` | 0.0497 | 0.1457 | **0.0290** |
| `glove-l` | 0.0118 | 0.0122 | **0.0109** |
| `glove-r` | 0.0000 | 0.0000 | **0.0000** |

Binding to the nearest bone ignores that each bracer's proximal ring is ~26% weighted to the upper
arm, so its seam stands open during a punch. Blending the four bones' delta *transforms* is worse
still — averaging translations of deltas taken about different centres is not the average of the
motion, and the error grows with the distance between the bones. The fit asks directly for the
rigid transform closest to the real deformation, which is by definition the best a rigid piece can
do, and it spreads the residual over the piece instead of piling it onto one edge.

Rotation comes from the polar decomposition of the covariance matrix, iterated as
`R ← (R + R⁻ᵀ)/2` — no SVD, which three does not carry. Scale is **fixed** at the normalise scale
rather than solved: the best-fit scale swings about 8% over a punch, because linear blend skinning
really does compress the inside of a bent elbow, and a bracer that shrinks and swells is the exact
deformation this split exists to remove. Fixing it costs 0.0005 in tracking and buys rigidity by
construction.

Fitting on 49 samples is as good as fitting on all 1,734 vertices (0.05321 vs 0.05396), so it is
49.

### The seam

| piece | worst gap, all clips | of figure height |
|---|---|---|
| `bracer-l` | 0.0534 | 2.8% |
| `bracer-r` | 0.0319 | 1.7% |
| `glove-l` | 0.0006 | 0.03% |
| `glove-r` | 0.0000 | 0% |

The gloves are near-perfect because their cut ring is weighted purely to the hand bone, which the
glove also rides. The bracers cannot do better while staying rigid: their ring is genuinely
blended into the elbow. Moving the cut distally to escape that blend would delete the bracer
entirely, so the residual is accepted and reported rather than hidden.

---

## Clips play in place

Only `Hip` carries translation, and its track is in `Root`'s local frame, not world space. Root's
rest quaternion (-0.5, 0.5, 0.5, 0.5) maps a local `(a, b, c)` to world `(-b, c, -a)`, so the hip's
local **z is world up** and local x/y are the two horizontal axes. Holding x and y at their
first-frame values stops the drift — `front_kick_01` moves the hip 0.431 and `dance_01` 0.864,
enough to walk the figure out of a fixed frame mid-move — while leaving the crouch in a kick and
the 0.412 drop in `defeat_03` intact. Zeroing all three instead would pin the pelvis at a fixed
height and make every one of those moves slide rather than settle. Pass `inPlace: false` for the
clips exactly as retargeted.

---

## Skills, named by measurement

The 16 clips ship under Tripo retarget-library names like `box_01` and `fire`, and nobody has
confirmed what they look like. So each skill's name, lead limb and impact frame come from
`tools/measure-rig.mjs`, which walks every clip at 40 poses and records how far each tracked bone
travels from rest and when it peaks. Effects fire on that measured peak, not on a guessed beat.

| skill | clip | measured |
|---|---|---|
| Bark Strike | `box_01` | L_Hand leads at 1.321, peaks 0.54 s |
| Splinter Combo | `box_02` | both hands clear 1.0; R_Hand peaks 1.87 s |
| Heartwood Uppercut | `box_03` | L_Hand 1.099 at 0.62 s, Spine02 0.626 behind it |
| Rootfall Kick | `front_kick_01` | R_ToeBase 2.323 at 1.02 s — the largest excursion in the set |
| Grovebreaker Stomp | `front_kick_02` | R_ToeBase 1.820 at 0.68 s |
| Wildfire Sap | `fire` | L_Hand 0.771 while Head moves 0.035 — a planted cast, not a swing |
| Deadfall | `defeat_03` | L_Hand 1.838, Head 1.408 — the figure goes down |
| Idle / Guard | `idle`, `standing_relax` | long cycles, feet planted |

`fire` is inference: a torso that barely moves while an arm extends is what a planted cast looks
like and what a running attack does not. It is still inference — the pose has not been reviewed
visually.

---

## The wood

The export ships the figure as 115,350 triangles of smooth shading with the bark painted on in
vertex colour. `object-sculpt-spec.json` records why: *"source had a normal map; NOT carried
(vertex normals only)"*. So the silhouette is a tree and every surface between the silhouettes is
soft. Two things had to be rebuilt, and both were found by measurement rather than by taste.

### 1. The grain runs along the limb, taken from the rig

Real wood grain runs the length of whatever grew it. A single vertical noise field gives a figure
carved out of one plank — horizontal banding across the forearms, grain running sideways over the
shoulders. So grain direction is a per-vertex attribute read off the skeleton: each vertex takes
the bind-space axis of the bone it is most strongly weighted to, measured bone-to-child.

| bone | measured axis | reads as |
|---|---|---|
| `L_Forearm` | `[ 0.00, 0.00, -1.00]` | along the arm |
| `R_Forearm` | `[ 0.30, 0.00, 0.95]` | along the arm |
| `L_Thigh` | `[-0.09, -0.99, -0.11]` | down the leg |
| `Spine02` | `[-0.02, 0.96, -0.29]` | up the torso |

40 of 41 bones resolve a real axis; 13 leaves inherit from their parent, and `Hip` is genuinely
degenerate (`Pelvis` sits on top of it) so it falls back to +Y — the right answer for a hip anyway.
Twist helpers are skipped when picking a bone's child: they sit at the *same position* as their
parent, so aiming at one gives a zero-length axis for exactly the bones whose direction matters
most.

The value written is the **weighted blend of all four influences**, sign-aligned into the dominant
bone's hemisphere, not the dominant bone's axis alone. Grain is an axis rather than an arrow — a
limb pointing −Z and its neighbour pointing +Z describe the same fibre — so unflipped averaging
cancels to zero. Taking the dominant axis outright makes the field jump wherever influence hands
over between bones, and the relief built on it then seams along every one of those boundaries: the
figure came back with a stippled chain drawn around each muscle group. That was diagnosed by
ablation, not by inspection — switching the bump term off removed the chains while the veins and
cavity stayed, which pointed at the field the bump reads.

### 2. The albedo had no blue in it

The figure rendered lime, and every plausible lighting fix failed. Measured on the lit chest at
rgb(72, 78, **7**), then re-measured with the sap, the environment, every point light, the
atmospherics, the rim and the hemisphere switched off one at a time: **the blue channel moved by at
most 7/255**. Nothing in the lighting was responsible. The cavity and moss tints were the next
suspects, and were cleared the same way.

The albedo itself had no blue to light:

| | median bark albedo | blue as a fraction of red |
|---|---|---|
| the generated mesh | `#3d2d0e` | **0.094** |
| the reference photograph | `#4b3e2b` | **0.343** |

**97% of the 56,588 bark vertices carry a blue channel under 55% of their red.** Tripo's bake took
the blue out of the wood. The fix is a per-channel gain applied in linear space — the ratio of the
two medians, `[1.508, 1.836, 5.501]` — which is a white balance to the reference, not a stylistic
grade. It is the step that makes the wood grey-brown wood instead of olive.

Cavity shading **darkens** rather than tints for the same reason: mixing toward `#231f12`, whose
blue is a tenth of its red, crushed the channel again wherever the grain was deep.

### What relief costs

The bump is derivative-based (three's own `perturbNormalArb` construction), which needs neither UVs
nor tangents — this mesh has neither. Two things were learned the expensive way:

- **One height field cannot drive both colour and normals.** Albedo is sampled once per pixel with
  no filtering, so a sharp field breaks into hard blotches; a normal can carry far more detail
  because lighting integrates it. They are now two fields: coarse for colour, coarse+fibre for the
  normal.
- **An analytic object-space gradient was tried and reverted.** Four height evaluations per pixel
  instead of one, on the theory that quantised 2×2 screen derivatives were stippling the surface.
  They were not — the grain field was — and it cost half the frame rate to find out.

Anisotropy is 4:1, not 10:1. Ten to one is corduroy: the fibres align so exactly that any real bump
turns the chest into zebra stripes.

## VFX — all hand-written

The img2threejs skill has **no particle subsystem, no trail subsystem and no shader library**.
Every effect here was written for this demo, in plain three, with **no dependency added**. Textures
are painted into a `<canvas>` at build time; nothing is fetched.

| effect | what it is | why |
|---|---|---|
| **sap veins** | `MeshStandardMaterial` patched through `onBeforeCompile`, fbm value noise thresholded to thin ridges, added to `totalEmissiveRadiance` | the character glows from *inside the wood*. The one effect that changes what the figure **is** rather than what is around it |
| **spirit wisps** | 6 sprites on Lissajous orbits, each with a short additive tail, one shared `PointLight` | they hold station around the figure — the difference between atmosphere and *presence* |
| **rune circles** | two counter-rotating glyph rings, painted once into a canvas | a ring says "impact"; a ring with turning script in it says the impact was **called for** |
| **root eruption** | `TubeGeometry` along bent `CatmullRomCurve3`, staggered rise-and-sink | the only real geometry in the set — a shockwave you can see the far side of is what makes a stomp move earth |
| **canopy shafts** | 5 soft additive slabs, drifting on separate phases | puts the figure under a broken forest roof instead of on a backdrop |
| **ground mist** | one plane, alpha from two scrolling noise fields | one field alone reads as a sliding texture; two curl |
| **spore field** | 340 `THREE.Points`, seeded PRNG, one draw call | ambient life |
| **eye glow** | two additive sprites + a short-range `PointLight` | picks out the brow ridge rather than lighting the whole head |
| **palm trails** | ribbon strip, per-vertex alpha via `ShaderMaterial` | the swing arc |
| **impact bursts** | `THREE.Points` with gravity | the hit |

### Three things that were wrong first, and what they cost

- **The veins flooded the figure.** At a wide ridge and `pow(ridge, 7.0)` the seams merged and the
  whole treant went flat neon, losing the bark relief that is its entire silhouette up close. The
  ridge is now four times narrower at `pow(…, 14.0)` and a fifth the intensity.
- **The wisp tails drew as straight scratches.** A tail tapers from full width at the head to
  nothing at the tail, so length matters as much as width: at 14 segments a fast orbit outruns the
  taper and the tail rasterises as a bright line across the frame. 8 segments, and hair-thin.
- **The roots read as lime plastic straws.** The stage key is 7.0 and both the fill and the rim are
  green, so a root with any real emissive comes back matte lime. They also rendered *before* they
  rose — a tube at zero height is a bright plate lying on the floor — so each one is now hidden
  until its own delay elapses.

### Three moves the rig does not contain

The 16 shipped clips are a generic biped library — boxing, kicks, dances, a death. None of them is
a *tree* doing anything. Rather than settle for renaming them, three moves drive the skeleton
procedurally on top of a clip:

| move | clip under it | what is added |
|---|---|---|
| **Deep Root Surge** | `box_02` | the arm lengthens on the way down so the fist reaches the floor; the fracture then runs away underground and a grove tears up where it arrives |
| **Impaling Bough** | `box_01` | the arm roughly **doubles** through the thrust and a branch lance is driven out of the fist, then withdrawn |
| **Grove Awakening** | `fire` | both arms lift and lengthen while a ring of trees comes up around the figure |

**The stretch is measured, not guessed.** Every arm bone's child sits on its parent's local **+Y at
100% of the segment length** (`L_Forearm → L_Hand` is `[0.0000, 0.1245, -0.0000]`), so `scale.y`
*is* length along the limb for this skeleton. Shoulder-to-wrist distance measured at **2.047×** at
the peak of Impaling Bough, back to **1.000** the moment another move takes over.

Three things this got wrong first, each caught by measurement rather than by eye:

- **Order.** Every clip carries scale tracks, so the mixer rewrites `bone.scale` on each update. A
  stretch decided after `update` ran was applied a frame late and the peak of the curve was never
  the value used — the arm reached 1.27× instead of 2×. `applyStretch()` is now called explicitly
  after the skill drives it.
- **Applied twice.** Leaving the call inside `update` *as well* squared the factor: reach hit
  **4.88×** and the arm read as a tentacle. It now runs exactly once per frame, and the doc comment
  says so, because nothing about the code makes it obvious.
- **Direction.** The surge first fired along the arm's heading — but a *downward* punch has the
  forearm pointing at the floor, so the horizontal component is near zero and essentially
  arbitrary. It now uses the character's facing, derived from the **midpoint of the two measured
  eye sockets minus the head bone**, which stays correct under the viewer's turntable where a
  hard-coded +X would not.

The child bone is counter-scaled, so the fist keeps its own size while the limb behind it grows;
without that, scale propagates down the hierarchy and the hand stretches into a smear.

Roots, grove and lance all come from **one** branch recursion at three scales and three forking
depths — a root, a young tree and a lance are the same structure — and all three run the figure's
own bark shader, so grown wood is visibly the same material as the character.

### Grown wood: measured proportions, and the character's own twigs

Everything the demo grows — roots, groves, the lance — went through three wrong versions before it
read as wood, and each failure had a single measurable cause.

**1. Cylinders.** Tapered tubes at the trunk's proportions: right size, wrong shape. Smooth and
round, nothing like the figure.

**2. The shoulder spurs.** Extracting real geometry off the body was the right instinct and the
wrong donor. The shoulder cluster is a branch, but lifting it drags a lump of shoulder mass along,
and 2,526 triangles of body wall instanced on a trunk reads as a slab.

**3. Too thick.** The measurement that settled it: slice the crown into horizontal slabs and size
each twig's cross-section. A real twig on this character runs **0.0140 radius at its base down to
0.0038 at the tip** over about 0.13 of run — **radius/length ≈ 0.042**, tapering to roughly a
quarter. The generated branches were using 0.060 for roots and **0.130** for grove trunks, two to
three times too stout. No amount of forking or gnarl rescues that, because a shape that thick is a
trunk whatever is done to its silhouette.

So: thickness derives from length at the measured ratio, the taper is the measured 0.27, the stock
is now the **crown twigs above y 0.90** — the thin dry wood over the skull, which is what the
character's branches actually are — and the wander is biased sideways so a branch bends across its
own line instead of standing up straight.

One more correction on top of that, because the first fix overshot: at two forks per node through a
depth-4 recursion the growth is exponential, and the grove came up as a thicket that buried the
character and halved the frame rate to 30. A second twig now appears at one node in three, grove
trees recurse to depth 3, and the ring frames the figure instead of swallowing it. 84 fps.

### The swing trail

A flat band of one colour with hard edges is a strip of tape moving through the air, which is
precisely what "just a light streak" means. Three things changed:

- **A hot core inside a soft body.** The fragment shader fades across the ribbon's width from an
  attribute running −1 to +1 between its edges, with a thin bright centre on top of it.
- **It cools along its length.** Near-white at the fist, the sap green behind it, ash at the tail.
  One colour end to end was the other half of the problem.
- **The edge is broken up.** Noise eats into the body and tears holes in the tail, where a real
  trail is already coming apart. A mathematically perfect ribbon is the strongest single tell that
  a trail was drawn rather than shed.

And the swing now **sheds embers** while it is fast — a few sparks every 45 ms, thrown off the
grip socket. A trail alone is a clean surface moving through clean air with nothing coming off it,
which is most of why one reads as drawn.

### Damage that outlives the blow

Every impact leaves cracks and a toxin stain that run for **ten seconds** — roughly six times the
life of anything else in the set. That difference is the point: the burst and the shockwave are the
moment of contact and are gone inside a second, so without a long tail each attack resets the stage
to clean ground and nothing the character does appears to cost anything. With it, by the third blow
of a combo the floor is fractured and contaminated, and it is still that way when the next move
starts.

**Cracks** run on three separate timescales, and collapsing them onto one curve is what makes this
kind of effect read as a light being dimmed rather than as damage:

| | over | because |
|---|---|---|
| open | 0.35 s | a fracture propagates faster than the eye follows |
| cool | 3.2 s | the sap in the fissure goes from hot to dark |
| fade | last 28% | the crack is still *there* long after it stops glowing |

The pattern is drawn once into a canvas — seven trunks radiating from the centre, each forking
recursively down to hairlines, jinking as it goes the way a real crack finds the weakest path. A
crack has no thickness worth giving geometry to.

**Toxin** spreads from the impact with an edge displaced by a scrolling noise field, so it creeps
outward unevenly and keeps moving after it has stopped growing. A clean expanding circle reads as a
shockwave — the demo already has one — and never as contamination. Its rising spores live inside
the same class rather than in a separate emitter, because they have to die *with* it: motes still
climbing out of a stain that has already faded is the giveaway that two effects were bolted
together. Replenishment stops at 70% of the life so the stragglers can rise and go out on their own.

Both are centred on the ground **under** the socket, not at it. A fist connects in mid-air, but
what a treant that size breaks is the floor beneath it.

**They are capped at five.** Ten-second effects accumulate — a viewer holding down the attack
buttons stacks decals until the ground is a solid sheet of glow and the frame rate goes with it.
The oldest is retired early to make room. Measured at sixteen attacks in a row: five lingering
effects, 120 fps, 50 draw calls, flat.

### Where things go

Everything anchors to `actionProfile.sockets`, and every socket is a measured vertex centroid on a
real bone, not a coordinate someone typed:

| socket | bone | kind | measured from |
|---|---|---|---|
| `eye-l` / `eye-r` | `Head` | effect | the green-dominant vertex clusters on the head, split at the midline (55 and 28 vertices) |
| `crown` | `Head` | effect | the 200 highest vertices bound to the head — the branch antlers |
| `chest-core` | `Spine02` | effect | centroid of the 5,697 vertices bound to Spine01/Spine02 |
| `grip-l` / `grip-r` | `L_Hand` / `R_Hand` | grip | the 150 most distal vertices on each hand |
| `foot-l` / `foot-r` | `L_ToeBase` / `R_ToeBase` | attachment | centroid of each foot's vertices |

The eye sockets double as a chirality check. They land at z = −0.023 and +0.021, mirrored about the
head midline, and the rig puts `L_Hand` at z = −0.35 and `R_Hand` at +0.33. With forward = +x and
up = +y, right = forward × up = +z, so the rig's own L/R prefixes agree with the measured geometry:
a mirrored pair, not a rotated one.

Charge is **one number**. `vfx.charge` drives the chest core, the sap veins and the wisps together,
because they are one event seen three ways — driving them separately from the skill table is how
they drift out of step.

Every effect object is flagged `userData.isHighlight`, which is the viewer's own marker for "an
overlay that is not part of the model". Without it the Parts inspector lists `vfx:trail:vfx:wisp:0`
beside the bark shell and clicking the glow in front of the character's face selects the glow.

### Colour

Everything emissive is `setHSL` off **`LIFE_HUE` = 82.5°**, the hue measured off the character's
iris in the reference photograph. Saturation and lightness are pushed past the measured values —
an emissive channel has to out-run the albedo it sits on — but the hue never moves. So the eye
glow, the drifting motes, the swing trails and the ground rings are all the same green the
character already has.

The lights are the same story: key tinted `#726a5c`, fill `#8b8c69`, rim at the life hue, bounce
`#4b3e2b`, all sampled off the photograph. There is no neutral white light in the rig. The key sits
at intensity 7.0 because the measured bark albedo is only `#4b3e2b` — about 0.06 in linear — and
lighting this figure at the intensities a mid-grey subject wants leaves it a silhouette.

---

## The measurement harness

```
node scripts/measure-monster-tree-rig.mjs          # human-readable
node scripts/measure-monster-tree-rig.mjs --json   # machine-readable, exit 1 on failure
```

| gate | what it measures |
|---|---|
| **R0** | the export's own builder, measured the same way as R2, for comparison |
| **R1** | every clip seeked to ≥ 5 points, skinned on the CPU → `maxSampledBindingDelta` |
| **R2** | rest pose as a similarity fit — catches a normalise scale applied twice |
| **R3** | within-piece vertex-pair distances across every pose → costume rigidity |
| **R4** | the two copies of each shared cut-ring vertex → seam gap |
| **R5** | bone indices in range, weights normalised, LOD count |

R1 currently reports all 16 clips driving the skin, `maxSampledBindingDelta` **2.085**, nothing
`unevaluated`. A clip that exists is not a clip that runs: one whose delta is ~0 fails, and a clip
that cannot be evaluated is reported `unevaluated` with the input it was missing rather than
defaulted to a pass.

The harness caught two of its own bugs before it caught anything else — comparing local-space rest
distances against world-space posed ones (which reads a perfectly rigid piece as 13% sheared), and
pairing seam vertices by proximity instead of by shared identity. Both are fixed; both are why the
numbers above are worth quoting.

---

## What this is not

- **Not photogrammetry, not a hand-sculpted procedural model.** It is the img2threejs GLB fast
  lane: a generated mesh used as a measurement instrument, embedded as code.
- **Hidden sides are generated, not observed.** One photograph cannot confirm the back.
- **The costume split is a hypothesis.** Symmetric across both arms and confirmed in the render,
  but the export carries no material IDs to check it against.
- **The clip poses have not been reviewed visually.** Skill names rest on kinematics alone.
- **No AI-vision likeness review has run.** The spec is still ready to hand to the full img2threejs
  skill for the judgement passes.
