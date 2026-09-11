# iPhone Duo showcase

Open `/iphone-duo.html` to explore the articulated device, six finishes, two screen treatments, and the display and hinge release sequences. The optional Hyper3D study is available in the process section.

## Run and build

```sh
npm ci
npm run dev:iphone-duo
npm run build:iphone-duo
npm run preview:iphone-duo
```

The dedicated build writes `dist-iphone-duo/`. The regular `npm run build` includes both the existing site and `iphone-duo.html`.

## No-GLB commitment

The iPhone Duo source, assets, build, and runtime must not include, fetch, parse, or depend on GLB files. This also excludes GLTF/BIN model files, `GLTFLoader`, and a GLB-to-TypeScript encoder. `npm run check:iphone-duo` enforces the file, loader, and removed-encoder checks before either build. It also checks local iPhone Duo work/archive and output directories when present.

External models may be viewed as optional visual references during research. They must not be added as implementation inputs or runtime dependencies. Geometry can instead be authored procedurally from images and measurements; Hyper3D is not required.

### Existing data provenance

This edition retains Apple-source surfaces in `src/iphone-duo/encodedSource.ts` and a provider study in `encodedHyper3d.ts`. Those existing scene descriptions, geometry arrays, and images were derived from converted models before this restriction. They are not GLB containers, but they are also not independently authored procedural geometry. This commitment concerns model files and the supported build/runtime workflow; it does not erase that provenance or claim that GLB was never used historically.

The runtime adds the hinge, connected display, finish controls, lighting, and release motion. Provenance remains in the public manifests. The GLB encoder and its regeneration instructions have been removed. A fully procedural replacement would require a separately authored and visually validated model.

## Validation context

Before reference-file removal, same-renderer comparison covered 120 states (108 static, 10 timeline, and two context-restoration cases), with exact rendered pixels for that paired comparison. All 23 Apple and three Hyper3D embedded images retained their original bytes. These are conversion checks against the supplied model, not a claim of photographic identity to Apple's marketing imagery.

The original reference GLBs are no longer present. That historical comparison is not part of the supported no-GLB workflow; normal build and browser checks use no model reference files.
