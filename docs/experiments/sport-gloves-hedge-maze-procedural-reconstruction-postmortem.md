# Sport Gloves | Hedge Maze Procedural Reconstruction Postmortem

## Document status

- Date: 2026-07-28
- Repository: `img2threejs-showcase`
- Item: `★ Sport Gloves | Hedge Maze (Field-Tested)`
- State: paused experimental checkpoint
- Outcome: useful texture, material, browser-QA, and pipeline work; unsuccessful topology architecture
- Build state at the checkpoint: `npm run build` passes
- Visual acceptance state: not accepted

This document intentionally records both successful and unsuccessful work. The current implementation is a checkpoint for investigation, not a model that should be treated as finished or used as the topology foundation for another glove.

## Original goal and constraints

The target was a procedural Three.js reconstruction of a left CS2 Sport Glove from two supplied views:

- dorsal view: `public/references/hedge-maze-dorsal.png`
- palmar view: `public/references/hedge-maze-palmar.png`
- gallery composite: `public/references/sport-gloves-hedge-maze-field-tested.png`

The important constraints evolved during the discussion:

1. The result must be a real 3D model that survives orbit and explode inspection.
2. No pre-made `.glb` or locked glove base mesh may be used.
3. The procedural base must be authored in code.
4. Surface details such as the maze pattern, cyan traction rails, stitching, wear, and printed palm symbols must remain texture or normal-map information.
5. These details must not become floating geometry.
6. Materials must read as rough synthetic fabric, leather, rubber, and silicone rather than glossy plastic.
7. The model must be compared against both source images, not judged only from a single attractive render.
8. Chrome CDP is the required browser-testing surface.
9. Explode is a structural diagnostic, not a presentation effect.

There was an intermediate contradictory instruction to use a locked pre-made glove mesh. The user later clarified that the actual goal was fully procedural geometry with no `.glb`. The checkpoint follows the later requirement.

## Current implementation

The implementation currently consists of:

- `src/createGloveModel.ts`
  - custom `THREE.BufferGeometry` generation
  - a superellipsoid-like palm and cuff shell
  - Catmull-Rom finger and thumb tubes with manually generated rings
  - separate front, back, side, tip-front, tip-back, and tip-crown geometry groups
  - seven explode-visible structural modules
- `src/demos/sport-gloves-hedge-maze/gloveTextures.ts`
  - reference-projected dorsal and palmar albedo
  - derived normal and roughness maps
  - procedural fourchette fabric
  - procedural fingertip fabric
  - connected-border black-background removal
- `src/demos/sport-gloves-hedge-maze/cs2-intake.json`
  - image-only intake metadata
- `src/demos/sport-gloves-hedge-maze/object-sculpt-spec.json`
  - generated experimental specification
- `src/demos/registry.ts`
  - gallery registration and camera/look-development settings

The current object reports seven primary parts:

1. palm shell
2. wrist shell
3. little finger stall
4. ring finger stall
5. middle finger stall
6. index finger stall
7. thumb shell

The cuff bridge and thumb saddle are structural liners attached to their parent modules and are not independent explode parts.

### Important warning about the generated specification

`object-sculpt-spec.json` contains stale generic template data, including incorrect terms such as `weapon-skin`, `hard-surface`, `bladed`, `blade`, and `grip`. It is preserved because it was part of the experiment, but it is not a trustworthy source of truth for a future implementation. A restart should replace it with a tailoring-oriented glove specification.

## What worked

### Reference projection

Using world-space planar projection for the dorsal and palmar photographs produced strong frontal similarity. Large identity-defining regions were retained:

- charcoal dorsal armor
- lime side panels
- cyan vertical rails
- wrist armor
- palmar grey reinforcement
- green thenar and hypothenar patches
- cuff frame
- thumb vent markings

This was substantially more faithful than attempting to redraw every design feature procedurally.

### Surface detail remained flat

The maze pattern, cyan rails, stitching, printed symbols, wear, and cavity dirt are represented by maps. They are not separate floating meshes. This satisfies one of the most important corrections made after the first failed hard-surface-style reconstruction.

### PBR direction

The current materials use `MeshPhysicalMaterial` with:

- `metalness: 0`
- high roughness
- low clearcoat
- low specular intensity
- derived normal maps
- derived roughness maps
- subtle fabric sheen

This removed much of the original plastic-toy appearance.

### Custom geometry rather than Three.js primitives

The checkpoint does not use `CylinderGeometry`, `SphereGeometry`, or `BoxGeometry` to build the glove base. The geometry is written into `BufferGeometry` directly.

This solved the literal primitive-constructor restriction, but it did not solve the more important topology problem described below.

### Browser and evidence workflow

The demo was exercised in the existing Chrome session through Chrome CDP:

- direct model rotation through the debug model handle
- dorsal, palmar, and three-quarter inspection
- explode and assemble interaction
- console and network inspection capability
- canvas capture

The build passed repeatedly with:

```text
tsc --noEmit && vite build
```

The only build output of note was Vite's existing large-chunk warning.

## Chronology of the experiment

### Phase 1: primitive and floating-detail failure

The earliest reconstruction treated the glove as a collection of hard-surface components:

- cylindrical fingers
- flattened palm blocks
- detached cyan rails
- raised maze lines
- separate decorative plates

The result resembled a mechanical assembly or toy. The fingers looked like rockets or pointed sausages. Explode made the error obvious because visual surface details detached from the glove.

The user correctly identified this as an organic-mesh failure.

### Phase 2: brief pre-made-mesh detour

One response proposed loading a pre-defined rigged glove mesh and limiting the task to UV texturing. This would have solved the base anatomy problem, but it contradicted the intended no-`.glb`, fully procedural requirement.

The user clarified that the reconstruction must still be generated in code.

### Phase 3: custom palm and finger shells

The next architecture replaced Three.js primitive constructors with custom geometry:

- ellipsoid/superellipsoid palm and cuff shells
- Catmull-Rom finger tubes
- generated front, back, and side material groups
- rounded start and end caps

This improved the silhouette and allowed a real three-dimensional orbit, but each anatomical region remained a separate closed volume.

That decision became the central architectural trap.

### Phase 4: projected PBR materials

The dorsal and palmar images were projected using shared world-space bounds. Normal and roughness maps were derived from image luminance and color categories.

The projection created a convincing frontal view and made adjoining parts appear continuous when their world positions aligned. This was useful but deceptive: the image concealed topology discontinuities in frontal views.

### Phase 5: fingertip debugging

Several tip profiles were tested:

- long cap around `0.62 * radius`: too domed
- very short cap around `0.22 * radius`: visibly chopped
- intermediate cap around `0.38 * radius`: less extreme but still cap-like
- final checkpoint end cap around `0.52 * radius`: rounder but still visually separate

Additional failures included:

- source-image edge pixels stretching into radial stripes
- black image-background pixels becoming dark cap bands
- large fallback-color regions reading as plastic caps

The eventual checkpoint uses procedural rough green fabric for the cap groups. This removes black bands but still looks like a separate cap rather than a sewn fingertip.

### Phase 6: palm-to-finger seam debugging

The original palm ellipsoid extended too high and covered the lower finger stalls with a large curved seam.

Attempts included:

1. reducing palm height
2. moving the palm downward
3. reducing palm depth
4. changing the palm silhouette to a superellipse profile
5. extending finger roots down into the palm
6. adding a broad knuckle web
7. adding small fourchette gussets
8. removing those gussets after they appeared as grey blobs
9. adding a thin finger-web liner
10. removing the liner after it created two horizontal seams
11. flaring finger radii near the roots
12. brightening the fourchette material

Every adjustment improved one view while damaging another:

- a taller palm hid gaps but created a mechanical arc
- a shorter palm removed the arc but opened gaps
- web liners filled gaps but created overlapping lighting seams
- finger flares reduced empty space but stretched side surfaces into triangular wedges
- brighter fourchettes improved palmar readability but did not repair topology

### Phase 7: thickness correction

The first custom version remained too thin at three-quarter angles:

- finger depth scale was `0.6`
- palm half-depth was approximately `0.075`

The checkpoint increases:

- default finger depth scale to `0.85`
- palm half-depth to `0.16`
- cuff bridge and thumb saddle depth

This improves volume, but the model still reads as separate strips because the seam architecture is unchanged.

### Phase 8: explode validation

Explode correctly demonstrated seven primary modules and verified that:

- decorative texture details do not detach
- cuff and thumb liners follow their parents
- the model is not a single camera-facing card

It also exposed the deeper problem: the chosen modules correspond to closed geometric volumes, not to the real sewn pattern pieces of a glove.

## Tooling and QA mistakes

### Playwright and `node_repl`

An early QA pass launched or controlled a separate Playwright browser through `node_repl`. That was the wrong testing surface for this project because the existing workflow used Chrome CDP.

Why this mattered:

- it did not prove behavior in the user's active Chrome session
- it introduced unnecessary browser-state differences
- evidence from that browser could not be considered final

The workflow was corrected to use the existing Chrome CDP page exclusively.

`node_repl` was only an orchestration environment for running JavaScript and Playwright. It was not required for the model itself. It should not be used in the next iteration unless the user explicitly requests Playwright.

### Stale canvas captures

The first CDP download attempt changed `model.rotation.y` and called `canvas.toDataURL()` immediately.

All four downloaded images had the same SHA-256:

```text
003c0f681448690faaac5cbb3446f74e41bb2a04c6abe4f7d89dadf76f18b578
```

This happened because the capture occurred before the next WebGL render frame.

The corrected capture procedure waits for two `requestAnimationFrame` callbacks before calling `toDataURL()`. Correct captures then produced distinct hashes.

### Evidence freshness

The untracked `.omo/evidence/hedge-maze/` directory contains many iterations, including Playwright-era captures and CDP captures. It is intentionally not part of this commit.

Important:

- old `final-*` folders are not proof of the current source
- `cdp-final` was captured before the last depth increase
- a partially captured `cdp-v3` set existed in the Downloads directory when the work was paused
- no final reviewer approval applies to the exact checkpoint committed here

Any resumed work must create a fresh evidence directory after the new topology is implemented.

### Reviewer signals

NotebookLM was used as an external visual consultant:

- an earlier review gave a misleadingly positive result around `87/100`
- a later stricter review failed the result around `45/100`
- the stricter review identified cap shape, side smearing, and seam continuity problems

The later Chrome CDP inspection confirmed those criticisms.

This demonstrates that a single review score is not a quality gate. A useful review must include dorsal, palmar, three-quarter, side, and explode views tied to the exact source revision.

### LSP behavior

Fresh LSP diagnostics repeatedly timed out for the new TypeScript files. One real error was observed when a removed gusset left `palmShell` unused; it was fixed.

`tsc --noEmit` in `npm run build` is the authoritative type-check evidence for this checkpoint.

## Why the implementation became trapped

### The wrong decomposition was selected first

The model was decomposed as:

- one palm volume
- one cuff volume
- five digit volumes

That is anatomically intuitive but not how a glove is manufactured.

A glove is assembled from pattern panels and seam boundaries. Treating each finger as a closed tube forces the implementation to invent ways to hide the intersections between those tubes and the palm.

### Closed meshes cannot create a sewn junction by overlap alone

The finger and palm meshes each have their own:

- vertices
- normals
- caps
- material groups
- curvature

Even when projected UV coordinates match exactly, their lighting normals do not. At a frontal angle the shared photograph conceals the boundary. At a grazing angle the boundary becomes a seam, dark wedge, floating strip, or lighting discontinuity.

### Every local repair preserved the bad architecture

The iteration loop focused on local symptoms:

- hide a gap
- lower an arc
- fill a cap
- brighten a side
- increase depth

Each repair retained separate closed volumes. Therefore the same structural defect reappeared in another view.

### Reference projection produced deceptive progress

The projected photograph made dorsal and palmar renders appear close to the references very early. This encouraged continued local polishing even though the grey-clay topology would already have failed.

The next attempt must pass a texture-free clay review before reference projection is enabled.

### Explode granularity reinforced the wrong mental model

The requirement for seven meaningful parts encouraged the implementation to make each anatomical region an independent closed object.

Explode parts should instead correspond to manufacturing or rigging modules while preserving shared seam logic in the assembled state.

### The iteration lacked an architecture reset gate

Once three materially different seam-fixing approaches failed, work should have stopped and returned to topology design. Continuing parameter changes made the implementation more complex without changing the underlying model.

## Correct restart direction: digital tailoring

The next implementation should model how a craftsperson makes a glove.

### 1. Define two-dimensional pattern pieces

Recommended pieces:

- dorsal hand panel
- palmar hand panel
- dorsal finger extensions or finger upper panels
- palmar finger extensions or finger lower panels
- fourchette strip for each finger-side pair
- thumb outer panel
- thumb inner panel
- thumb gusset
- cuff dorsal panel
- cuff palmar panel
- wrist strap or cuff frame

The exact decomposition should be checked against real glove sewing references before coding.

### 2. Define explicit seam contracts

Each seam pair must specify:

- source pattern edge
- destination pattern edge
- equal sample count
- seam direction
- allowance or overlap
- final welded or constrained vertex relationship

Examples:

- dorsal index edge ↔ index-side fourchette edge
- palmar index edge ↔ opposite fourchette edge
- dorsal palm top ↔ finger-root panel edges
- thumb gusset loop ↔ palm thumb opening

### 3. Triangulate panels in pattern space

Each panel should begin as a two-dimensional mesh. Pattern-space coordinates should become UV coordinates directly.

This avoids forcing a photograph through unrelated cylindrical UVs.

### 4. Assemble matched seam loops

Matched edges should share positions or be joined by explicit seam constraints. They must not be independent closed meshes that overlap.

The assembled glove can still retain logical part metadata for explode and rigging.

### 5. Shape and inflate

After assembly:

- apply hand-like depth profiles
- relax interior vertices
- inflate paired dorsal and palmar surfaces
- preserve seam lengths
- round fingertip loops
- bend finger centerlines slightly
- form the thumb saddle from the gusset rather than an intersecting ellipsoid

This can be implemented with deterministic iterative constraints in JavaScript; it does not require a `.glb`.

### 6. Validate topology before textures

Required clay-render gates:

1. dorsal
2. palmar
3. left side
4. right side
5. three-quarter dorsal
6. three-quarter palmar
7. fingertip close-up
8. thumb-root close-up
9. explode

Reject the topology if any view shows:

- capped tubes
- floating panels
- intersecting shells
- horizontal palm arcs
- triangular black wedges
- unmatched seam boundaries

Only after this gate should texture projection and PBR extraction be restored.

### 7. Apply detail maps in pattern UV space

The useful texture work from this checkpoint can be reused:

- dorsal and palmar source cleanup
- black-background isolation
- albedo projection concepts
- roughness classification
- normal derivation
- procedural fabric weave

However, the maps should be remapped or baked into the new panel UV layout rather than projected independently onto overlapping volumes.

## Recommended implementation sequence

1. Research and diagram a real sport-glove pattern.
2. Replace the incorrect object-sculpt specification.
3. Implement pattern panel and seam data structures.
4. Build a texture-free left glove with welded seam loops.
5. Verify clay views through Chrome CDP.
6. Implement deterministic inflate/relax shaping.
7. Verify clay views again.
8. Restore dorsal and palmar texture processing.
9. Bake or transfer source color into panel UV space.
10. Restore roughness and normal channels.
11. Implement logical explode groups without breaking assembled seam continuity.
12. Capture fresh CDP evidence.
13. Run two independent visual reviews against the exact checkpoint.

## Files worth reusing

- `src/demos/sport-gloves-hedge-maze/gloveTextures.ts`
  - image loading
  - connected-border black-background removal
  - edge padding
  - normal and roughness derivation
  - procedural fabric material
- `public/references/hedge-maze-dorsal.png`
- `public/references/hedge-maze-palmar.png`
- `public/references/sport-gloves-hedge-maze-field-tested.png`
- Chrome CDP debug handle and capture technique in the gallery entry

## Files that should be replaced or heavily rewritten

- `src/createGloveModel.ts`
  - keep only broadly useful metadata conventions
  - replace palm ellipsoid and curved closed finger tubes
- `src/demos/sport-gloves-hedge-maze/object-sculpt-spec.json`
  - replace generic hard-surface template content
- attachment contracts in the runtime metadata
  - redefine around panel seams, not intersecting anatomical volumes

## Checkpoint verification

The exact checkpoint represented by this document passed:

```text
npm run build
```

The command performs:

```text
tsc --noEmit && vite build
```

No final visual acceptance is claimed. The remaining Vite large-chunk warning is unrelated to this glove experiment.

## Resume rule

Do not resume by tuning:

- palm height
- finger flare
- cap radius
- web-liner dimensions
- overlap depth
- side-material brightness

Resume by replacing the topology architecture with pattern pieces, matched seam loops, and an inflate/relax pass. The current implementation has already demonstrated that parameter tuning cannot escape the closed-volume decomposition.
