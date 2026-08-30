/**
 * Remove clips from the embedded rig.
 *
 * Not a filter in the UI — the keyframes actually go. `rigData.ts` is by far the largest thing this
 * package ships, and a clip that nobody can select is still bytes every visitor downloads, so
 * curating the set is worth doing at the payload rather than at the dropdown.
 *
 * `rigData.ts` is generated output, so this is a repeatable step rather than a hand edit: re-export
 * from the playground and re-run this, and you land in the same place. The list of what to drop is
 * the only thing it takes.
 *
 * It also rewrites the two places the clip list is spelled out by hand — the header comment and
 * `MONSTER_CUTE_CLIPS` — because a stale list there is a lie the type system cannot catch.
 *
 * Run: node tools/run-ts.mjs tools/prune_clips.ts
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import type { EncodedRig } from '../../src/demos/monster-cute/meshCodec';

/** The clips to drop. */
const DROP = new Set([
  'preset:shoot',
  'preset:biped:look_around',
  'preset:biped:cry',
  'preset:biped:frustrated_02',
  'preset:biped:dance_04',
  'preset:biped:dance_05',
  'preset:biped:dance_06',
]);

const rigPath = new URL('../../src/demos/monster-cute/rigData.ts', import.meta.url);
const factoryPath = new URL('../../src/demos/monster-cute/createMonsterCuteModel.ts', import.meta.url);

const before = statSync(rigPath).size;
const source = readFileSync(rigPath, 'utf8');

const marker = 'export const RIG: EncodedRig = ';
const start = source.indexOf(marker);
if (start < 0) throw new Error('rigData.ts: could not find the RIG declaration');
const jsonStart = start + marker.length;
const json = source.slice(jsonStart).replace(/;\s*$/, '').trim();
const rig = JSON.parse(json) as EncodedRig;

const kept = rig.clips.filter((c) => !DROP.has(c.name));
const dropped = rig.clips.filter((c) => DROP.has(c.name));
const missing = [...DROP].filter((name) => !rig.clips.some((c) => c.name === name));
if (missing.length) {
  // Loud rather than silent: a name that matches nothing means the list has drifted from the rig,
  // and quietly pruning six of seven is how a set ends up wrong without anyone noticing.
  throw new Error(`these clips are not in the rig, so the drop list is stale: ${missing.join(', ')}`);
}

rig.clips = kept;

const summary = kept.map((c) => `${c.name} ${c.duration.toFixed(2)}s`).join(', ');
const header = `import type { EncodedRig } from './meshCodec';

/**
 * Skeleton, joint weights and every retargeted clip, embedded — nothing is fetched at runtime.
 *
 * ${rig.bones.length} bones, ${kept.length} clip(s): ${summary}.
 *
 * Keyframes stay Float32 rather than quantised: a quantised quaternion drifts visibly over a loop.
 *
 * CURATED. ${dropped.length} clip(s) were removed from the generated export by tools/prune_clips.ts:
 * ${dropped.map((c) => c.name).join(', ')}.
 */
export const RIG: EncodedRig = `;

writeFileSync(rigPath, `${header}${JSON.stringify(rig)};\n`);
const after = statSync(rigPath).size;

// ---- keep the hand-written clip list in the factory honest ----
let factory = readFileSync(factoryPath, 'utf8');
const listMatch = factory.match(/export const MONSTER_CUTE_CLIPS = \[[^\]]*\] as const;/);
if (!listMatch) throw new Error('createMonsterCuteModel.ts: could not find MONSTER_CUTE_CLIPS');
factory = factory.replace(
  listMatch[0],
  `export const MONSTER_CUTE_CLIPS = [${kept.map((c) => `'${c.name}'`).join(', ')}] as const;`,
);
// And the prose list in the factory's doc comment.
factory = factory.replace(
  /\* The clips shipped here: [^\n]*\n/,
  `* The clips shipped here: ${summary}.\n`,
);
writeFileSync(factoryPath, factory);

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(`dropped ${dropped.length} clip(s):`);
for (const c of dropped) console.log(`  ${c.name.padEnd(28)} ${c.duration.toFixed(2)}s  ${c.tracks.length} tracks`);
console.log(`\nkept ${kept.length} clip(s)`);
console.log(`rigData.ts: ${mb(before)} -> ${mb(after)}  (${(((before - after) / before) * 100).toFixed(1)}% smaller)`);
