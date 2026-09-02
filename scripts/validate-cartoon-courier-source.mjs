import { readFile } from 'node:fs/promises';

const sourcePath = new URL('../src/demos/cartoon-courier/createCartoonCourierHeroModel.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');

const required = [
  'createCartoonCourierHeroModel',
  'createCartoonCourierHeroLookDevLights',
  'Hair_Crown',
  'Eye_L',
  'Jacket_Shell',
  'Scarf_Wrap',
  'Satchel',
  'Boot_L',
  'Boot_R',
  'animationController',
  'sculptRuntime',
];

for (const token of required) {
  if (!source.includes(token)) throw new Error(`Missing required courier source token: ${token}`);
}

if (source.includes('TextureLoader')) {
  throw new Error('Courier hero model must not stretch reference crops as runtime textures.');
}

console.log(`PASS courier hero source contract (${required.length} required systems)`);
