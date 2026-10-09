<div align="center">

# img2threejs Showcase

### Build the mesh. Keep the source.

Reference-led 3D studies rebuilt as inspectable, animation-ready Three.js code —
running live in the browser.

[![Explore the live gallery](https://img.shields.io/badge/Explore_the_live_gallery-img2threejs.io-EA8B73?style=for-the-badge)](https://img2threejs.io/)
[![View img2threejs](https://img.shields.io/badge/View_the_core_project-GitHub-111111?style=for-the-badge&logo=github)](https://github.com/img2threejs/img2threejs)

[![GitHub stars](https://img.shields.io/github/stars/img2threejs/img2threejs-showcase?style=flat&logo=github&color=EA8B73)](https://github.com/img2threejs/img2threejs-showcase/stargazers)
[![Deploy](https://github.com/img2threejs/img2threejs-showcase/actions/workflows/deploy.yml/badge.svg)](https://github.com/img2threejs/img2threejs-showcase/actions/workflows/deploy.yml)
[![PR safety check](https://github.com/img2threejs/img2threejs-showcase/actions/workflows/pr-safety-check.yml/badge.svg)](https://github.com/img2threejs/img2threejs-showcase/actions/workflows/pr-safety-check.yml)
[![Three.js r169](https://img.shields.io/badge/three.js-r169-000000?logo=three.js&logoColor=white)](https://threejs.org/)
[![img2threejs v1.5.2](https://img.shields.io/badge/img2threejs-v1.5.2-1AB9E8)](https://github.com/img2threejs/img2threejs/releases)

<a href="https://img2threejs.io/">
  <img src=".github/readme-assets/hero-gallery.webp" alt="The current img2threejs live gallery featuring the Ocean Blue PRS Guitar study" width="100%">
</a>

<sub>Open a study, orbit the model, inspect its parts, trigger its actions, and follow the source back to the code.</sub>

[Gallery](https://img2threejs.io/) · [How it works](#from-reference-to-live-study) · [Contribute](#contributing-a-study) · [Develop](#local-development) · [Community](#community)

</div>

---

## About the showcase

This repository is the public gallery for [img2threejs](https://github.com/img2threejs/img2threejs).
Each study pairs its reference with a reviewable TypeScript implementation, catalog metadata,
and a live Three.js scene. The result is not a sealed render: it is code you can inspect,
diff, animate, and extend.

<table>
<tr>
<td width="33%" valign="top">
<strong>Reference-led</strong><br><br>
Silhouette, proportions, materials, and visible details are measured against the supplied source.
</td>
<td width="33%" valign="top">
<strong>Code-owned</strong><br><br>
Runtime geometry and behavior live in the repository. Demo code cannot depend on remote meshes, CDNs, or network calls.
</td>
<td width="33%" valign="top">
<strong>Animation-ready</strong><br><br>
Named parts, pivots, rigs, contact pairs, and effects are authored for interaction rather than flattened into a single asset.
</td>
</tr>
</table>

The catalog keeps honest status metadata: **final** entries are completed reconstructions;
**placeholder** entries remain visible while their final rebuild is in progress. The live source
of truth is [`src/demos/registry.ts`](src/demos/registry.ts).

## Recent studies

| Study | What to explore |
| --- | --- |
| [Tropical Island — code-only measured study](src/demos/tropical-island/createTropicalIslandModel.ts) | Ten force-measured TypeScript surfaces, procedural terrain/water/foliage, 27 selectable parts, and no runtime GLB or source texture maps. |
| [Ocean Blue PRS Guitar](https://img2threejs.io/#/demo/prs-ocean) | Measured vertex color and PBR samples preserved in code, six addressable strings, and opt-in water-flow actions. |
| [Groot — Heart of the Forest](https://img2threejs.io/#/demo/monster-tree) | A navigable woodland scene with retargeted movement, grounded combat, living-wood effects, and lantern spirits. |
| [Mars Cat](https://img2threejs.io/#/demo/mars-cat) | Seventeen measured regions streamed at three quality levels without shipping the reference GLB, textures, or UV atlas. |
| [Starship + Super Heavy](https://img2threejs.io/#/demo/starship-super-heavy) | Procedural stainless shells, heat-shield tiles, flaps, grid fins, engine arrays, and a staged separation sequence. |

<div align="center">

[Browse every live study](https://img2threejs.io/#archive)

</div>

## Gallery snapshots

<table>
<tr>
<td width="50%" align="center" valign="top">
<a href="https://img2threejs.io/#/demo/sony-wf1000xm3"><img src=".github/readme-assets/sony-wf1000xm3.png" width="100%" alt="Sony WF-1000XM3 earbuds and charging case"></a><br>
<strong><a href="https://img2threejs.io/#/demo/sony-wf1000xm3">Sony WF-1000XM3</a></strong><br>
<sub>Open the case, lift both earbuds, spin them through a full turn, and settle them back into place.</sub>
</td>
<td width="50%" align="center" valign="top">
<a href="https://img2threejs.io/#/demo/gerber-knife"><img src=".github/readme-assets/gerber-knife.png" width="100%" alt="Gerber Paracord Knife"></a><br>
<strong><a href="https://img2threejs.io/#/demo/gerber-knife">Gerber Paracord Knife</a></strong><br>
<sub>A stonewashed tanto profile, skeletonized tang, hex pommel, and woven orange cord.</sub>
</td>
</tr>
<tr>
<td width="50%" align="center" valign="top">
<a href="https://img2threejs.io/#/demo/doraemon-house"><img src=".github/readme-assets/doraemon-house.png" width="100%" alt="Doraemon House isometric diorama"></a><br>
<strong><a href="https://img2threejs.io/#/demo/doraemon-house">Doraemon House</a></strong><br>
<sub>An isometric street diorama with layered roofs, overhead wires, a garden, and animated atmosphere.</sub>
</td>
<td width="50%" align="center" valign="top">
<a href="https://img2threejs.io/#/demo/warhauler"><img src=".github/readme-assets/warhauler.png" width="100%" alt="War-Hauler Sector 07"></a><br>
<strong><a href="https://img2threejs.io/#/demo/warhauler">War-Hauler “SECTOR 07”</a></strong><br>
<sub>A weathered six-wheel hauler with a riveted plow, reactor-lit hubs, and drifting exhaust.</sub>
</td>
</tr>
</table>

## From reference to live study

```mermaid
graph LR
    A[Reference image or measured source] --> B[Analysis and sculpt specification]
    B --> C[TypeScript model factory]
    C --> D[Quality and safety gates]
    D --> E[Interactive Three.js study]
```

1. **Study the source.** Record visible proportions, silhouette, material behavior, and unknown depth.
2. **Build in code.** Assemble geometry, materials, named parts, and optional actions in a TypeScript factory.
3. **Measure the result.** Compare the render with the source, document inference, and iterate on the largest visible gaps.
4. **Publish the study.** Add catalog metadata and a local reference; CI builds the gallery and runs the static safety gate.

For the reconstruction workflow itself, start with the
[img2threejs repository](https://github.com/img2threejs/img2threejs).

## Contributing a study

Have an img2threejs model worth sharing? The repository includes a scaffold command and a
purpose-built contribution path.

```bash
git clone https://github.com/<your-user>/img2threejs-showcase.git
cd img2threejs-showcase
npm ci

git switch -c add-demo/<id>
npm run new-demo -- <id> "<Title>" object   # or: character

# Add the factory and reference, then complete the generated registry entry.
npm run build
node scripts/check-showcase-safety.mjs --base main
```

A submission must:

- build its runtime geometry in code without fetching remote meshes, textures, fonts, or scripts;
- include a reference image you have the right to use (`.png`, `.jpg`, `.jpeg`, or `.webp`, at most 800 KB);
- use a unique kebab-case id and complete every required registry field;
- set `status: 'final'` once the real implementation replaces the scaffold;
- pass both the production build and the same safety scan used by CI.

Read the full [contribution guide](CONTRIBUTING.md) before opening a pull request.

## Local development

### Requirements

- Node.js 20
- npm

### Commands

```bash
npm ci
npm run dev            # start Vite in development mode
npm run build          # run project checks, TypeScript, and the production build
npm run preview        # serve the production build locally
npm run new-demo -- --help
npm run star-history   # regenerate the chart below; requires GITHUB_TOKEN
```

The gallery uses hash routes (`#/` and `#/demo/:id`) so direct navigation remains compatible
with static hosting.

### Tropical Island — code-only diorama

Open `#/demo/tropical-island`. The demo has 27 selectable parts, a coupled
shallow-water simulation, moored boat buoyancy, wind-driven foliage, a day/night
cycle and procedural fire, smoke and water-entry effects. Click/tap clear deep
sea to drop a rock, drag to orbit, and press **R** to repeat at the last water
point. Strong shore impacts extinguish the campfire; click its retained wood or
stone to relight it. Reduced motion holds the scene and disables physical drops.

The ten prop surfaces in [`measured/`](src/demos/tropical-island/measured/)
follow the img2threejs force-measured route: u16 positions, octahedral 8+8-bit
normals, sampled vertex colors and lossless indices decoded into ordinary
Three.js geometry. These are surface buffers, **not a base64-wrapped GLB**.
Runtime uses no GLB/GLTF/BIN, GLTF/DRACO loader, source texture image or UV atlas.
The reference WebP is a gallery thumbnail, not a model texture.

[The measurement manifest](pipelines/tropical-island/measured-surfaces.json)
records source hashes, topology, transforms and sampling conventions. Across ten
source meshes, 708,881 vertices and 1,145,710 triangles retain their original
index order before the existing palm/fire cleanup. Independent local parity
checks measured maximum position error of `7.62939453125e-6` in source mesh
units and nonzero-normal error below `0.95°`.

**Fidelity limit:** base color is sampled at vertices; roughness and metalness
use measured sampled medians. Sub-vertex texture detail and source normal maps
are not retained, so this is not pixel-identical PBR texture shading.

`npm run build` checks island source/public assets before building and checks
`dist/` afterward. Focused physics and interaction regression tests:

```bash
node --test pipelines/tropical-island/*.test.mjs
npm run check:tropical-island
npm run build
```

The offline encoder and independent verifier are retained as code in
`pipelines/tropical-island/`. Regeneration requires Python 3 with Pillow and the
original GLBs under the gitignored `work/tropical-island/reference-models/`:

```bash
python3 pipelines/tropical-island/encode-surfaces.py
node pipelines/tropical-island/verify-surfaces.mjs
```

Normal builds do not need Python or the offline GLBs. Original models, temporary
state/specs, generation logs and historical QA images/videos are not part of
this showcase submission. Optional inspector GLB **export** remains available;
static exports do not bake the simulation, wind or volumetric effects.

## Repository map

```text
src/
  main.ts                 application bootstrap and route mounting
  content.ts              editorial copy for the gallery shell
  site-data.ts            canonical links, release, sponsor, and roadmap data
  pages/demo.ts           study viewer and information panel
  pages/workbench.ts      inspection and export workbench
  scene.ts                renderer, camera, controls, lighting, and disposal
  exporters.ts            browser-side export flows
  demos/registry.ts       catalog metadata and lazy runtime loaders
  demos/<id>/             one implementation folder per study
public/references/         local source references used by the catalog
scripts/
  new-showcase.mjs         contributor scaffold
  check-showcase-safety.mjs static pull-request safety gate
  generate-star-history.mjs repository-owned star chart generator
```

### Quality gates

Pull requests targeting `main` run the shared Node 20 quality workflow. The repository adds
showcase-specific checks for unsafe network access, reference formats and sizes, catalog ids,
and contribution boundaries. Merged changes are deployed automatically.

## Community

- [Discord](https://discord.gg/8DS8RTyuR) — feedback, reconstruction discussion, and work-in-progress studies
- [Issue tracker](https://github.com/img2threejs/img2threejs-showcase/issues) — gallery bugs and showcase submissions
- [YouTube](https://www.youtube.com/@hoainho1465) · [X / @NickDevFE](https://x.com/NickDevFE) — build logs and releases

## Support the project

img2threejs and this gallery are open source. If they save you time, you can support ongoing
work through [Ko-fi](https://ko-fi.com/iamnick) or the
[project donation page](https://img2threejs.io/donate.html).

## Star history

<div align="center">

<a href="https://github.com/img2threejs/img2threejs-showcase/stargazers">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/readme-assets/star-history-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/readme-assets/star-history-light.svg">
    <img alt="Star history for img2threejs/img2threejs-showcase" src=".github/readme-assets/star-history-light.svg" width="100%">
  </picture>
</a>

<sub>Generated in-repository by <a href="scripts/generate-star-history.mjs"><code>scripts/generate-star-history.mjs</code></a> and refreshed daily.</sub>

</div>
