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

## Optional references

GLB is an optional reference format, not a prerequisite for the workflow. Geometry can be authored procedurally from images and measurements. Hyper3D is also optional; its static study was evaluated during exploration and was not selected for the articulated model.

This edition preserves Apple-source surfaces in `src/iphone-duo/encodedSource.ts` and the optional provider study in `encodedHyper3d.ts`. These are source-derived scene data, not independently authored procedural geometry. The runtime adds the hinge, connected display, finish controls, lighting, and release motion. Provenance is recorded in `public/iphone-duo/apple-official-manifest.json` and `public/iphone-duo/providers/manifest.json`.

No iPhone Duo GLB, GLTF, or BIN files are included or needed to install, build, or run. The runtime decodes embedded scene data with `ObjectLoader`. Historical source hashes identify reference inputs; the original GLB files and all local archive/baseline copies were removed.

## Optional offline encoding

Only use the encoder when intentionally replacing the embedded reference data. It is not run by installation or either build command. Keep any reference file outside the repository.

Start the dedicated dev server on port 5274 and, in another terminal, supply an external reference explicitly:

```sh
npm run dev:iphone-duo -- --port 5274
# In another terminal, after separately installing Playwright:
node scripts/encode-iphone-duo-source.mjs /absolute/path/to/apple-reference.glb
node scripts/encode-iphone-duo-source.mjs hyper3d /absolute/path/to/provider-reference.glb
```

`IPHONE_DUO_PLAYWRIGHT_MODULE` can point to an existing Playwright module. `IPHONE_DUO_ENCODER_URL` can select another running dev server. The input must be a self-contained GLB with embedded images and the expected source structure. The encoder reads it in place and overwrites the corresponding encoded TypeScript module. Review and validate that output before committing it; an arbitrary replacement may require model-specific mapping changes.

A procedural implementation can replace the model factory while retaining the scene controls and release timing. It needs its own visual validation; encoding a reference does not establish independently authored geometry.

## Validation context

Before reference-file removal, same-renderer comparison covered 120 states (108 static, 10 timeline, and two context-restoration cases), with exact rendered pixels for that paired comparison. All 23 Apple and three Hyper3D embedded images retained their original bytes. These are conversion checks against the supplied model, not a claim of photographic identity to Apple's marketing imagery.

The original reference GLBs are no longer present. Repeating the historical paired comparison requires separately supplied references; normal build and browser checks do not.
