// Shared decoder for the offline analyses: pulls the embedded surface + rig out of the TS modules
// without a bundler, so measurement scripts run under plain node.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('src/demos/van-hi');

function jsonAfter(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) throw new Error(`marker not found: ${marker}`);
  const start = text.indexOf('{', i);
  // The generated modules end each export with `};` on its own; find the matching close by depth,
  // skipping anything inside a string so a brace in base64 (there is none) or a comment cannot lie.
  let depth = 0, inStr = false, esc = false;
  for (let p = start; p < text.length; p += 1) {
    const c = text[p];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return JSON.parse(text.slice(start, p + 1)); }
  }
  throw new Error(`unbalanced object after ${marker}`);
}

function stringAfter(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) throw new Error(`marker not found: ${marker}`);
  const q = text.indexOf("'", i) >= 0 && (text.indexOf("'", i) < text.indexOf('"', i) || text.indexOf('"', i) < 0)
    ? "'" : '"';
  const start = text.indexOf(q, i) + 1;
  const end = text.indexOf(q, start);
  return text.slice(start, end);
}

export function loadSurface() {
  const text = fs.readFileSync(path.join(DIR, 'surfaceData.high.ts'), 'utf8');
  return { model: jsonAfter(text, 'SURFACE_MODEL'), stream: stringAfter(text, 'SURFACE_STREAM') };
}

export function loadRig() {
  const text = fs.readFileSync(path.join(DIR, 'rigData.ts'), 'utf8');
  return jsonAfter(text, 'export const RIG');
}

function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }

export function decodeModel(model, base64) {
  const stream = Buffer.from(base64, 'base64');
  const { origin, extent } = model.quantization;
  let at = 0;
  const readVarint = () => {
    let value = 0, shift = 1;
    for (;;) {
      const byte = stream[at]; at += 1;
      value += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) return value;
      shift *= 128;
    }
  };
  const out = [];
  for (const meta of model.parts) {
    const n = meta.vertexCount, t = meta.triangleCount;
    const position = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i += 1) {
      const q = stream[at] | (stream[at + 1] << 8); at += 2;
      position[i] = origin[i % 3] + (q / 65535) * extent[i % 3];
    }
    const normal = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      const packed = stream[at] | (stream[at + 1] << 8); at += 2;
      let x = ((packed & 0xff) / 255) * 2 - 1, y = ((packed >> 8) / 255) * 2 - 1;
      const z = 1 - Math.abs(x) - Math.abs(y);
      if (z < 0) { const ox = x; x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1); y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1); }
      const len = Math.hypot(x, y, z) || 1;
      normal[i * 3] = x / len; normal[i * 3 + 1] = y / len; normal[i * 3 + 2] = z / len;
    }
    const colour = new Float32Array(n * 3);
    const srgb = new Uint8Array(n * 3);
    for (let i = 0; i < n * 3; i += 1) { srgb[i] = stream[at]; colour[i] = srgbToLinear(stream[at] / 255); at += 1; }
    const index = new Uint32Array(t * 3);
    let prev = 0;
    for (let i = 0; i < t * 3; i += 1) {
      const raw = readVarint();
      prev += raw % 2 === 0 ? raw / 2 : -(raw + 1) / 2;
      index[i] = prev;
    }
    out.push({ meta, position, normal, colour, srgb, index });
  }
  if (at !== stream.length) throw new Error(`consumed ${at} of ${stream.length}`);
  return out;
}

export function decodeUint16s(b64) {
  const bytes = Buffer.from(b64, 'base64');
  return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}
export function decodeFloats(b64) {
  const bytes = Buffer.from(b64, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
