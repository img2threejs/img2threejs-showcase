// Original procedural street environment for the robot-cinematic street film.
// Quiet Vietnamese-inspired neighbourhood street at late-afternoon golden hour.
// Y up, world metres, street along Z. Everything static is built once at factory time;
// update() only moves the sun/shadow window with the robot.
export function createStreetWorld(THREE, scene) {
  const root = new THREE.Group();
  root.name = 'street-world';
  scene.add(root);
  const addGroup = (name) => { const g = new THREE.Group(); g.name = name; root.add(g); return g; };
  const gGround = addGroup('street-ground');
  const gDecals = addGroup('street-surface-detail');
  const gBuildings = addGroup('street-architecture-primary');
  const gDistant = addGroup('street-architecture-distant');

  // ------------------------------------------------------------------ helpers
  const mulberry = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const rnd = mulberry(240917);
  const R = (a, b) => a + (b - a) * rnd();
  const RI = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  const chance = (p) => rnd() < p;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const hash2 = (x, y, s) => {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const vnoise = (x, y, s) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
  const mulc = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const WHITE = [1, 1, 1];

  // ------------------------------------------------------------------ canvas / texture helpers
  const makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const toTex = (canvas, srgb = true, repeat = true) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    if (repeat) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping; }
    t.anisotropy = 8;
    return t;
  };
  const rgbCanvas = (N, rgb, M = N) => {
    const c = makeCanvas(N, M), ctx = c.getContext('2d'), img = ctx.createImageData(N, M), d = img.data;
    for (let i = 0, n = N * M; i < n; i++) {
      d[i * 4] = clamp(rgb[i * 3], 0, 1) * 255; d[i * 4 + 1] = clamp(rgb[i * 3 + 1], 0, 1) * 255;
      d[i * 4 + 2] = clamp(rgb[i * 3 + 2], 0, 1) * 255; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  };
  const grayCanvas = (N, g) => {
    const c = makeCanvas(N, N), ctx = c.getContext('2d'), img = ctx.createImageData(N, N), d = img.data;
    for (let i = 0, n = N * N; i < n; i++) { const v = clamp(g[i], 0, 1) * 255; d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    return c;
  };
  const normalCanvas = (h, N, strength) => {
    const c = makeCanvas(N, N), ctx = c.getContext('2d'), img = ctx.createImageData(N, N), d = img.data;
    for (let y = 0; y < N; y++) {
      const ym = ((y - 1 + N) % N) * N, yp = ((y + 1) % N) * N, y0 = y * N;
      for (let x = 0; x < N; x++) {
        const xm = (x - 1 + N) % N, xp = (x + 1) % N;
        const nx = (h[y0 + xm] - h[y0 + xp]) * strength, ny = (h[yp + x] - h[ym + x]) * strength;
        const l = Math.sqrt(nx * nx + ny * ny + 1), i = (y0 + x) * 4;
        d[i] = (nx / l * 0.5 + 0.5) * 255; d[i + 1] = (ny / l * 0.5 + 0.5) * 255; d[i + 2] = (1 / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  };
  // Tileable fractal value noise, 0..1.
  const fbmField = (n, basePeriod, octaves, seed) => {
    const out = new Float32Array(n * n);
    let amp = 1, total = 0, period = basePeriod;
    for (let o = 0; o < octaves; o++) {
      const rg = mulberry(seed + o * 101), g = new Float32Array(period * period);
      for (let i = 0; i < g.length; i++) g[i] = rg();
      const step = period / n;
      for (let y = 0; y < n; y++) {
        const fy = y * step, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
        const ya = (y0 % period) * period, yb = ((y0 + 1) % period) * period;
        for (let x = 0; x < n; x++) {
          const fx = x * step, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
          const xa = x0 % period, xb = (x0 + 1) % period;
          const a = g[ya + xa], b = g[ya + xb], c = g[yb + xa], d = g[yb + xb];
          out[y * n + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
        }
      }
      total += amp; amp *= 0.5; period *= 2;
    }
    for (let i = 0; i < out.length; i++) out[i] /= total;
    return out;
  };
  const walk = (N, r, steps, step, fn) => {
    let x = r() * N, y = r() * N, a = r() * 6.2832;
    for (let s = 0; s < steps; s++) {
      a += (r() - 0.5) * 0.7; x += Math.cos(a) * step; y += Math.sin(a) * step;
      fn((((x | 0) % N) + N) % N, (((y | 0) % N) + N) % N, s / steps);
    }
  };

  // ------------------------------------------------------------------ ground textures
  const genAsphalt = () => {
    const N = 1024, r = mulberry(7001);
    const macro = fbmField(N, 4, 5, 701), meso = fbmField(N, 24, 3, 733);
    const rgb = new Float32Array(N * N * 3), h = new Float32Array(N * N), rg = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      const base = 0.39 + (macro[i] - 0.5) * 0.10 + (meso[i] - 0.5) * 0.06 + (r() - 0.5) * 0.07;
      rgb[i * 3] = base + 0.008; rgb[i * 3 + 1] = base + 0.003; rgb[i * 3 + 2] = base - 0.004;
      h[i] = r() * 0.12 + meso[i] * 0.1; rg[i] = 0.92 + (r() - 0.5) * 0.08;
    }
    for (let s = 0; s < 15000; s++) {
      const cx = (r() * N) | 0, cy = (r() * N) | 0, rad = 1.1 + Math.pow(r(), 2.2) * 4.4, t = r();
      let c;
      if (t < 0.42) { const g = 0.42 + r() * 0.24; c = [g + 0.01, g, g - 0.015]; }
      else if (t < 0.74) { const g = 0.30 + r() * 0.14; c = [g + 0.01, g, g - 0.01]; }
      else if (t < 0.92) { const g = 0.14 + r() * 0.12; c = [g, g, g]; }
      else c = [0.48 + r() * 0.1, 0.40 + r() * 0.08, 0.30 + r() * 0.06];
      const Rr = Math.ceil(rad), ht = 0.35 + r() * 0.5;
      for (let dy = -Rr; dy <= Rr; dy++) for (let dx = -Rr; dx <= Rr; dx++) {
        const d2 = (dx * dx + dy * dy) / (rad * rad);
        if (d2 >= 1) continue;
        const i = ((cy + dy + N) % N) * N + ((cx + dx + N) % N), dome = 1 - d2, a = Math.min(1, dome * 3), sh = 0.82 + 0.3 * dome;
        for (let k = 0; k < 3; k++) rgb[i * 3 + k] = rgb[i * 3 + k] * (1 - a) + c[k] * sh * a;
        if (dome * ht + 0.1 > h[i]) h[i] = dome * ht + 0.1;
        rg[i] = 0.92 - 0.2 * a;
      }
    }
    return { map: toTex(rgbCanvas(N, rgb)), normal: toTex(normalCanvas(h, N, 5), false), rough: toTex(grayCanvas(N, rg), false) };
  };
  const genPavers = () => {
    const N = 1024, P = 256, r = mulberry(7101);
    const mott = fbmField(N, 8, 4, 711), fine = fbmField(N, 64, 2, 712);
    const rgb = new Float32Array(N * N * 3), h = new Float32Array(N * N), rg = new Float32Array(N * N);
    const tone = [];
    for (let k = 0; k < 16; k++) {
      let g = 0.56 + (r() - 0.5) * 0.07, tint = [0, 0, 0]; const t = r();
      if (t < 0.12) { tint = [0.05, -0.02, -0.05]; g -= 0.03; } else if (t < 0.22) g -= 0.08;
      tone.push([g, tint]);
    }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x, px = x % P, py = y % P, e = Math.min(px, py, P - 1 - px, P - 1 - py);
      const [g, tint] = tone[((y / P) | 0) * 4 + ((x / P) | 0)];
      let v = g + (mott[i] - 0.5) * 0.09 + (r() - 0.5) * 0.05, hh = 1, ro = 0.86;
      if (e < 4) { v = 0.27 + (r() - 0.5) * 0.05; hh = 0; ro = 1; }
      else if (e < 10) { const t = (e - 4) / 6; hh = t; v *= 0.92 + 0.08 * t; }
      else { hh = 1 + (fine[i] - 0.5) * 0.12; if (r() < 0.004) { v *= 0.7; hh -= 0.3; } }
      rgb[i * 3] = v + tint[0] + 0.006; rgb[i * 3 + 1] = v + tint[1] + 0.003; rgb[i * 3 + 2] = v + tint[2] - 0.004;
      h[i] = hh; rg[i] = ro;
    }
    for (let c = 0; c < 8; c++) walk(N, r, 170, 1.7, (x, y) => {
      for (let o = 0; o < 2; o++) { const i = y * N + ((x + o) % N); rgb[i * 3] = 0.2; rgb[i * 3 + 1] = 0.2; rgb[i * 3 + 2] = 0.2; h[i] = 0; rg[i] = 1; }
    });
    for (let i = 0; i < h.length; i++) h[i] *= 0.5;
    return { map: toTex(rgbCanvas(N, rgb)), normal: toTex(normalCanvas(h, N, 4), false), rough: toTex(grayCanvas(N, rg), false) };
  };
  const genCurb = () => {
    const N = 512, r = mulberry(7151), m = fbmField(N, 6, 4, 751);
    const rgb = new Float32Array(N * N * 3);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x; let v = 0.66 + (m[i] - 0.5) * 0.12 + (r() - 0.5) * 0.06;
      if (x < 3 || x > N - 2) v *= 0.45;                       // joint
      const fromBottom = (N - y) / N;                          // v = 0 at the canvas bottom: grimy gutter side
      if (fromBottom < 0.2) v *= 0.62 + 1.9 * fromBottom;
      rgb[i * 3] = v + 0.004; rgb[i * 3 + 1] = v; rgb[i * 3 + 2] = v - 0.006;
    }
    return toTex(rgbCanvas(N, rgb));
  };
  const genFineAsphalt = (N, base, seed, warm) => {
    const r = mulberry(seed), rgb = new Float32Array(N * N * 3), m = fbmField(N, 4, 3, seed + 3);
    for (let i = 0; i < N * N; i++) { const v = base + (m[i] - 0.5) * 0.06 + (r() - 0.5) * 0.06; rgb[i * 3] = v + warm; rgb[i * 3 + 1] = v; rgb[i * 3 + 2] = v - warm * 0.6; }
    for (let s = 0; s < N * 3; s++) {
      const cx = (r() * N) | 0, cy = (r() * N) | 0, rad = 0.8 + r() * 2, g = base + (r() - 0.35) * 0.3;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx * dx + dy * dy < rad * rad) {
        const i = ((cy + dy + N) % N) * N + ((cx + dx + N) % N); rgb[i * 3] = g; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = g;
      }
    }
    return toTex(rgbCanvas(N, rgb));
  };
  const genWornPaint = () => {
    const W = 128, H = 1024, c = makeCanvas(W, H), ctx = c.getContext('2d'), img = ctx.createImageData(W, H), d = img.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const edge = Math.min(x, W - 1 - x) / 7, e = clamp(edge, 0, 1);
      let a = 0.96 - 0.6 * vnoise(x * 0.05, y * 0.012, 5) - 0.32 * vnoise(x * 0.4, y * 0.3, 8) - (1 - e) * 0.5 * hash2(x, y, 3);
      a = clamp(a, 0.12, 1);
      const i = (y * W + x) * 4; d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = a * 255;
    }
    ctx.putImageData(img, 0, 0);
    return toTex(c, true, false);
  };
  const genTactile = () => {
    const c = makeCanvas(128, 128), ctx = c.getContext('2d');
    ctx.fillStyle = '#c8a636'; ctx.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const g = ctx.createRadialGradient(16 + x * 32 - 3, 16 + y * 32 - 3, 1, 16 + x * 32, 16 + y * 32, 10);
      g.addColorStop(0, '#e6c85a'); g.addColorStop(1, '#8e7422'); ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(16 + x * 32, 16 + y * 32, 9, 0, 6.2832); ctx.fill();
    }
    const t = toTex(c); return t;
  };
  // Decal atlas: 4x4 cells of 256.
  const genDecals = () => {
    const c = makeCanvas(1024, 1024), ctx = c.getContext('2d'), r = mulberry(7401);
    const cell = (i) => [(i % 4) * 256, ((i / 4) | 0) * 256];
    const crack = (i, branches) => {
      const [ox, oy] = cell(i); ctx.save(); ctx.translate(ox, oy); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const trunk = (x, y, a, len, wd) => {
        ctx.beginPath(); ctx.moveTo(x, y);
        for (let s = 0; s < len; s++) { a += (r() - 0.5) * 0.55; x += Math.cos(a) * 4; y += Math.sin(a) * 4; ctx.lineTo(x, y); }
        ctx.lineWidth = wd; ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.stroke();
        return [x, y, a];
      };
      let x = 12, y = 120 + r() * 20, a = r() * 0.4 - 0.2;
      const pts = [];
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let s = 0; s < 58; s++) { a += (r() - 0.5) * 0.5; x += Math.cos(a) * 4; y += Math.sin(a) * 4; ctx.lineTo(x, y); if (s % 6 === 0) pts.push([x, y, a]); }
      ctx.lineWidth = 2.2; ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.stroke();
      for (let b = 0; b < branches; b++) { const p = pts[(r() * pts.length) | 0]; trunk(p[0], p[1], p[2] + (r() < 0.5 ? 1 : -1) * (0.7 + r() * 0.6), 6 + ((r() * 14) | 0), 1.2); }
      ctx.restore();
    };
    crack(0, 1); crack(1, 4); crack(2, 3);
    { // oil / damp stain
      const [ox, oy] = cell(3);
      for (let k = 0; k < 9; k++) {
        const x = ox + 70 + r() * 120, y = oy + 70 + r() * 120, rad = 20 + r() * 44, g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, 'rgba(255,255,255,0.45)'); g.addColorStop(0.6, 'rgba(255,255,255,0.2)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      }
    }
    const leaves = (i, n) => {
      const [ox, oy] = cell(i);
      const cols = ['#8a6a2c', '#a4792f', '#6b6a2b', '#5a4a2a', '#b08a3c', '#7a5530'];
      for (let k = 0; k < n; k++) {
        const x = ox + 20 + r() * 216, y = oy + 20 + r() * 216, a = r() * 6.28, L = 6 + r() * 8;
        ctx.save(); ctx.translate(x, y); ctx.rotate(a); ctx.fillStyle = cols[(r() * cols.length) | 0];
        ctx.beginPath(); ctx.ellipse(0, 0, L, L * 0.45, 0, 0, 6.2832); ctx.fill();
        ctx.strokeStyle = 'rgba(40,30,15,0.6)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-L, 0); ctx.lineTo(L, 0); ctx.stroke(); ctx.restore();
      }
    };
    leaves(4, 46); leaves(5, 22);
    { // dirt / sand smear
      const [ox, oy] = cell(6);
      ctx.save(); ctx.beginPath(); ctx.rect(ox, oy, 256, 256); ctx.clip();
      for (let k = 0; k < 50; k++) {
        const x = ox + r() * 256, y = oy + 110 + r() * 36 + Math.sin(k) * 10, rad = 14 + r() * 30, g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, 'rgba(120,96,64,0.30)'); g.addColorStop(1, 'rgba(120,96,64,0)'); ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      }
      ctx.restore();
    }
    { // gravel
      const [ox, oy] = cell(7);
      for (let k = 0; k < 160; k++) {
        const x = ox + r() * 256, y = oy + r() * 256, d = Math.hypot(x - ox - 128, y - oy - 128) / 128; if (d > 1) continue;
        const g = 90 + r() * 90; ctx.fillStyle = `rgba(${g},${g * 0.95},${g * 0.85},${0.9 * (1 - d * 0.7)})`; ctx.beginPath(); ctx.arc(x, y, 1 + r() * 2.2, 0, 6.2832); ctx.fill();
      }
    }
    { // manhole cover
      const [ox, oy] = cell(8), cx = ox + 128, cy = oy + 128;
      let g = ctx.createRadialGradient(cx, cy, 80, cx, cy, 118); g.addColorStop(0, '#3b3a38'); g.addColorStop(1, '#262523');
      ctx.fillStyle = '#1c1b1a'; ctx.beginPath(); ctx.arc(cx, cy, 122, 0, 6.2832); ctx.fill();
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, 112, 0, 6.2832); ctx.fill();
      ctx.strokeStyle = 'rgba(150,145,138,0.5)'; ctx.lineWidth = 3;
      for (let k = -4; k <= 4; k++) { ctx.beginPath(); ctx.moveTo(cx - 100, cy + k * 22); ctx.lineTo(cx + 100, cy + k * 22 + 0); ctx.stroke(); }
      ctx.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < 60; k++) { ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.arc(cx + (r() - 0.5) * 220, cy + (r() - 0.5) * 220, 3 + r() * 6, 0, 6.2832); ctx.fill(); }
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(120,70,40,0.35)'; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(cx, cy, 116, 0.2, 2.4); ctx.stroke();
    }
    { // storm grate
      const [ox, oy] = cell(9);
      ctx.fillStyle = '#1b1a19'; ctx.fillRect(ox + 8, oy + 40, 240, 176);
      ctx.fillStyle = '#0a0908'; for (let k = 0; k < 9; k++) ctx.fillRect(ox + 20, oy + 52 + k * 17, 216, 9);
      ctx.fillStyle = '#4a4743'; ctx.fillRect(ox + 8, oy + 40, 240, 5); ctx.fillRect(ox + 8, oy + 211, 240, 5);
      ctx.strokeStyle = '#5d5953'; ctx.lineWidth = 3; ctx.strokeRect(ox + 9, oy + 41, 238, 174);
    }
    { // tyre scuff arcs
      const [ox, oy] = cell(10);
      for (let k = 0; k < 3; k++) {
        ctx.strokeStyle = `rgba(255,255,255,${0.14 - k * 0.03})`; ctx.lineWidth = 14 - k * 3;
        ctx.beginPath(); ctx.moveTo(ox + 10, oy + 60 + k * 50); ctx.quadraticCurveTo(ox + 128, oy + 100 + k * 40, ox + 246, oy + 70 + k * 60); ctx.stroke();
      }
    }
    return toTex(c, true, false);
  };

  // ------------------------------------------------------------------ facade / material textures
  const genPlaster = () => {
    const N = 1024, r = mulberry(7201);
    const a = fbmField(N, 3, 5, 721), b = fbmField(N, 14, 4, 722), dm = fbmField(N, 2, 4, 723), pe = fbmField(N, 5, 4, 724);
    const rgb = new Float32Array(N * N * 3), h = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      let v = 0.86 + (a[i] - 0.5) * 0.10 + (b[i] - 0.5) * 0.07 + (r() - 0.5) * 0.045;
      let hh = 0.5 + (b[i] - 0.5) * 0.5 + (r() - 0.5) * 0.12, rr = v + 0.006, gg = v + 0.002, bb = v - 0.006;
      const d = dm[i];
      if (d > 0.6) { const k = Math.min(1, (d - 0.6) * 3.2); rr *= 1 - 0.16 * k; gg *= 1 - 0.12 * k; bb *= 1 - 0.10 * k; }
      const p = pe[i];
      if (p > 0.7) {
        if (p < 0.715) { rr *= 0.62; gg *= 0.62; bb *= 0.62; }
        else { rr = rr * 0.35 + 0.94 * 0.65; gg = gg * 0.35 + 0.92 * 0.65; bb = bb * 0.35 + 0.86 * 0.65; }
        hh -= 0.28;
      }
      rgb[i * 3] = rr; rgb[i * 3 + 1] = gg; rgb[i * 3 + 2] = bb; h[i] = hh;
    }
    for (let k = 0; k < 3; k++) {  // exposed brick under failed render
      const x0 = 80 + ((r() * (N - 400)) | 0), y0 = 80 + ((r() * (N - 300)) | 0), wd = 90 + ((r() * 120) | 0), ht = 60 + ((r() * 70) | 0);
      for (let y = y0 - 20; y < y0 + ht + 20; y++) for (let x = x0 - 20; x < x0 + wd + 20; x++) {
        const i = y * N + x, ed = Math.min(x - x0, x0 + wd - x, y - y0, y0 + ht - y) + (b[i] - 0.5) * 38;
        if (ed < 0) continue;
        const row = Math.floor((y - y0) / 18), xo = x - x0 + (row % 2) * 20, col = Math.floor(xo / 40);
        if (ed < 2.5) { rgb[i * 3] *= 0.55; rgb[i * 3 + 1] *= 0.55; rgb[i * 3 + 2] *= 0.55; h[i] = 0.35; continue; }
        if ((y - y0) % 18 < 3 || xo % 40 < 3) { rgb[i * 3] = 0.72; rgb[i * 3 + 1] = 0.70; rgb[i * 3 + 2] = 0.64; h[i] = 0.12; }
        else { const t = hash2(row, col, 9); rgb[i * 3] = 0.56 + t * 0.14; rgb[i * 3 + 1] = 0.27 + t * 0.07; rgb[i * 3 + 2] = 0.20 + t * 0.05; h[i] = 0.3 + t * 0.1; }
      }
    }
    for (let c = 0; c < 10; c++) walk(N, r, 220, 1.5, (x, y) => { const i = y * N + x; rgb[i * 3] *= 0.5; rgb[i * 3 + 1] *= 0.5; rgb[i * 3 + 2] *= 0.5; h[i] -= 0.4; });
    return { map: toTex(rgbCanvas(N, rgb)), normal: toTex(normalCanvas(h, N, 3.5), false) };
  };
  const genRoof = () => {
    const N = 1024, cols = 8, rows = 8, tw = N / cols, th = N / rows, r = mulberry(7301), mot = fbmField(N, 4, 4, 731);
    const tc = [];
    for (let k = 0; k < cols * rows; k++) {
      const t = r(), v = 0.8 + r() * 0.3; let base = [0.60 * v, 0.29 * v, 0.19 * v];
      if (t < 0.14) base = [base[0] * 0.72, base[1] * 0.78, base[2] * 0.7]; else if (t > 0.93) base = [0.42, 0.46, 0.30];
      tc.push(base);
    }
    const rgb = new Float32Array(N * N * 3), h = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const row = Math.floor(y / th), ty = (y % th) / th, xx = (x + (row % 2) * tw / 2) % N, col = Math.floor(xx / tw), tx = (xx % tw) / tw;
      const s = (tx - 0.5) * 2, cross = Math.sqrt(Math.max(0, 1 - s * s * 0.8));
      let sh = (0.55 + 0.45 * cross) * (0.8 - 0.28 * s);
      sh *= 1 - 0.55 * Math.exp(-ty * 16); sh *= 1 + 0.14 * Math.exp(-(1 - ty) * 26);
      if (ty > 0.965) sh *= 0.45; if (Math.abs(s) > 0.93) sh *= 0.6;
      const c = tc[row * cols + col], i = y * N + x, n = (mot[i] - 0.5) * 0.18 + (r() - 0.5) * 0.06;
      rgb[i * 3] = c[0] * sh + n; rgb[i * 3 + 1] = c[1] * sh + n * 0.8; rgb[i * 3 + 2] = c[2] * sh + n * 0.6;
      h[i] = cross * (0.4 + 0.6 * ty) * (ty > 0.965 ? 0.4 : 1);
    }
    return { map: toTex(rgbCanvas(N, rgb)), normal: toTex(normalCanvas(h, N, 4), false) };
  };
  const genLouver = () => {
    const N = 256, r = mulberry(7501), rgb = new Float32Array(N * N * 3);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const t = (y % 32) / 32; let v = t < 0.1 ? 0.45 : t < 0.6 ? 0.98 - 0.2 * t : t < 0.92 ? 0.72 : 0.38;
      if (x < 14 || x > 241) v = (x < 3 || x > 252 || (x > 11 && x < 14) || (x > 241 && x < 244)) ? 0.5 : 0.88;
      v = v * 0.82 + (r() - 0.5) * 0.04; const i = (y * N + x) * 3; rgb[i] = v; rgb[i + 1] = v; rgb[i + 2] = v;
    }
    return toTex(rgbCanvas(N, rgb));
  };
  const genPlanks = () => {
    const N = 256, r = mulberry(7601), rgb = new Float32Array(N * N * 3), gx = new Float32Array(N);
    for (let x = 0; x < N; x++) gx[x] = r();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const pl = (x / 64) | 0, px = x % 64, tone = 0.76 + hash2(pl, 1, 77) * 0.12;
      let v = tone + (gx[(x + (pl * 17)) % N] - 0.5) * 0.18 + (r() - 0.5) * 0.03 + Math.sin(y * 0.05 + pl * 2 + gx[x] * 3) * 0.02;
      if (px < 2 || px > 61) v = 0.28;
      const i = (y * N + x) * 3; rgb[i] = v + 0.02; rgb[i + 1] = v; rgb[i + 2] = v - 0.03;
    }
    return toTex(rgbCanvas(N, rgb));
  };
  const genRollup = () => {
    const N = 256, r = mulberry(7701), rgb = new Float32Array(N * N * 3), rust = fbmField(N, 4, 3, 771);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const t = (y % 16) / 16; let v = t < 0.12 ? 1.0 : t < 0.8 ? 0.78 - 0.12 * t : 0.46; if (y % 16 === 15) v = 0.28;
      v = v * 0.78 + (r() - 0.5) * 0.04; let rr = v, gg = v, bb = v;
      const q = Math.max(0, rust[y * N + x] - 0.55) * 1.6; rr += q * 0.18; gg -= q * 0.02; bb -= q * 0.1;
      const i = (y * N + x) * 3; rgb[i] = rr; rgb[i + 1] = gg; rgb[i + 2] = bb;
    }
    return toTex(rgbCanvas(N, rgb));
  };
  const genStripes = (c1, c2) => {
    const W = 128, H = 64, c = makeCanvas(W, H), ctx = c.getContext('2d'), img = ctx.createImageData(W, H), d = img.data, a = lin(c1), b = lin(c2);
    const sr = (v) => Math.pow(v, 1 / 2.2);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const base = x < 64 ? a : b, n = 0.94 + 0.06 * Math.sin(x * 3.1) * Math.sin(y * 3.1) + (hash2(x, y, 2) - 0.5) * 0.06, i = (y * W + x) * 4;
      d[i] = sr(base[0] * n) * 255; d[i + 1] = sr(base[1] * n) * 255; d[i + 2] = sr(base[2] * n) * 255; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return toTex(c);
  };

  // Window / interior atlas: 4 x 4 cells of 256 x 384.
  const CW = 256, CH = 384;
  const LIT_KINDS = [3, 6, 11, 14, 15];
  const paintWindowCell = (ctx, k, ox, oy, em) => {
    ctx.save(); ctx.beginPath(); ctx.rect(ox, oy, CW, CH); ctx.clip(); ctx.translate(ox, oy);
    const lg = (stops, y0 = 0, y1 = CH) => { const g = ctx.createLinearGradient(0, y0, 0, y1); stops.forEach(([s, c]) => g.addColorStop(s, c)); ctx.fillStyle = g; ctx.fillRect(0, 0, CW, CH); };
    const rr = mulberry(9000 + k);
    switch (k) {
      case 0: lg([[0, '#3a322b'], [1, '#1f1a16']]); for (let i = 0; i < 9; i++) { ctx.fillStyle = `rgba(228,218,196,${0.5 + 0.2 * Math.sin(i * 2)})`; ctx.fillRect(i * 29, 0, 28, CH); ctx.fillStyle = 'rgba(80,70,55,0.25)'; ctx.fillRect(i * 29 + 20, 0, 4, CH); } break;
      case 1: lg([[0, '#d2c6a6'], [1, '#bfb291']]); ctx.fillStyle = 'rgba(120,108,80,0.35)'; for (let y = 6; y < CH; y += 10) ctx.fillRect(0, y, CW, 2); ctx.fillStyle = '#8d8160'; ctx.fillRect(0, 300, CW, 8); break;
      case 2: lg([[0, '#10131a'], [1, '#262b33']]); ctx.fillStyle = 'rgba(190,215,240,0.10)'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(140, 0); ctx.lineTo(30, CH); ctx.lineTo(0, CH); ctx.fill(); break;
      case 3: lg([[0, '#4a331c'], [1, '#c58d4a']]); { const g = ctx.createRadialGradient(130, 130, 4, 130, 130, 120); g.addColorStop(0, 'rgba(255,224,150,1)'); g.addColorStop(1, 'rgba(255,190,100,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, CW, CH); } ctx.fillStyle = '#6b4a2a'; ctx.fillRect(20, 250, 216, 8); ctx.fillStyle = '#2a1a0e'; ctx.fillRect(0, 330, CW, 54); break;
      case 4: lg([[0, '#1d1b19'], [1, '#12110f']]); ctx.fillStyle = '#4a6b4d'; ctx.fillRect(0, 0, 90, CH); ctx.fillRect(166, 0, 90, CH); for (let i = 0; i < 6; i++) { ctx.fillStyle = 'rgba(20,40,25,0.4)'; ctx.fillRect(i * 16, 0, 4, CH); ctx.fillRect(166 + i * 16, 0, 4, CH); } break;
      case 5: lg([[0, '#1d1815'], [1, '#12100f']]); ctx.fillStyle = '#7a2e2a'; ctx.fillRect(0, 0, 100, CH); ctx.fillRect(156, 0, 100, CH); ctx.fillStyle = 'rgba(220,180,90,0.5)'; ctx.fillRect(98, 0, 3, CH); ctx.fillRect(156, 0, 3, CH); for (let i = 0; i < 7; i++) { ctx.fillStyle = 'rgba(40,10,10,0.4)'; ctx.fillRect(i * 15, 0, 4, CH); ctx.fillRect(156 + i * 15, 0, 4, CH); } break;
      case 6: lg([[0, '#15181d'], [1, '#101216']]); { const g = ctx.createLinearGradient(40, 140, 220, 260); g.addColorStop(0, '#9cc4f0'); g.addColorStop(1, '#4b79b0'); ctx.fillStyle = g; ctx.fillRect(48, 140, 160, 96); } break;
      case 7: lg([[0, '#a58052'], [1, '#8d6c42']]); ctx.strokeStyle = 'rgba(70,45,20,0.5)'; ctx.lineWidth = 2; for (let x = 0; x < CW; x += 9) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CH); ctx.stroke(); } ctx.fillStyle = '#5c4026'; ctx.fillRect(0, 260, CW, 10); break;
      case 8: lg([[0, '#1d1812'], [1, '#12100c']]); ctx.fillStyle = '#bcae8c'; ctx.fillRect(0, 0, CW, 160); ctx.fillStyle = '#8d8060'; ctx.fillRect(0, 160, CW, 8); ctx.fillStyle = '#2f5a32'; ctx.beginPath(); ctx.ellipse(60, 320, 40, 52, 0, 0, 6.28); ctx.fill(); ctx.beginPath(); ctx.ellipse(110, 335, 28, 40, 0.4, 0, 6.28); ctx.fill(); break;
      case 9: lg([[0, '#b9ad93'], [1, '#8c8168']]); ctx.fillStyle = '#c0483c'; ctx.fillRect(80, 60, 96, 130); ctx.fillStyle = '#e8d9a8'; ctx.fillRect(92, 76, 72, 20); ctx.fillStyle = '#2f5a32'; ctx.beginPath(); ctx.ellipse(40, 320, 34, 50, 0, 0, 6.28); ctx.fill(); break;
      case 10: lg([[0, '#262a2e'], [1, '#14161a']]); ctx.strokeStyle = '#0b0c0e'; ctx.lineWidth = 6; ctx.strokeRect(10, 10, 110, CH - 20); ctx.strokeRect(136, 10, 110, CH - 20); ctx.fillStyle = 'rgba(200,220,240,0.07)'; ctx.fillRect(10, 10, 110, 150); break;
      case 11: lg([[0, '#3c2a1a'], [1, '#7a5530']]); for (let row = 0; row < 5; row++) { ctx.fillStyle = '#b98a50'; ctx.fillRect(10, 70 + row * 62, 236, 6); let x = 14; while (x < 230) { const w = 8 + rr() * 12; ctx.fillStyle = ['#a33a2e', '#2d5a7a', '#d2b45a', '#3a6a45', '#6a3a5a'][(rr() * 5) | 0]; ctx.fillRect(x, 24 + row * 62 + (rr() * 6), w, 46 - rr() * 6); x += w + 1; } } break;
      case 12: lg([[0, '#8fb0c8'], [0.55, '#dbc99c'], [1, '#6f7e86']]); ctx.fillStyle = 'rgba(30,34,40,0.55)'; ctx.fillRect(0, 290, 60, 94); ctx.fillRect(70, 250, 70, 134); ctx.fillRect(150, 310, 106, 74); break;
      case 13: lg([[0, '#cfc6b0'], [1, '#8f8672']]); ctx.fillStyle = 'rgba(60,50,35,0.55)'; ctx.fillRect(30, 250, 120, 90); ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(160, 30, 70, 160); break;
      case 14: lg([[0, '#2a2018'], [1, '#17120e']]); ctx.strokeStyle = '#5a4a3a'; ctx.lineWidth = 12; ctx.lineCap = 'round'; for (let i = 0; i < 4; i++) { const a = i * 1.57 + 0.4; ctx.beginPath(); ctx.moveTo(128, 90); ctx.lineTo(128 + Math.cos(a) * 80, 90 + Math.sin(a) * 26); ctx.stroke(); } { const g = ctx.createRadialGradient(128, 110, 2, 128, 110, 60); g.addColorStop(0, 'rgba(255,214,140,0.9)'); g.addColorStop(1, 'rgba(255,160,70,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, CW, CH); } break;
      default: lg([[0, '#2e2216'], [1, '#6f4e2c']]); ctx.fillStyle = 'rgba(255,200,120,0.25)'; ctx.fillRect(60, 80, 140, 200); break;
    }
    ctx.restore();
  };
  const genWindowAtlas = () => {
    const a = makeCanvas(1024, 1536), ac = a.getContext('2d'), e = makeCanvas(1024, 1536), ec = e.getContext('2d');
    ec.fillStyle = '#000'; ec.fillRect(0, 0, 1024, 1536);
    for (let k = 0; k < 16; k++) {
      const ox = (k % 4) * CW, oy = ((k / 4) | 0) * CH;
      paintWindowCell(ac, k, ox, oy, false);
      if (LIT_KINDS.includes(k)) paintWindowCell(ec, k, ox, oy, true);
    }
    return { map: toTex(a, true, false), emissive: toTex(e, true, false) };
  };
  // normalised UV rect of an atlas cell (v flipped for canvas textures)
  const cellUV = (i, cols, rows, inset = 0.004) => {
    const cx = i % cols, cy = Math.floor(i / cols), du = 1 / cols, dv = 1 / rows;
    return [cx * du + inset * du, 1 - (cy + 1) * dv + inset * dv, (cx + 1) * du - inset * du, 1 - cy * dv - inset * dv];
  };

  // Goods atlas: 4 x 4 cells of 256 (shelves, fridge, AC unit, ...).
  const genGoods = () => {
    const c = makeCanvas(1024, 1024), ctx = c.getContext('2d'), r = mulberry(8101);
    const cell = (i, fn) => { const ox = (i % 4) * 256, oy = ((i / 4) | 0) * 256; ctx.save(); ctx.beginPath(); ctx.rect(ox, oy, 256, 256); ctx.clip(); ctx.translate(ox, oy); fn(); ctx.restore(); };
    const rows = (n, boardColor, fillFn) => { for (let k = 0; k < n; k++) { const y = 20 + k * (216 / n); fillFn(y, 216 / n - 8); ctx.fillStyle = boardColor; ctx.fillRect(0, y + 216 / n - 8, 256, 6); } };
    cell(0, () => { ctx.fillStyle = '#2a1c12'; ctx.fillRect(0, 0, 256, 256); rows(5, '#a87a45', (y, hh) => { let x = 6; while (x < 250) { const w = 5 + r() * 9; ctx.fillStyle = ['#a33a2e', '#2d5a7a', '#d2b45a', '#3a6a45', '#6a3a5a', '#d9d2bc', '#3a3a44'][(r() * 7) | 0]; ctx.fillRect(x, y + r() * 5, w, hh - r() * 5); x += w + 0.8; } }); });
    cell(1, () => { ctx.fillStyle = '#d8d2c2'; ctx.fillRect(0, 0, 256, 256); rows(5, '#8a8f95', (y, hh) => { let x = 6; while (x < 250) { const w = 10 + r() * 14; ctx.fillStyle = ['#d23c2e', '#f0c43c', '#2f7fb0', '#3f9a54', '#e7e0d0', '#c46a2a'][(r() * 6) | 0]; ctx.fillRect(x, y + (hh * 0.25) * r(), w, hh * 0.75); x += w + 2; } }); });
    cell(2, () => { ctx.fillStyle = '#ead9b5'; ctx.fillRect(0, 0, 256, 256); rows(4, '#7a5a38', (y, hh) => { for (let x = 14; x < 244; x += 34) { ctx.fillStyle = `rgb(${190 + r() * 30},${130 + r() * 30},${60 + r() * 20})`; ctx.beginPath(); ctx.ellipse(x + 10, y + hh * 0.6, 15, hh * 0.32, 0, 0, 6.28); ctx.fill(); } }); });
    cell(3, () => { ctx.fillStyle = '#e8ece8'; ctx.fillRect(0, 0, 256, 256); rows(5, '#b8c0b8', (y, hh) => { let x = 8; while (x < 248) { const w = 14 + r() * 12; ctx.fillStyle = ['#ffffff', '#2f8a5a', '#9fc8e8', '#e8e2c8'][(r() * 4) | 0]; ctx.fillRect(x, y + hh * 0.2, w, hh * 0.8); ctx.fillStyle = 'rgba(40,120,80,0.7)'; ctx.fillRect(x, y + hh * 0.45, w, 3); x += w + 3; } }); });
    cell(4, () => { ctx.fillStyle = '#3a2d26'; ctx.fillRect(0, 0, 256, 256); for (let x = 6; x < 250; x += 30) { const g = ctx.createLinearGradient(x, 0, x + 26, 0); const col = ['#b8453a', '#3a6a9a', '#d8b050', '#4a8a5a', '#8a4a8a', '#e8e0cc'][(r() * 6) | 0]; g.addColorStop(0, col); g.addColorStop(0.5, '#ffffff55'); g.addColorStop(1, col); ctx.fillStyle = g; ctx.fillRect(x, 20 + r() * 40, 26, 200); } });
    cell(5, () => { ctx.fillStyle = '#26332b'; ctx.fillRect(0, 0, 256, 256); ctx.strokeStyle = '#8a6a3a'; ctx.lineWidth = 8; ctx.strokeRect(4, 4, 248, 248); ctx.fillStyle = 'rgba(235,235,225,0.88)'; ctx.font = 'bold 34px Georgia, serif'; ctx.textAlign = 'center'; ctx.fillText('MENU', 128, 52); ctx.font = '20px Georgia, serif'; ['Cà phê sữa đá  25', 'Bạc xỉu  29', 'Trà đào  35', 'Cà phê trứng  39', 'Sinh tố  35', 'Bánh flan  20'].forEach((t, i) => ctx.fillText(t, 128, 92 + i * 30)); });
    cell(6, () => { const g = ctx.createLinearGradient(0, 0, 0, 256); g.addColorStop(0, '#dff0ff'); g.addColorStop(1, '#a9cbe8'); ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256); rows(4, '#cfd8e0', (y, hh) => { for (let x = 10; x < 246; x += 20) { ctx.fillStyle = ['#2f8a4a', '#d23c2e', '#e8a22e', '#2f6fb0'][(r() * 4) | 0]; ctx.fillRect(x, y + 6, 12, hh - 6); ctx.fillStyle = '#e8eef2'; ctx.fillRect(x + 3, y, 6, 8); } }); ctx.strokeStyle = '#6c7680'; ctx.lineWidth = 6; ctx.strokeRect(3, 3, 250, 250); });
    cell(7, () => { ctx.fillStyle = '#6d4d30'; ctx.fillRect(0, 0, 256, 256); rows(4, '#a87a45', (y, hh) => { for (let x = 12; x < 240; x += 24) { ctx.fillStyle = ['#eee8d8', '#c8553f', '#3a6a8a'][(r() * 3) | 0]; ctx.fillRect(x, y + hh * 0.35, 16, hh * 0.65); ctx.fillRect(x + 14, y + hh * 0.5, 5, 6); } }); });
    cell(8, () => { ctx.fillStyle = '#e4e4e0'; ctx.fillRect(0, 0, 256, 256); ctx.strokeStyle = '#b4b6b4'; ctx.lineWidth = 6; ctx.strokeRect(3, 3, 250, 250); const g = ctx.createRadialGradient(128, 118, 6, 128, 118, 82); g.addColorStop(0, '#6a6e72'); g.addColorStop(1, '#2d3033'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(128, 118, 82, 0, 6.28); ctx.fill(); ctx.strokeStyle = '#9aa0a4'; ctx.lineWidth = 3; for (let k = 1; k < 5; k++) { ctx.beginPath(); ctx.arc(128, 118, k * 16, 0, 6.28); ctx.stroke(); } for (let k = 0; k < 6; k++) { ctx.beginPath(); ctx.moveTo(128, 118); ctx.lineTo(128 + Math.cos(k * 1.047) * 82, 118 + Math.sin(k * 1.047) * 82); ctx.stroke(); } ctx.fillStyle = '#c4c6c4'; for (let y = 218; y < 250; y += 7) ctx.fillRect(14, y, 228, 3); ctx.fillStyle = 'rgba(120,100,60,0.25)'; ctx.fillRect(0, 0, 256, 18); });
    cell(9, () => { const g = ctx.createLinearGradient(0, 0, 256, 256); g.addColorStop(0, '#c8d4d8'); g.addColorStop(0.5, '#eef2f2'); g.addColorStop(1, '#a8b6bc'); ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256); ctx.strokeStyle = '#5a3a22'; ctx.lineWidth = 12; ctx.strokeRect(6, 6, 244, 244); });
    cell(10, () => { ctx.fillStyle = '#7a8a8c'; ctx.fillRect(0, 0, 256, 256); ctx.fillStyle = '#4a5558'; for (let x = 12; x < 250; x += 24) for (let y = 12; y < 250; y += 24) { ctx.beginPath(); ctx.arc(x, y, 2, 0, 6.28); ctx.fill(); } for (let k = 0; k < 14; k++) { ctx.fillStyle = ['#d23c2e', '#e8b22e', '#2f6fb0', '#222'][(r() * 4) | 0]; ctx.fillRect(10 + r() * 220, 14 + r() * 200, 8 + r() * 10, 30 + r() * 40); } });
    cell(11, () => { ctx.fillStyle = '#3a2a1c'; ctx.fillRect(0, 0, 256, 256); for (let y = 30; y < 230; y += 66) for (let x = 8; x < 240; x += 62) { ctx.fillStyle = '#8a6a40'; ctx.fillRect(x, y + 28, 54, 28); for (let k = 0; k < 18; k++) { ctx.fillStyle = ['#3f9a3a', '#d2402e', '#e89a2e', '#7ab83a'][(r() * 4) | 0]; ctx.beginPath(); ctx.arc(x + 6 + r() * 42, y + 20 + r() * 12, 6 + r() * 4, 0, 6.28); ctx.fill(); } } });
    cell(12, () => { ctx.fillStyle = '#b9bec0'; ctx.fillRect(0, 0, 256, 256); ctx.fillStyle = '#5a5e60'; for (let x = 16; x < 240; x += 70) { ctx.fillRect(x, 70, 54, 70); ctx.fillStyle = '#2d3032'; ctx.fillRect(x + 4, 62, 46, 10); ctx.fillStyle = '#5a5e60'; } ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.fillRect(0, 150, 256, 6); });
    cell(13, () => { ctx.fillStyle = '#c9bea4'; ctx.fillRect(0, 0, 256, 256); for (let k = 0; k < 4; k++) { ctx.fillStyle = '#4a3220'; ctx.fillRect(20 + k * 56, 40 + (k % 2) * 40, 44, 60); ctx.fillStyle = ['#d98a6a', '#6a9ab8', '#d8c46a', '#8aa86a'][k]; ctx.fillRect(25 + k * 56, 45 + (k % 2) * 40, 34, 50); } });
    return toTex(c, true, false);
  };

  // Sign atlases. Boards: 1024 x 96 cells (2 x 24), blade signs: 256 cells (8 x 4).
  const SIGN_COLS = 2, SIGN_ROWS = 24, SIGN_CH = 96;
  const signCanvas = makeCanvas(2048, SIGN_ROWS * SIGN_CH), signCtx = signCanvas.getContext('2d');
  signCtx.fillStyle = '#444'; signCtx.fillRect(0, 0, 2048, SIGN_ROWS * SIGN_CH);
  const FONT_SANS = 'Arial, "Helvetica Neue", Helvetica, sans-serif', FONT_SERIF = 'Georgia, "Times New Roman", serif';
  let signCount = 0;
  const paintSign = (text, o, aspect) => {
    const idx = signCount++ % (SIGN_COLS * SIGN_ROWS), ox = (idx % SIGN_COLS) * 1024, oy = Math.floor(idx / SIGN_COLS) * SIGN_CH, cw = 1024, ch = SIGN_CH;
    const sr = mulberry(9500 + idx * 7), ctx = signCtx, sy = aspect / (cw / ch), lh = ch / sy;
    ctx.save(); ctx.beginPath(); ctx.rect(ox, oy, cw, ch); ctx.clip(); ctx.translate(ox, oy); ctx.scale(1, sy);
    const g = ctx.createLinearGradient(0, 0, 0, lh); g.addColorStop(0, o.bg); g.addColorStop(1, o.bg2 || o.bg); ctx.fillStyle = g; ctx.fillRect(0, 0, cw, lh);
    for (let k = 0; k < 70; k++) { ctx.fillStyle = `rgba(${sr() < 0.5 ? '255,255,255' : '0,0,0'},${0.03 + sr() * 0.05})`; ctx.fillRect(sr() * cw, sr() * lh, 6 + sr() * 40, 1 + sr() * 3); }
    ctx.strokeStyle = o.fg; ctx.globalAlpha = 0.55; ctx.lineWidth = lh * 0.04; ctx.strokeRect(lh * 0.07, lh * 0.07, cw - lh * 0.14, lh - lh * 0.14); ctx.globalAlpha = 1;
    let fs = lh * 0.62; ctx.font = `${o.weight || 'bold'} ${fs}px ${o.font || FONT_SANS}`;
    const padL = o.icon ? lh * 1.0 : 0, avail = cw * 0.9 - padL; let tw = ctx.measureText(text).width;
    if (tw > avail) { fs *= avail / tw; ctx.font = `${o.weight || 'bold'} ${fs}px ${o.font || FONT_SANS}`; tw = ctx.measureText(text).width; }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillText(text, cw / 2 + padL / 2 + fs * 0.04, lh / 2 + fs * 0.05);
    ctx.fillStyle = o.fg; ctx.fillText(text, cw / 2 + padL / 2, lh / 2);
    if (o.icon === 'cross') { const cx = cw / 2 - tw / 2 - lh * 0.1 - lh * 0.3, cy = lh / 2, a = lh * 0.3; ctx.fillStyle = '#1f9a55'; ctx.fillRect(cx - a, cy - a / 3, a * 2, a * 2 / 3); ctx.fillRect(cx - a / 3, cy - a, a * 2 / 3, a * 2); }
    ctx.restore();
    return cellUV(idx, SIGN_COLS, SIGN_ROWS, 0.003);
  };
  const BLADE = { cup: 0, book: 1, cross: 2, bread: 3, scissors: 4, thread: 5, wrench: 6, bowl: 7, store: 8 };
  const bladeCanvas = makeCanvas(2048, 1024), bladeCtx = bladeCanvas.getContext('2d');
  { // blade signs
    const ctx = bladeCtx; ctx.fillStyle = '#333'; ctx.fillRect(0, 0, 2048, 1024);
    const defs = [
      ['CÀ PHÊ', '#2f4a3a', '#f1e2b8', (x, y) => { ctx.fillStyle = '#f1e2b8'; ctx.fillRect(x + 80, y + 70, 90, 70); ctx.beginPath(); ctx.arc(x + 178, y + 100, 20, -1.5, 1.5); ctx.lineWidth = 8; ctx.strokeStyle = '#f1e2b8'; ctx.stroke(); }],
      ['SÁCH', '#3a2a22', '#d9b45a', (x, y) => { ctx.fillStyle = '#d9b45a'; ctx.fillRect(x + 60, y + 60, 60, 90); ctx.fillRect(x + 130, y + 60, 60, 90); ctx.fillStyle = '#3a2a22'; ctx.fillRect(x + 124, y + 60, 6, 90); }],
      ['THUỐC', '#f2f0e6', '#1f7a4a', (x, y) => { ctx.fillStyle = '#1f9a55'; ctx.fillRect(x + 90, y + 60, 70, 24 * 3); ctx.fillRect(x + 90 - 24, y + 84, 24 * 3 + 22, 24); }],
      ['BÁNH MÌ', '#d9a441', '#7a2a1a', (x, y) => { ctx.fillStyle = '#7a2a1a'; ctx.beginPath(); ctx.ellipse(x + 125, y + 105, 60, 28, -0.3, 0, 6.28); ctx.fill(); }],
      ['CẮT TÓC', '#1d3557', '#f1faee', (x, y) => { ctx.strokeStyle = '#f1faee'; ctx.lineWidth = 10; ctx.beginPath(); ctx.moveTo(x + 80, y + 150); ctx.lineTo(x + 170, y + 60); ctx.moveTo(x + 170, y + 150); ctx.lineTo(x + 80, y + 60); ctx.stroke(); }],
      ['MAY ĐO', '#6b2d3c', '#f3d9b1', (x, y) => { ctx.strokeStyle = '#f3d9b1'; ctx.lineWidth = 8; ctx.beginPath(); ctx.arc(x + 125, y + 105, 40, 0, 6.28); ctx.stroke(); }],
      ['SẮT THÉP', '#1f4e79', '#ffd23f', (x, y) => { ctx.fillStyle = '#ffd23f'; ctx.fillRect(x + 118, y + 60, 16, 100); ctx.fillRect(x + 90, y + 56, 72, 22); }],
      ['PHỞ BÒ', '#a8342a', '#f6ecd2', (x, y) => { ctx.fillStyle = '#f6ecd2'; ctx.beginPath(); ctx.arc(x + 125, y + 100, 52, 0, Math.PI); ctx.fill(); }],
      ['TẠP HÓA', '#c7372f', '#ffe27a', (x, y) => { ctx.fillStyle = '#ffe27a'; ctx.fillRect(x + 80, y + 70, 90, 70); }],
    ];
    defs.forEach(([t, bg, fg, icon], i) => {
      const x = (i % 8) * 256, y = Math.floor(i / 8) * 256;
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, 256, 256); ctx.clip();
      ctx.fillStyle = bg; ctx.fillRect(x, y, 256, 256); ctx.strokeStyle = fg; ctx.lineWidth = 7; ctx.strokeRect(x + 8, y + 8, 240, 240);
      icon(x, y); ctx.fillStyle = fg; ctx.font = `bold 40px ${FONT_SANS}`; ctx.textAlign = 'center'; ctx.fillText(t, x + 128, y + 218);
      ctx.restore();
    });
  }

  // ------------------------------------------------------------------ build textures + materials
  const asphalt = genAsphalt(), pavers = genPavers(), curbTex = genCurb(), plaster = genPlaster(), roofTex = genRoof();
  const louverTex = genLouver(), planksTex = genPlanks(), rollTex = genRollup(), winAtlas = genWindowAtlas(), goodsTex = genGoods();
  const decalTex = genDecals(), paintTex = genWornPaint(), tactileTex = genTactile();
  const patchTex = genFineAsphalt(256, 0.17, 7801, 0.006), patchLightTex = genFineAsphalt(256, 0.58, 7811, 0.012);
  const signTex = toTex(signCanvas, true, false), bladeTex = toTex(bladeCanvas, true, false);

  const S = (o) => { const m = new THREE.MeshStandardMaterial(o); m.shadowSide = THREE.DoubleSide; return m; };
  const V2 = (v) => new THREE.Vector2(v, v);
  const decalProps = (f) => ({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -f, polygonOffsetUnits: -f, vertexColors: true, roughness: 0.95, metalness: 0 });
  const awning = (a, b) => S({ map: genStripes(a, b), roughness: 0.92, metalness: 0, vertexColors: true, side: THREE.DoubleSide });
  const mats = {
    road: S({ map: asphalt.map, normalMap: asphalt.normal, normalScale: V2(0.8), roughnessMap: asphalt.rough, roughness: 1, metalness: 0, vertexColors: true }),
    pave: S({ map: pavers.map, normalMap: pavers.normal, normalScale: V2(0.7), roughnessMap: pavers.rough, roughness: 1, metalness: 0, vertexColors: true }),
    curb: S({ map: curbTex, roughness: 0.9, metalness: 0, vertexColors: true }),
    patch: S({ map: patchTex, roughness: 0.95, metalness: 0, vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    patchLight: S({ map: patchLightTex, roughness: 0.95, metalness: 0, vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    decal: S({ map: decalTex, ...decalProps(3) }),
    paint: S({ map: paintTex, ...decalProps(4) }),
    tactile: S({ map: tactileTex, roughness: 0.9, metalness: 0, vertexColors: true, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    plaster: S({ map: plaster.map, normalMap: plaster.normal, normalScale: V2(0.6), roughness: 0.95, metalness: 0, vertexColors: true }),
    roof: S({ map: roofTex.map, normalMap: roofTex.normal, normalScale: V2(0.9), roughness: 0.88, metalness: 0, vertexColors: true }),
    wood: S({ map: planksTex, roughness: 0.78, metalness: 0, vertexColors: true }),
    louver: S({ map: louverTex, roughness: 0.72, metalness: 0, vertexColors: true }),
    metal: S({ roughness: 0.5, metalness: 0.35, vertexColors: true }),
    rollup: S({ map: rollTex, roughness: 0.55, metalness: 0.4, vertexColors: true }),
    window: S({ map: winAtlas.map, emissiveMap: winAtlas.emissive, emissive: new THREE.Color(1, 0.92, 0.8), emissiveIntensity: 0.8, roughness: 0.28, metalness: 0, vertexColors: true }),
    glass: new THREE.MeshStandardMaterial({ color: '#c8dcea', transparent: true, opacity: 0.13, roughness: 0.05, metalness: 0, depthWrite: false }),
    goods: S({ map: goodsTex, emissiveMap: goodsTex, emissive: new THREE.Color(1, 0.9, 0.75), emissiveIntensity: 0.5, roughness: 0.7, metalness: 0, vertexColors: true }),
    sign: S({ map: signTex, roughness: 0.6, metalness: 0, vertexColors: true }),
    blade: S({ map: bladeTex, roughness: 0.6, metalness: 0, vertexColors: true }),
    lamp: new THREE.MeshStandardMaterial({ color: '#fff0cf', emissive: new THREE.Color('#ffc97a'), emissiveIntensity: 1.6, roughness: 0.6, vertexColors: true }),
    awG: awning('#3f6a4a', '#e8e0c8'), awR: awning('#a8382e', '#ece3cf'), awB: awning('#2f5a86', '#e6e2d6'),
    awY: awning('#cf9a3a', '#ece0c0'), awD: awning('#2f4a3a', '#2f4a3a'), awM: awning('#7a2e36', '#7a2e36'),
  };

  // ------------------------------------------------------------------ mesher: merged static geometry with world-metre UVs
  const UX = [1, 0, 0], UY = [0, 1, 0], UZ = [0, 0, 1];
  class Mesher {
    constructor(name, def) {
      this.name = name; this.material = def.mat; this.k = def.k || 1;
      this.cast = def.cast !== false; this.receive = def.receive !== false; this.order = def.order || 0;
      this.ou = 0; this.ov = 0; this.p = []; this.n = []; this.t = []; this.c = []; this.i = []; this.v = 0;
    }
    quad(a, b, c, d, hint, color, uv, proj, nrm) {
      const dx1 = c[0] - a[0], dy1 = c[1] - a[1], dz1 = c[2] - a[2], dx2 = d[0] - b[0], dy2 = d[1] - b[1], dz2 = d[2] - b[2];
      let nx = dy1 * dz2 - dz1 * dy2, ny = dz1 * dx2 - dx1 * dz2, nz = dx1 * dy2 - dy1 * dx2;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-12) return;
      nx /= len; ny /= len; nz /= len;
      let P = [a, b, c, d], C = Array.isArray(color[0]) ? color : [color, color, color, color], UV = uv || null, NN = nrm || null;
      if (hint && nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) {
        P = [a, d, c, b]; C = [C[0], C[3], C[2], C[1]];
        if (UV) UV = [UV[0], UV[3], UV[2], UV[1]];
        if (NN) NN = [NN[0], NN[3], NN[2], NN[1]];
        nx = -nx; ny = -ny; nz = -nz;
      }
      let ub = null, vb = null;
      if (!UV) {
        if (proj) { ub = proj[0]; vb = proj[1]; }
        else {
          const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
          if (ax >= ay && ax >= az) { ub = UZ; vb = UY; } else if (ay >= az) { ub = UX; vb = UZ; } else { ub = UX; vb = UY; }
        }
      }
      const base = this.v;
      for (let j = 0; j < 4; j++) {
        const p = P[j];
        this.p.push(p[0], p[1], p[2]);
        if (NN) this.n.push(NN[j][0], NN[j][1], NN[j][2]); else this.n.push(nx, ny, nz);
        if (UV) this.t.push(UV[j][0], UV[j][1]);
        else this.t.push((p[0] * ub[0] + p[1] * ub[1] + p[2] * ub[2]) * this.k + this.ou, (p[0] * vb[0] + p[1] * vb[1] + p[2] * vb[2]) * this.k + this.ov);
        this.c.push(C[j][0], C[j][1], C[j][2]);
      }
      this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
      this.v += 4;
    }
    tri(a, b, c, hint, color, uv, proj) {
      const C = Array.isArray(color[0]) ? [color[0], color[1], color[2], color[2]] : color;
      this.quad(a, b, c, c, hint, C, uv ? [uv[0], uv[1], uv[2], uv[2]] : null, proj, null);
    }
    box(x0, x1, y0, y1, z0, z1, color, skip = 0) {
      if (x1 - x0 < 1e-5 || y1 - y0 < 1e-5 || z1 - z0 < 1e-5) return;
      const A = [x0, y0, z0], B = [x1, y0, z0], C = [x1, y1, z0], D = [x0, y1, z0], E = [x0, y0, z1], F = [x1, y0, z1], G = [x1, y1, z1], H = [x0, y1, z1];
      if (!(skip & 1)) this.quad(A, E, H, D, [-1, 0, 0], color);
      if (!(skip & 2)) this.quad(B, C, G, F, [1, 0, 0], color);
      if (!(skip & 4)) this.quad(A, B, F, E, [0, -1, 0], color);
      if (!(skip & 8)) this.quad(D, H, G, C, [0, 1, 0], color);
      if (!(skip & 16)) this.quad(A, D, C, B, [0, 0, -1], color);
      if (!(skip & 32)) this.quad(E, F, G, H, [0, 0, 1], color);
    }
    // c: 8 corners, index bit0 = +x, bit1 = +y, bit2 = +z of the local box
    boxC(c, color, skip = 0) {
      const ctr = [0, 0, 0];
      for (const p of c) { ctr[0] += p[0] / 8; ctr[1] += p[1] / 8; ctr[2] += p[2] / 8; }
      const faces = [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]];
      faces.forEach((f, k) => {
        if (skip & (1 << k)) return;
        const q = f.map((i) => c[i]);
        this.quad(q[0], q[1], q[2], q[3], [(q[0][0] + q[2][0]) / 2 - ctr[0], (q[0][1] + q[2][1]) / 2 - ctr[1], (q[0][2] + q[2][2]) / 2 - ctr[2]], color);
      });
    }
    cyl(cx, cz, y0, y1, r0, r1, seg, color, caps = true) {
      for (let s = 0; s < seg; s++) {
        const a0 = s / seg * 6.2832, a1 = (s + 1) / seg * 6.2832, c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        const A = [cx + c0 * r0, y0, cz + s0 * r0], B = [cx + c1 * r0, y0, cz + s1 * r0], C = [cx + c1 * r1, y1, cz + s1 * r1], D = [cx + c0 * r1, y1, cz + s0 * r1];
        this.quad(A, B, C, D, [c0 + c1, 0, s0 + s1], color, null, null, [[c0, 0, s0], [c1, 0, s1], [c1, 0, s1], [c0, 0, s0]]);
        if (caps) this.tri([cx, y1, cz], C, D, [0, 1, 0], color);
      }
    }
    flush(parent) {
      if (!this.v) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
      g.setIndex(new THREE.BufferAttribute(this.v > 65535 ? new Uint32Array(this.i) : new Uint16Array(this.i), 1));
      g.computeBoundingSphere(); g.computeBoundingBox();
      const mesh = new THREE.Mesh(g, this.material);
      mesh.name = this.name; mesh.castShadow = this.cast; mesh.receiveShadow = this.receive; mesh.renderOrder = this.order;
      parent.add(mesh);
      this.p = this.n = this.t = this.c = this.i = null; this.v = 0;
      return mesh;
    }
  }
  const DEFS = {
    plaster: { mat: mats.plaster, k: 1 / 3.5 }, roof: { mat: mats.roof, k: 1 / 2.4 }, wood: { mat: mats.wood, k: 1 },
    louver: { mat: mats.louver, k: 1 / 0.6 }, metal: { mat: mats.metal, k: 1 }, rollup: { mat: mats.rollup, k: 1 / 0.8 },
    window: { mat: mats.window, k: 1 }, glass: { mat: mats.glass, cast: false, receive: false, order: 4 }, goods: { mat: mats.goods, k: 1 },
    sign: { mat: mats.sign, k: 1 }, blade: { mat: mats.blade, k: 1 }, lamp: { mat: mats.lamp, cast: false, receive: false },
    awG: { mat: mats.awG }, awR: { mat: mats.awR }, awB: { mat: mats.awB }, awY: { mat: mats.awY }, awD: { mat: mats.awD }, awM: { mat: mats.awM },
  };
  const makeSet = (prefix) => { const o = {}; for (const k of Object.keys(DEFS)) o[k] = new Mesher(`${prefix}:${k}`, DEFS[k]); return o; };
  const flushSet = (set, parent) => { for (const k of Object.keys(set)) set[k].flush(parent); };

  // ------------------------------------------------------------------ frames: facade-local coordinates
  // s runs to the viewer's right when looking at the facade from the street, y up, d out of the facade toward the street.
  const axisBit = (vx, vz) => (vx > 0 ? 2 : vx < 0 ? 1 : vz > 0 ? 32 : 16);
  const makeFrame = (ox, oz, sx, sz, nx, nz) => ({
    ox, oz, sx, sz, nx, nz,
    p: (s, y, d) => [ox + sx * s + nx * d, y, oz + sz * s + nz * d],
    n: [nx, 0, nz], sv: [sx, 0, sz],
    mask: { f: axisBit(nx, nz), b: axisBit(-nx, -nz), r: axisBit(sx, sz), l: axisBit(-sx, -sz), t: 8, u: 4 },
  });
  const UP = [0, 1, 0], DOWN = [0, -1, 0];
  const neg = (v) => [-v[0], -v[1], -v[2]];
  const fq = (m, F, s0, y0, s1, y1, d, color, uv, proj, back) =>
    m.quad(F.p(s0, y0, d), F.p(s1, y0, d), F.p(s1, y1, d), F.p(s0, y1, d), back ? neg(F.n) : F.n, color, uv, proj);
  const fbox = (m, F, s0, s1, y0, y1, d0, d1, color, skip = '') => {
    const a = F.p(s0, y0, d0), b = F.p(s1, y1, d1);
    let mask = 0;
    for (const ch of skip) mask |= F.mask[ch];
    m.box(Math.min(a[0], b[0]), Math.max(a[0], b[0]), y0, y1, Math.min(a[2], b[2]), Math.max(a[2], b[2]), color, mask);
  };
  // quad in the plane s = const (facing +S when plus) / y = const (facing up when up)
  const fSide = (m, F, s, y0, y1, d0, d1, plus, color) =>
    m.quad(F.p(s, y0, d0), F.p(s, y0, d1), F.p(s, y1, d1), F.p(s, y1, d0), plus ? F.sv : neg(F.sv), color);
  const fFlat = (m, F, y, s0, s1, d0, d1, up, color, uv, proj) =>
    m.quad(F.p(s0, y, d0), F.p(s1, y, d0), F.p(s1, y, d1), F.p(s0, y, d1), up ? UP : DOWN, color, uv, proj);

  // ------------------------------------------------------------------ ground
  const ZA = -228, ZB = 268;                  // street ends (closure facades)
  const BASE = 0.14;                          // sidewalk top
  const CROSS0 = 28.2, CROSS1 = 31.8;         // dropped-kerb ramp zone around the zebra crossing
  const roadM = new Mesher('road-asphalt', { mat: mats.road, k: 1 / 2.4, cast: false });
  const paveM = new Mesher('sidewalk-pavers', { mat: mats.pave, k: 1 / 1.6, cast: false });
  const curbM = new Mesher('kerb-stones', { mat: mats.curb, k: 1, cast: true });
  const segs = (a, b, step) => { const n = Math.max(1, Math.ceil((b - a) / step - 1e-6)), o = []; for (let i = 0; i < n; i++) o.push(a + (b - a) * i / n); return o; };
  const ZE = [...segs(ZA, CROSS0, 2), ...segs(CROSS0, CROSS1, CROSS1 - CROSS0), ...segs(CROSS1, ZB, 2), ZB];
  const roadTone = (x, z) => {
    const ax = Math.abs(x);
    let k = 0.9 + 0.2 * vnoise(x * 0.4, z * 0.16, 11);
    const t = Math.max(Math.exp(-(((ax - 1.35) / 0.35) ** 2)), Math.exp(-(((ax - 2.75) / 0.35) ** 2)));
    k *= 1 - 0.09 * t * (0.6 + 0.8 * vnoise(z * 0.08, 3, 5));
    k *= 1 - 0.16 * smooth01((ax - 3.3) / 0.7);
    k *= 0.94 + 0.12 * vnoise(x * 0.08 + 7, z * 0.05, 21);
    return [k, k * 0.995, k * 0.985];
  };
  for (let i = 0; i < ZE.length - 1; i++) {
    for (let xi = -4; xi < 4; xi++) {
      const x0 = xi, x1 = xi + 1, z0 = ZE[i], z1 = ZE[i + 1];
      roadM.quad([x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1], UP, [roadTone(x0, z0), roadTone(x1, z0), roadTone(x1, z1), roadTone(x0, z1)]);
    }
  }
  const paveTone = (x, z) => {
    const ax = Math.abs(x);
    let k = 0.9 + 0.2 * vnoise(x * 0.5, z * 0.5, 31);
    k *= 0.9 + 0.1 * vnoise(x * 0.12, z * 0.09, 33);
    k *= 1 - 0.14 * smooth01((ax - 6.6) / 0.7);                 // dirt along the plinths
    k *= 1 - 0.08 * smooth01((4.9 - ax) / 0.7);                 // kerb-side grime
    return [k * 1.0, k * 0.985, k * 0.955];
  };
  const XE = [4.2, 5.4, 6.35, 7.3];
  for (const sgn of [1, -1]) {
    for (let i = 0; i < ZE.length - 1; i++) {
      const z0 = ZE[i], z1 = ZE[i + 1], ramp = Math.abs(z0 - CROSS0) < 1e-6;
      for (let xi = 0; xi < XE.length - 1; xi++) {
        if (ramp && xi === 0) continue;
        const x0 = sgn * XE[xi], x1 = sgn * XE[xi + 1];
        paveM.quad([x0, BASE, z0], [x1, BASE, z0], [x1, BASE, z1], [x0, BASE, z1], UP, [paveTone(x0, z0), paveTone(x1, z0), paveTone(x1, z1), paveTone(x0, z1)]);
      }
    }
    // dropped-kerb ramp, side flares and tactile strip
    const rz0 = CROSS0, rz1 = CROSS1, xa = sgn * 4, xb = sgn * 5.4;
    paveM.quad([xa, 0, rz0], [xb, BASE, rz0], [xb, BASE, rz1], [xa, 0, rz1], UP, [paveTone(xa, rz0), paveTone(xb, rz0), paveTone(xb, rz1), paveTone(xa, rz1)]);
    const stone = [0.7, 0.69, 0.66];
    curbM.tri([xa, 0, rz0], [xa, BASE, rz0], [xb, BASE, rz0], [0, 0, 1], stone, [[0, 0], [0, 0.3], [1, 0.3]]);
    curbM.tri([xa, 0, rz1], [xa, BASE, rz1], [xb, BASE, rz1], [0, 0, -1], stone, [[0, 0], [0, 0.3], [1, 0.3]]);
    for (const [z0, z1] of [[ZA, CROSS0], [CROSS1, ZB]]) {
      const x0 = sgn * 4, x1 = sgn * 4.2, top = [0.86, 0.85, 0.82];
      for (let z = z0; z < z1 - 1e-6; z += 4) {
        const za = z, zb = Math.min(z1, z + 4), tone = 0.9 + 0.2 * vnoise(za * 0.5, 2, 41), cc = [tone * top[0], tone * top[1], tone * top[2]];
        curbM.quad([x0, BASE, za], [x1, BASE, za], [x1, BASE, zb], [x0, BASE, zb], UP, cc, [[za, 0.3], [za, 0.5], [zb, 0.5], [zb, 0.3]]);
        curbM.quad([x0, 0, za], [x0, BASE, za], [x0, BASE, zb], [x0, 0, zb], [-sgn, 0, 0], cc, [[za, 0], [za, BASE], [zb, BASE], [zb, 0]]);
      }
    }
  }
  // unify the two end faces of the sidewalk strips along the ramp (ramp flare) already added; sidewalk kerb-side faces beyond curb are hidden.

  // flat decals
  const decalM = new Mesher('road-wear-decals', { mat: mats.decal, k: 1, cast: false, order: 2 });
  const paintM = new Mesher('road-paint-worn', { mat: mats.paint, k: 1, cast: false, order: 3 });
  const patchM = new Mesher('road-asphalt-repairs', { mat: mats.patch, k: 1 / 1.2, cast: false, order: 1 });
  const patchLM = new Mesher('sidewalk-concrete-repairs', { mat: mats.patchLight, k: 1 / 1.2, cast: false, order: 1 });
  const tactM = new Mesher('kerb-ramp-tactile-paving', { mat: mats.tactile, k: 1, cast: false });
  const decalQuad = (m, cx, cz, w, l, yaw, uvr, y, color) => {
    const c = Math.cos(yaw), s = Math.sin(yaw), hw = w / 2, hl = l / 2;
    const pt = (px, pz) => [cx + px * c + pz * s, y, cz - px * s + pz * c];
    m.quad(pt(-hw, -hl), pt(hw, -hl), pt(hw, hl), pt(-hw, hl), UP, color, [[uvr[0], uvr[1]], [uvr[2], uvr[1]], [uvr[2], uvr[3]], [uvr[0], uvr[3]]]);
  };
  const DC = (i) => cellUV(i, 4, 4, 0.01);
  const DARK = [0.05, 0.05, 0.05];
  for (const sgn of [1, -1]) {       // tactile warning strips on the dropped kerbs
    const x0 = 4.1, x1 = 4.75, n = [-0.1, 1, 0], nl = Math.hypot(n[0], n[1]), off = 0.004;
    const y = (x) => (x - 4) * BASE / 1.4;
    const pts = [[x0, y(x0), CROSS0 + 0.3], [x1, y(x1), CROSS0 + 0.3], [x1, y(x1), CROSS1 - 0.3], [x0, y(x0), CROSS1 - 0.3]].map((p) => [sgn * p[0], p[1] + off * n[1] / nl, p[2]]);
    const w = (x1 - x0) / 0.24, l = (CROSS1 - CROSS0 - 0.6) / 0.24;
    tactM.quad(pts[0], pts[1], pts[2], pts[3], UP, [0.95, 0.9, 0.8], [[0, 0], [w, 0], [w, l], [0, l]]);
  }
  // road markings (worn, no clean highway lanes)
  const OFFWHITE = [0.8, 0.78, 0.7];
  for (let z = -76; z < 258; z += 8) {
    if (z + 3.2 > 24 && z < 36) continue;
    const vs = R(0, 0.6);
    decalQuad(paintM, 0.0 + R(-0.03, 0.03), z + 1.6, 0.13, 3.2, R(-0.01, 0.01), [0, vs, 1, vs + 0.32], 0.004, OFFWHITE);
  }
  for (let k = 0; k < 8; k++) {      // zebra bars across z 28..32
    const vs = R(0, 0.5), x = -3.5 + k + 0.5;
    decalQuad(paintM, x, 30, 0.5, 4, 0, [0.05, vs, 0.95, vs + 0.5], 0.0045, OFFWHITE);
  }
  decalQuad(paintM, 2.0, 26.5, 0.4, 3.5, Math.PI / 2, [0.05, 0.1, 0.95, 0.6], 0.0045, OFFWHITE);
  decalQuad(paintM, -2.0, 33.5, 0.4, 3.5, Math.PI / 2, [0.05, 0.4, 0.95, 0.9], 0.0045, OFFWHITE);
  // asphalt repairs: saw-cut rectangles with rubber-sealed seams
  const repairs = [[2.6, 3.7, 11, 15.5], [-3.5, -1.0, 40, 42.4], [-4, 4, 7.4, 8.2], [-4, 1.5, 63, 63.7], [0.2, 2.2, -12, -10.4], [-2.8, -0.8, 88, 90], [1.0, 3.8, 108, 109.2], [-3.6, -2.2, 18, 21], [-1.2, 0.2, 52, 55], [2.2, 3.6, -40, -37]];
  const seam = (x0, x1, z0, z1) => {
    const sw = 0.07, sc = [0.04, 0.04, 0.04], y = 0.0035, vs = R(0, 0.8);
    const strip = (cx, cz, w, l, yaw) => decalQuad(paintM, cx, cz, w, l, yaw, [0.3, vs, 0.7, vs + 0.15], y, sc);
    strip((x0 + x1) / 2, z0, sw, x1 - x0, Math.PI / 2); strip((x0 + x1) / 2, z1, sw, x1 - x0, Math.PI / 2);
    strip(x0, (z0 + z1) / 2, sw, z1 - z0, 0); strip(x1, (z0 + z1) / 2, sw, z1 - z0, 0);
  };
  for (const [x0, x1, z0, z1] of repairs) {
    const t = R(0.85, 1.0);
    patchM.quad([x0, 0.0025, z0], [x1, 0.0025, z0], [x1, 0.0025, z1], [x0, 0.0025, z1], UP, [t, t, t]);
    seam(x0, x1, z0, z1);
  }
  const sRepairs = [[4.6, 5.6, -30, -28.6], [-6.4, -5.0, 3, 4.4], [5.8, 7.0, 17, 18], [-5.6, -4.5, 44, 46], [6.0, 6.8, 71, 73], [-6.8, -5.4, 96, 97.5], [4.6, 5.4, 118, 120], [-5.2, -4.4, -52, -50]];
  for (const [x0, x1, z0, z1] of sRepairs) {
    const t = R(0.85, 1);
    patchLM.quad([x0, BASE + 0.0025, z0], [x1, BASE + 0.0025, z0], [x1, BASE + 0.0025, z1], [x0, BASE + 0.0025, z1], UP, [t, t * 0.98, t * 0.94]);
    const sc = [0.1, 0.1, 0.1], vs = R(0, 0.8);
    const strip = (cx, cz, w, l, yaw) => decalQuad(paintM, cx, cz, w, l, yaw, [0.3, vs, 0.7, vs + 0.1], BASE + 0.0035, sc);
    strip((x0 + x1) / 2, z0, 0.03, x1 - x0, Math.PI / 2); strip((x0 + x1) / 2, z1, 0.03, x1 - x0, Math.PI / 2); strip(x0, (z0 + z1) / 2, 0.03, z1 - z0, 0); strip(x1, (z0 + z1) / 2, 0.03, z1 - z0, 0);
  }
  for (let k = 0; k < 34; k++) {      // cracks in asphalt
    const x = R(-3.7, 3.7), z = R(-80, 150), size = R(1.4, 3.4);
    decalQuad(decalM, x, z, size, size, R(0, 6.28), DC(k % 3), 0.003, DARK);
  }
  for (let k = 0; k < 14; k++) {      // sidewalk cracks
    const side = k % 2 ? 1 : -1, x = side * R(4.6, 7.0), z = R(-70, 140), size = R(0.8, 1.8);
    decalQuad(decalM, x, z, size, size, R(0, 6.28), DC(k % 3), BASE + 0.003, [0.08, 0.08, 0.08]);
  }
  for (let k = 0; k < 12; k++) {      // oil / damp staining where cars wait
    const x = (k % 2 ? 1 : -1) * R(2.6, 3.4), z = R(-70, 140), size = R(1.0, 2.2);
    decalQuad(decalM, x, z, size, size, R(0, 6.28), DC(3), 0.0032, [0.04, 0.035, 0.04]);
  }
  for (let k = 0; k < 6; k++) decalQuad(decalM, R(-1.8, 1.8), (k < 3 ? 24.5 : 36) + R(-1, 1), 2.2, 2.2, R(-0.3, 0.3), DC(10), 0.0034, [0.03, 0.03, 0.03]);
  for (let k = 0; k < 80; k++) {      // gutter leaves, sand and gravel
    const side = k % 2 ? 1 : -1, x = side * R(3.45, 4.0), z = R(-90, 150), cell = [4, 5, 6, 7][k % 4], size = R(1.0, 2.4);
    decalQuad(decalM, x, z, size, size, R(0, 6.28), DC(cell), 0.0034, WHITE);
  }
  for (let k = 0; k < 36; k++) {      // leaves and grit on the pavement, strongest along the facade bases
    const side = k % 2 ? 1 : -1, x = side * (k % 3 === 0 ? R(6.4, 7.2) : R(4.3, 7.2)), z = R(-80, 150), size = R(0.8, 1.8);
    decalQuad(decalM, x, z, size, size, R(0, 6.28), DC([4, 5, 6, 7][k % 4]), BASE + 0.0034, WHITE);
  }
  for (const [x, z] of [[-1.7, -34], [3.0, 12.5], [-2.2, 47], [3.1, 70], [-1.5, 96], [2.9, 125]]) decalQuad(decalM, x, z, 0.72, 0.72, R(0, 6.28), DC(8), 0.0042, WHITE);
  [[-3.82, -44], [3.82, -8], [-3.82, 24], [3.82, 58], [-3.82, 92], [3.82, 126]].forEach(([x, z]) => decalQuad(decalM, x, z, 0.9, 0.62, Math.PI / 2, DC(9), 0.0042, WHITE));

  // ------------------------------------------------------------------ architecture data
  const PLASTER = ['#e6d8ae', '#e0c98f', '#d3a957', '#e4cf80', '#aab68f', '#bfc9a4', '#92b0a5', '#d9a998', '#c98a62', '#a3b3bd', '#ddd5c3', '#e3b78f', '#cfc09a', '#bda47a'].map(lin);
  const GPLASTER = ['#6e6a60', '#4d5b52', '#7a6a58', '#b8ad96', '#8a7f6b', '#5d6a73'].map(lin);
  const TRIMS = ['#efe6d2', '#d9cfb8', '#f3ecdc', '#bfb59c'].map(lin);
  const SHUTC = ['#35523f', '#5b3d2b', '#4a6272', '#e7dcc2', '#8a4b34', '#3f6a66', '#6b7a4a'].map(lin);
  const FRAMEC = ['#f1eadb', '#e0d6bf', '#4a3426', '#2f4a3a', '#d7cfba'].map(lin);
  const IRON = lin('#2a2c2e'), ZINC = lin('#8a8f93'), CLAY = lin('#9a4a30');
  const WIN_DARK = [0, 0, 1, 1, 2, 2, 4, 5, 7, 8, 9, 12, 13, 13], WIN_LIT = [3, 11, 14, 15, 6];
  const pickCell = () => (chance(0.2) ? pick(WIN_LIT) : pick(WIN_DARK));
  const SHOP = {
    cafe: { room: 'cafe', glass: true, door: true, aw: 'curved', awM: ['awG', 'awR', 'awB'], blade: 'cup', minW: 7.2,
      sign: { names: ['CÀ PHÊ XƯA', 'CÀ PHÊ SÂN VƯỜN', 'THE CORNER CAFÉ', 'CAFÉ HẺM NHỎ'], bg: '#2f4a3a', bg2: '#243a2d', fg: '#f1e2b8', font: FONT_SERIF } },
    books: { room: 'books', glass: true, door: true, aw: 'flat', awM: ['awD'], blade: 'book', minW: 6.2,
      sign: { names: ['HIỆU SÁCH PHỐ CŨ', 'NHÀ SÁCH HOA MAI', 'SÁCH CŨ - SÁCH MỚI'], bg: '#3a2a22', bg2: '#2a1e18', fg: '#d9b45a', font: FONT_SERIF } },
    grocer: { room: 'grocery', glass: false, door: false, aw: 'flat', awM: ['awY', 'awR'], blade: 'store', shutter: 'raised', minW: 5.8,
      sign: { names: ['TẠP HÓA BÀ TƯ', 'TẠP HÓA 24H', 'SIÊU THỊ MINI AN PHÚC'], bg: '#c7372f', bg2: '#a82c26', fg: '#ffe27a' } },
    bakery: { room: 'bakery', glass: true, door: true, aw: 'flat', awM: ['awR', 'awY'], blade: 'bread', minW: 5.4,
      sign: { names: ['BÁNH MÌ NÓNG GIÒN', 'TIỆM BÁNH BƠ SỮA'], bg: '#d9a441', bg2: '#c4902f', fg: '#6e2316' } },
    pharmacy: { room: 'pharm', glass: true, door: true, aw: null, blade: 'cross', minW: 5.4,
      sign: { names: ['NHÀ THUỐC AN KHANG', 'NHÀ THUỐC TÂY'], bg: '#f2f0e6', bg2: '#e0ddd0', fg: '#1f7a4a', icon: 'cross' } },
    barber: { room: 'barber', glass: true, door: true, aw: 'flat', awM: ['awB'], blade: 'scissors', minW: 4.6,
      sign: { names: ['CẮT TÓC NAM', 'SALON TÓC MINH'], bg: '#1d3557', bg2: '#16294a', fg: '#f1faee' } },
    tailor: { room: 'fabric', glass: true, door: true, aw: null, blade: 'thread', minW: 4.6,
      sign: { names: ['TIỆM MAY LAN', 'MAY ĐO - SỬA ĐỒ'], bg: '#6b2d3c', bg2: '#582331', fg: '#f3d9b1', font: FONT_SERIF } },
    hardware: { room: 'hardware', glass: false, door: false, aw: 'flat', awM: ['awB'], blade: 'wrench', shutter: 'raised', minW: 6.8,
      sign: { names: ['SẮT THÉP - VẬT LIỆU XÂY DỰNG', 'ĐIỆN NƯỚC THÀNH ĐẠT'], bg: '#1f4e79', bg2: '#173d60', fg: '#ffd23f' } },
    pho: { room: 'pho', glass: false, door: false, aw: 'flat', awM: ['awR'], blade: 'bowl', shutter: 'raised', minW: 5.6,
      sign: { names: ['PHỞ BÒ HÀ NỘI', 'BÚN CHẢ 36'], bg: '#a8342a', bg2: '#8d2a22', fg: '#f6ecd2' } },
    shutter: { room: null, glass: false, door: false, aw: null, blade: null, shutter: 'closed', minW: 4.2,
      sign: { names: ['GẠO - DẦU - NƯỚC MẮM', 'ĐẠI LÝ NƯỚC NGỌT', 'VẬT TƯ NÔNG NGHIỆP'], bg: '#d8d2bc', bg2: '#c4bda4', fg: '#3a3a3a' } },
  };
  const signNameIdx = {};
  const nextName = (type, st) => { const i = signNameIdx[type] || 0; signNameIdx[type] = i + 1; return st.names[i % st.names.length]; };

  // wall tone (vertex-colour weathering). `col` is the plaster colour.
  const makeTone = (L) => (s, y, col) => {
    const yy = y - BASE, n = vnoise(s * 0.8 + L.nx, y * 0.8, L.seed), streak = vnoise(s * 2.6 + L.nx, y * 0.12, L.seed + 9);
    let k = 0.93 + 0.12 * n - 0.1 * Math.max(0, streak - 0.55);
    const dirt = Math.max(0, 1 - yy / 1.6);
    k *= 1 - 0.28 * dirt * dirt;
    k *= 1 - 0.1 * Math.max(0, 1 - (L.H - y) / 1.0) * streak;
    const c = mulc(col, k);
    return yy < 0.56 ? mixc(c, L.plinth, 0.65) : c;
  };
  // wall band: a rectangle of facade minus openings, split into <=1.4 m cells so vertex tone can weather it
  const refine = (arr, max) => {
    arr.sort((a, b) => a - b);
    const out = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      const a = out[out.length - 1], b = arr[i];
      if (b - a < 1e-4) continue;
      const n = Math.ceil((b - a) / max - 1e-6);
      for (let k = 1; k <= n; k++) out.push(a + (b - a) * k / n);
    }
    return out;
  };
  const wallBand = (m, F, s0, s1, y0, y1, ops, toneFn, extraY) => {
    const sb = [s0, s1], yb = [y0, y1];
    for (const o of ops) { sb.push(clamp(o.s0, s0, s1), clamp(o.s1, s0, s1)); yb.push(clamp(o.y0, y0, y1), clamp(o.y1, y0, y1)); }
    if (extraY) for (const y of extraY) if (y > y0 + 0.05 && y < y1 - 0.05) yb.push(y);
    const S = refine(sb, 1.4), Y = refine(yb, 1.3);
    for (let j = 0; j < Y.length - 1; j++) for (let i = 0; i < S.length - 1; i++) {
      const cs = (S[i] + S[i + 1]) / 2, cy = (Y[j] + Y[j + 1]) / 2;
      if (ops.some((o) => cs > o.s0 && cs < o.s1 && cy > o.y0 && cy < o.y1)) continue;
      fq(m, F, S[i], Y[j], S[i + 1], Y[j + 1], 0, [toneFn(S[i], Y[j]), toneFn(S[i + 1], Y[j]), toneFn(S[i + 1], Y[j + 1]), toneFn(S[i], Y[j + 1])]);
    }
  };
  // parametric grid on a (possibly sloped) surface
  const gridQuads = (m, ptFn, nu, nv, colFn, hint, proj) => {
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const u0 = i / nu, u1 = (i + 1) / nu, v0 = j / nv, v1 = (j + 1) / nv;
      m.quad(ptFn(u0, v0), ptFn(u1, v0), ptFn(u1, v1), ptFn(u0, v1), hint, [colFn(u0, v0), colFn(u1, v0), colFn(u1, v1), colFn(u0, v1)], null, proj);
    }
  };
  // extrude a (d, y) profile along s; used for curved awnings/vault roofs. normals are radial from `inner`.
  const sweepProfile = (m, F, s0, s1, pts, inner, color, uvFn) => {
    const nrm = pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let td = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(td, ty) || 1; td /= l; ty /= l;
      let nd = ty, ny = -td;
      if (nd * (p[0] - inner[0]) + ny * (p[1] - inner[1]) < 0) { nd = -nd; ny = -ny; }
      return [F.n[0] * nd, ny, F.n[2] * nd];
    });
    let len = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const A = pts[i], B = pts[i + 1], l0 = len; len += Math.hypot(B[0] - A[0], B[1] - A[1]);
      const uv = uvFn ? [uvFn(s0, l0), uvFn(s1, l0), uvFn(s1, len), uvFn(s0, len)] : null;
      m.quad(F.p(s0, A[1], A[0]), F.p(s1, A[1], A[0]), F.p(s1, B[1], B[0]), F.p(s0, B[1], B[0]),
        [F.n[0] * ((A[0] + B[0]) / 2 - inner[0]), (A[1] + B[1]) / 2 - inner[1], F.n[2] * ((A[0] + B[0]) / 2 - inner[0])], color, uv, null, [nrm[i], nrm[i], nrm[i + 1], nrm[i + 1]]);
    }
  };

  // ------------------------------------------------------------------ the lot builder
  // L: {id,type,lite,F,w,floors,gh,fh,H,Hf,D,plaster,gColor,trim,plinth,roof,pitch,seed,nx,ou,ov,balc,shut,bay,winW,winH,sill,inset,...}
  const buildLot = (L, M) => {
    const F = L.F, w = L.w, D = L.D, H = L.H, lite = L.lite;
    const P = M.plaster, ROOF = M.roof, WD = M.wood, LV = M.louver, MT = M.metal, RU = M.rollup, WIN = M.window, GL = M.glass, GO = M.goods, SG = M.sign, BL = M.blade, LP = M.lamp;
    for (const k in M) { M[k].ou = L.ou; M[k].ov = L.ov; }
    const tone = makeTone(L), trimC = L.trim, gTop = BASE + L.gh;
    const cuv = (k, cols = 4, rows = 4, ins = 0.004) => cellUV(k, cols, rows, ins);
    const rectUV = (u) => [[u[0], u[1]], [u[2], u[1]], [u[2], u[3]], [u[0], u[3]]];
    const goodsFace = (s0, s1, y0, y1, d, cell, tint = 1) => GO.quad(F.p(s0, y0, d), F.p(s1, y0, d), F.p(s1, y1, d), F.p(s0, y1, d), F.n, [tint, tint, tint], rectUV(cuv(cell, 4, 4, 0.01)));
    // goods on a plane s = const (shelf on a side wall), spanning depth dA (near the street) .. dB (deeper)
    const sideGoods = (s, plus, y0, y1, dA, dB, cell) => {
      const u = cuv(cell, 4, 4, 0.01);
      GO.quad(F.p(s, y0, dA), F.p(s, y0, dB), F.p(s, y1, dB), F.p(s, y1, dA), plus ? F.sv : neg(F.sv), [1, 1, 1],
        plus ? [[u[0], u[1]], [u[2], u[1]], [u[2], u[3]], [u[0], u[3]]] : [[u[2], u[1]], [u[0], u[1]], [u[0], u[3]], [u[2], u[3]]]);
    };
    const reveal = (s0, s1, y0, y1, dep, c = L.plaster) => {
      const rc = mulc(c, 0.8);
      fFlat(P, F, y0, s0, s1, 0, -dep, true, mulc(rc, 0.9));
      fFlat(P, F, y1, s0, s1, 0, -dep, false, mulc(rc, 0.7));
      fSide(P, F, s0, y0, y1, 0, -dep, true, rc);
      fSide(P, F, s1, y0, y1, 0, -dep, false, rc);
    };
    const winQuad = (s0, s1, y0, y1, d, cell, tint = 0.95) => {
      const u = cuv(cell, 4, 4);
      WIN.quad(F.p(s0, y0, d), F.p(s1, y0, d), F.p(s1, y1, d), F.p(s0, y1, d), F.n, [tint, tint, tint], rectUV(u));
    };
    const signBoard = (s0, s1, y0, y1, text, st) => {
      const uv = paintSign(text, st, (s1 - s0) / (y1 - y0)), d = 0.09;
      fbox(P, F, s0, s1, y0, y1, 0, d, mixc(lin(st.bg), [0.02, 0.02, 0.02], 0.4), 'f');
      SG.quad(F.p(s0, y0, d), F.p(s1, y0, d), F.p(s1, y1, d), F.p(s0, y1, d), F.n, WHITE, rectUV(uv));
    };
    const bladeSign = (s, y, kind) => {
      const u = cuv(BLADE[kind], 8, 4, 0.01), d0 = 0.2, d1 = 0.78;
      fbox(MT, F, s - 0.015, s + 0.015, y + 0.6, y + 0.63, 0, d1 + 0.05, IRON);
      fbox(MT, F, s - 0.025, s + 0.025, y, y + 0.58, d0, d1, mulc(IRON, 1.5), 'lr');
      BL.quad(F.p(s + 0.026, y, d1), F.p(s + 0.026, y, d0), F.p(s + 0.026, y + 0.58, d0), F.p(s + 0.026, y + 0.58, d1), F.sv, WHITE, rectUV(u));
      BL.quad(F.p(s - 0.026, y, d0), F.p(s - 0.026, y, d1), F.p(s - 0.026, y + 0.58, d1), F.p(s - 0.026, y + 0.58, d0), neg(F.sv), WHITE, rectUV(u));
    };

    // ---------- awnings
    const awningStraight = (mk, s0, s1, yWall, yFront, dp, vh) => {
      const A = M[mk], col = [1, 1, 1], dark = [0.55, 0.55, 0.55], ks = 1 / 0.36, len = Math.hypot(dp, yWall - yFront);
      const slopeN = [F.n[0] * (yWall - yFront), dp, F.n[2] * (yWall - yFront)];
      const uvf = (s, l) => [s * ks, l * ks];
      A.quad(F.p(s0, yWall, 0), F.p(s1, yWall, 0), F.p(s1, yFront, dp), F.p(s0, yFront, dp), slopeN, col, [uvf(s0, 0), uvf(s1, 0), uvf(s1, len), uvf(s0, len)]);
      A.quad(F.p(s0, yWall - 0.03, 0), F.p(s1, yWall - 0.03, 0), F.p(s1, yFront - 0.03, dp), F.p(s0, yFront - 0.03, dp), [-slopeN[0], -dp, -slopeN[2]], dark, [uvf(s0, 0), uvf(s1, 0), uvf(s1, len), uvf(s0, len)]);
      A.quad(F.p(s0, yFront, dp), F.p(s1, yFront, dp), F.p(s1, yFront - vh, dp), F.p(s0, yFront - vh, dp), F.n, col, [uvf(s0, 0), uvf(s1, 0), uvf(s1, 0.5), uvf(s0, 0.5)]);
      A.quad(F.p(s0, yFront, dp - 0.03), F.p(s1, yFront, dp - 0.03), F.p(s1, yFront - vh, dp - 0.03), F.p(s0, yFront - vh, dp - 0.03), neg(F.n), dark, [uvf(s0, 0), uvf(s1, 0), uvf(s1, 0.5), uvf(s0, 0.5)]);
      for (const [s, plus] of [[s0, false], [s1, true]]) {
        A.tri(F.p(s, yWall, 0), F.p(s, yFront, dp), F.p(s, yFront - vh, dp), plus ? F.sv : neg(F.sv), [0.8, 0.8, 0.8]);
        A.tri(F.p(s, yWall, 0), F.p(s, yFront - vh, dp), F.p(s, yWall - 0.03, 0), plus ? F.sv : neg(F.sv), [0.8, 0.8, 0.8]);
        fbox(MT, F, s - 0.012, s + 0.012, yFront - vh - 0.02, yFront - vh + 0.02, 0.02, dp, IRON);
      }
      fbox(MT, F, s0, s1, yFront - vh - 0.03, yFront - vh, dp - 0.04, dp, IRON);
    };
    const awningCurved = (mk, s0, s1, yTop, dp, vh) => {
      const A = M[mk], ry = 0.62, cy = yTop - ry, n = 9, ks = 1 / 0.36, pts = [], inn = [];
      for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI / 2; pts.push([dp * Math.sin(a), cy + ry * Math.cos(a)]); inn.push([(dp - 0.04) * Math.sin(a), cy + (ry - 0.04) * Math.cos(a)]); }
      const uvf = (s, l) => [s * ks, l * ks];
      sweepProfile(A, F, s0, s1, pts, [0, cy], [1, 1, 1], uvf);
      sweepProfile(A, F, s0, s1, inn, [0, cy], [0.55, 0.55, 0.55], uvf);
      const e = pts[n];
      A.quad(F.p(s0, e[1], e[0]), F.p(s1, e[1], e[0]), F.p(s1, e[1] - vh, e[0]), F.p(s0, e[1] - vh, e[0]), F.n, [1, 1, 1], [uvf(s0, 0), uvf(s1, 0), uvf(s1, 0.5), uvf(s0, 0.5)]);
      for (const [s, plus] of [[s0, false], [s1, true]]) for (let i = 0; i < n; i++) A.tri(F.p(s, cy, 0), F.p(s, pts[i][1], pts[i][0]), F.p(s, pts[i + 1][1], pts[i + 1][0]), plus ? F.sv : neg(F.sv), [0.8, 0.8, 0.8]);
      fbox(MT, F, s0, s1, e[1] - vh - 0.03, e[1] - vh, e[0] - 0.04, e[0], IRON);
    };

    // ---------- windows, doors, balconies
    const casementFrame = (s0, s1, y0, y1, dep, fc, door) => {
      const fw = 0.055, d0 = -dep, d1 = -dep + 0.07;
      fbox(WD, F, s0, s0 + fw, y0, y1, d0, d1, fc, 'b'); fbox(WD, F, s1 - fw, s1, y0, y1, d0, d1, fc, 'b');
      fbox(WD, F, s0 + fw, s1 - fw, y0, y0 + fw, d0, d1, fc, 'b'); fbox(WD, F, s0 + fw, s1 - fw, y1 - fw, y1, d0, d1, fc, 'b');
      if (s1 - s0 > 1.05) fbox(WD, F, (s0 + s1) / 2 - 0.025, (s0 + s1) / 2 + 0.025, y0 + fw, y1 - fw, d0, d1, fc, 'b');
      if (!door) fbox(WD, F, s0 + fw, s1 - fw, y0 + (y1 - y0) * 0.68, y0 + (y1 - y0) * 0.68 + 0.04, d0, d1, fc, 'b');
    };
    const windowAt = (s0, s1, y0, y1, o) => {
      const dep = 0.3;
      reveal(s0, s1, y0, y1, dep);
      winQuad(s0, s1, y0, y1, -dep - 0.02, o.cell);
      if (lite) return;
      casementFrame(s0, s1, y0, y1, dep, o.frameC, o.door);
      fbox(P, F, s0 - 0.1, s0, y0 - 0.06, y1 + 0.12, 0, 0.04, trimC, 'b'); fbox(P, F, s1, s1 + 0.1, y0 - 0.06, y1 + 0.12, 0, 0.04, trimC, 'b');
      fbox(P, F, s0 - 0.13, s1 + 0.13, y1, y1 + 0.13, 0, 0.08, trimC, 'b');
      if (!o.door) fbox(P, F, s0 - 0.09, s1 + 0.09, y0 - 0.08, y0, 0, 0.14, trimC, 'b');
      const lw = (s1 - s0) / 2, sc = o.shutC, shut = o.door ? 'none' : o.shut;
      if (shut === 'open' && s0 - lw > 0.08 && s1 + lw < w - 0.08) {
        fbox(LV, F, s0 - lw - 0.02, s0 - 0.02, y0 - 0.02, y1 + 0.04, 0.0, 0.04, sc, 'b'); fbox(LV, F, s1 + 0.02, s1 + lw + 0.02, y0 - 0.02, y1 + 0.04, 0.0, 0.04, sc, 'b');
      } else if (shut === 'closed') {
        fbox(LV, F, s0 - 0.02, (s0 + s1) / 2, y0 - 0.02, y1 + 0.04, 0.02, 0.06, sc, 'b'); fbox(LV, F, (s0 + s1) / 2, s1 + 0.02, y0 - 0.02, y1 + 0.04, 0.02, 0.06, sc, 'b');
      } else if (shut === 'half' && s0 - lw > 0.08 && s1 + lw < w - 0.08) {
        for (const side of [-1, 1]) {
          const phi = (side < 0 ? 1 : 1) * R(0.5, 1.05), hs = side < 0 ? s0 - 0.02 : s1 + 0.02, ds = side * Math.cos(phi) * lw, dd = Math.sin(phi) * lw;
          const tl = Math.hypot(ds, dd) || 1, ts = -dd / tl * 0.035 * side, td = ds / tl * 0.035 * side, c = [];
          for (let i = 0; i < 8; i++) c.push(F.p(hs + (i & 1) * ds + ((i >> 2) & 1) * ts, y0 - 0.02 + ((i >> 1) & 1) * (y1 - y0 + 0.06), 0.05 + (i & 1) * dd + ((i >> 2) & 1) * td));
          LV.boxC(c, sc);
        }
      }
      if (o.grille) {
        const n = Math.max(3, Math.floor((s1 - s0) / 0.1));
        for (let i = 0; i <= n; i++) { const s = s0 + (s1 - s0) * i / n; fbox(MT, F, s - 0.009, s + 0.009, y0 - 0.02, y1 + 0.02, 0.03, 0.05, IRON, 'b'); }
        fbox(MT, F, s0, s1, y0 + (y1 - y0) * 0.5, y0 + (y1 - y0) * 0.5 + 0.025, 0.03, 0.055, IRON); fbox(MT, F, s0, s1, y1 - 0.025, y1, 0.03, 0.055, IRON); fbox(MT, F, s0, s1, y0, y0 + 0.025, 0.03, 0.055, IRON);
      }
      if (o.ac) {
        const s = o.ac, aw = 0.82, ah = 0.52, ay = y0 - 0.14 - ah;
        fbox(MT, F, s - aw / 2, s + aw / 2, ay, ay + ah, 0.06, 0.34, [0.78, 0.78, 0.76], 'f');
        goodsFace(s - aw / 2, s + aw / 2, ay, ay + ah, 0.341, 8, 0.95);
        fbox(MT, F, s - 0.3, s + 0.3, ay - 0.03, ay, 0.0, 0.3, IRON); fbox(MT, F, s - 0.01, s + 0.01, ay - 0.5, ay - 0.02, 0.01, 0.03, [0.78, 0.78, 0.76]);
      }
    };
    const balcony = (s0, s1, yF, dp, iron, c) => {
      fbox(P, F, s0, s1, yF - 0.17, yF, 0, dp, c, 'b');
      fbox(P, F, s0 - 0.02, s1 + 0.02, yF - 0.22, yF - 0.17, 0, dp + 0.03, mulc(c, 0.85), 'b');
      const rc = iron ? IRON : mulc(c, 0.95);
      if (iron) {
        fbox(MT, F, s0, s1, yF + 0.98, yF + 1.04, dp - 0.07, dp - 0.01, rc); fbox(MT, F, s0, s1, yF + 0.05, yF + 0.09, dp - 0.05, dp - 0.02, rc);
        const nb = Math.floor((s1 - s0) / 0.13);
        for (let i = 0; i <= nb; i++) { const s = s0 + 0.03 + (s1 - s0 - 0.06) * i / nb; fbox(MT, F, s - 0.01, s + 0.01, yF + 0.07, yF + 0.99, dp - 0.045, dp - 0.025, rc, 'b'); }
        for (const [s, p] of [[s0 + 0.015, 1], [s1 - 0.015, -1]]) {
          fbox(MT, F, s - 0.02, s + 0.02, yF, yF + 1.04, 0, dp, rc, 'bf');
          fbox(MT, F, s - 0.02, s + 0.02, yF, yF + 1.04, dp - 0.05, dp - 0.01, rc);
          const nd = Math.floor(dp / 0.14);
          for (let i = 1; i < nd; i++) fbox(MT, F, s - 0.007, s + 0.007, yF + 0.07, yF + 0.99, dp * i / nd - 0.01, dp * i / nd + 0.01, rc);
          fbox(MT, F, s - 0.015, s + 0.015, yF + 0.98, yF + 1.04, 0, dp, rc);
        }
      } else {
        fbox(P, F, s0, s1, yF, yF + 0.95, dp - 0.14, dp, rc, 'b'); fbox(P, F, s0, s0 + 0.14, yF, yF + 0.95, 0, dp - 0.14, rc, 'bf'); fbox(P, F, s1 - 0.14, s1, yF, yF + 0.95, 0, dp - 0.14, rc, 'bf');
        fbox(P, F, s0 - 0.03, s1 + 0.03, yF + 0.95, yF + 1.01, -0.0, dp + 0.03, mulc(c, 1.05), 'b');
      }
    };
    const downpipe = (s, y1, col) => {
      fbox(MT, F, s - 0.04, s + 0.04, BASE, y1, 0.0, 0.08, col, 'b');
      for (let y = BASE + 0.7; y < y1; y += 1.5) fbox(MT, F, s - 0.055, s + 0.055, y, y + 0.04, 0.0, 0.1, IRON, 'b');
      fbox(MT, F, s - 0.04, s + 0.04, BASE + 0.18, BASE + 0.3, 0.0, 0.2, col, 'b');
    };

    // ---------- shop interiors
    const room = (sa, sb, ytop, kind, hasDoor) => {
      const Rm = Math.min(D - 1.2, R(3.6, 4.8)), dF = -0.32, yF = BASE + 0.03, yC = ytop, fl = [0.3, 0.23, 0.17], wl = [0.46, 0.4, 0.33], ce = [0.52, 0.48, 0.42];
      const wlC = kind === 'pharm' ? [0.7, 0.72, 0.7] : kind === 'barber' ? [0.5, 0.52, 0.5] : wl;
      WD.quad(F.p(sa, yF, dF), F.p(sb, yF, dF), F.p(sb, yF, -Rm), F.p(sa, yF, -Rm), UP, kind === 'pharm' || kind === 'bakery' ? [0.5, 0.5, 0.48] : fl);
      fFlat(P, F, yC, sa, sb, dF, -Rm, false, ce);
      fq(P, F, sa, yF, sb, yC, -Rm, wlC);
      fSide(P, F, sa, yF, yC, dF, -Rm, true, mulc(wlC, 0.85)); fSide(P, F, sb, yF, yC, dF, -Rm, false, mulc(wlC, 0.85));
      const mid = (sa + sb) / 2, wd = sb - sa, back = -Rm;
      const ceilingLamp = (s, d, len = 0.9) => fbox(LP, F, s - len / 2, s + len / 2, yC - 0.05, yC - 0.01, d - 0.07, d + 0.07, [1, 0.86, 0.62]);
      const table = (s, d, c) => {
        fbox(WD, F, s - 0.32, s + 0.32, 0.72 + BASE, 0.76 + BASE, d - 0.32, d + 0.32, c); fbox(WD, F, s - 0.03, s + 0.03, yF, 0.72 + BASE, d - 0.03, d + 0.03, mulc(c, 0.6));
        for (const sd of [-0.46, 0.46]) fbox(WD, F, s + sd - 0.15, s + sd + 0.15, yF, yF + 0.44, d - 0.15, d + 0.15, [0.35, 0.2, 0.14]);
      };
      const shelf = (s0, s1, y1, cell, dp = 0.36) => { fbox(WD, F, s0, s1, yF, y1, back, back + dp, [0.3, 0.22, 0.16], 'f'); goodsFace(s0, s1, yF, y1, back + dp + 0.004, cell, 0.9); };
      const counter = (s0, s1, d0, d1, c) => { fbox(WD, F, s0, s1, yF, yF + 0.95, d0, d1, c); fbox(P, F, s0 - 0.04, s1 + 0.04, yF + 0.95, yF + 1.0, d0 - 0.04, d1 + 0.04, [0.55, 0.52, 0.48]); };
      const alc = hasDoor ? 0.7 : 0;      // keep the entrance side clear
      switch (kind) {
        case 'cafe':
          shelf(sa + 0.3, mid - 0.1, yF + 2.2, 5); shelf(mid + 0.1, sb - 0.3, yF + 2.2, 7);
          counter(mid - 1.6, mid + 1.6, back + 0.45, back + 1.1, [0.28, 0.2, 0.15]); fbox(MT, F, mid - 0.4, mid + 0.4, yF + 1.0, yF + 1.45, back + 0.55, back + 1.0, [0.6, 0.58, 0.55]);
          for (let i = 0; i < 2; i++) { const s = sa + 0.9 + i * 1.7; if (s + 0.7 < sb - alc * 0 && !(hasDoor && s > sb - 1.4)) { table(s, -1.6 - i * 0.2, [0.5, 0.36, 0.24]); fbox(LP, F, s - 0.09, s + 0.09, yC - 0.62, yC - 0.45, -1.6 - i * 0.2 - 0.09, -1.6 - i * 0.2 + 0.09, [1, 0.8, 0.5]); fbox(MT, F, s - 0.005, s + 0.005, yC - 0.45, yC, -1.6 - i * 0.2 - 0.005, -1.6 - i * 0.2 + 0.005, IRON); }
          }
          ceilingLamp(mid, -2.8); break;
        case 'books':
          shelf(sa + 0.2, sb - 0.2, yF + 2.3, 0); sideGoods(sa + 0.02, true, yF, yF + 2.3, -0.9, -Rm + 0.4, 0); sideGoods(sb - 0.02, false, yF, yF + 2.3, -0.9, -Rm + 0.4, 0);
          table(mid, -1.9, [0.3, 0.22, 0.15]); fbox(WD, F, mid - 0.2, mid + 0.2, BASE + 0.76, BASE + 0.9, -2.0, -1.8, [0.7, 0.3, 0.25]); ceilingLamp(mid, -1.8); ceilingLamp(mid, -3.2); break;
        case 'grocery':
          shelf(sa + 0.3, mid + 0.5, yF + 2.2, 1); shelf(mid + 0.6, sb - 0.2, yF + 2.2, 1);
          sideGoods(sa + 0.02, true, yF, yF + 2.2, -0.9, -Rm + 0.4, 6);
          counter(sb - 1.7, sb - 0.3, -1.0, -1.7, [0.4, 0.3, 0.22]); fbox(MT, F, sb - 1.1, sb - 0.7, yF + 1.0, yF + 1.25, -1.2, -1.5, [0.2, 0.2, 0.22]);
          fbox(WD, F, mid - 0.5, mid + 0.5, yF, yF + 0.8, -2.2, -1.5, [0.4, 0.3, 0.2], 'f'); goodsFace(mid - 0.5, mid + 0.5, yF, yF + 0.8, -1.5 + 0.004, 11, 0.9); ceilingLamp(mid, -1.8); ceilingLamp(mid, -3.2); break;
        case 'bakery':
          fbox(WD, F, sa + 0.4, sb - 0.4 - alc, yF, yF + 1.0, -1.5, -0.8, [0.42, 0.28, 0.2], 'f'); goodsFace(sa + 0.4, sb - 0.4 - alc, yF + 0.1, yF + 0.95, -0.796, 2, 0.95);
          GL.quad(F.p(sa + 0.4, yF + 1.0, -0.8), F.p(sb - 0.4 - alc, yF + 1.0, -0.8), F.p(sb - 0.4 - alc, yF + 1.4, -0.8), F.p(sa + 0.4, yF + 1.4, -0.8), F.n, WHITE);
          shelf(sa + 0.3, sb - 0.3, yF + 2.2, 2); ceilingLamp(mid, -1.4); ceilingLamp(mid, -3); break;
        case 'pharm':
          shelf(sa + 0.2, sb - 0.2, yF + 2.3, 3); counter(sa + 0.5, sb - 0.5 - alc, -1.6, -2.3, [0.82, 0.84, 0.82]); ceilingLamp(mid, -1.2); ceilingLamp(mid, -2.8); break;
        case 'barber':
          sideGoods(sa + 0.02, true, yF + 0.8, yF + 2.3, -0.8, -Rm + 0.8, 9); sideGoods(sb - 0.02, false, yF + 0.8, yF + 2.3, -0.8, -Rm + 0.8, 9);
          for (const s of [sa + 0.9, sb - 0.9 - alc]) { fbox(MT, F, s - 0.25, s + 0.25, yF, yF + 0.55, -1.7, -1.2, [0.18, 0.18, 0.2]); fbox(WD, F, s - 0.25, s + 0.25, yF + 0.55, yF + 1.3, -1.72, -1.6, [0.22, 0.12, 0.1]); }
          ceilingLamp(mid, -1.6); break;
        case 'fabric':
          shelf(sa + 0.2, sb - 0.2, yF + 2.3, 4); fbox(WD, F, mid - 0.7, mid + 0.7, yF + 0.72, yF + 0.78, -2.2, -1.4, [0.5, 0.38, 0.26]);
          fbox(MT, F, sa + 0.8, sa + 1.2, yF + 0.9, yF + 1.55, -0.9, -0.6, [0.82, 0.76, 0.68]); fbox(MT, F, sa + 0.9, sa + 1.1, yF + 1.55, yF + 1.8, -0.84, -0.66, [0.85, 0.7, 0.58]); fbox(MT, F, sa + 0.98, sa + 1.02, yF, yF + 0.9, -0.77, -0.73, IRON);
          ceilingLamp(mid, -1.8); break;
        case 'hardware':
          shelf(sa + 0.2, mid, yF + 2.2, 10); shelf(mid, sb - 0.2, yF + 2.2, 12); fbox(WD, F, sa + 0.6, sa + 1.6, yF, yF + 0.7, -1.6, -0.9, [0.45, 0.34, 0.22]); ceilingLamp(mid, -1.8); ceilingLamp(mid, -3.2); break;
        case 'pho':
          fbox(MT, F, mid - 1.4, mid + 1.4, yF, yF + 1.0, back + 0.1, back + 0.8, [0.7, 0.72, 0.72]); goodsFace(mid - 1.4, mid + 1.4, yF + 1.0, yF + 2.0, back + 0.101, 12, 0.9);
          for (let i = 0; i < 3; i++) table(sa + 0.9 + i * 1.5, -1.5 - (i % 2) * 0.5, [0.62, 0.6, 0.56]);
          for (let i = 0; i < 3; i++) fbox(LP, F, sa + 1.2 + i * 1.5 - 0.1, sa + 1.2 + i * 1.5 + 0.1, yC - 0.45, yC - 0.2, -1.2 - 0.1, -1.2 + 0.1, [1, 0.18, 0.1]);
          break;
        default: ceilingLamp(mid, -1.8);
      }
      return wd;
    };

    // ---------- building shell: back wall, side walls, roof
    const tile = L.roof === 'tile', vault = L.roof === 'vault', flat = L.roof === 'flat';
    const tp = Math.tan(L.pitch), ridgeD = -D / 2, rise = (0.55 + D / 2) * tp, topFront = tile ? L.Hf : (flat ? H + L.parapet : H);
    fq(P, F, 0, 0, w, topFront, -D, tone(0, 5, L.plaster), null, null, true);
    const sideC = mulc(L.plaster, 0.94);
    const sideWall = (s, plus) => {
      const hint = plus ? F.sv : neg(F.sv), dFront = L.inset, nD = Math.max(2, Math.ceil((D + dFront) / 2.2)), top = tile ? L.Hf : (flat ? H + L.parapet : H);
      for (let j = 0; j < Math.max(2, Math.ceil(top / 2.4)); j++) {
        const ya = top * j / Math.max(2, Math.ceil(top / 2.4)), yb = top * (j + 1) / Math.max(2, Math.ceil(top / 2.4));
        for (let i = 0; i < nD; i++) {
          const da = dFront - (D + dFront) * i / nD, db = dFront - (D + dFront) * (i + 1) / nD, c = (d, y) => tone(d * 0.7 + (plus ? 40 : 0), y, sideC);
          P.quad(F.p(s, ya, da), F.p(s, ya, db), F.p(s, yb, db), F.p(s, yb, da), hint, [c(da, ya), c(db, ya), c(db, yb), c(da, yb)]);
        }
      }
      if (tile) { const yLow = L.Hf; P.tri(F.p(s, yLow, 0), F.p(s, yLow, -D), F.p(s, H + 0.04 + rise, ridgeD), hint, sideC); }
      if (vault) {
        const pts = L.vaultPts;
        for (let i = 0; i < pts.length - 1; i++) P.quad(F.p(s, H, pts[i][0]), F.p(s, H, pts[i + 1][0]), F.p(s, pts[i + 1][1], pts[i + 1][0]), F.p(s, pts[i][1], pts[i][0]), hint, sideC);
      }
    };
    sideWall(0, false); sideWall(w, true);
    if (L.inset > 0.01) {  // forecourt slab for a set-back frontage
      fFlat(M.plaster, F, BASE, 0, w, 0, L.inset, true, [0.6, 0.58, 0.54]);
      fbox(P, F, -0.0, w, BASE, BASE + 0.14, 0, L.inset, [0.62, 0.6, 0.55], 'bf');
    }
    if (tile) {
      const yE = H, dE = 0.55, yR = H + 0.04 + rise, dB = -D - 0.55, ca = Math.cos(L.pitch), sa = Math.sin(L.pitch);
      const vF = [-F.n[0] * ca, sa, -F.n[2] * ca], vB = [F.n[0] * ca, sa, F.n[2] * ca];
      const nu = Math.max(1, Math.round(w / 3)), colF = (u, v) => { const k = 0.92 + 0.16 * vnoise(u * w * 0.2 + L.nx, v * 3, L.seed + 3); return [k, k, k]; };
      gridQuads(ROOF, (u, v) => F.p(u * w, yE + 0.04 + (yR - yE - 0.04) * v, dE + (ridgeD - dE) * v), nu, 3, colF, [F.n[0] * sa, ca, F.n[2] * sa], [F.sv, vF]);
      gridQuads(ROOF, (u, v) => F.p(u * w, yR + (yE + 0.04 - yR) * v, ridgeD + (dB - ridgeD) * v), nu, 3, colF, [-F.n[0] * sa, ca, -F.n[2] * sa], [F.sv, vB]);
      fbox(ROOF, F, 0, w, yR - 0.02, yR + 0.14, ridgeD - 0.13, ridgeD + 0.13, mulc(CLAY, 0.8));
      fbox(P, F, 0, w, yE - 0.1, yE + 0.08, dE - 0.06, dE, mulc(trimC, 0.8), 'b');                        // fascia
      fbox(MT, F, 0, w, yE - 0.17, yE - 0.03, dE - 0.16, dE - 0.02, ZINC);                                  // gutter
      fFlat(P, F, yE, 0, w, 0, dE, false, [0.52, 0.48, 0.42]);                                                // soffit
    } else if (flat) {
      const pc = mulc(L.plaster, 0.97);
      fq(P, F, 0, H - 0.0, w, H + L.parapet, 0, [tone(0, H, pc), tone(w, H, pc), tone(w, H, pc), tone(0, H, pc)]);
      fbox(P, F, -0.02, w + 0.02, H + L.parapet, H + L.parapet + 0.08, -0.26, 0.05, trimC, 'b');
      fbox(P, F, -0.02, w + 0.02, H - 0.34, H, 0, 0.15, trimC, 'b'); fbox(P, F, -0.02, w + 0.02, H - 0.1, H - 0.0, 0.15, 0.17, mulc(trimC, 0.85), 'b');
      fFlat(P, F, H + 0.04, 0, w, -D, 0, true, [0.2, 0.19, 0.18]);
      if (!lite) {
        if (chance(0.7)) { const s = R(1.4, Math.max(1.5, w - 1.4)), d = -R(3, D - 3); fbox(MT, F, s - 0.5, s + 0.5, H + 0.04, H + 0.7, d - 0.5, d + 0.5, [0.1, 0.1, 0.11], 't'); M.metal.cyl(F.p(s, 0, d)[0], F.p(s, 0, d)[2], H + 0.7, H + 1.9, 0.55, 0.52, 10, chance(0.5) ? [0.04, 0.07, 0.16] : [0.06, 0.06, 0.07]); }
        if (chance(0.5)) { const s = R(1.3, Math.max(1.4, w - 2.6)), d = -R(4, D - 4); fbox(P, F, s, s + 2.0, H + 0.04, H + 2.5, d - 1.1, d + 1.1, mulc(L.plaster, 0.92), 't'); fbox(P, F, s - 0.2, s + 2.2, H + 2.5, H + 2.65, d - 1.3, d + 1.3, mulc(trimC, 0.9)); fbox(WD, F, s + 0.6, s + 1.3, H + 0.04, H + 2.1, d + 1.095, d + 1.12, [0.3, 0.2, 0.14]); }
        for (let k = 0; k < RI(0, 2); k++) { const s = R(0.8, Math.max(0.9, w - 1)), d = -R(2, D - 2); fbox(MT, F, s, s + 0.7, H + 0.04, H + 0.65, d, d + 0.5, [0.72, 0.72, 0.7]); }
      }
    } else if (vault) {
      const pts = L.vaultPts, inner = [(L.vaultPts[0][0] + L.vaultPts[L.vaultPts.length - 1][0]) / 2, H - 0.5];
      sweepProfile(MT, F, 0, w, pts, inner, [0.55, 0.52, 0.5]);
      for (let k = 0; k < w; k += 0.35) fbox(MT, F, k, Math.min(w, k + 0.04), H, H + 0.04, 0.2, 0.34, IRON);
      fq(P, F, 0, H, w, H + 0.12, 0.34, tone(0, H, L.plaster));
    }

    // ---------- facade
    const ground = { ops: [] };
    const st = L.type === 'house' || L.type === 'lite' || !SHOP[L.type] ? null : SHOP[L.type];
    const gTone = (s, y) => tone(s, y, ground.cut !== undefined && y <= ground.cut + 0.005 ? L.gColor : L.plaster);
    const gh = L.gh;
    const pier = L.pier;
    if (st) {
      const ytop = BASE + 2.5, sa = pier, sb = w - pier, op = { s0: sa, s1: sb, y0: BASE, y1: ytop };
      ground.ops.push(op); ground.ytop = ytop;
      reveal(sa, sb, BASE, ytop, 0.32, L.gColor);
      fbox(P, F, sa - 0.1, sb + 0.1, ytop, ytop + 0.18, 0, 0.07, trimC, 'b');
      // sign above the opening
      const sy0 = ytop + (st.aw && !lite ? 0.56 : 0.26), sy1 = BASE + gh - 0.1;
      ground.cut = sy0;
      signBoard(sa - 0.1, sb + 0.1, sy0, sy1, nextName(L.type, st.sign), st.sign);
      let ds0 = 0, ds1 = 0;
      if (st.door) {
        const dw = 1.05, dpos = chance(0.5) ? sa + 0.35 : sb - 0.35 - dw;
        ds0 = dpos; ds1 = dpos + dw;
      }
      if (st.glass && !lite) {
        const gy0 = BASE + 0.6, segs2 = st.door ? [[sa, ds0], [ds1, sb]] : [[sa, sb]];
        for (const [a, b] of segs2) {
          if (b - a < 0.3) continue;
          GL.quad(F.p(a, gy0, -0.34), F.p(b, gy0, -0.34), F.p(b, ytop, -0.34), F.p(a, ytop, -0.34), F.n, WHITE);
          fbox(P, F, a, b, BASE, gy0, -0.34, -0.04, mulc(L.gColor, 0.7), 'b');                      // tiled bulkhead
          fbox(P, F, a, b, gy0, gy0 + 0.05, -0.34, -0.04, trimC);
          fbox(WD, F, a, b, ytop - 0.05, ytop, -0.36, -0.26, [0.9, 0.88, 0.82], 'b'); fbox(WD, F, a, b, BASE + 2.12, BASE + 2.16, -0.36, -0.28, [0.9, 0.88, 0.82], 'b');
          const nm = Math.max(1, Math.round((b - a) / 1.15));
          for (let i = 0; i <= nm; i++) { const s = a + (b - a) * i / nm; fbox(WD, F, s - 0.03, s + 0.03, gy0, ytop, -0.37, -0.27, [0.9, 0.88, 0.82], 'b'); }
        }
      }
      if (st.door) {
        // recessed entrance with a deeper reveal and a glazed timber door
        const ey = ytop - 0.02;
        fbox(P, F, ds0 - 0.06, ds0, BASE, ey, -0.95, -0.3, mulc(L.gColor, 0.85), 'b'); fbox(P, F, ds1, ds1 + 0.06, BASE, ey, -0.95, -0.3, mulc(L.gColor, 0.85), 'b');
        fbox(P, F, ds0 - 0.06, ds1 + 0.06, ey - 0.05, ey, -0.95, -0.3, [0.5, 0.47, 0.42], 'b');
        fFlat(P, F, BASE + 0.01, ds0, ds1, -0.3, -0.95, true, [0.5, 0.48, 0.44]);
        fbox(WD, F, ds0 + 0.02, ds1 - 0.02, BASE, ytop - 0.15, -0.98, -0.92, [0.3, 0.2, 0.14], 'b');
        GL.quad(F.p(ds0 + 0.12, BASE + 0.75, -0.9), F.p(ds1 - 0.12, BASE + 0.75, -0.9), F.p(ds1 - 0.12, ytop - 0.3, -0.9), F.p(ds0 + 0.12, ytop - 0.3, -0.9), F.n, WHITE);
        fbox(MT, F, ds1 - 0.2, ds1 - 0.16, BASE + 1.0, BASE + 1.15, -0.9, -0.82, ZINC);
        winQuad(ds0 + 0.12, ds1 - 0.12, BASE + 0.75, ytop - 0.3, -1.0, 3, 0.8);
      }
      if (st.room && !lite) {
        room(sa, sb, ytop, st.room, st.door);
      } else if (!st.shutter || st.shutter === 'closed') {
        // closed shop front: dark interior plane behind glass/door
        winQuad(sa, sb, BASE, ytop, -0.4, lite ? 2 : 15, 0.8);
      } else winQuad(sa, sb, BASE, ytop, -0.4, 15, 0.8);
      if (st.shutter) {
        const closed = st.shutter === 'closed', hh = closed ? ytop - BASE : 0.55;
        const sy1b = ytop, sy0b = ytop - hh;
        fbox(RU, F, sa + 0.02, sb - 0.02, sy0b, sy1b, -0.18, -0.1, closed ? [0.78, 0.82, 0.78] : [0.8, 0.8, 0.78], 'b');
        fbox(MT, F, sa, sb, ytop - 0.22, ytop - 0.0, -0.22, -0.02, [0.55, 0.56, 0.58]);       // roller box
        fbox(MT, F, sa, sa + 0.07, BASE, ytop, -0.2, -0.05, IRON); fbox(MT, F, sb - 0.07, sb, BASE, ytop, -0.2, -0.05, IRON);
        if (closed) fbox(MT, F, (sa + sb) / 2 - 0.15, (sa + sb) / 2 + 0.15, BASE + 0.0, BASE + 0.1, -0.1, -0.04, IRON);
      }
      if (st.aw && !lite) {
        const mk = pick(st.awM), as0 = sa - 0.1, as1 = sb + 0.1;
        if (st.aw === 'curved') awningCurved(mk, as0, as1, ytop + 0.5, R(1.45, 1.8), 0.22);
        else awningStraight(mk, as0, as1, ytop + 0.2, ytop - 0.08, R(1.4, 1.9), 0.22);
      }
      if (st.blade && !lite && pier > 0.5 && chance(0.85)) bladeSign(chance(0.5) ? pier / 2 : w - pier / 2, ytop + 0.45, st.blade);
      if (!lite && st.glass) { const lt = LP; fbox(lt, F, sa + 0.2, sb - 0.2, ytop - 0.01, ytop, -0.2, -0.1, [0.9, 0.8, 0.6]); }
    } else if (L.type === 'house') {
      const gw = clamp(w * 0.38, 2.2, 2.9), left = chance(0.5), g0 = left ? 0.6 : w - 0.6 - gw, g1 = g0 + gw, gy1 = BASE + 2.45;
      ground.ops.push({ s0: g0, s1: g1, y0: BASE, y1: gy1 });
      reveal(g0, g1, BASE, gy1, 0.5, L.plaster);
      winQuad(g0, g1, BASE, gy1, -0.6, lite ? 15 : 3, 0.8);
      fbox(P, F, g0 - 0.28, g0, BASE, gy1 + 0.25, 0, 0.12, trimC, 'b'); fbox(P, F, g1, g1 + 0.28, BASE, gy1 + 0.25, 0, 0.12, trimC, 'b'); fbox(P, F, g0 - 0.28, g1 + 0.28, gy1, gy1 + 0.25, 0, 0.14, trimC, 'b');
      if (!lite) {
        const n = Math.floor(gw / 0.11);
        for (let i = 0; i <= n; i++) { const s = g0 + 0.04 + (gw - 0.08) * i / n; fbox(MT, F, s - 0.012, s + 0.012, BASE + 0.05, gy1 - 0.05, -0.12, -0.08, IRON, 'b'); }
        for (const y of [BASE + 0.04, BASE + 0.9, BASE + 1.7, gy1 - 0.08]) fbox(MT, F, g0, g1, y, y + 0.05, -0.13, -0.07, IRON);
        fbox(P, F, g0 - 0.15, g1 + 0.15, BASE, BASE + 0.12, 0, 0.38, [0.62, 0.6, 0.56], 'b');
        const ws0 = left ? g1 + 0.6 : 0.5, ws1 = left ? w - 0.5 : g0 - 0.6;
        if (ws1 - ws0 > 1.0) {
          const c = (ws0 + ws1) / 2, hw = Math.min(0.6, (ws1 - ws0) / 2 - 0.1);
          ground.ops.push({ s0: c - hw, s1: c + hw, y0: BASE + 1.0, y1: BASE + 2.35 });
          windowAt(c - hw, c + hw, BASE + 1.0, BASE + 2.35, { cell: pickCell(), frameC: pick(FRAMEC), shut: 'none', grille: true });
        }
        // small altar shelf with red lamps
        const as = left ? g1 + 0.35 : g0 - 0.35;
        fbox(WD, F, as - 0.24, as + 0.24, BASE + 1.62, BASE + 1.68, 0.0, 0.3, [0.3, 0.14, 0.1]);
        fbox(LP, F, as - 0.17, as - 0.1, BASE + 1.68, BASE + 1.78, 0.1, 0.17, [1, 0.12, 0.06]); fbox(LP, F, as + 0.1, as + 0.17, BASE + 1.68, BASE + 1.78, 0.1, 0.17, [1, 0.12, 0.06]);
      } else {
        const ws0 = left ? g1 + 0.6 : 0.5, ws1 = left ? w - 0.5 : g0 - 0.6;
        if (ws1 - ws0 > 1.0) { const c = (ws0 + ws1) / 2; ground.ops.push({ s0: c - 0.5, s1: c + 0.5, y0: BASE + 1.0, y1: BASE + 2.3 }); windowAt(c - 0.5, c + 0.5, BASE + 1.0, BASE + 2.3, { cell: 2, frameC: FRAMEC[0], shut: 'none' }); }
      }
      // sign-less band: plain
    } else {
      // lite / generic: one dark opening with a header and a flat sign band
      const sa = pier, sb = w - pier, ytop = BASE + 2.6;
      ground.ops.push({ s0: sa, s1: sb, y0: BASE, y1: ytop }); ground.cut = ytop + 0.25;
      reveal(sa, sb, BASE, ytop, 0.3, L.gColor); winQuad(sa, sb, BASE, ytop, -0.35, pick([2, 3, 15, 14]), 0.8);
      fbox(P, F, sa - 0.1, sb + 0.1, ytop + 0.25, Math.min(BASE + gh - 0.1, ytop + 0.95), 0, 0.08, mixc(L.gColor, [0.3, 0.1, 0.08], 0.5), 'b');
    }

    // ground band
    const gOps = ground.ops, ex = ground.cut !== undefined ? [ground.cut, ground.cut + 0.02] : [];
    wallBand(P, F, 0, w, BASE, BASE + gh, gOps, gTone, ex);
    if (!lite) { fbox(P, F, -0.02, w + 0.02, BASE + gh - 0.04, BASE + gh + 0.08, 0, 0.06, trimC, 'b'); }

    // upper floors
    for (let fl = 1; fl < L.floors; fl++) {
      const y0 = BASE + gh + (fl - 1) * L.fh, y1 = fl === L.floors - 1 ? (tile ? L.Hf : H) : y0 + L.fh, ops = [], wins = [];
      const nb = clamp(Math.round(w / L.bay), 1, 9), hasBalc = L.balc.includes(fl);
      for (let i = 0; i < nb; i++) {
        const c = clamp(w * (i + 0.5) / nb + L.jit[i % 4], 0.8 + L.winW / 2, w - 0.8 - L.winW / 2);
        const door = hasBalc && i === Math.floor((nb - 1) / 2);
        if (door) {
          const dw = 0.78, s0 = c - dw, s1 = c + dw, dy0 = y0 + 0.04, dy1 = y0 + 2.3;
          ops.push({ s0, s1, y0: dy0, y1: dy1 }); wins.push({ s0, s1, y0: dy0, y1: dy1, door: true, cell: lite ? 10 : pick([10, 10, 12, 3]), c });
        } else {
          const ww = Math.min(L.winW, c * 2 - 0.9, (w - c) * 2 - 0.9), s0 = c - ww / 2, s1 = c + ww / 2, wy0 = y0 + L.sill, wy1 = wy0 + L.winH;
          if (ww < 0.6) continue;
          ops.push({ s0, s1, y0: wy0, y1: wy1 });
          wins.push({ s0, s1, y0: wy0, y1: wy1, cell: pickCell(), c });
        }
      }
      wallBand(P, F, 0, w, y0, y1, ops, (s, y) => tone(s, y, L.plaster), null);
      for (const o of wins) {
        windowAt(o.s0, o.s1, o.y0, o.y1, { cell: o.cell, door: o.door, frameC: L.frameC, shutC: L.shutC, shut: L.shut === 'mixed' ? pick(['open', 'closed', 'half', 'none']) : L.shut, grille: !lite && fl === 1 && chance(0.25) && !o.door, ac: !lite && !o.door && chance(0.3) ? o.c + R(-0.1, 0.1) : 0 });
        if (o.door && !lite) { balcony(o.c - 1.15, o.c + 1.15, y0, L.balcDepth, L.balcIron, mulc(L.plaster, 1.05)); }
      }
      if (!lite && fl >= 1 && L.bands && fl < L.floors) fbox(P, F, -0.02, w + 0.02, y0 - 0.05, y0 + 0.05, 0, 0.05, trimC, 'b');
    }
    if (!lite) {
      if (L.pil) { fbox(P, F, 0, 0.22, BASE, tile ? L.Hf : H, 0, 0.05, mulc(trimC, 0.95), 'b'); fbox(P, F, w - 0.22, w, BASE, tile ? L.Hf : H, 0, 0.05, mulc(trimC, 0.95), 'b'); }
      downpipe(L.pipeLeft ? 0.2 : w - 0.2, tile ? H - 0.1 : H - 0.2, mulc(ZINC, 0.8));
      const cy = BASE + gh + (L.floors > 2 ? L.fh : 0.4) - 0.4 + R(-0.2, 0.3);   // overhead cable run along the facade
      let prev = null;
      for (let s = 0; s <= w; s += 1.0) {
        const sag = Math.sin(((s % 4) / 4) * Math.PI) * 0.12, y = cy - sag;
        if (prev !== null) fbox(MT, F, prev[0], s, Math.min(prev[1], y) - 0.012, Math.max(prev[1], y) + 0.012, 0.06, 0.085, IRON);
        prev = [s, y];
      }
    }
  };

  // ------------------------------------------------------------------ lot parameter generation and street assembly
  const PR0 = -64, PR1 = 134;          // fully detailed street span (approved primary span -48..118 plus margin)
  let lastColor = -1;
  const makeLot = (id, F, w, o) => {
    const lite = !!o.lite, shop = SHOP[o.type] || null;
    const floors = o.floors || pick([2, 2, 3, 3, 3, 4, 4].filter((n) => !(n === 4 && w < 5)));
    const gh = shop ? R(3.7, 4.2) : R(3.3, 3.8), fh = R(3.0, 3.35), H = BASE + gh + (floors - 1) * fh;
    let roof = o.roof || (floors === 2 ? (chance(0.6) ? 'tile' : 'flat') : floors === 3 ? (chance(0.45) ? 'tile' : 'flat') : (chance(0.1) ? 'tile' : 'flat'));
    if (o.type === 'hardware' && floors <= 3 && chance(0.8)) roof = 'vault';
    if (o.floors >= 5) roof = 'flat';
    const pitch = R(0.35, 0.44), tp = Math.tan(pitch), D = o.D || R(9, 13);
    let ci; do { ci = Math.floor(rnd() * PLASTER.length); } while (ci === lastColor);
    lastColor = ci;
    const plasterC = PLASTER[ci];
    const gColor = shop ? pick(GPLASTER) : plasterC;
    const winW = R(0.95, 1.3), winH = R(1.5, 1.95);
    const L = {
      id, type: o.type, lite, F, w, floors, gh, fh, H, D, roof, pitch,
      Hf: H + 0.04 + 0.55 * tp, parapet: R(0.6, 0.9), plaster: plasterC, gColor, trim: pick(TRIMS), plinth: lin('#6b6258'),
      frameC: pick(FRAMEC), shutC: pick(SHUTC), shut: lite ? 'none' : pick(['none', 'open', 'open', 'closed', 'mixed', 'half']),
      bay: o.bay || R(2.9, 3.6), winW, winH, sill: Math.min(R(0.75, 0.95), fh - 0.3 - winH),
      jit: [R(-0.12, 0.12), R(-0.12, 0.12), R(-0.12, 0.12), R(-0.12, 0.12)],
      balc: [], balcDepth: R(0.95, 1.35), balcIron: chance(0.6), pil: chance(0.35), bands: chance(0.55), pipeLeft: chance(0.5),
      inset: o.inset || 0, nx: R(0, 100), seed: RI(1, 9999), ou: R(0, 10), ov: R(0, 10), vaultPts: null,
    };
    if (!lite && w >= 6 && floors >= 2) { if (floors >= 3 && chance(0.4)) { L.balc.push(1); if (floors === 4 && chance(0.3)) L.balc.push(2); } else if (floors === 2 && chance(0.3)) L.balc.push(1); }
    if (shop) L.pier = clamp(R(0.45, 0.9), 0.3, w * 0.12);
    else { const ow = Math.min(w - 1.2, R(2.4, 5)); L.pier = (w - ow) / 2; }
    if (roof === 'vault') {
      const a = (D + 0.7) / 2, dc = -D / 2, b = R(1.6, 2.1), phi0 = 1.05, pts = [];
      for (let i = 0; i <= 14; i++) { const phi = -phi0 + 2 * phi0 * i / 14; pts.push([dc - a * Math.sin(phi) / Math.sin(phi0), H + b * (Math.cos(phi) - Math.cos(phi0)) / (1 - Math.cos(phi0))]); }
      L.vaultPts = pts;
    }
    return L;
  };
  const SEQ_R = ['house', 'bakery', 'cafe', 'grocer', 'shutter', 'books', 'pharmacy', 'house', 'pho', 'barber', 'grocer', 'tailor', 'cafe', 'hardware', 'house', 'books', 'bakery', 'shutter', 'grocer', 'pharmacy', 'house', 'cafe', 'barber', 'pho'];
  const SEQ_L = ['grocer', 'cafe', 'house', 'barber', 'books', 'shutter', 'bakery', 'tailor', 'house', 'pho', 'cafe', 'pharmacy', 'hardware', 'grocer', 'house', 'books', 'shutter', 'cafe', 'bakery', 'house', 'pho', 'tailor', 'grocer', 'barber'];
  const frameFor = (sgn, xf, z0, z1) => (sgn > 0 ? makeFrame(xf, z0, 0, 1, -1, 0) : makeFrame(-xf, z1, 0, -1, 1, 0));
  const counts = { R: 0, L: 0, distantR: 0, distantL: 0, backdrop: 0, closure: 0 };
  let liteSet = null, liteN = 0, liteIdx = 0;
  const flushLite = () => {
    if (!liteSet) return;
    const g = new THREE.Group(); g.name = `distant-street-block-${liteIdx++}`; gDistant.add(g); flushSet(liteSet, g); liteSet = null; liteN = 0;
  };
  const buildLite = (L) => {
    if (!liteSet) liteSet = makeSet(`distant-${liteIdx}`);
    buildLot(L, liteSet);
    if (++liteN >= 6) flushLite();
  };

  const buildRow = (sgn) => {
    const tag = sgn > 0 ? 'R' : 'L', seq = sgn > 0 ? SEQ_R : SEQ_L;
    let z = ZA, idx = 0, si = sgn > 0 ? 0 : 3, det = null;
    const flushDet = () => {
      if (!det) return;
      det.g.name = `buildings-${det.ids.join('+')}`; det.g.userData.lots = det.ids.slice();
      flushSet(det.M, det.g); det = null;
    };
    while (z < ZB - 1e-6) {
      const near = z > PR0 - 6 && z < PR1;
      let w = near ? R(6.5, 12.5) : R(9, 18);
      if (ZB - z - w < 5) w = ZB - z;
      const zc = z + w / 2, detail = zc > PR0 && zc < PR1, id = `${tag}${String(idx).padStart(2, '0')}`;
      let type = 'lite', lite = true;
      if (detail) {
        type = seq[si++ % seq.length]; lite = false;
        if (SHOP[type] && w < SHOP[type].minW) type = w >= 4.2 ? 'shutter' : 'house';
        if (type === 'shutter' && w < SHOP.shutter.minW) type = 'house';
      } else type = chance(0.5) ? 'house' : 'lite';
      const inset = !lite && type === 'house' && chance(0.18) ? R(0.8, 1.8) : 0;
      const F = frameFor(sgn, 7.3 + inset, z, z + w);
      const L = makeLot(id, F, w, { type, lite, inset });
      if (lite) { flushDet(); buildLite(L); counts[`distant${tag}`]++; }
      else {
        if (!det) { const g = new THREE.Group(); gBuildings.add(g); det = { M: makeSet(`${id}`), g, ids: [], n: 0 }; }
        buildLot(L, det.M); det.ids.push(`${id}:${type}`); counts[tag]++;
        if (++det.n >= 3) flushDet();
      }
      z += w; idx++;
    }
    flushDet(); flushLite();
  };
  // second tier of taller backdrop blocks behind the first row so the skyline layers and no sky/void shows between roofs
  const buildBackdrop = (sgn) => {
    let z = ZA - 10, idx = 0;
    while (z < ZB + 10) {
      const w = R(14, 26), xf = 24 + R(0, 7), id = `${sgn > 0 ? 'BR' : 'BL'}${idx++}`;
      const F = frameFor(sgn, xf, z, z + w);
      const L = makeLot(id, F, w, { type: 'lite', lite: true, floors: RI(4, 6), roof: 'flat', D: R(9, 12), bay: 3.6 });
      buildLite(L); counts.backdrop++; z += w;
    }
    flushLite();
  };
  // closing blocks facing down the street so neither end reads as a stage edge
  const buildClosure = (front) => {
    const xs = [-40, -26, -12, 2, 16, 30];
    for (let i = 0; i < xs.length; i++) {
      const w = i === xs.length - 1 ? 14 : 14, id = `${front ? 'CF' : 'CB'}${i}`;
      const F = front ? makeFrame(xs[i] + w, ZB, -1, 0, 0, -1) : makeFrame(xs[i], ZA, 1, 0, 0, 1);
      const L = makeLot(id, F, w, { type: 'lite', lite: true, floors: RI(4, 6), roof: 'flat', D: R(9, 12), bay: 3.4 });
      buildLite(L); counts.closure++;
    }
    flushLite();
  };
  buildRow(1); buildRow(-1); buildBackdrop(1); buildBackdrop(-1); buildClosure(true); buildClosure(false);

  roadM.flush(gGround); paveM.flush(gGround); curbM.flush(gGround);
  for (const m of [patchM, patchLM, decalM, paintM, tactM]) m.flush(gDecals);
  signTex.needsUpdate = true; bladeTex.needsUpdate = true;

  // ------------------------------------------------------------------ sky, fog and light
  const HAZE = '#e6cda3';
  const sky = (() => {
    const W = 2048, Hh = 1024, c = makeCanvas(W, Hh), ctx = c.getContext('2d'), r = mulberry(9901);
    const g = ctx.createLinearGradient(0, 0, 0, Hh);
    [[0, '#3b6aa6'], [0.16, '#5b8cc2'], [0.30, '#98b9d6'], [0.40, '#d8cdb2'], [0.46, '#eed0a0'], [0.50, HAZE], [0.53, '#d9c4a0'], [0.70, '#b8a98e'], [1, '#8d8270']].forEach(([s, col]) => g.addColorStop(s, col));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, Hh);
    const sx = 0.1947 * W, sy = (1 - (0.5 + 31 / 180)) * Hh;
    for (let i = 0; i < 38; i++) {   // thin high cirrus, kept faint and off the sun so nothing blocks the street
      const x = r() * W, y = Hh * (0.14 + r() * 0.26), rx = 120 + r() * 300, ry = 4 + r() * 12, warm = Math.exp(-(((x - sx) / 500) ** 2));
      ctx.save(); ctx.translate(x, y); ctx.scale(rx, ry);
      const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, 1); gr.addColorStop(0, `rgba(${255},${235 - warm * 30},${210 - warm * 60},0.10)`); gr.addColorStop(1, 'rgba(255,235,210,0)');
      ctx.fillStyle = gr; ctx.fillRect(-1, -1, 2, 2); ctx.restore();
    }
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 340);
    glow.addColorStop(0, 'rgba(255,240,205,0.95)'); glow.addColorStop(0.12, 'rgba(255,214,150,0.55)'); glow.addColorStop(0.4, 'rgba(255,196,120,0.18)'); glow.addColorStop(1, 'rgba(255,190,110,0)');
    ctx.fillStyle = glow; ctx.fillRect(sx - 340, sy - 340, 680, 680);
    ctx.fillStyle = 'rgba(255,248,225,1)'; ctx.beginPath(); ctx.arc(sx, sy, 11, 0, 6.2832); ctx.fill();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.mapping = THREE.EquirectangularReflectionMapping;
    return t;
  })();
  scene.background = sky; scene.backgroundIntensity = 1.0;
  scene.environment = sky; scene.environmentIntensity = 0.8;
  scene.fog = new THREE.FogExp2(HAZE, 0.0058);

  const hemi = new THREE.HemisphereLight('#a9c6ee', '#8a7355', 1.3); hemi.name = 'street-sky-ambient'; root.add(hemi);
  const SUN_DIR = new THREE.Vector3(-0.291, 0.515, -0.806).normalize();       // direction toward the sun: behind-left of a +Z walker
  const sun = new THREE.DirectionalLight('#ffd8a2', 3.2); sun.name = 'street-golden-sun';
  const SH = 48; // Keep the visible street vista inside the moving shadow window.
  sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 10, far: 220 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.00008; sun.shadow.normalBias = 0.015;
  root.add(sun); root.add(sun.target);
  const bounce = new THREE.DirectionalLight('#ffc78e', 0.55); bounce.name = 'street-facade-bounce'; bounce.position.set(30, 8, 4); root.add(bounce); root.add(bounce.target);
  const fwd = SUN_DIR.clone().negate(), lRight = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize(), lUp = new THREE.Vector3().crossVectors(lRight, fwd).normalize();
  const TEXEL = (SH * 2) / 4096, tgt = new THREE.Vector3();
  const update = (t, camera, robotPosition) => {
    const rp = robotPosition || {}, px = Number.isFinite(rp.x) ? rp.x : 0, pz = Number.isFinite(rp.z) ? rp.z : 0;
    tgt.set(clamp(px, -3, 3) * 0.5, 0, pz + 3);
    const a = tgt.dot(lRight), b = tgt.dot(lUp);       // snap to the shadow-map texel grid so shadows do not crawl
    tgt.addScaledVector(lRight, Math.round(a / TEXEL) * TEXEL - a).addScaledVector(lUp, Math.round(b / TEXEL) * TEXEL - b);
    sun.target.position.copy(tgt);
    sun.position.copy(tgt).addScaledVector(SUN_DIR, 100);
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
    bounce.target.position.set(tgt.x - 10, 0, tgt.z); bounce.position.set(tgt.x + 30, 8, tgt.z + 4);
    bounce.target.updateMatrixWorld(); bounce.updateMatrixWorld();
  };
  update(0, null, { x: 1.35, z: -18 });
  root.userData.counts = counts;
  return { update };
}
