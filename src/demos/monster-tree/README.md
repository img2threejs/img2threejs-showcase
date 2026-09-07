# Groot — Heart of the Forest

The current runtime has 31 actions: 21 original user-supplied FBX motions, eight additional
animation-only B2 FBXs, and two retained procedural clips, using one 71-joint controller. Walking and Shift-running use the supplied movement files;
Rootfall grips and releases an overhead bark vine. It includes two keyboard spellbooks, an English first-use
field guide, a moonlit forest and summonable lantern spirits. Attacks use the character's original
bark shapes and colours, with subtle toxic sap and expanded visual reach. Original embedded clips
are preserved. Original and Bloom are available at the near-spawn wardrobe; three unique relics
unlock the actual supplied Ice form and its private frost/crystal B1 themes. Selection waits for
cast recovery and uses reversible two-second transitions. See [GROOT_ICE.md](./GROOT_ICE.md) for
source provenance, wardrobe/state APIs, evidence and limitations, [GROOT_B2_V2.md](./GROOT_B2_V2.md)
for the silent second bank, and [GROOT_FBX.md](./GROOT_FBX.md) for original motion mapping.

The sections below are historical export/rig investigation notes. The old `SkillRunner`, pose
overrides, costume splitting and seven-action table are not used by the current showcase.

## Historical Stage-R investigation

A treant rebuilt from `public/references/monster-tree/front.jpg`, built **on top of** the playground's
own export rather than re-deriving it. The geometry was already measured; nothing here re-sculpts
it. What this stage adds is the rig work, the costume separation, the effects and the lighting —
and a measurement harness for all of it.

Open it with `npm run build && npm run preview`, then `/#/demo/monster-tree`.
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

## The kit's animation is authored, not borrowed

The rig ships sixteen clips from Tripo's generic biped library — boxing rounds, front kicks, six
dances. They are real motion and measured honestly elsewhere in this demo, but none is the motion
of a treant bending into a branch strike, dropping its full trunk weight into the earth, or opening
an antler canopy. A human jab with green particles is still a human jab; effects cannot fix a body
doing the wrong thing.

So the kit's seven moves are **posed** (`poses.ts`). Each is a timeline of aim directions, one per
bone, solved onto the skeleton by `rig.aim` / `rig.applyPose`. Underneath, the body still plays a
trimmed copy of `standing_relax`, so the torso keeps breathing and the weight keeps shifting
without any of that having to be hand-authored.

### The aim solver, and why the child bones are named

For each bone: take the rest direction of its segment in the parent's frame, find the swing that
takes it to the target, and apply that **before** the rest rotation so the bone's authored twist
survives. Parents are solved first and their world rotations accumulated, so aiming a shoulder and
then the elbow off it composes the way a limb does.

Every aim pair is named explicitly rather than taken as `children[0]`, which is wrong on this rig
in two ways: the twist bones are co-located with their parents (`L_ForearmTwist01` sits exactly on
`L_Forearm`, giving a zero-length segment with no direction at all), and the child *order* differs
left to right — `L_Thigh` lists L_Calf first, `R_Thigh` lists R_ThighTwist01 first — so the same
code would aim the two legs by different bones.

### Authored beats

Everywhere else this showcase schedules against `events.ts`, a 240 Hz sweep of clips nobody here
wrote. For these seven the relationship inverts: the gesture is designed around when a hand, body,
or external force should
stop, and `BEATS` holds those numbers in one place so the pose and the effect cannot drift apart.

They are then measured back, with the same method, to check the gesture does what it claims:

| move | peak hand | what the sweep finds |
|---|---|---|
| Greatwood Body | 0.063 H/s | no event spike; mean body motion is 0.0335 H/s |
| Firstborn Seed | 3.798 H/s | the cast-window peak is **0.804 s**, 0.016 s from the 0.820 s release; soil contact follows at 1.400 s |
| Heartwood Aegis | 2.343 H/s | arms close by 0.620 s and the whole trunk yields to the scheduled outside hit at 1.020 s |
| Splintered Resolve | 5.583 H/s | no anticipation before 0.340 s; full compression follows at 0.480 s |
| Heartwood Lash | 8.359 H/s | hand speed peaks at **0.787 s**, 0.067 s after release and before the 0.860 s arrest |
| Rootbreaker | 11.808 H/s | two-hand descent peaks at **0.838 s** and arrests on the authored 0.900 s ground contact |
| Crown of First Seeds | 3.103 H/s | a controlled channel whose largest motion is the trunk growth at 0.400 s |

That table is a gate, not decoration. It caught three defects that looked fine in a still frame:

1. **Aim directions were lerped, not slerped.** A plain lerp of two unit vectors crawls at the ends
   and whips through the middle, and the closer to opposite, the worse. The ultimate folds a
   forearm from pointing left to pointing right in a fifth of a second; lerped, that measured a
   hand speed of **60.7 H/s** — twelve times the fastest hand in any shipped clip — as a two-frame
   spike that read as the arm teleporting.
2. **The old ground move never touched the ground.** It raised both arms and held them while roots
   appeared elsewhere. Rootbreaker now holds overhead, drops both hands with the trunk and knees,
   and schedules the root crest from the 0.900 s contact.
3. **The passive was a statue.** Aiming at full weight replaces the clip's own hand motion, and the
   first stance swept 0.01 H/s where `standing_relax` itself manages 0.103 — ten times stiller than
   the quietest thing in the library. Blending at partial weight looked like the fix and is not
   (see below); the life had to be authored.

### Two three.js behaviours that only measurement finds

`PropertyMixer.apply` writes to the scene graph **only when the value it accumulated differs from
the snapshot it took**. Every scale track in this rig is a constant 1, so for scale the mixer
decides nothing changed and never writes at all — and a stretch that *multiplies* the live value is
therefore never reset. Measured on the former authored falling-prop test, `L_Forearm.scale.y` reached
**106,195** inside 2.3 seconds and threw the hand hundreds of units out of the world. It had
survived this long only because the shipped presets vary their scale enough to keep the mixer
writing. Stretches now restore what they applied and rewrite each bone once from the clip's own
value.

The same optimisation applies to quaternions, which is why a partial-weight aim does not work: it
reads its own previous output, converges to the aim within two frames, and then jerks whenever the
clip *does* change. That measured as a 1.08 H/s twitch on a stance that should be the stillest
thing in the demo.

And a bone can be **both** stretched and the child of a stretched bone — Waist is stretched, Spine01
is stretched, and Spine01 is Waist's child. Handling those in one pass wrote Spine01 twice and
recorded the second base from the first write's output, compounding in the other direction and
lurching the shoulders every time the mixer happened to write. Factors and divisors are now
collected first, and each affected bone is written exactly once.

## Groot's living-world kit

The character is **Groot**. Y'bneth supplies the battlefield grammar from the user's ability brief;
Groot supplies the Flora Colossus motion, body transformation, regrowth, and VFX material language.
The seven panel actions are authored for this rig; embedded biped clips remain measurement and
binding evidence rather than public actions.

| | clip | what it does |
|---|---|---|
| **Nội tại · Đất Mẹ** | `authored:passive` | living grass appears under the feet; soil-to-heart sap presents the 2% heal and a five-second +60 speed wake without turning the resting loop into a repeated explosion |
| **Chiêu 1 · Dây Gai** | `authored:thornline` | bends the full trunk, elongates the left arm into thornwood, and reaches its target on the 0.860 s arrest with 65 ms of hitstop |
| **Chiêu 1 · Cây Đổ** | `authored:falling-tree` | compresses into hardened heartwood, dashes shoulder-first, then stops at 0.940 s while splinters and a root wedge continue forward as knockback |
| **Chiêu 2 · Thiên Nhiên Vỗ Về** | `authored:embrace` | opens both arms to claim the front arc, closes into a 0.940 s centre gather, and holds the converging field for the one-second stun |
| **Chiêu Cuối · Hạt Giống Sinh Mệnh** | `authored:life-seed` | crouches, jumps, arrests on the ground, then sleeps in a six-second shield/slow zone while seven scheduled seed volleys, healing pulses, and a final stun/pull cycle play |
| **Groot · Tái Sinh Tế Bào** | `authored:regrowth` | receives an outside force with no false windup, sheds bark from the torso, contracts the ring inward, and regrows from root to heart |
| **Groot · Bào Tử Phát Quang** | `authored:spore` | cups both palms, opens the canopy, and releases slow warm spores with no impact ring or hitstop |

### The lash is a living branch, not a beam

Thirty preallocated branch sections form a shallow curve from the animated hand. Their radius
tapers toward the end, ten smaller twigs break the tube silhouette, and a narrow iris-coloured core
reads as sap under bark. Both endpoints update from the same hand and stage direction every frame,
so the branch remains attached while the arrest pose moves. The catch point uses one incomplete
compression arc, a warm resin core and directional wood splinters — no white portal at the hand.

### The ultimate is a rooted six-second channel

The ultimate now has a visible crouch, airborne beat, ground arrest, sleep posture, shield shell,
slow field, seven fixed seed volleys, two soil-to-body healing pulses, and one inward pull. Warm seed
resin is the single contrast against bark/moss green; its source stays on Groot's crown instead of
becoming unrelated full-screen rain.

### The camera leads the action

Groot faces +X. The review camera uses equal +X/+Z weight for a true three-quarter front: both
hands separate during Thiên Nhiên Vỗ Về and the trunk bend stays readable. The target leads mid-torso
slightly downrange, leaving the right half of the shot for the complete lash and arrest crown.

### The passive is an activation, then circulation

Đất Mẹ explicitly grows the brush patch once, lifts a healing pulse into the body, and keeps a
five-second brighter circulation window. After that activation, only the quiet, clip-calibrated
root-to-heart layer remains; the loop does not keep re-casting the heal.

### Public actions stay character-native

The downloaded rig still carries 16 clips, but the generic biped clips are retained only as
binding and retarget evidence. The gallery controller exposes the seven authored treant actions
above, defaults to Đất Mẹ, and returns one-shot skills to that same passive loop. Human boxing,
kicking and dancing clips are not presented as Groot's moves.

## Archived rig experiment: Phân Thân

The following section documents an earlier stress test retained in source; it is not exposed in
the gallery action menu.

Five real `THREE.SkinnedMesh` copies over the character's own 101,466-triangle geometry, each with
its **own skeleton** and its own `AnimationMixer`. Only the bones are duplicated; the vertex buffer
is shared.

The separate skeletons are the point. Locked to the original's playhead, five copies hold one pose
in five places and the eye reads a mirror artifact. Each copy runs the clip a fixed interval
behind, so on any frame the fan shows the whole strike sequence at once — and each flares and lands
its blow when **its own** playhead crosses **its own** measured arrest.

Which arrests: `beats()` takes the hardest arrest in each of five windows rather than the five
loudest outright, because the five loudest cluster — dance_05's all fall at 0.433 and 1.633, so a
move built on them fires in two bursts and runs silent for a second and a half. One per window
gives 0.200, 0.433, 0.833, 1.233, 1.633.

Two things had to be measured rather than chosen:

- **Where they stand.** Even angles do not give even spacing. The camera is 7.7° above the floor,
  so the ring projects nearly edge-on and a copy's place in frame goes as the *sine* of its angle;
  five copies spread evenly over an arc landed at sine 0.77, 0.91, 0, −0.91, −0.77 — two pairs
  almost on top of each other. Inverting it (pick the position in frame, solve for the angle with
  `asin`) spreads them at −1, −½, 0, +½, +1 of the radius and keeps every one on the half of the
  ring away from the viewer. The chorus learns where the viewer is from an `onBeforeRender` hook on
  a one-triangle probe, which works in any host without the model knowing anything about a renderer.
- **How solid.** The first version decayed each copy to nothing after its beat; with beats 0.4 s
  apart and a 0.75 s decay, at most two were ever lit at once. Five copies never once on stage
  together are not five copies. A copy that has struck now settles and stays.

They carry the demo's **one contrasting accent** — the exact complement of `LIFE_HUE`, the 82.5°
measured off the character's iris, so 262.5°, a cold violet. Everything else in the showcase sits
on the green-through-bark ramp, which is right for a creature made of wood and wrong for the one
thing on stage that is not the creature.

## Heartwood Lash: bend, hold, release, arrest

The move is built around the instant motion stops, with four distinct phases:

| | |
|---|---|
| **0.00 – 0.58 s** | the pelvis withdraws, trunk bends into a reverse curve and the free arm opens the silhouette |
| **0.58 – 0.72 s** | the loaded body holds while sap fragments travel shoulder-to-hand; this scheduled lead is the windup a live deceleration test cannot know about |
| **0.72 – 0.86 s** | hand and heartwood branch extend together; measured hand speed peaks at 0.787 s |
| **0.86 s** | the body crosses into its full stop, the branch arrests, directional splinters fire and the mixer holds for 65 ms |

The branch stays anchored to the hand through the short post-arrest hold, then dissolves from its
tail while the pose follows through and recovers. Measured, release lands 67 ms from peak hand
speed; the stop is separately scheduled at full extension.

### It has to be bark, not a smooth rope

The main section is nearly round so its thirty joins do not form a saw-tooth edge, while taper is
applied along the full length. Small alternating twigs supply the irregular silhouette of living
wood; the arc is shallow enough that direction and speed remain dominant.

## The arrest, made directional

Contact is a fan oriented by the incoming branch, not a radial kit effect played at an arbitrary
point. Bark splinters inherit a forward component, spread across the arrest plane, and fall away as
their sap cores cool. One broken arc compresses normal to the strike; two more pool slots remain
parked rather than stacking into a portal. The tiny centre is warm exposed resin from the measured
leather band, not a white flash that competes with the character's eyes.

## The whole body, or it is a mannequin

The first authored gestures moved arms and tilted a spine on top of a near-static resting clip, and
that is exactly what they looked like: a figure standing perfectly still while one limb swung. A
strip of frames across a move shows it immediately and a single screenshot never does — which is
why `mt-strip.mjs` steps the clip with the demo's own loop stopped and tiles the frames.

What was missing was everything below the shoulders. Three channels were added:

- **`rig.turn(bone, radians)`** — twist about the figure's own up axis. Aiming can point a segment
  somewhere; it cannot twist anything, and hips and shoulders are exactly the case that needs it
  (`Hip` and `Waist` sit at the same point, so there is no direction between them to aim).
- **`rig.shift(x, y, z)`** — the hips, for weight transfer and crouch.
- **`leg(side, bend)`** — a leg derived from the measured rest, bent by a two-bone solve.

The gestures were then rebuilt on animation fundamentals rather than arm positions: anticipation
that goes the wrong way first, hips firing before the chest and the chest before the hand, weight
moving onto one foot and off it, a bent elbow, follow-through past the frame that delivered, and
no bilateral symmetry anywhere.

### Four defects that only came out of measuring the rebuilt version

1. **The hip-shift axes were wrong on all three.** Hip translation is expressed in `Root`'s local
   frame, where world up is local **Z**. "Forward" was being written into local Z — so asking the
   figure to step forward pushed it *down*, and the feet went 8 cm through the floor at the deepest
   frame of a lunge. It read as a leg-bend problem, and no amount of knee work fixed it.
2. **Typed leg directions quietly straightened the leg.** The rest leg already sits about 9 degrees
   off vertical at the thigh and 12 at the calf; a leg typed as vertical is *longer* than rest and
   drives the foot through the floor. `leg()` derives both segments from the measured rest with a
   bend that can only ever add, and **solves** the calf angle — given a thigh of 0.395 tilted by
   `a`, the calf of 0.473 must come back by `asin(0.395·sin(a)/0.473)` to put the foot under the
   hip. Picking that angle by eye left the foot out in front and barely shortened the leg, so a
   crouch asking for 7 cm of drop got 2 cm of leg and pushed the difference through the ground.
3. **`setFromUnitVectors` is undefined at the antipode.** The minimal rotation between two opposite
   directions has no unique axis, so a limb aimed through the far side of its own rest direction
   *flips*: `L_Forearm` turned **134.8 degrees in one frame** while every other bone moved
   smoothly. The axis is now chosen deterministically from the bone's rest frame, and the authored
   poses keep clear of the antipode — which is the real remedy, since no aim is well behaved there.
4. **The stretch did not cross-fade.** The pose hands over across the clip's own fade window; the
   bone stretch snapped, dropping the ultimate's trunk from 1.45x to 1 between two frames and
   taking the hands 0.22 units with it. It now decays across the same window.

Together these took the worst transition discontinuity from 0.227 units to **0.055**.

### And two ugliness fixes that no rubric was ever going to catch

Point size goes as one over distance, so an atmospheric sprite that drifted near the camera grew
without limit — a single spore covered a third of the frame as a flat green sheet. Every point
material is now clamped below 30 pixels. Rootbreaker had a more fundamental visual problem: a flat
translucent wedge turned the ground wave into a polygon. The public move now lets raised bark roots
and branching fissures alone describe the travelling crest.

## The animation is scored, and the score is reproducible

`scripts/score-monster-tree-animation.mjs` drives the shared gallery route in a browser and prints
thirteen checks scaled to ten. It steps every public authored clip deterministically — fixed dt
through the real mixer, with the pose solved exactly as the frame loop solves it — and separately
measures live frame timing twice. It exits non-zero below 9.0, so it can gate.

Visual review is reproducible too. `node scripts/review-monster-tree-frames.mjs` renders nine
labelled event frames for each action and packages seven contact sheets. Add `--every-frame` to
export the complete 30 fps review sequence: **786 screenshots** spanning all seven actions while
the real mixer is still integrated at 120 Hz. Evidence is written below `.img2threejs/review/`,
which is intentionally ignored rather than adding generated captures to the application bundle.

The 2026-09-04 expanded-kit run reads:

```
1.00  no teleports                    peak 8.335 H/s; worst frame 1.32x its neighbours
1.00  no frame stalls                 worst max 23.3ms; p95 17.0ms; repeated stalls 0
1.00  transitions do not pop          worst natures-embrace -> regrowth 0.0353
0.97  elongation release at peak      Dây Gai 0.067s from authored release
1.00  holds are alive                 passive 0.0335 H/s; Life Seed hold 0.0223 H/s
1.00  feet stay planted               highest toe 0.035; lowest -0.008
1.00  payoffs readable and distinct   weakest from rest 0.314; closest pair 0.215
1.00  gestures survive projection     weakest 1.24x the resting spread
1.00  nothing left behind             0.02deg; zero scale and position residue
1.00  clean run                       no console errors
1.00  VFX follows the animated rig    stable model space; rest = passive
1.00  VFX pools allocation-stable     objects 353; geometries 242; materials 181
1.00  harness reports every clip      7/7 public clips
TOTAL 9.98 / 10
```

### What it caught that no still frame shows

- **Ending the ultimate moved a hand 1.10 units in a single frame.** The clip cross-fades; the
  authored pose did not, so the whole gesture snapped back to the resting animation between two
  frames. A gesture is now handed over across the same window the clip fades in.
- **Leaving the former empowered lash snapped the figure home**, 0.35 units — the body, not the arm.
- **Arriving from idle applied the incoming pose at full weight on frame one**, 0.28 units.
- **A partial-weight aim was a lie.** `PropertyMixer.apply` skips writing a track whose value never
  changes, so a weighted slerp read its own previous output and converged to full weight inside two
  frames. Restoring the captured base first is what made the fades possible at all — the same class
  of bug as the scale compounding, found the same way.

### Where the rubric itself was wrong

Five of the eleven checks were measuring the wrong thing before they measured anything useful, and
that is worth writing down because a bad gate is more dangerous than no gate:

- *Distinct from rest* was failing the passive for being a resting stance.
- *Alive* averaged the old ground move's whole clip, including the raise it is not about.
- *Pop* took the largest single-frame jump, punishing the lash for having a fast throw. A pop is a
  frame that stands **alone** — the excess over its own neighbours.
- The teleport ratio pooled both hands, so the working arm looked like a teleport beside the still
  one.
- Frame timing on one pass swung the total by 0.17 between identical runs. A code stall repeats on
  the same clip at the same time; a collection blip does not. Better of two passes.
- Residue compared idle at two different playhead phases and reported 2.48 degrees of nothing.

### And the check the rubric was missing

A former two-hand pose scored **1.00 for distinctness while the render showed an unreadable smear** —
both arms raised along the axis the camera looks down, foreshortened flat over the chest. Three
dimensional displacement cannot see that. There is now a screen-space check measuring the pose in
pixels on the demo's own canvas, and the total is normalised to ten so that adding a check cannot
inflate the score.

The attachment-space check covers the matching runtime failure: effects read socket `matrixWorld`
positions, so nesting them under the moving rig transformed those positions twice during the
Lash. The scorer now fails unless the rig and world-space VFX share one stable model parent and
one-shots return to the authored passive loop.

## Seamlessness: the stalls were not the hitstop

The demo felt like it stuttered, and the obvious suspect was wrong. Instrumenting the clip playhead
in the browser — sampling `action.time` against `performance.now()` every frame — showed 8 ms
frames throughout a strike **except at the impact frames**, which took 70 ms and 52 ms. A six-to-
eight frame stall, landing exactly on the beat. Three causes, all found by measurement:

1. **Shader compiles.** Every effect pool owns its `ShaderMaterial` from construction, but three
   still compiles each program on the first render that encounters it. Every effect type therefore
   cost one stall on its own first impact — which is every impact a viewer sees first. Fixed by
   rearming one constructor-owned slot per pool at a millimetre scale far under the floor on the
   first frame, with `frustumCulled` off so it is actually submitted.
2. **Lights.** Adding a `PointLight` changes the scene's lighting configuration, and three responds
   by marking **every lit material** for recompilation — including the character's own patched bark
   shader. Then the flash expires and it all recompiles again. Fixed by a pool of four permanent
   lights whose *intensity* changes; the count never moves.
3. **Skeletons.** A skeleton uploads its bone texture on the first frame it is rendered. Warming one
   copy of the chorus left the other four to upload theirs on the frame of the split.

Measured after the expanded 2026-09-04 pass: the seven public actions report a worst live frame of
15.6 ms, a worst p95 of 14.0 ms, and **zero stalls over 25 ms repeated across both timing passes**.

Two more discontinuities came out of the same pass:

- **Hitstop was firing eight times a clip.** Splinter Combo held for 0.386 s of a 2.267 s clip
  across eight separate stalls — 17% of the move frozen — and it read as broken rather than heavy.
  There is now a 0.18 s refractory gap, jabs in a flurry do not hold at all, and the hold **eases
  out** instead of releasing on one frame.
- **Two skills sharing a clip could not follow one another.** Deep Root Surge and Splinter Combo
  were both `box_02`; `play` returned early when the action was already current, so the second
  skill started from wherever the first had got to, with its windup already behind it.
- **Charge stepped rather than swelled.** Cues set it 0 → 0.5 → 1, which is two visible pops inside
  what the viewer is being told is one gathering. Rises now ramp; the release still snaps, because
  the snap *is* the spend.

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

## Signature VFX — all hand-written

The img2threejs skill has **no particle subsystem, no trail subsystem and no shader library**.
Every effect here was written for this demo, in plain three, with **no dependency added**. Textures
are painted into a `<canvas>` at build time; nothing is fetched.

| public layer | what it is | why |
|---|---|---|
| **root breath** | line roots plus 48 pooled sap motes, attached between feet and chest | a quiet circulation that follows the resting clip instead of repeatedly casting |
| **hand gather** | 40 pooled fragments travelling shoulder-to-hand | scheduled anticipation, visible before the strike exists |
| **heartwood lash** | 30 tapered bark sections, 10 side twigs and a narrow sap spine | a living branch that stays attached to the animated hand |
| **arrest crown** | directional bark/sap splinters, one broken arc and a warm resin core | describes the instant motion stops without forming a white portal |
| **root crest** | 42 staggered raised roots plus 30 branching ground segments | carries the two-hand contact away from the body as a travelling force |
| **first-seed canopy** | 24 warm seeds inside three rotating broken arcs above the antlers | holds a readable source and one contrasting accent without hiding the face |

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

### Archived procedural experiments (not public actions)

The 16 shipped clips are a generic biped library — boxing, kicks, dances, a death. Earlier R&D
experiments drove three extra moves procedurally on top of them. They remain documented as rig and
stretch evidence, but the gallery does not present them as Y'bneth's authored kit:

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

### Branches are one surface, not a chain of pieces

Every grown branch was a chain of separate tapered cylinders, one per segment. Each cylinder
carried its own end rings, so consecutive segments shared **no vertices**: wherever the branch
changed direction the two rings splayed apart and the joint opened. The crookedness that makes a
branch look grown made it worse — the sharper the turn, the wider the gap — so the grove read as a
pile of loose sticks.

A branch is now swept as **one continuous tube**: the whole path and its radii are collected first,
then a single surface is run along them. Forks start *on* the parent's path, so a child tube begins
inside the parent's surface and the two read as joined rather than as two sticks meeting.

Rings are carried along the path by **parallel transport** rather than rebuilt from a fixed
up-vector at each one. A fresh frame per ring spins about the path as the tangent turns and the
tube visibly corkscrews along its own length; transport carries the previous frame forward and
rotates it only by the change in tangent, which is the smallest rotation that keeps it square. The
normal is re-orthogonalised each step, because the error accumulates over a long path.

### The spear is thrown, not held

Impaling Bough hurls a spear. Every earlier version grew one out of the fist and kept it there,
which made it a prop: nothing was thrown, so nothing arrived anywhere, and nothing could happen on
arrival. Now it leaves the hand at the strike, flies, lands, and **everything downrange happens
because it got there** — sparks torn off along the flight path, then a burst, a shockwave, cracks
and a toxin bloom where it strikes.

The shaft comes from the same `growBranch` recursion as the grove, posed as a weapon: thirteen
steps, almost no wander, forks cut to a fifth of their length, knotting raised to 0.34 so the wood
swells and pinches, and the tip closed to a point instead of stopping at the 0.27 a branch keeps.
It carries **no crown twigs** — the grove hangs those at its forks, and on a shaft in flight they
read as a cloud of debris travelling alongside rather than as one thrown object.

**A light travels with it.** The alternative was raising the shaft's emissive, and that is exactly
what once turned this move into "just a light streak": an emissive bright enough to be seen against
a black stage stops the thing being wood at all. A carried light leaves the albedo alone — the
spear is lit rather than glowing, and it rakes the ground it passes over, which sells the flight
better than the shaft could on its own. The light dies as it lands; a spear standing in the ground
is spent, not still burning.

### Where a projectile can be seen from

The camera moved for this, and the reason is measurable. The figure faces +X and the old framing
sat at +X too — flattering for the face, and it sent every projectile straight at the lens.
Projected against the actual **canvas** (708 × 900, not the browser window — the stage shares the
page with a panel), a spear thrown 1.4 units landed at screen (1020, 910): past the right edge and
below the bottom. The impact, the cracks and the toxin all happened where nobody was looking.

Viewing from +Z puts the character's forward axis **across** the frame. The same throw now lands at
79% of the way across, inside the shot, with the figure at the left and the impact at the right —
and Deep Root Surge, which also fires forward, became visible for free.

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

### The event table: where things actually happen

`scripts/measure-monster-tree-events.mjs` sweeps every embedded clip through a real
`AnimationMixer` at 240 Hz and reads the dynamics — no timings were eyeballed off a scrub bar.
Three event kinds, all defined by motion:

- **arrest** — a limb travelling above 1.1 H/s that stops, recorded at the frame of greatest
  *deceleration*: the frame the impact happens on, which is later than the frame the limb was
  fastest and earlier than the frame it finally rests.
- **plant** — weight arriving: a foot below 0.14 H whose vertical velocity crosses from falling to
  still.
- **driven** — the body accelerated by something that is not its own limbs: a hip spike with no
  limb arrest within 120 ms. That is what a blow *taken* looks like from inside a clip, and it
  plays as one — ring turning inward, debris off the body, no flash at the hand.

Everything is in figure heights, so the table survives a change of scale. It is baked into
`events.ts` and the skills schedule against it. Scheduling — not a live "it just decelerated"
test — is what lets a **windup** exist: the sap starts gathering 0.2–0.4 s before the arrest
because the table knows the strike is coming, and nothing watching live motion knows any such
thing.

In the archived experiments, the table corrected both hero moves. Deep Root Surge's old climax was hand-timed at 0.40 s — a
frame with no event in it at all; the sweep found the real one at **1.800 s, where both hands
arrest on the same frame and R_Hand posts a deceleration of 366.5 H/s², the loudest stop in the
entire clip library**. The move is now a measured flurry (0.667, 0.833, 1.000 — each a light hit)
building to that double-hand slam. Impaling Bough's spear left at box_01's measured arrest
at extension (0.467 s), one frame after the measured foot plant at 0.375 s.

## Current scheduled VFX runtime

### Hitstop

On every public impact the clip itself is held nearly still for 65–85 ms (`rig.hitstop`), scaled on the
mixer's own delta so the effects, the ambient drift and the camera keep running while the body
stops. This is most of the felt difference between effects happening *near* the character and the
character *hitting something*. The strongest hold wins, so a light hit landing inside a heavy
one's hold cannot shorten it.

### The public impact vocabulary

The public kit differs in **motion first, colour second**:

| kind | motion | debris | hitstop |
|---|---|---|---|
| lash arrest | one broken arc normal to the branch | splinters fan in the incoming direction | 65 ms |
| ground contact | no ring; a crest travels away along the floor | roots rise by row while fissures branch ahead | 85 ms |
| canopy release | broken arcs rotate above the antlers | warm seeds orbit, then force returns through roots | 85 ms on the return |
| taken | compression turns **inward** | bark comes off the **body**, never the hand | owned by the receiving clip |

`taken` is reserved for measured external-force events and has **no flash at the hand**, because
nothing was swung.

### Continuous layers are calibrated per clip

The embedded clip sweep spans handPeak 0.134 H/s (`fire`) to 5.231 (`box_02`) — a factor of 39 — and
the public authored set is wider still. One global trail threshold would smear Heartwood Lash and
leave Greatwood Body bare, so the quiet action owns its sparse root circulation, windups own their
shoulder-to-hand gather, and the fast actions do not carry a persistent ribbon. Their clocks are
continuous; changing action strength changes amplitude rather than jumping particle phase.

### Pooling

The complete public effects kit is constructor-owned: two lash slots, six arrest crowns, four root
waves, root breath, canopy, hand gather, light flashes and burst slots all exist before the first
frame. Each transient exposes `restart()` and returns to an invisible parked state; if a pool is
saturated, its oldest slot restarts rather than extending the scene. Heartwood Lash streams its
preallocated instance matrices in place instead of creating or disposing geometry during play.

This is checked in the browser harness, which sweeps every public action and asserts that the scene
contains the same **353 objects, 242 geometries and 181 materials** before and after the sweep.
Starting every
object invisible also means the viewer's framing pass measures the figure alone, never an effect.
On the final clean-scene two-pass run, no action repeated a frame over 25 ms; the worst frame was
23.3 ms and the worst p95 was 17.0 ms, both in `thornline`.

### One palette, used across its range

Every effect in this demo was built from `LIFE_HUE` — the 82.5 degrees measured off the
character's iris. That is right for the creature and wrong for everything it does: sap, toxin,
cracks, sparks, shockwaves and rune circles all arriving in one hue means no effect can be told
from another, and a frame with six of them in it reads as a single green smear.

Each skill now carries an **accent**, and they are still measured — points on the reference's own
eye ramp (deep `#36581c`, iris `#799d3d`, near-white core `#d6faca`) plus its moss and bark tones.
Nothing is invented; the palette is used across its range instead of at one point on it. The
assignment follows what a move *does*:

| | accent | why |
|---|---|---|
| heartwood body and lash | iris green | living sap beneath bark |
| root crest and fissures | deep green + bark | weight moving through soil and wood |
| arrest core and crown seeds | warm leather | exposed resin; the one contrast accent |
| eye and tiny highlight | near-white core | kept small so it cannot become a generic white blast |

**Impacts land on the creature too.** A hit spikes its own sap veins for a moment and drops a short
bright light at the point of contact. Without that, every effect happened in front of a figure that
never reacted to any of it — the hits read as something passing by rather than as something it did.

### Leaves, not fireflies

The ambient field was round dots, which read as fireflies: fine anywhere, and nothing to do with a
forest. A third of the motes are now leaves — a lanceolate blade with a midrib, painted once — and
they **turn as they fall**. A point sprite has no orientation of its own, so the sprite's own
coordinate is rotated in the fragment shader and the blade flattens edge-on periodically, which is
what makes a leaf tumble rather than sit pinned to the screen like a decal.

### Archived damage experiment

The hidden generic-clip experiments leave cracks and a toxin stain for **ten seconds** — roughly six times the
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
- **The public action poses and the required quiet / loud / ground-contact frames were reviewed in
  the live gallery route.** Their cue times still come from measurement; visual review is used for
  silhouette, hierarchy and palette, not to move an event off its measured frame.
