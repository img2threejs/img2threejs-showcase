import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const moduleURL = (javascript) => `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`;
const threeURL = JSON.stringify(import.meta.resolve('three'));
const threeExampleURL = (path) => JSON.stringify(import.meta.resolve(`three/examples/jsm/${path}`));
const compiled = new Map();
async function compile(name) {
  const source = await readFile(new URL(`../../src/demos/tropical-island/${name}.ts`, import.meta.url), 'utf8');
  let javascript = ts.transpileModule(source, { compilerOptions: options }).outputText;
  // Rewrite bare 'three' and 'three/examples/...' specifiers to absolute file:// URLs.
  javascript = javascript.replace(/from ['"]three\/examples\/jsm\/([^'"]+)['"]/g, (_match, sub) => `from ${threeExampleURL(sub)}`);
  javascript = javascript.replace(/from ['"]three['"]/g, `from ${threeURL}`);
  for (const [dependency, url] of compiled) {
    javascript = javascript.replace(
      new RegExp(`from ['"]\\./${dependency}['"]`, 'g'),
      `from ${JSON.stringify(url)}`,
    );
  }
  return moduleURL(javascript);
}

// Runtime dependencies shared by the physics modules, in dependency order.
for (const name of [
  'incidentWaves', 'waterEntryDynamics', 'entryWaterOptics',
  'entrySplash', 'meteorTrail', 'entrySteam',
]) compiled.set(name, await compile(name));

export async function loadPhysicsModule(name) {
  let url = compiled.get(name);
  if (!url) {
    url = await compile(name);
    compiled.set(name, url);
  }
  return import(url);
}
