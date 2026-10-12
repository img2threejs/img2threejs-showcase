import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js';

const forbiddenAsset = /\.(?:glb|gltf)(?:[?#]|$)/i;
const codeExtension = /\.(?:ts|tsx|js|mjs)$/;
const slash = (value) => value.split(path.sep).join('/');

async function filesBelow(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = slash(path.join(prefix, entry.name));
    if (entry.isDirectory()) result.push(...await filesBelow(root, name));
    else if (entry.isFile()) result.push(name);
  }
  return result;
}

async function resolveLocal(root, importer, specifier) {
  const target = path.resolve(root, path.dirname(importer), specifier.split('?')[0]);
  if (!target.startsWith(root + path.sep)) throw new Error(`Source dependency leaves repository: ${importer}: ${specifier}`);
  const candidates = [target, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}.json`, path.join(target, 'index.ts')];
  if (target.endsWith('.js')) candidates.push(target.slice(0, -3) + '.ts');
  for (const candidate of candidates) {
    if (await stat(candidate).then((info) => info.isFile(), () => false)) return slash(path.relative(root, candidate));
  }
  throw new Error(`Unresolved source dependency: ${importer}: ${specifier}`);
}

/** Extract the real registry object, never maintain a second list of factories or lighting hooks. */
export async function sourceCatalog(root) {
  const source = await readFile(path.join(root, 'src/demos/registry.ts'), 'utf8');
  const file = ts.createSourceFile('registry.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => item.name.getText(file) === 'authored'));
  if (!declaration) throw new Error('Showcase catalog declaration not found.');
  const array = declaration.declarationList.declarations[0].initializer;
  if (!array || !ts.isArrayLiteralExpression(array)) throw new Error('Showcase catalog must be a literal array.');
  const prefix = source.slice(0, declaration.getStart(file));
  return array.elements.map((entry) => {
    const id = entry.properties.find((property) => property.name?.getText(file) === 'id')?.initializer;
    if (!id || !ts.isStringLiteral(id)) throw new Error('Showcase id must be a string literal.');
    return {
      id: id.text,
      source: `${prefix}export const showcase: CatalogEntry = ${entry.getText(file)};\n\nexport async function loadShowcase(): Promise<DemoEntry> {\n  const { loadRuntime, ...metadata } = showcase;\n  return { ...metadata, ...await loadRuntime() };\n}\n`,
    };
  });
}

/** A ZIP contains one original runtime graph and its assets, not a serialized mesh or the gallery. */
export async function createSourceArchive(root, entry, publicFiles) {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const files = Object.create(null);
  const packages = new Set(['three']);
  const publicAssets = new Set();
  const visited = new Set();
  // Robot segment-color studio is mounted through renderRobotStudio on a WebGPU renderer
  // (with WebGL2 fallback). The generic Viewer uses WebGL and cannot preserve its TSL/WebGPU
  // material nodes, so the robot entry gets its own entry point instead of the shared one.
  const templatePath = entry.id === 'man-robot-studio'
    ? 'scripts/source-package/robot-index.template'
    : 'scripts/source-package/index.template';
  const examplePath = entry.id === 'man-robot-studio'
    ? 'scripts/source-package/robot-example.template'
    : 'scripts/source-package/example.template';
  const template = await readFile(path.join(root, templatePath), 'utf8');
  const example = await readFile(path.join(root, examplePath), 'utf8');

  async function addFile(name, override) {
    if (visited.has(name)) return;
    visited.add(name);
    for (const sibling of await readdir(path.join(root, path.dirname(name)))) {
      if (sibling.endsWith('.d.ts')) await addFile(slash(path.join(path.dirname(name), sibling)));
    }
    if (forbiddenAsset.test(name)) throw new Error(`Binary model dependency prohibited: ${name}`);
    if (!codeExtension.test(name)) {
      files[name] = new Uint8Array(await readFile(path.join(root, name)));
      return;
    }
    const source = override ?? await readFile(path.join(root, name), 'utf8');
    const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    const dependencies = new Set();
    const replacements = [];
    const assetModule = './' + slash(path.relative(path.dirname(name), 'src/source-assets'));
    let usesAssetResolver = false;
    function addSpecifier(specifier) {
      if (specifier.includes('GLTFLoader')) throw new Error(`GLTFLoader is prohibited in source archives: ${name}`);
      if (specifier.startsWith('.')) dependencies.add(specifier);
      else {
        const parts = specifier.split('/');
        packages.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
      }
    }
    function matchPublic(text) {
      const candidate = text.replace(/^\//, '');
      if (!candidate || !/[-/.]/.test(candidate) || candidate.includes(' ') || candidate.includes('\n')) return false;
      const matches = publicFiles.filter((asset) => asset === candidate || asset.startsWith(candidate));
      for (const asset of matches) {
        if (forbiddenAsset.test(asset)) throw new Error(`Binary model asset prohibited: ${name}: ${asset}`);
        publicAssets.add(asset);
      }
      return matches.length > 0;
    }
    // Exact normalized path membership only — no directory-prefix fuzzy match.
    // The whole-binary rewrite of `BASE_URL + 'literal'` must point resolveSourceAsset at
    // a real public file; prefix matches would rewrite a `BASE_URL + 'robot/'` reference
    // into resolveSourceAsset('__SHOWCASE_ASSET__/robot/'), which throws at runtime because
    // the urls map keys individual files, not directories.
    function exactPublicAsset(text) {
      const candidate = text.replace(/^\//, '');
      if (!candidate || candidate.includes(' ') || candidate.includes('\n')) return null;
      const exact = publicFiles.find((asset) => asset === candidate);
      if (exact) {
        if (forbiddenAsset.test(exact)) throw new Error(`Binary model asset prohibited: ${name}: ${exact}`);
        publicAssets.add(exact);
        return exact;
      }
      return null;
    }
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        addSpecifier(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (node.arguments.length === 1 && ts.isStringLiteral(argument)) addSpecifier(argument.text);
        else if (!node.getText(file).includes('@vite-ignore')
          || !file.statements.some((statement) => ts.isImportDeclaration(statement)
            && statement.moduleSpecifier.text.endsWith('?url'))) {
          throw new Error(`Computed dynamic import has no declared URL assets: ${name}`);
        }
      }
      if (ts.isNewExpression(node) && node.expression.getText(file) === 'URL'
        && node.arguments?.length === 2 && ts.isStringLiteral(node.arguments[0])
        && node.arguments[1].getText(file) === 'import.meta.url') {
        if (node.arguments[0].text.startsWith('.')) dependencies.add(node.arguments[0].text);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && (node.expression.name.text === 'load' || node.expression.name.text === 'loadAsync')
        && node.arguments.length > 0) {
        const argument = node.arguments[0];
        // Skip when the argument is a `BASE_URL + 'literal'` concatenation that the
        // binary-expression handler below rewrites as a single resolveSourceAsset call.
        // The skip must use the SAME exact-match condition as that handler, otherwise a
        // dynamic / non-existent tail would slip past the loader wrapper into a raw
        // BASE_URL concatenation that never resolves to a real asset URL.
        const isBaseUrlConcat = ts.isBinaryExpression(argument)
          && argument.operatorToken.kind === ts.SyntaxKind.PlusToken
          && ts.isPropertyAccessExpression(argument.left)
          && argument.left.getText(file) === 'import.meta.env.BASE_URL'
          && (ts.isStringLiteral(argument.right) || ts.isNoSubstitutionTemplateLiteral(argument.right))
          && exactPublicAsset(argument.right.text) !== null;
        if (!isBaseUrlConcat) {
          usesAssetResolver = true;
          replacements.push({ start: argument.getStart(file), end: argument.getStart(file), text: 'resolveSourceAsset(' });
          replacements.push({ start: argument.end, end: argument.end, text: ')' });
        }
      }
      // `import.meta.env.BASE_URL + 'public-asset-path'` becomes
      // resolveSourceAsset('__SHOWCASE_ASSET__/public-asset-path'). The static prefix is
      // only safe to inline when the right-hand tail exactly names a tracked public
      // asset — exactPublicAsset returns null for directory prefixes and unknown paths,
      // leaving the expression alone for the original recursion to handle.
      // Returning early prevents the children from being visited independently and
      // overlapping the replacement range.
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
        && ts.isPropertyAccessExpression(node.left)
        && node.left.getText(file) === 'import.meta.env.BASE_URL'
        && (ts.isStringLiteral(node.right) || ts.isNoSubstitutionTemplateLiteral(node.right))) {
        const exact = exactPublicAsset(node.right.text);
        if (exact !== null) {
          usesAssetResolver = true;
          const fullPath = '__SHOWCASE_ASSET__/' + exact;
          replacements.push({ start: node.getStart(file), end: node.end,
            text: 'resolveSourceAsset(' + JSON.stringify(fullPath) + ')' });
          return;
        }
      }
      if (ts.isPropertyAccessExpression(node) && node.getText(file) === 'import.meta.env.BASE_URL') {
        replacements.push({ start: node.getStart(file), end: node.end, text: JSON.stringify('__SHOWCASE_ASSET__/') });
        return;
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (matchPublic(node.text) && node.text.startsWith('/')) {
          replacements.push({ start: node.getStart(file), end: node.end,
            text: JSON.stringify('__SHOWCASE_ASSET__' + node.text) });
        }
      }
      // BASE-prefixed template paths include a finite static prefix even when the suffix varies.
      if (ts.isTemplateExpression(node)) {
        matchPublic(node.head.text);
        for (const span of node.templateSpans) matchPublic(span.literal.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    let portable = source;
    for (const replacement of replacements.sort((a, b) => b.start - a.start || b.end - a.end)) {
      portable = portable.slice(0, replacement.start) + replacement.text + portable.slice(replacement.end);
    }
    if (usesAssetResolver) portable = `import { resolveSourceAsset } from ${JSON.stringify(assetModule)};\n` + portable;
    files[name] = new TextEncoder().encode(portable);
    for (const dependency of dependencies) await addFile(await resolveLocal(root, name, dependency));
  }

  await addFile('src/demos/registry.ts', entry.source);
  await addFile('src/index.ts', template);
  for (const asset of publicAssets) files[`assets/${asset}`] = new Uint8Array(await readFile(path.join(root, 'public', asset)));
  const dependencies = Object.fromEntries([...packages].sort().map((name) => {
    const version = packageJson.dependencies[name];
    if (!version) throw new Error(`Missing package version for ${name}`);
    return [name, version];
  }));
  const textFile = (name, text) => { files[name] = new TextEncoder().encode(text); };
  textFile('src/source-assets.ts', `// Module-relative URLs let the consumer bundler include dynamic texture names.\nconst urls: Record<string, string> = {\n${[...publicAssets].sort().map((asset) => `  ${JSON.stringify(asset)}: new URL(${JSON.stringify('../assets/' + asset)}, import.meta.url).href,`).join('\n')}\n};\nexport function resolveSourceAsset(url: string): string {\n  const prefix = '__SHOWCASE_ASSET__/';\n  const key = url.startsWith(prefix) ? url.slice(prefix.length) : url;\n  if (key in urls) return urls[key];\n  if (url.startsWith(prefix)) throw new Error('Missing showcase asset: ' + key);\n  return url;\n}\n`);
  textFile('package.json', JSON.stringify({
    name: `@img2threejs/${entry.id}-source`, version: '1.0.0', private: true, type: 'module',
    exports: './src/index.ts', scripts: { dev: 'vite', build: 'tsc --noEmit && vite build' },
    dependencies, devDependencies: { '@types/three': packageJson.devDependencies['@types/three'],
      typescript: packageJson.devDependencies.typescript, vite: packageJson.devDependencies.vite },
  }, null, 2) + '\n');
  textFile('tsconfig.json', JSON.stringify({ compilerOptions: {
    target: 'ES2020', module: 'ESNext', moduleResolution: 'bundler', lib: ['DOM', 'DOM.Iterable', 'ES2020'],
    strict: true, skipLibCheck: true, noEmit: true, resolveJsonModule: true, allowImportingTsExtensions: true,
  }, include: ['src', 'example.ts'] }, null, 2) + '\n');
  textFile('src/vite-env.d.ts', '/// <reference types="vite/client" />\n');
  textFile('index.html', '<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Showcase source</title><style>body{margin:0}#stage{width:100vw;height:100vh}#actions{position:fixed;bottom:1rem;left:1rem;right:1rem;display:flex;flex-wrap:wrap;gap:.5rem;max-height:30vh;overflow:auto}button{padding:.5rem}</style><div id="stage"></div><div id="actions" aria-label="Showcase controls"></div><script type="module" src="./example.ts"></script></html>\n');
  textFile('example.ts', example);
  if (entry.id === 'man-robot-studio') {
    textFile('README.md', `# ${entry.id} — portable Three.js source\n\nThis package contains exactly the Man Robot · Segment Color Studio from img2threejs-showcase, including its WebGPURenderer stage with WebGL2 fallback, TSL/WebGPU material nodes, 23 measured motion clips, per-segment paint layer, green-energy scan VFX, original low-level robot runtime/factory APIs and all six encoded public assets. No GLB/glTF file or GLTFLoader is used: the source mesh and rig are reconstructed at load time from the encoded \`robot3d-threejs-scene-v152.json.gz\` stream plus the offline-generated animation profiles in \`exported-robot-animations.json\`. Encoded geometry/rig streams stay code data, not a GLB hidden inside a loader. Public assets use module-relative URLs; this package does not request assets from the gallery or GitHub.\n\n## Run the included example\n\n\`npm install\`, then \`npm run dev\`. For a production build run \`npm run build\`. Use a web server, not file://. Requires a browser with WebGPU support (Chrome/Edge on desktop or any browser with WebGPU enabled) and falls back to WebGL2 when WebGPU is unavailable. Three.js version ${dependencies.three}; the host and package must share one compatible Three.js instance.\n\n## What the studio mounts\n\n\`mountShowcase(host)\` calls \`renderRobotStudio(host, await loadShowcase())\`. The studio renders the same DOM as the gallery: top bar, segment list, motion library, color picker, reset view, rotate toggle and animation playback row. The export/source-download section is intentionally hidden — the gallery's exporter module owns interchange exports and the source-ZIP download; this portable runtime is a pure viewer.\n\nFor an existing WebGPU renderer, import the low-level factory APIs directly: \`createRobotModel(scene, onProgress?)\` returns the display Group; \`waitForRobotModel(displayRoot)\` resolves to a \`RobotRuntime\` carrying the meshes, mixer, clips, segmentation, originalVertexColors, segment color setters and motion correction hooks. \`loadRobotAsset\`, \`loadRobotGreetingClips\` and \`loadRobotExportedAnimationClips\` are exposed for advanced consumers; \`prewarmRobotModel\` is the gallery's prewarm entry.\n\n## Import into another project\n\nCopy \`src/\` AND \`assets/\` together, preserving relative paths. Install the dependencies in package.json. Import \`mountShowcase\` from \`./path/to/src/index\` and call \`await mountShowcase(container)\` on a sized HTMLElement. The returned handle matches the generic portable package shape (\`{ dispose }\`); call \`asset.dispose()\` to tear down the renderer, mixer and event listeners on unmount. The original \`renderRobotStudio\` and every low-level robot API remain reachable from \`./path/to/src/index\`.\n\nAll 23 measured clips (16 source clips, 6 exported retargeted clips and 1 greeting collection) are retained along with the original positions/normals/UVs/texture map and the per-segment colour layer. Source provenance and attribution comments are preserved. Third-party reference/texture rights remain the user's responsibility; this download does not grant additional rights.\n`);
  } else {
    textFile('README.md', `# ${entry.id} — portable Three.js source\n\nThis package contains exactly one showcase from img2threejs-showcase, its original TypeScript dependency graph, shaders, animation/controller/VFX code, encoded data and required image/JSON assets. No GLB/glTF file or GLTFLoader is used. Encoded geometry/rig streams remain code data, not a GLB hidden inside a loader. Public assets use module-relative URLs; this package does not request assets from the gallery or GitHub.\n\n## Run the included example\n\n\`npm install\`, then \`npm run dev\`. For a production build run \`npm run build\`. Use a web server, not file://. Requires a browser with WebGL and a TypeScript-aware bundler supporting standard asset imports and new URL(..., import.meta.url), such as Vite. Three.js version ${dependencies.three}; the host and package must share one compatible Three.js instance.\n\n## Import into another project\n\nCopy \`src/\` AND \`assets/\` together, preserving relative paths. Install the dependencies in package.json. Import \`mountShowcase\` from \`./path/to/src/index\` and call \`await mountShowcase(container)\` on a sized HTMLElement. The returned \`viewer\` owns the render loop, stage interactions and cleanup; call \`asset.dispose()\` on unmount. The included example exposes every declared animation and strike-element controller, plus outfit switching when available. Quality options and game controls remain in the original source modules.\n\nFor an existing Three.js scene, import \`createShowcase\` and use \`const asset = await createShowcase(scene)\`. Each frame call \`asset.update(dtSeconds, elapsedSeconds)\`, then \`asset.prepareRender()\` once before your main render. Do NOT also run asset.update with mountShowcase: its viewer already advances the tickers. \`asset.model\` is the original Group. \`asset.runtime\` exposes the original animationController, strikeVfx and other authored APIs. Camera-dependent game/interaction hooks require the included Viewer; use mountShowcase for the complete stage experience or adapt those hooks to your engine. Own scene resources/teardown when using createShowcase directly.\n\nThis exports authored code, not the current posed/isolated asset scope. All quality levels and animations reachable from this showcase are included. It does not add animations to static showcases. Source provenance and attribution comments are retained. Third-party reference/texture rights remain the user's responsibility; this download does not grant additional rights.\n`);
  }
  textFile('manifest.json', JSON.stringify({ showcase: entry.id, entry: 'src/index.ts',
    runtime: 'native-threejs-source', glbDependency: false, dependencies,
    files: [...Object.keys(files), 'manifest.json'].sort() }, null, 2) + '\n');
  return zipSync(files, { level: 6 });
}

export function sourceArchivesPlugin() {
  let root;
  let outDir;
  let productionBuild = false;
  return {
    name: 'showcase-source-archives',
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(root, config.build.outDir);
      productionBuild = config.command === 'build';
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        const match = /\/source\/([a-z0-9-]+)\.zip$/.exec(pathname);
        if (!match) return next();
        try {
          const entry = (await sourceCatalog(root)).find((candidate) => candidate.id === match[1]);
          if (!entry) { response.statusCode = 404; response.end('Unknown showcase'); return; }
          const archive = await createSourceArchive(root, entry, await filesBelow(path.join(root, 'public')));
          response.setHeader('Content-Type', 'application/zip');
          response.setHeader('Content-Disposition', `attachment; filename="${entry.id}-source.zip"`);
          response.end(archive);
        } catch (error) { response.statusCode = 500; response.end(String(error)); }
      });
    },
    async closeBundle() {
      if (!productionBuild) return;
      const entries = await sourceCatalog(root);
      const publicFiles = await filesBelow(path.join(root, 'public'));
      await mkdir(path.join(outDir, 'source'), { recursive: true });
      for (const entry of entries) {
        const archive = await createSourceArchive(root, entry, publicFiles);
        await writeFile(path.join(outDir, 'source', `${entry.id}.zip`), archive);
      }
      console.log(`Source archives: ${entries.length} portable Three.js showcases`);
    },
  };
}

// Regenerate archives without rebuilding the already-built gallery.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const plugin = sourceArchivesPlugin();
  plugin.configResolved({ root, command: 'build', build: { outDir: 'dist' } });
  await plugin.closeBundle();
}
