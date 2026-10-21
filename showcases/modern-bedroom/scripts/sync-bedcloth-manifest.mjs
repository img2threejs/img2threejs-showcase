// Syncs public/assets/interior/manifest.json's bedCloth block from scene-spec.json's
// runtime.bedCloth, exactly as pipeline.stage_export does: the spec is the single source of truth.
//
// Only the bedCloth block is rewritten. Every other manifest key is left byte-identical, and each
// number keeps the literal spelling the manifest already used for that key (0.0, 1.0), so the diff
// shows the block and nothing else.
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const specPath = `${ROOT}scene-spec.json`;
const manifestPath = `${ROOT}public/assets/interior/manifest.json`;

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const manifestText = readFileSync(manifestPath, 'utf8');

if (!spec.runtime?.bedCloth) throw new Error('scene-spec.json has no runtime.bedCloth block to export.');
const block = spec.runtime.bedCloth;

// Locate the top-level "bedCloth" key and its matching closing brace.
const keyIndex = manifestText.indexOf('\n  "bedCloth": {');
if (keyIndex < 0) throw new Error('manifest.json has no top-level "bedCloth" block.');
const start = manifestText.indexOf('{', keyIndex);
let depth = 0, end = -1;
for (let i = start; i < manifestText.length; i++) {
  const ch = manifestText[i];
  if (ch === '"') { i = manifestText.indexOf('"', i + 1); while (manifestText[i + 1] === '\\') i = manifestText.indexOf('"', i + 2); continue; }
  if (ch === '{') depth++;
  else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
}
if (end < 0) throw new Error('manifest.json "bedCloth" block is not closed.');
const oldBlockText = manifestText.slice(start, end + 1);

// Collect the literal spelling of every number in the old block, keyed by its JSON path.
function collectLiterals(text) {
  const literals = new Map();
  let i = 0;
  const path = [];
  function ws() { while (i < text.length && /\s/.test(text[i])) i++; }
  function readValue() {
    ws();
    const ch = text[i];
    if (ch === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws();
        const keyStart = i;
        while (text[i] !== '"') i++;
        const key = JSON.parse(text.slice(keyStart, text.indexOf('"', i + 1) + 1));
        i = text.indexOf('"', i + 1) + 1; ws();
        i++; // ':'
        path.push(key);
        readValue();
        path.pop();
        ws();
        if (text[i] === ',') { i++; continue; }
        i++; // '}'
        return;
      }
    }
    if (ch === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      for (let index = 0; ; index++) {
        path.push(String(index));
        readValue();
        path.pop();
        ws();
        if (text[i] === ',') { i++; continue; }
        i++; // ']'
        return;
      }
    }
    if (ch === '"') {
      i++;
      while (text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      i++;
      return;
    }
    if (text.startsWith('true', i) || text.startsWith('false', i) || text.startsWith('null', i)) {
      while (i < text.length && /[a-z]/.test(text[i])) i++;
      return;
    }
    const numberStart = i;
    while (i < text.length && /[-+0-9.eE]/.test(text[i])) i++;
    const raw = text.slice(numberStart, i);
    if (raw) literals.set(path.join('.'), raw);
  }
  readValue();
  return literals;
}
const literals = collectLiterals(oldBlockText);

// Render the block exactly like JSON.stringify(value, null, 2), but with the manifest's own number
// spelling for each key. The block's top level sits at 2 spaces, so its children are at 4 and the
// deepest at 12.
function render(value, path, indent) {
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  if (typeof value === 'number') {
    const raw = literals.get(path.join('.'));
    return raw !== undefined && Number(raw) === value ? raw : String(value);
  }
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const items = value.map((item, index) => `${inner}${render(item, [...path, String(index)], indent + 2)}`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    const items = entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${render(item, [...path, key], indent + 2)}`);
    return `{\n${items.join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}
const text = render(block, [], 2);
const replacement = `  "bedCloth": ${text}`;

const next = manifestText.slice(0, keyIndex + 1) + replacement + manifestText.slice(end + 1);
if (next === manifestText) { console.log('manifest.bedCloth already matches scene-spec.json.'); process.exit(0); }

// Guard: the rest of the manifest must be untouched, and the new block must be the spec's block.
const before = JSON.parse(manifestText), after = JSON.parse(next);
for (const key of Object.keys(before)) {
  if (key === 'bedCloth') continue;
  if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) throw new Error(`manifest key "${key}" changed; only bedCloth may be rewritten.`);
}
if (JSON.stringify(after.bedCloth) !== JSON.stringify(block)) throw new Error('manifest.bedCloth does not match the spec block.');

writeFileSync(manifestPath, next);
console.log(`manifest.bedCloth synced from scene-spec.json runtime.bedCloth (${block.cloths.length} cloths).`);
for (const cloth of block.cloths) console.log(`  ${cloth.id}: fixed=${cloth.fixed === true ? 'true' : 'absent'}`);
