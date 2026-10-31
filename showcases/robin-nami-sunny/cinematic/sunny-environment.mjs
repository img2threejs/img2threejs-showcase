import * as THREE from 'three';

const SHIP_URL = 'assets/thousand-sunny/scene.glb';
const FEATURES = Object.freeze([
  'rounded-planked-hull', 'red-ivory-scroll-bulwarks', 'soldier-dock-number-one',
  'sun-maned-lion-and-crossbones', 'grass-lawn-and-promenade', 'white-balustrades',
  'arched-cream-cabin', 'red-yellow-dome', 'billowed-straw-hat-main-sail',
  'striped-aft-sail', 'masts-ratlines-crows-nests', 'orange-trees',
  'gerstner-open-ocean', 'seeded-big-wave-schedule', 'hull-foam-and-spray',
  'rocking-deck-pivot', 'blue-gradient-sky', 'white-cumulus-clouds',
  'refracted-wave-fronts-around-hull', 'hull-reflection-and-runup-sheets', 'advected-aerated-foam',
  'sunset-and-halloween-night-sky', 'moon-glitter-and-stars', 'rain-ripples-and-lightning',
  'raymarched-cauliflower-cumulus', 'storm-deck-with-in-cloud-bolts',
  'forward-voyage', 'bow-diverging-waves-and-stern-wake',
  'crossing-directional-spectrum', 'crest-compression-and-broad-troughs',
]);

// ---------------------------------------------------------------------------
// Pure, deterministic model (no DOM / WebGL): wave table, big-wave schedule and
// ship motion. Everything is a function of absolute time only.
// ---------------------------------------------------------------------------
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const GRAVITY = 9.81;
const SEA_Y = -5;
const PIVOT = Object.freeze({ x: 0, y: -3, z: 0 });
const CRUISE_SPEED = 2.2; // metres/second along the native bow (+Z)
// Waves travel toward this horizontal direction: across the beam (from port to
// starboard, slightly aft-to-bow), so the wind is roughly perpendicular to the hull.
const WIND_ANGLE = Math.atan2(0.27, -0.963);
const WIND = Object.freeze([Math.cos(WIND_ANGLE), Math.sin(WIND_ANGLE)]);
const smooth01 = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function hash1(i, salt) {
  let x = Math.imul(i | 0, 0x9E3779B1) ^ Math.imul((salt | 0) + 0x7F4A7C15, 0x85EBCA6B);
  x ^= x >>> 15; x = Math.imul(x, 0x2C1B3C6D);
  x ^= x >>> 12; x = Math.imul(x, 0x297A2D39);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Video reference: broad travelling bodies, crossing shorter shoulders, compressed
// crests and broad troughs. Metre scales are authored, not measurements of the clip.
// lambda (m), amplitude (m), offset from wind (deg), phase (rad).
const WAVE_SPEC = [
  [100, 0.70, 0, 0.4], [69, 0.55, -18, 2.1], [43, 0.60, 19, 4.0],
  [28, 0.40, -29, 1.3], [18, 0.27, 12, 5.2], [12, 0.16, -35, 3.3],
  [7.4, 0.09, 37, 0.9], [4.6, 0.045, -17, 4.4], [2.9, 0.028, 55, 2.6],
  [1.8, 0.013, -60, 5.8], [1.1, 0.006, 25, 1.7],
  [82, 0.32, 61, 3.1], [37, 0.28, 48, 0.7], [22, 0.17, -75, 4.7],
  [11, 0.095, 92, 2.4], [6, 0.043, -110, 5.5],
  [3.2, 0.022, 110, 1.2], [1.45, 0.009, -86, 3.8],
];
const WAVES = (() => {
  const rows = WAVE_SPEC.map(([lambda, A, off, phase]) => {
    const angle = WIND_ANGLE + off * DEG;
    const k = TAU / lambda;
    return { lambda, A, k, omega: Math.sqrt(GRAVITY * k), phase0: phase,
      dx: Math.cos(angle), dz: Math.sin(angle), Q: 3.8 * A * k,
      crest: lambda > 8 ? 0.24 : 0.12 };
  });
  // Σ Q ≤ 0.97 bounds the horizontal Jacobian away from folding at coincident crests.
  const sum = rows.reduce((s, row) => s + row.Q, 0);
  const scale = Math.min(1, 0.97 / sum);
  for (const row of rows) row.Q *= scale;
  return Object.freeze(rows.map(row => Object.freeze(row)));
})();
const GERSTNER_COUNT = WAVES.length;

// Swell components that the hull actually rides (same phases as the water).
const MOTION_COMPONENTS = Object.freeze([0, 1, 2, 11, 12]);
const RESPONSE = Object.freeze({ roll: 0.45, pitch: 0.45, heave: 0.48 });

const SIDES = Object.freeze(['port', 'starboard', 'bow']);
// Seconds between the nominal impact time and the visible hull contact: the
// refracted crest is slowed on the last metres before it touches the hull.
const CONTACT_LAG = 0.38;
const BIG_SPEED = 11;            // m/s, crest speed of the travelling big swell
const GAP_MIN = 9, GAP_MAX = 20; // seconds between big wave impacts (uniform)
const WALL_SIDE = 6.9, WALL_BOW = 16.8;
const eventTimes = [];
function eventTime(index) {
  while (eventTimes.length <= index) {
    const n = eventTimes.length;
    eventTimes.push(n === 0 ? 5 + 4 * hash1(0, 11)
      : eventTimes[n - 1] + GAP_MIN + (GAP_MAX - GAP_MIN) * hash1(n - 1, 17));
  }
  return eventTimes[index];
}
// Lowest index whose impact time is >= time (0 for time <= first event).
function firstEventAtOrAfter(time) {
  const t = Number.isFinite(time) ? Math.min(Math.max(time, 0), 6e6) : 0;
  let hi = Math.max(1, Math.floor(t / 11));
  while (eventTime(hi) < t) hi *= 2;
  let lo = 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (eventTime(mid) < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}
function makeEvent() {
  return { index: 0, time: 0, sideIndex: 0, side: 'port', strength: 0, dx: 0, dz: 0, nx: 0, nz: 0,
    lateral: 0, length: 0, width: 0, amplitude: 0, wall: 0, hitZ: 0, rollBias: 0 };
}
function fillEvent(index, e) {
  const hSide = hash1(index, 3), hStrength = hash1(index, 4), hJitter = hash1(index, 5);
  const hLateral = hash1(index, 6), hWidth = hash1(index, 7), hBias = hash1(index, 8);
  e.index = index;
  e.time = eventTime(index);
  e.sideIndex = hSide < 0.4 ? 0 : hSide < 0.8 ? 1 : 2;
  e.side = SIDES[e.sideIndex];
  e.strength = 0.5 + 0.5 * Math.pow(hStrength, 0.75);
  const jitter = (hJitter - 0.5) * 2 * 12 * DEG;
  const bx = e.sideIndex === 0 ? -1 : e.sideIndex === 1 ? 1 : 0;
  const bz = e.sideIndex === 2 ? -1 : 0;
  const c = Math.cos(jitter), s = Math.sin(jitter);
  e.dx = bx * c - bz * s;
  e.dz = bx * s + bz * c;
  e.nx = -e.dz;
  e.nz = e.dx;
  e.lateral = (hLateral - 0.5) * 2 * (e.sideIndex < 2 ? 9 : 4);
  e.length = 7.5 + 2.0 * e.strength;
  e.width = 24 + 14 * hWidth;
  e.amplitude = 0.65 + 0.65 * e.strength;
  e.wall = e.sideIndex < 2 ? WALL_SIDE : WALL_BOW;
  // World coordinate of the hit centre along the ship axis the crest line runs along.
  e.hitZ = e.sideIndex < 2 ? e.nz * e.lateral : 0;
  e.rollBias = (hBias - 0.5) * 2;
  return e;
}

/** Next `count` seeded big-wave impacts at or after `time` (allocates; for tests/diagnostics). */
export function bigWaveSchedule(time, count = 3) {
  const first = firstEventAtOrAfter(time);
  const out = [];
  for (let i = 0; i < count; i++) {
    const e = fillEvent(first + i, makeEvent());
    out.push({ index: e.index, time: e.time, side: e.side, strength: e.strength,
      direction: [e.dx, e.dz], lateral: e.lateral, length: e.length, width: e.width,
      amplitude: e.amplitude });
  }
  return out;
}

// Damped spring (omega, zeta) driven by a raised-cosine force pulse of D seconds
// centred on the impact: y'' + 2ζωy' + ω²y = F(t). Closed-form-free, but smooth (C2).
const PULSE = 1.3;
const springPeaks = new Map();
function springRaw(age, omega, zeta) {
  const half = PULSE / 2;
  if (age <= -half) return 0;
  const damp = zeta * omega;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const hi = Math.min(age, half);
  const n = 16;
  const step = (hi + half) / n;
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const s = -half + i * step;
    const tau = age - s;
    const f = 0.5 * (1 + Math.cos(TAU * s / PULSE));
    const v = f * Math.exp(-damp * tau) * Math.sin(wd * tau) / wd;
    sum += v * (i === 0 || i === n ? 1 : i % 2 ? 4 : 2);
  }
  return sum * step / 3;
}
function springUnit(age, omega, zeta) {
  const key = `${omega}|${zeta}`;
  let peak = springPeaks.get(key);
  if (peak === undefined) {
    peak = 0;
    for (let t = -PULSE / 2; t < 20; t += 0.01) peak = Math.max(peak, Math.abs(springRaw(t, omega, zeta)));
    springPeaks.set(key, peak);
  }
  const taper = 1 - smooth01(14, 20, age);
  return taper > 0 ? taper * springRaw(age, omega, zeta) / peak : 0;
}
const SPRING = Object.freeze({
  roll: [TAU / 5.8, 0.27], pitch: [TAU / 4.6, 0.30], heave: [TAU / 3.4, 0.35],
});
const IMPULSE = Object.freeze({ roll: 2.4 * DEG, pitchBow: 1.5 * DEG, pitchSide: 0.35 * DEG, heave: 0.12, heaveBow: 0.16 });
const scratchEvent = makeEvent();
const eventStore = new WeakMap();

// Force the wave puts on the (idealised, elliptical) waterline: the same
// windward weighting and lateral envelope the shaders use, integrated once per
// event. Returns normalised force along x / z and the lever position along z.
const HULL_ELLIPSE = Object.freeze({ a: 5.2, b: 17.5, cz: -1 });
const forceCache = new Map();
function contactForce(e) {
  let f = forceCache.get(e.index);
  if (f) return f;
  const { a, b, cz } = HULL_ELLIPSE;
  const prx = -e.dz, prz = e.dx;
  let fx = 0, fz = 0, wsum = 0, zsum = 0;
  const n = 96;
  for (let k = 0; k < n; k++) {
    const th = TAU * (k + 0.5) / n;
    const px = a * Math.sin(th), pz = cz + b * Math.cos(th);
    let nx = Math.sin(th) / a, nz = Math.cos(th) / b;
    const nl = Math.hypot(nx, nz); nx /= nl; nz /= nl;
    const ds = Math.hypot(a * Math.cos(th), b * Math.sin(th)) * TAU / n;
    const windward = smooth01(-0.1, 0.6, -(e.dx * nx + e.dz * nz));
    const lateral = (px * prx + pz * prz - e.lateral) / (0.9 * e.width);
    const w = windward * Math.exp(-lateral * lateral) * ds;
    fx -= w * nx; fz -= w * nz; wsum += w; zsum += w * pz;
  }
  f = { fx: Math.max(-1.1, Math.min(1.1, fx / (2 * b * 0.85))),
    fz: Math.max(-1.1, Math.min(1.1, fz / (2 * a * 0.85))),
    cz: wsum > 1e-6 ? Math.max(-1, Math.min(1, (zsum / wsum - cz) / 8)) : 0 };
  if (forceCache.size > 96) forceCache.clear();
  forceCache.set(e.index, f);
  return f;
}

/**
 * Hull motion at absolute `time`: continuous swell roll/pitch/heave plus damped
 * spring responses for every big wave. Positive roll lifts the port (+X) side,
 * positive pitch dips the bow (+Z). Radians / metres. Pure and C1-continuous.
 * Pass `out` to avoid allocation.
 */
export function shipMotionAt(time, out = {}) {
  const t = Number.isFinite(time) ? time : 0;
  let roll = 0, pitch = 0, heave = 0;
  for (const index of MOTION_COMPONENTS) {
    const w = WAVES[index];
    const theta = w.phase0 + w.k * w.dz * CRUISE_SPEED * t - w.omega * t;
    const s = Math.sin(theta), c = Math.cos(theta);
    heave += RESPONSE.heave * w.A * (s + w.crest * (s * s - 0.5));
    const slope = w.A * w.k * c * (1 + 2 * w.crest * s);
    roll += RESPONSE.roll * slope * w.dx;
    pitch -= RESPONSE.pitch * slope * w.dz;
  }
  let recent = null, recentAge = Infinity;
  if (t > -1) {
    const first = firstEventAtOrAfter(t - 20);
    for (let index = first; eventTime(index) + CONTACT_LAG <= t + PULSE / 2; index++) {
      const e = fillEvent(index, scratchEvent);
      const age = t - e.time - CONTACT_LAG;
      if (age > 20) continue;
      const force = contactForce(e);
      const bow = Math.max(0, -force.fz);
      const rollAmp = IMPULSE.roll * e.strength * (-force.fx + 0.18 * e.rollBias * bow);
      const pitchAmp = -IMPULSE.pitchBow * e.strength * bow
        - IMPULSE.pitchSide * e.strength * Math.abs(force.fx) * force.cz;
      const heaveAmp = -(e.sideIndex === 2 ? IMPULSE.heaveBow : IMPULSE.heave) * e.strength;
      roll += rollAmp * springUnit(age, SPRING.roll[0], SPRING.roll[1]);
      pitch += pitchAmp * springUnit(age, SPRING.pitch[0], SPRING.pitch[1]);
      heave += heaveAmp * springUnit(age, SPRING.heave[0], SPRING.heave[1]);
      if (age >= 0 && age <= 6 && age < recentAge) { recentAge = age; recent = e; }
    }
  }
  out.roll = roll; out.pitch = pitch; out.heave = heave;
  const voyage = out.voyage ??= {};
  voyage.x = 0; voyage.z = CRUISE_SPEED * t; voyage.distance = CRUISE_SPEED * t; voyage.speed = CRUISE_SPEED;
  if (recent) {
    let store = eventStore.get(out);
    if (!store) { store = { side: '', strength: 0, age: 0 }; eventStore.set(out, store); }
    store.side = recent.side; store.strength = recent.strength; store.age = recentAge;
    out.waveEvent = store;
  } else out.waveEvent = null;
  return out;
}


// ---------------------------------------------------------------------------
// Wave-front fields. For every big wave event the arrival coordinate of the
// crest is solved on a grid around the hull with an eikonal (fast-sweeping)
// solver: the hull outline blocks the water (so crests diffract around the
// bow and stern), and the wave speed drops close to the hull (refraction, so
// crests bend to wrap the sides). A second solve launches the reflected /
// scattered wave from every windward hull cell at its own contact time.
// Everything is a pure function of the seeded event, cached per event index.
// ---------------------------------------------------------------------------
const HULL_BOX = Object.freeze({ x0: -24, z0: -36, w: 48, d: 72, cell: 0.25 });
const HULL_LEVELS = Object.freeze([-5.6, -4.8, -4.0, -3.0]);
const FIELD = Object.freeze({ x0: -32, z0: -44, w: 64, d: 88, cell: 0.5, nx: 128, nz: 176 });
const REFRACT = Object.freeze({ gain: 1.35, scale: 3.4 });
const RIM_COUNT = 360;
const INF = 1e9;
const FIELD_LAYERS = 3;

/** Godunov fast sweeping for |grad T| = n(p). Cells with canUpdate === 0 are fixed. */
function fastSweep(T, n, canUpdate, nx, nz, h, amp) {
  for (let iter = 0; iter < 18; iter++) {
    let changed = 0;
    for (let s = 0; s < 4; s++) {
      const sx = s & 1 ? -1 : 1, sz = s & 2 ? -1 : 1;
      for (let z = sz > 0 ? 0 : nz - 1; z >= 0 && z < nz; z += sz) {
        for (let x = sx > 0 ? 0 : nx - 1; x >= 0 && x < nx; x += sx) {
          const i = z * nx + x;
          if (!canUpdate[i]) continue;
          let a = INF, b = INF, ia = -1, ib = -1;
          if (x > 0 && T[i - 1] < a) { a = T[i - 1]; ia = i - 1; }
          if (x < nx - 1 && T[i + 1] < a) { a = T[i + 1]; ia = i + 1; }
          if (z > 0 && T[i - nx] < b) { b = T[i - nx]; ib = i - nx; }
          if (z < nz - 1 && T[i + nx] < b) { b = T[i + nx]; ib = i + nx; }
          if (a >= INF && b >= INF) continue;
          if (a > b) { const tv = a; a = b; b = tv; const ti = ia; ia = ib; ib = ti; }
          const f = n[i] * h;
          const t = b - a >= f ? a + f : 0.5 * (a + b + Math.sqrt(2 * f * f - (a - b) * (a - b)));
          if (t < T[i] - 1e-4) {
            T[i] = t;
            if (amp) amp[i] = amp[ia];
            changed++;
          }
        }
      }
    }
    if (!changed) break;
  }
}

/** Separable box blur (radius in cells), repeated `passes` times; edges clamp. */
function boxBlur(a, nx, nz, radius, passes) {
  const tmp = new Float32Array(Math.max(nx, nz));
  const inv = 1 / (2 * radius + 1);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < nz; j++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += a[j * nx + Math.min(nx - 1, Math.max(0, k))];
      for (let i = 0; i < nx; i++) {
        tmp[i] = acc * inv;
        acc += a[j * nx + Math.min(nx - 1, i + radius + 1)] - a[j * nx + Math.max(0, i - radius)];
      }
      for (let i = 0; i < nx; i++) a[j * nx + i] = tmp[i];
    }
    for (let i = 0; i < nx; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += a[Math.min(nz - 1, Math.max(0, k)) * nx + i];
      for (let j = 0; j < nz; j++) {
        tmp[j] = acc * inv;
        acc += a[Math.min(nz - 1, j + radius + 1) * nx + i] - a[Math.max(0, j - radius) * nx + i];
      }
      for (let j = 0; j < nz; j++) a[j * nx + i] = tmp[j];
    }
  }
}
/** Blocked-cell mask, refractive index and outward normals on the field grid. */
function buildFieldStatic(hull) {
  const { nx, nz, cell, x0, z0 } = FIELD;
  const blocked = new Uint8Array(nx * nz);
  const hb = HULL_BOX;
  const hnx = Math.round(hb.w / hb.cell), hnz = Math.round(hb.d / hb.cell);
  const profile = hull.masks[2];
  const hullAt = (x, z) => {
    if (hull.fallback) return Math.hypot(x / 5.2, (z + 1) / 17.5) < 1 ? 1 : 0;
    const cx = Math.floor((x - hb.x0) / hb.cell), cz = Math.floor((z - hb.z0) / hb.cell);
    return cx >= 0 && cz >= 0 && cx < hnx && cz < hnz ? profile[cz * hnx + cx] : 0;
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * cell, z = z0 + (j + 0.5) * cell;
      const k = hullAt(x - 0.12, z - 0.12) + hullAt(x + 0.12, z - 0.12) + hullAt(x - 0.12, z + 0.12) + hullAt(x + 0.12, z + 0.12);
      blocked[j * nx + i] = k >= 2 ? 1 : 0;
    }
  }
  const sq = distanceTransform(blocked, nx, nz);
  const dist = new Float32Array(nx * nz), n = new Float32Array(nx * nz);
  for (let i = 0; i < n.length; i++) {
    dist[i] = Math.sqrt(sq[i]) * cell;
    n[i] = blocked[i] ? 1 : 1 + REFRACT.gain * Math.exp(-dist[i] / REFRACT.scale);
  }
  const nrm = new Float32Array(nx * nz * 2);
  const at = (x, z) => dist[Math.min(nz - 1, Math.max(0, z)) * nx + Math.min(nx - 1, Math.max(0, x))];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const gx = at(i + 1, j) - at(i - 1, j), gz = at(i, j + 1) - at(i, j - 1);
      const l = Math.hypot(gx, gz) || 1;
      nrm[(j * nx + i) * 2] = gx / l; nrm[(j * nx + i) * 2 + 1] = gz / l;
    }
  }
  const source = new Uint8Array(nx * nz);
  for (let j = 1; j < nz - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const c = j * nx + i;
      if (blocked[c]) continue;
      if (blocked[c - 1] || blocked[c + 1] || blocked[c - nx] || blocked[c + nx]) source[c] = 1;
    }
  }
  const free = new Uint8Array(nx * nz), solid = new Uint8Array(nx * nz), ones = new Float32Array(nx * nz).fill(1);
  for (let i = 0; i < free.length; i++) { free[i] = blocked[i] ? 0 : 1; solid[i] = blocked[i]; }
  return { blocked, dist, n, nrm, source, free, solid, ones };
}

const halfOf = (v) => THREE.DataUtils.toHalfFloat(Math.max(-60000, Math.min(60000, v)));
function gridSample(arr, x, z) {
  const { nx, nz, cell, x0, z0 } = FIELD;
  const fx = Math.min(nx - 1.001, Math.max(0, (x - x0) / cell - 0.5)), fz = Math.min(nz - 1.001, Math.max(0, (z - z0) / cell - 0.5));
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
  const i = iz * nx + ix;
  return (arr[i] * (1 - tx) + arr[i + 1] * tx) * (1 - tz) + (arr[i + nx] * (1 - tx) + arr[i + nx + 1] * tx) * tz;
}

function packField(T, amp, e) {
  const { nx, nz, cell, x0, z0 } = FIELD;
  const out = new Uint16Array(nx * nz * 4);
  const gxs = new Float32Array(nx * nz), gzs = new Float32Array(nx * nz);
  const at = (x, z) => T[Math.min(nz - 1, Math.max(0, z)) * nx + Math.min(nx - 1, Math.max(0, x))];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      gxs[c] = (at(i + 1, j) - at(i - 1, j)) / (2 * cell);
      gzs[c] = (at(i, j + 1) - at(i, j - 1)) / (2 * cell);
    }
  }
  // One binomial smoothing pass hides the staircase of the first-order solver.
  for (let pass = 0; pass < 2; pass++) {
    for (const g of [gxs, gzs]) {
      const src = g.slice();
      for (let j = 1; j < nz - 1; j++) {
        for (let i = 1; i < nx - 1; i++) {
          const c = j * nx + i;
          g[c] = 0.25 * src[c] + 0.125 * (src[c - 1] + src[c + 1] + src[c - nx] + src[c + nx])
            + 0.0625 * (src[c - nx - 1] + src[c - nx + 1] + src[c + nx - 1] + src[c + nx + 1]);
        }
      }
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      const x = x0 + (i + 0.5) * cell, z = z0 + (j + 0.5) * cell;
      out[c * 4] = halfOf(T[c] - (x * e.dx + z * e.dz));
      out[c * 4 + 1] = halfOf(gxs[c]);
      out[c * 4 + 2] = halfOf(gzs[c]);
      out[c * 4 + 3] = halfOf(amp[c]);
    }
  }
  return out;
}

/** Incident + reflected arrival fields for one seeded big-wave event. */
function* fieldSteps(e, S) {
  const { nx, nz, cell, x0, z0 } = FIELD;
  const N = nx * nz;
  const T = new Float32Array(N).fill(INF);
  const update = new Uint8Array(N);
  const exact = (i, j) => (x0 + (i + 0.5) * cell) * e.dx + (z0 + (j + 0.5) * cell) * e.dz;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (S.blocked[c]) continue;
      let inflow = false;
      if (i === 0 && -e.dx <= 0.2) inflow = true;
      if (i === nx - 1 && e.dx <= 0.2) inflow = true;
      if (j === 0 && -e.dz <= 0.2) inflow = true;
      if (j === nz - 1 && e.dz <= 0.2) inflow = true;
      const onEdge = i === 0 || j === 0 || i === nx - 1 || j === nz - 1;
      if (onEdge && inflow) T[c] = exact(i, j); else update[c] = 1;
    }
  }
  for (let c = 0; c < N; c++) if (S.blocked[c]) update[c] = 0;
  fastSweep(T, S.n, update, nx, nz, cell, null);
  yield;
  // Shadow-zone amplitude: waves that had to detour far beyond the refraction lag are weak.
  const aF = new Float32Array(N);
  const lag = 1.15 * REFRACT.gain * REFRACT.scale;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      const delta = T[c] - exact(i, j);
      aF[c] = S.blocked[c] ? 1 : Math.exp(-Math.max(0, delta - lag) / 9);
    }
  }
  // Reflected / scattered wave: launched from the windward cells at their contact time.
  const R = new Float32Array(N).fill(INF), RA = new Float32Array(N);
  const prx = -e.dz, prz = e.dx;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (!S.source[c] || T[c] >= INF) continue;
      const x = x0 + (i + 0.5) * cell, z = z0 + (j + 0.5) * cell;
      const windward = smooth01(-0.1, 0.6, -(e.dx * S.nrm[c * 2] + e.dz * S.nrm[c * 2 + 1]));
      if (windward < 0.02) continue;
      const lateral = ((x * prx + z * prz) - e.lateral) / (0.9 * e.width);
      R[c] = T[c];
      RA[c] = windward * Math.exp(-lateral * lateral) * (0.55 + 0.1 * e.strength);
    }
  }
  const rUpdate = S.free;
  fastSweep(R, S.n, rUpdate, nx, nz, cell, RA);
  const rAmp = new Float32Array(N);
  for (let c = 0; c < N; c++) {
    if (S.blocked[c] || R[c] >= INF) { rAmp[c] = 0; continue; }
    rAmp[c] = RA[c] / Math.sqrt(1 + 0.12 * Math.max(R[c] - T[c], 0));
  }
  // Where the fronts of different sources meet the amplitude would jump: smooth it (not the arrival time).
  boxBlur(rAmp, nx, nz, 6, 3);
  yield;
  // Interior of the hull: continue both fields smoothly so bilinear taps at the outline stay clean.
  fastSweep(T, S.ones, S.solid, nx, nz, cell, null);
  fastSweep(R, S.ones, S.solid, nx, nz, cell, null);
  const inc = packField(T, aF, e);
  yield;
  return { index: e.index, inc, ref: packField(R, rAmp, e), T };
}

/** Stepwise solver (one stage per `next()`); the event is copied so scratch objects may be reused meanwhile. */
function computeEventFieldSteps(e, S) { return fieldSteps({ ...e }, S); }

const fieldCache = new Map();
function storeField(index, f) {
  fieldCache.set(index, f);
  if (fieldCache.size > 10) fieldCache.delete(fieldCache.keys().next().value);
}
function eventField(e, S) {
  let f = fieldCache.get(e.index);
  if (!f) {
    const steps = computeEventFieldSteps(e, S);
    let r;
    do { r = steps.next(); } while (!r.done);
    f = r.value;
    storeField(e.index, f);
  }
  return f;
}

/**
 * Per hull-rim sample (rim index k): rows of [contact age s, weight, tangent
 * component of the travel direction, windward] and the inverse CDF that maps
 * a uniform number to a rim index proportional to the impact weight.
 */
function computeRimRows(e, field, outline) {
  const N = RIM_COUNT;
  const props = new Float32Array(N * 4), cdf = new Float32Array(N * 4);
  const prx = -e.dz, prz = e.dx;
  const weights = new Float32Array(N);
  let total = 0;
  for (let k = 0; k < N; k++) {
    const x = outline.rim[k * 4], z = outline.rim[k * 4 + 1], nx = outline.rim[k * 4 + 2], nz = outline.rim[k * 4 + 3];
    const T = gridSample(field.T, x + nx * 0.75, z + nz * 0.75);
    const windward = smooth01(-0.1, 0.6, -(e.dx * nx + e.dz * nz));
    const lateral = ((x * prx + z * prz) - e.lateral) / (0.9 * e.width);
    const w = windward * Math.exp(-lateral * lateral);
    props[k * 4] = (T + e.wall) / BIG_SPEED;
    props[k * 4 + 1] = w;
    props[k * 4 + 2] = e.dx * -nz + e.dz * nx;
    props[k * 4 + 3] = windward;
    weights[k] = Math.max(w - 0.04, 0);
    total += weights[k];
  }
  if (total <= 1e-6) { weights.fill(1); total = N; }
  let acc = 0, k = 0;
  for (let j = 0; j < N; j++) {
    const u = (j + 0.5) / N * total;
    while (k < N - 1 && acc + weights[k] < u) { acc += weights[k]; k++; }
    cdf[j * 4] = k + (weights[k] > 0 ? Math.min(1, Math.max(0, (u - acc) / weights[k])) : 0.5);
  }
  return { props, cdf };
}

/** Hull outline per waterline level: radial scan around the slice centroid. */
function hullOutline(hull) {
  const { x0, z0, w, d, cell } = HULL_BOX;
  const NX = Math.round(w / cell), NZ = Math.round(d / cell);
  const N = RIM_COUNT;
  let sz = 0, count = 0;
  if (!hull.fallback) {
    const m = hull.masks[2];
    for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) if (m[z * NX + x]) { sz += z0 + (z + 0.5) * cell; count++; }
  }
  const cz = count ? sz / count : -1;
  const maskAt = (m, x, z) => {
    const cx = Math.floor((x - x0) / cell), iz = Math.floor((z - z0) / cell);
    return cx >= 0 && iz >= 0 && cx < NX && iz < NZ ? m[iz * NX + cx] : 0;
  };
  const radii = HULL_LEVELS.map((_, level) => {
    const r = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const th = TAU * k / N, sx = Math.sin(th), cc = Math.cos(th);
      let best = 0;
      if (hull.fallback) best = 1 / Math.hypot(sx / 5.2, cc / 17.5);
      else for (let rr = 0; rr < 30; rr += 0.1) if (maskAt(hull.masks[level], sx * rr, cz + cc * rr)) best = rr;
      r[k] = best;
    }
    for (let pass = 0; pass < 3; pass++) {
      const src = r.slice();
      for (let k = 0; k < N; k++) r[k] = 0.25 * src[(k + N - 1) % N] + 0.5 * src[k] + 0.25 * src[(k + 1) % N];
    }
    return r;
  });
  // Levels that do not reach the surface at some angle take the next level up.
  for (let l = HULL_LEVELS.length - 2; l >= 0; l--) {
    for (let k = 0; k < N; k++) if (radii[l][k] < 0.5) radii[l][k] = radii[l + 1][k];
  }
  const rim = new Float32Array(N * 4);
  for (let k = 0; k < N; k++) {
    const th = TAU * k / N;
    const r = radii[2][k];
    rim[k * 4] = Math.sin(th) * r;
    rim[k * 4 + 1] = cz + Math.cos(th) * r;
  }
  for (let k = 0; k < N; k++) {
    const a = (k + N - 1) % N, b = (k + 1) % N;
    let tx = rim[b * 4] - rim[a * 4], tz = rim[b * 4 + 1] - rim[a * 4 + 1];
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    let nx = tz, nz = -tx;
    const th = TAU * k / N;
    if (nx * Math.sin(th) + nz * Math.cos(th) < 0) { nx = -nx; nz = -nz; }
    rim[k * 4 + 2] = nx; rim[k * 4 + 3] = nz;
  }
  return { cz, radii, rim };
}

/** Radius of the hull side at height y (m, ship space) for rim index k. */
function hullRadiusAt(outline, k, y) {
  const r = outline.radii;
  if (y <= HULL_LEVELS[0]) return r[0][k];
  for (let l = 0; l < 3; l++) {
    if (y <= HULL_LEVELS[l + 1]) return r[l][k] + (r[l + 1][k] - r[l][k]) * (y - HULL_LEVELS[l]) / (HULL_LEVELS[l + 1] - HULL_LEVELS[l]);
  }
  const slope = Math.max(-0.8, Math.min(0.8, r[3][k] - r[2][k]));
  return r[3][k] + slope * Math.min(y - HULL_LEVELS[3], 3);
}


// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------
// All shader constants below are linear-light colours. The renderer owns tone
// mapping/exposure; exactly one Three output colour-space conversion is applied.
const OUTPUT = `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;
const NOISE = `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float hash31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float noise21(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float n = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    n += a * noise21(p);
    p = mat2(1.6, -1.2, 1.2, 1.6) * p + 4.7;
    a *= 0.5;
  }
  return n;
}
`;

// Shared atmosphere state: every material that needs it points at the same uniform objects.
const ATMOS_UNIFORMS = `
uniform float uNight;
uniform float uRain;
uniform float uFlash;
uniform float uMoonPhase;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uFlashDir;
uniform vec3 uHorizonCol;
uniform vec3 uZenithCol;
uniform vec3 uTwiWarm;
uniform vec3 uTwiCool;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform vec3 uMoonCol;
uniform vec3 uSunGlowCol;
uniform vec4 uSkyMix;   // twilight weight, night weight, moon visibility, sun visibility
`;
// ---------------------------------------------------------------------------
// Volumetric-style cumulus for the sky dome (only compiled with CLOUD_VOLUME).
// A cloud slab is ray-marched with log-spaced steps until the density iso-surface is
// found (bisection gives a crisp, scalloped silhouette), then shaded like a cel-lit
// solid: wrapped N.L tone ramp, self-shadow taps toward the light, darker flat bases,
// rim light and aerial perspective. Misses that graze the iso-surface leave a soft fringe.
// Everything is a pure function of (direction, absolute time).
// ---------------------------------------------------------------------------
const CLOUD_GLSL = `
uniform highp sampler3D uCloud3D;
uniform vec3 uCumLit;
uniform vec3 uCumShade;
uniform vec3 uCumLight;
uniform vec3 uVolRim;
uniform vec3 uStormGlow;
uniform vec4 uCloudA;     // base altitude (m), thickness (m), coverage 0..1, tower amount 0..1
uniform vec4 uCloudB;     // churn speed, surface threshold, unused, unused
uniform vec2 uCloudDrift; // metres per second

const float C_TILE = 6200.0;
const float C_DET = 1650.0;

float cloudField(vec3 p, float lod, float seconds, out float hF, out float topF) {
  hF = (p.y - uCloudA.x) / uCloudA.y;
  topF = 1.0;
  if (hF < -0.08 || hF > 1.0) return 0.0;
  vec2 q = p.xz - uCloudDrift * seconds;
  vec4 c1 = textureLod(uCloud3D, vec3(q / 52000.0, 0.21), 1.0);
  vec4 c2 = textureLod(uCloud3D, vec3(q / 21000.0 + vec2(0.37, 0.11), 0.63), 1.0);
  // Hanging, lumpy cloud base (mammatus-like in storms) instead of a perfectly flat ceiling.
  vec4 cb = textureLod(uCloud3D, vec3(q / 9000.0 + vec2(0.53, 0.29), 0.37), max(lod - 1.0, 1.0));
  hF += (0.5 - cb.g) * 0.05 * (0.25 + uCloudA.w) + (0.5 - c1.g) * 0.05 * uCloudA.w;
  if (hF < -0.01) return 0.0;
  float cm = 0.55 * c1.r + 0.45 * c2.r;
  float lo = 0.70 - 0.42 * uCloudA.z;
  float cov = smoothstep(lo, lo + 0.16, cm);
  // Column height: big towers where the large-scale noise peaks, low flat-topped heaps elsewhere.
  float tow = smoothstep(0.44, 0.70, c2.r) * uCloudA.w;
  topF = mix(0.26, 1.0, tow) * mix(0.50, 1.0, cov);
  float rel = hF / topF;
  vec4 s = textureLod(uCloud3D, vec3(q / C_TILE, p.y / C_TILE), lod);
  float billow = s.g * 0.46 + s.b * 0.34 + s.a * 0.20;
  vec3 dp = vec3(q / C_DET, p.y / C_DET + seconds * uCloudB.x);
  vec4 dt = textureLod(uCloud3D, dp, max(lod - 1.0, 0.0));
  float n = mix(s.r * 0.5 + billow * 0.5, billow, 0.78) + (dt.b * 0.5 + dt.a * 0.5 - 0.5) * 0.30;
  n += 0.20 * (1.0 - smoothstep(0.0, 0.32, rel)) * cov;
  // Rounded tops: the threshold rises with relative height; flat bases come from the hard floor.
  float cut = 0.12 + 0.62 * pow(clamp(rel, 0.0, 1.2), 1.25) + (1.0 - cov) * 0.50;
  float D = 0.5 + (n - cut) * 2.4;
  D *= smoothstep(0.0, 0.012, hF + (n - 0.5) * 0.05) * (1.0 - smoothstep(0.96, 1.0, rel));
  return max(D, 0.0);
}


// ---- In-cloud lightning -----------------------------------------------------------------
// Sixteen seeded channels alternate busy bursts and calmer spells. Each firing picks its
// own spot on the cloud deck for 60–140 ms, with a jagged 6-segment bolt, two forks
// and a glow pocket; the seventeenth channel follows the global scene flash.
// Everything is a pure function of (direction, absolute time). x = glow, y = bolt line,
// z = part of the line that is allowed to show below the cloud base.
uniform float uBolt;
float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
  return length(pa - ba * h);
}
vec3 boltField(vec3 d, float t, float pixAng) {
  vec3 outv = vec3(0.0);
  if (uBolt <= 0.001 || d.y < 0.0) return outv;
  // Storm activity breathes: busy bursts (several bolts at once) alternate with calmer spells.
  float burst = 0.5 + 0.5 * sin(6.2831853 * t / 7.3 + 1.1 * sin(t * 0.37));
  for (int c = 0; c < 17; c++) {
    float fc = float(c);
    float k, ph, P = 0.27 + 0.031 * fc;
    vec3 c0;
    float env, R, power = 1.0;
    vec3 h;
    if (c < 16) {
      float tt = t + 3.7 * fc;
      k = floor(tt / P);
      ph = tt - k * P;
      h = vec3(hash21(vec2(k, fc + 0.5)), hash21(vec2(k + 17.0, fc * 3.1)), hash21(vec2(k + 41.0, fc * 7.7)));
      if (h.x > 0.26 + 0.72 * burst) continue;
      float s0 = h.y * (P - 0.16);
      float dur = 0.06 + 0.08 * hash21(vec2(k + 5.0, fc + 9.0));
      float x = ph - s0;
      if (x < 0.0 || x > dur) continue;
      float u = x / dur;
      env = max(smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(0.30, 0.42, u)), 0.8 * smoothstep(0.50, 0.58, u) * (1.0 - smoothstep(0.85, 1.0, u)));
      float az = 6.2831853 * hash21(vec2(k + 3.3, fc + 21.0));
      float el = 0.10 + 0.60 * hash21(vec2(k + 9.1, fc + 33.0));
      c0 = vec3(cos(az) * cos(el), sin(el), sin(az) * cos(el));
      R = 0.040 + 0.055 * h.z;
    } else {
      // Correlates with the big scene flash: a bright pocket on its azimuth.
      if (uFlash < 0.05) continue;
      env = uFlash;
      c0 = normalize(vec3(uFlashDir.x, max(uFlashDir.y, 0.12), uFlashDir.z));
      k = floor(t * 7.0);
      h = vec3(hash21(vec2(k, 90.5)), 0.5, 0.9);
      R = 0.09;
      power = 1.3;
    }
    if (dot(d, c0) < 0.972) continue;
    vec3 ax = normalize(cross(vec3(0.0, 1.0, 0.0), c0));
    vec3 ay = cross(c0, ax);
    vec2 p = vec2(dot(d, ax), dot(d, ay));
    float g = exp(-dot(p, p) / (R * R * 1.1));
    outv.x += env * power * g * (0.55 + 0.45 * h.z);
    // Jagged main bolt (top to bottom) with two short forks.
    float w = max(0.0011, pixAng * 1.4);
    vec2 prev = vec2(0.0, R);
    float dMin = 1e9, dFork = 1e9;
    for (int i = 1; i <= 6; i++) {
      float fi = float(i);
      float jx = (hash21(vec2(k * 1.7 + fi, fc + 61.0)) - 0.5) * R * 0.75;
      vec2 cur = vec2(i == 6 ? 0.0 : jx, R - 2.0 * R * fi / 6.0);
      dMin = min(dMin, segDist(p, prev, cur));
      if (i == 2 || i == 4) {
        float sgn = hash21(vec2(k + fi, fc + 77.0)) < 0.5 ? -1.0 : 1.0;
        vec2 f1 = cur + vec2(sgn * R * 0.30, -R * 0.22);
        vec2 f2 = f1 + vec2(sgn * R * 0.12, -R * 0.26);
        dFork = min(dFork, min(segDist(p, cur, f1), segDist(p, f1, f2)));
      }
      prev = cur;
    }
    float line = exp(-(dMin * dMin) / (w * w)) + 0.55 * exp(-(dFork * dFork) / (w * w * 0.8));
    float core = exp(-(dMin * dMin) / (w * w * 0.12));
    outv.y += env * (line + 1.2 * core);
    outv.z += env * (line + 1.2 * core) * step(0.80, h.z);
  }
  return outv;
}

// Returns premultiplied-alpha cloud colour (rgb) and coverage (a).
vec4 volumeClouds(vec3 d, float seconds, float pixAng, vec3 bolt) {
  if (d.y < 0.012) return vec4(0.0);
  float t0 = uCloudA.x / d.y;
  if (t0 > 52000.0) return vec4(0.0);
  float t1 = min((uCloudA.x + uCloudA.y) / d.y, 56000.0);
  const int STEPS = 24;
  float lr = log(t1 / t0) / float(STEPS);
  float stepM = exp(lr);
  float thr = uCloudB.y;
  float t = t0 * exp(lr * 0.5);
  float tPrev = t0;
  float maxD = 0.0, tMax = t;
  bool hit = false;
  float tH = t;
  float hF, topF;
  for (int i = 0; i < STEPS; i++) {
    float step = t * (stepM - 1.0);
    float lod = log2(max(max(step * 0.55, pixAng * t * 2.2) / 97.0, 1.0));
    float D = cloudField(d * t, lod, seconds, hF, topF);
    if (D > maxD) { maxD = D; tMax = t; }
    if (D >= thr) {
      float a = tPrev, b = t;
      for (int k = 0; k < 4; k++) {
        float mid = 0.5 * (a + b);
        float Dm = cloudField(d * mid, lod, seconds, hF, topF);
        if (Dm >= thr) b = mid; else a = mid;
      }
      tH = b; hit = true;
      break;
    }
    tPrev = t;
    t *= stepM;
  }
  float alpha = 1.0;
  if (!hit) {
    alpha = smoothstep(thr - 0.11, thr - 0.015, maxD) * 0.8;
    if (alpha <= 0.002) return vec4(0.0);
    tH = tMax;
  }
  vec3 p = d * tH;
  float fp = max(pixAng * tH, 4.0);
  float eps = clamp(fp * 3.2, 60.0, 700.0);
  float lodN = log2(max(eps / 42.0, 1.0)) + 0.7;
  float c0 = cloudField(p, lodN, seconds, hF, topF);
  float rel = clamp(hF / max(topF, 0.15), 0.0, 1.0);
  float hx, tx;
  // Tetrahedral gradient: four taps instead of six.
  const vec2 kk = vec2(1.0, -1.0);
  vec3 g = kk.xyy * cloudField(p + kk.xyy * eps, lodN, seconds, hx, tx) + kk.yyx * cloudField(p + kk.yyx * eps, lodN, seconds, hx, tx)
         + kk.yxy * cloudField(p + kk.yxy * eps, lodN, seconds, hx, tx) + kk.xxx * cloudField(p + kk.xxx * eps, lodN, seconds, hx, tx);
  vec3 N = -normalize(g + vec3(0.0, 1e-4, 0.0));
  // Billowed surface normal, pulled slightly up/outward so the cauliflower lobes read as domes.
  N = normalize(N + vec3(0.0, 0.35 * (1.0 - 0.5 * rel), 0.0));
  // Cloud undersides are soft and flat-ish: relief fades out towards the base so a storm ceiling reads as a shaded mass.
  N = normalize(mix(N, vec3(0.0, -1.0, 0.0), 0.8 * (1.0 - smoothstep(0.02, 0.28, rel))));
  vec3 L = normalize(uCumLight);
  float occ = max(cloudField(p + L * 120.0, 1.0, seconds, hx, tx) - thr * 0.7, 0.0)
            + 1.4 * max(cloudField(p + L * 420.0, 3.0, seconds, hx, tx) - thr * 0.7, 0.0);
  float shadow = 1.0 - exp(-occ * 0.85);
  // Optical thickness straight above the surface point: thin cloud glows, thick cloud is dark underneath.
  float above = max(cloudField(p + vec3(0.0, 0.12 * uCloudA.y, 0.0), 2.0, seconds, hx, tx) - thr * 0.6, 0.0)
              + 1.5 * max(cloudField(p + vec3(0.0, 0.40 * uCloudA.y, 0.0), 4.0, seconds, hx, tx) - thr * 0.6, 0.0);
  float thin = exp(-above * 1.6);
  float under = 1.0 - smoothstep(0.06, 0.40, rel);
  float light = smoothstep(-0.20, 0.70, dot(N, L)) * (1.0 - 0.72 * shadow);
  float tone = mix(light, smoothstep(0.20, 0.62, light), 0.7);
  float baseShade = mix(0.42, 1.0, smoothstep(0.0, 0.30, rel));
  vec3 ambient = uCumShade + uZenithCol * 0.10 * (0.5 + 0.5 * N.y) + uStormGlow * (0.20 + 1.1 * thin) * (1.0 - rel);
  vec3 col = mix(ambient * 0.78, mix(ambient, uCumLit, tone), baseShade);
  col *= mix(1.0, mix(0.50, 1.12, thin), under);
  float fres = pow(1.0 - clamp(dot(N, -d), 0.0, 1.0), 2.2);
  float back = pow(clamp(dot(d, L), 0.0, 1.0), 6.0);
  col += uVolRim * fres * (0.10 + 1.1 * back + 0.35 * smoothstep(0.2, 0.9, light) + 0.8 * thin * under) * (1.0 - 0.75 * shadow);
  col += uFlash * vec3(0.30, 0.40, 0.75) * (0.30 + 0.70 * rel);
  // Lightning inside the cloud: the glow pocket lights the billows, strongest on their edges.
  col += vec3(0.30, 0.52, 1.0) * bolt.x * 1.15 * uBolt * (0.10 + 2.2 * fres + 0.55 * (1.0 - light) + 0.9 * thin);
  float aer = 1.0 - exp(-tH / 32000.0);
  col = mix(col, uHorizonCol * 1.05 + uStormGlow * 0.5, aer * 0.72);
  alpha *= mix(1.0, 0.62 + 0.38 * (1.0 - thin), under * smoothstep(0.05, 0.6, uCloudA.w - 0.4)) * smoothstep(0.012, 0.04, d.y);
  return vec4(col * alpha, alpha);
}
`;

const SKY = `
${ATMOS_UNIFORMS}
#ifdef CLOUD_VOLUME
${CLOUD_GLSL}
#endif
vec3 starLayer(vec3 d, float t) {
  vec3 p = d * 118.0;
  vec3 ip = floor(p);
  if (hash31(ip) < 0.945) return vec3(0.0);
  vec3 fp = p - ip;
  vec3 c = 0.22 + 0.56 * vec3(hash31(ip + 1.7), hash31(ip + 3.1), hash31(ip + 5.9));
  float r = length(fp - c);
  float fw = max(length(fwidth(p)), 1e-4);
  float base = 0.045 + 0.08 * hash31(ip + 9.3);
  float size = max(base, fw * 0.9);
  float comp = min(1.0, (base * base) / (size * size));
  float core = smoothstep(size, 0.0, r);
  float b = pow(hash31(ip + 13.7), 3.0) * 1.5 + 0.3;
  float tw = 0.7 + 0.3 * sin(t * (1.3 + 3.5 * hash31(ip + 21.1)) + 40.0 * hash31(ip + 7.7));
  vec3 tint = mix(vec3(0.75, 0.88, 1.0), vec3(1.0, 0.86, 0.68), hash31(ip + 31.0));
  return tint * core * b * tw * comp * 1.5;
}
vec3 moonLayer(vec3 d, vec3 base, float direct, float seconds) {
  float c = clamp(dot(d, uMoonDir), -1.0, 1.0);
  float ang = acos(c);
  float vis = uSkyMix.z;
  float halo = exp(-ang * 40.0) * 0.30 + exp(-ang * 10.0) * 0.20 + exp(-ang * 2.6) * 0.07;
  base += uMoonCol * halo * vis;
  if (direct > 0.5 && ang < 0.09) {
    vec3 mr = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDir));
    vec3 mu = cross(uMoonDir, mr);
    vec2 mp = vec2(dot(d, mr), dot(d, mu)) / 0.056;
    float r = length(mp);
    float disc = 1.0 - smoothstep(0.96, 1.0, r);
    if (disc > 0.0) {
      vec3 sn = vec3(mp, sqrt(max(1.0 - r * r, 0.0)));
      float a = (uMoonPhase - 0.5) * 6.2831853;
      vec3 Lp = vec3(sin(a), 0.0, cos(a));
      float lit = smoothstep(-0.03, 0.07, dot(sn, Lp));
      float maria = fbm(mp * 2.0 + vec2(3.7, 1.3));
      float craters = fbm(mp * 7.0 + vec2(9.1, 2.2));
      float albedo = mix(0.50, 1.0, smoothstep(0.36, 0.62, maria)) * (0.88 + 0.24 * craters) * (0.78 + 0.22 * sn.z);
      vec3 mcol = uMoonCol * albedo * (0.05 + 0.95 * lit) * 1.55;
      base = mix(base, mcol, disc * vis);
    }
  }
  return base;
}
vec3 skyColour(vec3 d, float seconds, float cloudLift, float direct) {
  float elevation = max(d.y, 0.0);
  vec3 colour = mix(uHorizonCol, uZenithCol, pow(elevation, 0.48));
  float tw = uSkyMix.x, nt = uSkyMix.y;
  if (tw > 0.002) {
    vec3 hd = normalize(vec3(d.x, 0.0, d.z) + vec3(1e-5, 0.0, 1e-5));
    vec3 hs = normalize(vec3(uSunDir.x, 0.0, uSunDir.z));
    float az = dot(hd, hs) * 0.5 + 0.5;
    float band = 1.0 - smoothstep(0.0, 0.6, d.y);
    colour += tw * band * (uTwiWarm * pow(az, 4.0) + uTwiCool * (1.0 - az) * 0.55);
    colour += tw * uTwiWarm * 0.45 * pow(max(dot(d, uSunDir), 0.0), 22.0);
  }
  // Celestial layers sit behind the clouds.
  if (direct > 0.5 && nt > 0.002) colour += starLayer(d, seconds) * nt * smoothstep(0.0, 0.12, d.y) * (1.0 - uRain);
  if (uSkyMix.z > 0.002) colour = moonLayer(d, colour, direct, seconds);
  float cloud = 0.0;
  vec3 cloudCol = uCloudLit;
#ifdef CLOUD_VOLUME
  if (direct > 0.5) {
    float pixAng = max(length(fwidth(d)), 1e-5);
    // Glowing gaps behind a storm deck and a high, thin cirrus veil.
    colour += uStormGlow * (1.0 - smoothstep(0.0, 0.75, d.y));
    vec2 cq = d.xz / max(d.y, 0.06);
    cq = vec2(cq.x * 0.22 + seconds * 0.004, cq.y * 0.9);
    float cir = smoothstep(0.52, 0.80, fbm(cq * 1.6)) * smoothstep(0.05, 0.30, d.y) * (1.0 - 0.7 * uRain);
    colour = mix(colour, mix(uCumShade, uCumLit, 0.65), cir * 0.32);
    vec3 bf = boltField(d, seconds, pixAng);
    vec4 vc = volumeClouds(d, seconds, pixAng, bf);
    colour = colour * (1.0 - vc.a) + vc.rgb;
    cloud = vc.a;
    // Bolts live inside the cloud mass (masked by cloud coverage); a few reach below the base.
    vec3 bcol = vec3(0.55, 0.75, 1.0);
    colour += bcol * bf.y * (0.10 + 0.9 * vc.a) * 1.4 * uBolt + vec3(0.75, 0.88, 1.0) * bf.y * bf.y * vc.a * 0.10 * uBolt;
    colour += bcol * bf.z * (1.0 - vc.a) * 0.9 * uBolt;
    colour += vec3(0.22, 0.38, 0.95) * bf.x * 0.10 * (1.0 - vc.a) * uBolt;
  } else
#endif
  {
    // Distant, soft cloud banks are projected onto a high horizontal layer (reflections only).
    vec2 q = d.xz / max(0.12, d.y + 0.12);
    q = q * 3.7 + vec2(seconds * 0.003, seconds * 0.001);
    float n0;
    if (direct > 0.5) n0 = fbm(q);
    else {
      // Reflections only need the coarse cloud shapes: three octaves.
      vec2 q2 = mat2(1.6, -1.2, 1.2, 1.6) * q + 4.7;
      vec2 q3 = mat2(1.6, -1.2, 1.2, 1.6) * q2 + 4.7;
      n0 = (0.5 * noise21(q) + 0.25 * noise21(q2) + 0.125 * noise21(q3)) * 1.0714;
    }
    cloud = smoothstep(mix(0.52, 0.30, uRain), mix(0.70, 0.52, uRain), n0);
    float cl = mix(cloudLift, -0.02, uRain);
    cloud *= smoothstep(0.015 + cl, 0.16 + cl, d.y) * (1.0 - smoothstep(0.82, 1.0, d.y));
    if (tw + nt > 0.002) {
      vec3 Lk = normalize(mix(uSunDir, uMoonDir, nt / (tw + nt)));
      vec2 ql = Lk.xz / max(0.12, Lk.y + 0.12) * 3.7 + vec2(seconds * 0.003, seconds * 0.001);
      float rim = clamp((n0 - fbm(q + normalize(ql - q + vec2(1e-4)) * 0.10)) * 5.0, 0.0, 1.0);
      cloudCol = mix(uCloudShade, uCloudLit, 0.14 + 0.86 * rim);
      cloudCol += uMoonCol * 0.20 * pow(max(dot(d, uMoonDir), 0.0), 5.0) * uSkyMix.z;
    }
    colour = mix(colour, cloudCol, cloud * mix(0.91, 0.97, uRain));
  }
  // A few thin cloud streaks crossing the moon.
  if (direct > 0.5 && uSkyMix.z > 0.002 && dot(d, uMoonDir) > 0.95) {
    vec3 mr = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDir));
    vec3 mu = cross(uMoonDir, mr);
    vec2 mp = vec2(dot(d, mr), dot(d, mu)) / 0.056;
    float streak = fbm(vec2(mp.x * 0.30 + seconds * 0.006, mp.y * 1.7) + 4.0);
    float sm = smoothstep(0.56, 0.70, streak) * (1.0 - smoothstep(2.0, 5.5, length(mp)));
    colour = mix(colour, mix(uCloudShade, uCloudLit, 0.55), sm * 0.62 * uSkyMix.z * (1.0 - uRain));
  }
  colour += uSunGlowCol * pow(max(dot(d, uSunDir), 0.0), 110.0) * uSkyMix.w;
  float flashMask = uFlash * (0.10 + 0.9 * cloud + 1.4 * pow(max(dot(d, uFlashDir), 0.0), 6.0) * (0.25 + cloud));
  colour += vec3(0.50, 0.60, 0.95) * flashMask;
  colour = mix(colour, uHorizonCol * 1.15, uRain * (1.0 - smoothstep(0.0, 0.28, d.y)) * 0.8);
  return colour;
}
`;

// Shared by the ocean vertex and fragment stages: Gerstner swell, refracted big
// crests, reflected waves, and the hull distance field (ship space).
const WATER_GLSL = `
#define NW ${GERSTNER_COUNT}
#define NB 3
const float BIG_SPEED = ${BIG_SPEED.toFixed(1)};
uniform float seconds;
uniform vec2 uWind;
uniform vec4 uWA[NW];   // dir.x, dir.z, k, amplitude
uniform vec4 uWB[NW];   // steepness Q, wrapped phase, wavelength, crest harmonic
uniform vec4 uBigA[NB]; // travel dir x, z, lateral centre, effective amplitude
uniform vec4 uBigB[NB]; // crest coordinate, pulse length, lateral width, breaking 0..1
uniform vec4 uBigC[NB]; // run-up (m), hull foam boost, event age (s), strength
uniform vec4 uBigD[NB]; // field layer, reflected gain, unused, unused
uniform mat4 uShipInv;
uniform vec4 uVoyage;  // world x/z translation, forward speed, travelled distance
uniform vec4 uHullEnds; // bow z, stern z, half beam, wake half-angle tangent
uniform sampler2D uHull;
uniform float uHeave;
uniform highp sampler2DArray uField;
uniform vec4 uFieldBox; // x0, z0, width, depth of the wave-front field grid

float hullDist(vec2 lp, float y) {
  vec2 uv = (lp - vec2(${HULL_BOX.x0.toFixed(1)}, ${HULL_BOX.z0.toFixed(1)})) / vec2(${HULL_BOX.w.toFixed(1)}, ${HULL_BOX.d.toFixed(1)});
  vec4 s = textureLod(uHull, uv, 0.0);
  float lv = clamp(y, ${HULL_LEVELS[0].toFixed(1)}, ${HULL_LEVELS[3].toFixed(1)});
  float d = lv < ${HULL_LEVELS[1].toFixed(1)} ? mix(s.r, s.g, (lv - (${HULL_LEVELS[0].toFixed(1)})) / 0.8)
          : lv < ${HULL_LEVELS[2].toFixed(1)} ? mix(s.g, s.b, (lv - (${HULL_LEVELS[1].toFixed(1)})) / 0.8)
          : mix(s.b, s.a, lv - (${HULL_LEVELS[2].toFixed(1)}));
  vec2 outside = max(abs(lp - vec2(${(HULL_BOX.x0 + HULL_BOX.w / 2).toFixed(1)}, ${(HULL_BOX.z0 + HULL_BOX.d / 2).toFixed(1)})) - vec2(${(HULL_BOX.w / 2).toFixed(1)}, ${(HULL_BOX.d / 2).toFixed(1)}), 0.0);
  return d + length(outside);
}
// Distance to the hull and the unit direction pointing away from it.
vec3 hullDistG(vec2 lp, float y) {
  float d0 = hullDist(lp, y);
  if (d0 > 22.0) return vec3(d0, 0.0, 0.0);
  vec2 g = vec2(hullDist(lp + vec2(0.35, 0.0), y) - d0, hullDist(lp + vec2(0.0, 0.35), y) - d0);
  float l = length(g);
  return vec3(d0, l > 1e-3 ? g / l : vec2(0.0));
}

// Sum of directional Gerstner waves. res = metres per sample footprint; waves
// shorter than a few footprints fade out so neither mesh nor pixels alias.
void swell(vec2 p, float res, out vec4 disp, out vec3 rx, out vec3 rz) {
  disp = vec4(0.0);
  float Sxx = 0.0, Sxz = 0.0, Szz = 0.0, Hx = 0.0, Hz = 0.0;
  for (int i = 0; i < NW; i++) {
    vec4 a = uWA[i], b = uWB[i];
    float w = smoothstep(2.0 * res, 6.0 * res, b.z);
    if (w <= 0.0) continue;
    float th = a.z * dot(a.xy, p) + b.y;
    float s = sin(th), c = cos(th);
    float ws = w * b.x;
    disp.xz += a.xy * (ws / a.z * c);
    float height = w * a.w * (s + b.w * (s * s - 0.5));
    disp.y += height;
    disp.w += height;
    float q = ws * s;
    Sxx += q * a.x * a.x; Sxz += q * a.x * a.y; Szz += q * a.y * a.y;
    float h = w * a.w * a.z * c * (1.0 + 2.0 * b.w * s);
    Hx += h * a.x; Hz += h * a.y;
  }
  rx = vec3(1.0 - Sxx, Hx, -Sxz);
  rz = vec3(-Sxz, Hz, 1.0 - Szz);
}

// Jacobian-only swell evaluation for the trailing-foam taps.
float swellJacobian(vec2 p, float res, float hf) {
  float Sxx = 0.0, Sxz = 0.0, Szz = 0.0;
  for (int i = 0; i < NW; i++) {
    vec4 a = uWA[i], b = uWB[i];
    float w = smoothstep(2.0 * res, 6.0 * res, b.z);
    if (w <= 0.0) continue;
    float q = w * b.x * sin(a.z * dot(a.xy, p) + b.y) * hf;
    Sxx += q * a.x * a.x; Sxz += q * a.x * a.y; Szz += q * a.y * a.y;
  }
  return (1.0 - Sxx) * (1.0 - Szz) - Sxz * Sxz;
}

// Asymmetric (steep front) pulse profile and its first two derivatives in q.
vec3 pulse(float q, float asym) {
  float tu = tanh(1.5 * q);
  float sk = 1.0 + asym * tu, s2u = 1.0 - tu * tu;
  float qs = q * sk;
  float dqs = sk + asym * 1.5 * q * s2u;
  float d2qs = asym * 1.5 * s2u * (2.0 - 3.0 * q * tu);
  float tq = tanh(qs), sech2 = 1.0 - tq * tq;
  float f = sech2, f1 = -2.0 * sech2 * tq, f2 = sech2 * (6.0 * tq * tq - 2.0);
  return vec3(f, f1 * dqs, f2 * dqs * dqs + f1 * d2qs);
}

vec4 fieldTap(int layer, vec2 p) {
  vec2 pc = clamp(p, uFieldBox.xy, uFieldBox.xy + uFieldBox.zw);
  return textureLod(uField, vec3((pc - uFieldBox.xy) / uFieldBox.zw, float(layer)), 0.0);
}

// One travelling pulse whose crest line is the level set s = crest of the
// solved arrival field; g is the field gradient (propagation direction * index).
void waveTerm(vec2 p, float s, vec2 g, float aF, float amp, float crest, float L, float W, float latC,
              float asym, float shapeK, vec2 pr, float fade, inout vec3 disp, inout vec3 rx, inout vec3 rz,
              out vec3 pfOut, out float latOut) {
  float gm = max(length(g), 1e-3);
  vec2 gh = g / gm;
  float q = (s - crest) / L;
  vec3 pf = pulse(q, asym);
  float en = (dot(p, pr) - latC) / W;
  float lat = exp(-en * en);
  float dlat = -2.0 * en / W * lat;
  float a = amp * aF * fade;
  float shape = shapeK * fade * aF / gm;
  float h = a * pf.x * lat;
  float hs = a * pf.y / L * lat, hn = a * pf.x * dlat;
  float Ds = shape * L * pf.y * lat;
  float Dss = shape * pf.z * lat, Dsn = shape * L * pf.y * dlat;
  disp.xz += gh * Ds;
  disp.y += h;
  float Dsx = Dss * g.x + Dsn * pr.x, Dsz = Dss * g.y + Dsn * pr.y;
  float hx = hs * g.x + hn * pr.x, hz = hs * g.y + hn * pr.y;
  rx += vec3(gh.x * Dsx, hx, gh.y * Dsx);
  rz += vec3(gh.x * Dsz, hz, gh.y * Dsz);
  pfOut = pf; latOut = lat;
}

// The travelling hull lifts a narrow bow shoulder; the wake is shed aft, not downwind.
float steadyRidge(float dHull, vec2 gD) {
  float bow = smoothstep(-0.1, 0.7, gD.y);
  return (0.16 * bow + 0.025) * exp(-max(dHull, 0.0) / 0.85) * smoothstep(0.1, 1.8, uVoyage.z);
}
// Steady translating pressure wake, with a finite trail since departure. Returns height, froth, age.
vec3 vesselWake(vec2 worldP) {
  vec2 p = worldP - uVoyage.xy;
  float s = uHullEnds.x - p.y;
  float aft = uHullEnds.y - p.y;
  float age = max(s, 0.0) / max(uVoyage.z, 0.1);
  float gate = smoothstep(0.0, 2.0, s) * smoothstep(0.0, 1.5, seconds - age);
  float lateral = abs(p.x) - (0.65 + uHullEnds.w * max(s, 0.0));
  float width = 0.48 + 0.022 * max(s, 0.0);
  float arm = exp(-pow(lateral / width, 2.0)) * exp(-max(s, 0.0) / 74.0) * gate;
  float second = exp(-pow((lateral - 1.6) / (width * 1.15), 2.0)) * exp(-max(s, 0.0) / 48.0) * gate;
  float sternAge = max(aft, 0.0) / max(uVoyage.z, 0.1);
  float stern = smoothstep(-1.0, 2.0, aft) * exp(-max(aft, 0.0) / 36.0)
    * exp(-pow(p.x / (max(1.2, uHullEnds.z * 0.65) + 0.10 * max(aft, 0.0)), 2.0))
    * smoothstep(0.0, 1.5, seconds - sternAge);
  float speed = smoothstep(0.1, 2.0, uVoyage.z);
  return vec3((0.24 * arm - 0.07 * second + 0.045 * stern * sin(aft * 2.3)) * speed,
    (0.85 * arm + 0.24 * second + 1.8 * stern) * speed, max(sternAge, age * 0.4));
}

// One event slot: incident (refracted, diffracted) and reflected (scattered) pulses, the run-up
// against the windward hull with the sloshing ridge that follows it, and (fragment only) its foam.
// foam = (density, seconds since the crest passed, drift direction); the densest slot wins.
void bigSlot(int i, vec2 p, float res, float dHull, vec2 gD, bool wantFoam,
             inout vec3 disp, inout vec3 rx, inout vec3 rz, inout float run, inout vec4 foam) {
  vec4 A = uBigA[i];
  p -= uVoyage.xy; // refracted event tables remain in the ship's untranslated reference frame
  if (A.w <= 0.0) return;
  vec4 B = uBigB[i], C = uBigC[i], D = uBigD[i];
  vec2 d0 = A.xy, pr = vec2(-d0.y, d0.x);
  float L = B.y;
  float s0 = dot(p, d0) - B.x;
  // Far outside the band this event's pulse (plus its field delay of at most ~90 m) can occupy.
  if (s0 + 90.0 < -10.0 * L || s0 - 3.0 > 8.0 * L) return;
  int layer = int(D.x + 0.5) * 2;
  vec4 F = fieldTap(layer, p);
  float fade = smoothstep(1.5 * res, 5.0 * res, 2.0 * L);
  vec3 pf; float lat;
  waveTerm(p, dot(p, d0) + F.x, F.yz, F.w, A.w, B.x, L, B.z, A.z, 0.45, 0.14 + 0.30 * B.w, pr, fade, disp, rx, rz, pf, lat);
  if (D.y > 0.001) {
    vec4 Fr = fieldTap(layer + 1, p);
    float Lr = L * 1.35;
    vec3 pfr; float latr;
    waveTerm(p, dot(p, d0) + Fr.x, Fr.yz, Fr.w, A.w * D.y, B.x, Lr, 1e5, 0.0, 0.12, 0.05, pr,
             smoothstep(1.5 * res, 5.0 * res, 2.0 * Lr), disp, rx, rz, pfr, latr);
  }
  float gm = max(length(F.yz), 1e-3);
  vec2 gh = F.yz / gm;
  float windward = smoothstep(0.05, 0.6, -dot(gh, gD));
  float envRun = windward * exp(-max(dHull, 0.0) / 2.4) * lat * F.w;
  float age = C.z;
  float slosh = smoothstep(0.25, 0.9, age) * exp(-max(age, 0.0) / 3.4) * cos(5.4 * age - 0.4);
  run += (C.x + 0.36 * C.w * slosh) * envRun;
  if (!wantFoam) return;
  float brk = B.w;
  float q = s0 / L + F.x / L;
  float latF = lat * F.w;
  float jb = 1.0 + (0.14 + 0.30 * brk) * fade * F.w / gm * pf.z * lat;
  float crest = fade * brk * latF * (0.95 * smoothstep(0.3, 0.8, pf.x) + 0.6 * (1.0 - smoothstep(0.2, 0.6, jb)));
  float tau = max(-q, 0.0) * L / BIG_SPEED;
  float behind = 1.0 - smoothstep(-0.9, -0.15, q);
  float shelf = fade * brk * latF * behind * exp(-tau / 2.6);
  float spread = 2.2 + 1.7 * sqrt(tau);
  float hullF = fade * brk * latF * (0.35 + 0.65 * windward) * (0.6 + 0.8 * C.w) * behind * exp(-tau / 4.4) * exp(-dHull / spread);
  float rho = max(max(crest, shelf * 0.9), hullF * 1.25);
  if (rho > foam.x) foam = vec4(rho, tau, normalize(mix(gh, gD, 0.35 * exp(-dHull / 3.0)) + vec2(1e-4)));
}

// Free-surface height of the sea at rest coordinate p0 (used by the hull foam sheet).
float waterHeight(vec2 p0, float res, float dHull, vec2 gD, float heave) {
  vec4 sd; vec3 rx, rz;
  swell(p0, res, sd, rx, rz);
  float hf = 0.35 + 0.65 * smoothstep(1.0, 16.0, dHull);
  vec3 bd = vec3(0.0), ax = vec3(1.0, 0.0, 0.0), az = vec3(0.0, 0.0, 1.0);
  float run = 0.0;
  vec4 nf = vec4(0.0);
  for (int i = 0; i < NB; i++) bigSlot(i, p0, res, dHull, gD, false, bd, ax, az, run, nf);
  return sd.y * hf + (1.0 - hf) * heave + bd.y + run + steadyRidge(dHull, gD) + vesselWake(p0).x;
}
`;


// ---------------------------------------------------------------------------
// Shared uniform objects (one source of truth for sky, sea, spray, hull foam)
// ---------------------------------------------------------------------------
function makeSharedUniforms(maps, hullTables) {
  const v3 = (x, y, z) => ({ value: new THREE.Vector3(x, y, z) });
  const slots = () => [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
  return {
    // atmosphere
    uNight: { value: 0 }, uRain: { value: 0 }, uFlash: { value: 0 }, uMoonPhase: { value: 0.5 },
    uSunDir: { value: new THREE.Vector3(-0.45, 0.74, 0.50).normalize() },
    uMoonDir: { value: new THREE.Vector3(-0.50, 0.30, -0.80).normalize() },
    uFlashDir: { value: new THREE.Vector3(0, 0.35, -1).normalize() },
    uHorizonCol: v3(0.22, 0.57, 0.90), uZenithCol: v3(0.012, 0.17, 0.60),
    uTwiWarm: v3(0, 0, 0), uTwiCool: v3(0, 0, 0),
    uCloudLit: v3(0.98, 0.985, 1.0), uCloudShade: v3(0.98, 0.985, 1.0),
    uCumLit: v3(1, 1, 1), uCumShade: v3(0.68, 0.79, 0.88), uCumLight: { value: new THREE.Vector3(-0.45, 0.74, 0.50).normalize() },
    uVolRim: v3(0.55, 0.70, 1.0), uStormGlow: v3(0, 0, 0), uBolt: { value: 0 },
    uCloud3D: { value: maps.cloud },
    uCloudA: { value: new THREE.Vector4(720, 1900, 0.45, 0.5) }, uCloudB: { value: new THREE.Vector4(0.004, 0.5, 0, 0) },
    uCloudDrift: { value: new THREE.Vector2(WIND[0] * 9, WIND[1] * 9) },
    uMoonCol: v3(1.0, 0.70, 0.40), uSunGlowCol: v3(0.28, 0.22, 0.11),
    uSkyMix: { value: new THREE.Vector4(0, 0, 0, 1) },
    // sea shading palette (linear)
    uKey: { value: new THREE.Vector4(-0.45, 0.74, 0.50, 1) },
    uSpecAmt: { value: new THREE.Vector2(1, 0) },
    uWDeep: v3(0.006, 0.052, 0.052), uWMid: v3(0.012, 0.13, 0.112), uWTurq: v3(0.04, 0.26, 0.20),
    uFoamAmb: v3(0.62, 0.62, 0.62), uFoamKey: v3(0.50, 0.50, 0.50),
    uSprayCol: v3(1.25, 1.31, 1.35),
    uFogRange: { value: new THREE.Vector2(500, 1800) },
    uHullFoam: { value: 1 },
    // waves
    seconds: { value: 0 },
    uWind: { value: new THREE.Vector2(WIND[0], WIND[1]) },
    uWA: { value: WAVES.map(w => new THREE.Vector4(w.dx, w.dz, w.k, w.A)) },
    uWB: { value: WAVES.map(w => new THREE.Vector4(w.Q, 0, w.lambda, w.crest)) },
    uBigA: { value: slots() }, uBigB: { value: slots() }, uBigC: { value: slots() }, uBigD: { value: slots() },
    uShipInv: { value: new THREE.Matrix4() },
    uVoyage: { value: new THREE.Vector4(0, 0, CRUISE_SPEED, 0) },
    uHullEnds: { value: new THREE.Vector4(17, -18, 5.2, 0.35) },
    uHull: { value: maps.hull },
    uHeave: { value: 0 },
    uField: { value: maps.field },
    uFieldBox: { value: new THREE.Vector4(FIELD.x0, FIELD.z0, FIELD.w, FIELD.d) },
    uRim: { value: maps.rim },
  };
}

const OCEAN_SEGMENTS = 480;
function oceanMaterial(shared, maps) {
  return new THREE.ShaderMaterial({
    name: 'Sunny Gerstner open ocean',
    uniforms: {
      ...shared,
      uDetail: { value: maps.detail }, uFoam: { value: maps.foam },
      uScroll: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    },
    vertexShader: `
      ${WATER_GLSL}
      varying vec2 vRest;
      varying vec3 vWorld;
      varying float vFj;    // swell Jacobian whitecaps + trailing foam
      varying float vHN;    // normalised wave height 0 trough .. 1 crest
      varying float vBig;   // big-wave height 0..1
      void main() {
        vec2 p0 = position.xz + uVoyage.xy;
        float r = length(position.xz);
        float sp = max(0.6, max(0.025 * r, r * 6.2832 / ${OCEAN_SEGMENTS}.0));
        vec3 loc = (uShipInv * vec4(p0.x, ${SEA_Y.toFixed(1)} + uHeave, p0.y, 1.0)).xyz;
        vec3 hd = hullDistG(loc.xz, loc.y);
        float dHull = hd.x; vec2 gD = hd.yz;
        float hf = 0.35 + 0.65 * smoothstep(1.0, 16.0, dHull);
        vec4 sd; vec3 rx, rz;
        swell(p0, sp, sd, rx, rz);
        rx = mix(vec3(1.0, 0.0, 0.0), rx, hf);
        rz = mix(vec3(0.0, 0.0, 1.0), rz, hf);
        vec3 disp = vec3(sd.x * hf, sd.y * hf + (1.0 - hf) * uHeave, sd.z * hf);
        float localH = sd.w * hf;
        vec3 bd = vec3(0.0);
        float run = 0.0;
        vec4 nf = vec4(0.0);
        for (int i = 0; i < NB; i++) {
          bigSlot(i, p0, sp, dHull, gD, false, bd, rx, rz, run, nf);
        }
        disp += bd;
        disp.y += run + steadyRidge(dHull, gD) + vesselWake(p0).x;
        float jac = rx.x * rz.z - rx.z * rz.x;
        float fj = 1.0 - smoothstep(0.48, 0.68, jac);
        // Recently compressed crests leave stretched, decaying patches behind them.
        float j1 = swellJacobian(p0 + uWind * 3.0, sp, hf);
        float j2 = swellJacobian(p0 + uWind * 7.0, sp, hf);
        fj = max(fj, max(0.62 * (1.0 - smoothstep(0.48, 0.68, j1)), 0.3 * (1.0 - smoothstep(0.48, 0.68, j2))));
        vFj = fj;
        float bigY = bd.y + run;
        vHN = clamp((localH + 0.35 * bigY + 1.8) / 3.6, 0.0, 1.0);
        vBig = clamp(bigY / 2.2, -1.0, 1.0);
        vRest = p0;
        vWorld = vec3(p0.x + disp.x, ${SEA_Y.toFixed(1)} + disp.y, p0.y + disp.z);
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uDetail;
      uniform sampler2D uFoam;
      uniform vec4 uScroll[3];
      uniform vec4 uKey;
      uniform vec2 uSpecAmt;
      uniform vec3 uWDeep;
      uniform vec3 uWMid;
      uniform vec3 uWTurq;
      uniform vec3 uFoamAmb;
      uniform vec3 uFoamKey;
      uniform vec2 uFogRange;
      uniform float uHullFoam;
      varying vec2 vRest;
      varying vec3 vWorld;
      varying float vFj;
      varying float vHN;
      varying float vBig;
      ${NOISE}
      ${SKY}
      ${WATER_GLSL}

      // Raindrop rings: slope (xy) and white splash fleck (z) of one cell layer.
      vec3 rainLayer(vec2 p, float t, float cell, float rate, float seed) {
        vec2 g = p / cell;
        vec2 ci = floor(g);
        vec2 slope = vec2(0.0);
        float fleck = 0.0;
        for (int j = -1; j <= 1; j++) {
          for (int i = -1; i <= 1; i++) {
            vec2 c = ci + vec2(float(i), float(j));
            float period = 0.8 + 0.9 * hash21(c + seed);
            float tt = t / period + hash21(c * 1.7 + seed + 3.1);
            float cyc = floor(tt);
            float ph = tt - cyc;
            float on = step(hash21(c + vec2(cyc * 0.37, seed + cyc * 1.13)), rate);
            vec2 ctr = c + 0.15 + 0.7 * vec2(hash21(c + cyc * 0.71 + 9.1), hash21(c + cyc * 1.31 + 4.7));
            vec2 dv = g - ctr;
            float dd = length(dv);
            float x = (dd - ph * 0.62) / 0.055;
            float env = (1.0 - ph) * (1.0 - ph) * on;
            float e = exp(-x * x);
            slope += dv / max(dd, 1e-3) * (-2.0 * x * e / 0.055 * env * 0.020 / cell);
            fleck += (1.0 - smoothstep(0.0, 0.14, ph)) * exp(-dd * dd / 0.006) * on + 0.42 * e * env;
          }
        }
        return vec3(slope, min(fleck, 1.0));
      }

      // Aerated films and fine cell walls, stretched along local flow. Coverage is
      // continuous: no binary threshold turns large bubble domes into opaque white spots.
      vec3 foamPattern(float rho, vec2 uv, vec2 dir, float stretch, float px, float fine, vec2 dux, vec2 duy) {
        if (rho < 0.015) return vec3(0.0, 0.0, 0.5);
        vec2 perp = vec2(-dir.y, dir.x);
        vec2 q = vec2(dot(uv, dir) / stretch, dot(uv, perp));
        vec2 qx = vec2(dot(dux, dir) / stretch, dot(dux, perp)), qy = vec2(dot(duy, dir) / stretch, dot(duy, perp));
        vec4 broad = textureGrad(uFoam, q / 5.4, qx / 5.4, qy / 5.4);
        vec4 cells = textureGrad(uFoam, q / 1.25 + vec2(0.37, 0.19), qx / 1.25, qy / 1.25);
        float detail = (1.0 - smoothstep(0.015, 0.10, px)) * fine;
        vec4 micro = textureGrad(uFoam, q / 0.32 + vec2(0.59, 0.43), qx / 0.32, qy / 0.32);
        float density = (1.0 - exp(-max(rho, 0.0) * 2.0)) * smoothstep(0.20, 0.65, rho);
        float body = smoothstep(0.55 - density * 0.3, 0.73 - density * 0.3, broad.r * 0.68 + cells.r * 0.32);
        float lace = max(cells.b, broad.b * 0.45);
        float bubbles = mix(0.5, micro.g, detail);
        float film = density * (body * 0.95 + lace * 0.28) * (0.92 + 0.08 * bubbles);
        return vec3(clamp(film, 0.0, 1.0), lace * density, bubbles);
      }

      void main() {
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        float px = max(length(fwidth(vRest)), 0.02);
        vec3 loc = (uShipInv * vec4(vWorld, 1.0)).xyz;
        vec3 hdg = hullDistG(loc.xz, loc.y);
        float dHull = hdg.x; vec2 gD = hdg.yz;
        float hf = 0.35 + 0.65 * smoothstep(1.0, 16.0, dHull);
        vec4 sd; vec3 rx, rz;
        swell(vRest, px, sd, rx, rz);
        rx = mix(vec3(1.0, 0.0, 0.0), rx, hf);
        rz = mix(vec3(0.0, 0.0, 1.0), rz, hf);
        vec3 bd = vec3(0.0);
        vec4 bf = vec4(0.0, 0.0, 1.0, 0.0);
        float run = 0.0;
        for (int i = 0; i < NB; i++) bigSlot(i, vRest, px, dHull, gD, true, bd, rx, rz, run, bf);
        float ridge = steadyRidge(dHull, gD);
        float bump = run / 2.4 + ridge / 1.5;
        rx.y -= bump * gD.x;
        rz.y -= bump * gD.y;
        float wakeDx = (vesselWake(vRest + vec2(0.18, 0.0)).x - vesselWake(vRest - vec2(0.18, 0.0)).x) / 0.36;
        float wakeDz = (vesselWake(vRest + vec2(0.0, 0.18)).x - vesselWake(vRest - vec2(0.0, 0.18)).x) / 0.36;
        rx.y += wakeDx; rz.y += wakeDz;
        vec3 N = normalize(cross(rz, rx));

        // Subordinate capillary ripples: broad geometric wave faces stay readable.
        float calm = mix(0.30, 1.0, smoothstep(0.0, 4.0, dHull));
        float far = 1.0 - smoothstep(60.0, 520.0, dist);
        vec2 uvA = mat2(0.866, -0.5, 0.5, 0.866) * vRest / 17.0 + uScroll[0].xy;
        vec2 uvB = mat2(0.6, 0.8, -0.8, 0.6) * vRest / 5.3 + uScroll[0].zw;
        vec2 uvC = mat2(0.0, -1.0, 1.0, 0.0) * vRest / 1.9 + uScroll[1].xy;
        vec2 slope = (texture(uDetail, uvA).rg * 2.0 - 1.0) * 0.035
                   + (texture(uDetail, uvB).rg * 2.0 - 1.0) * 0.025
                   + (texture(uDetail, uvC).rg * 2.0 - 1.0) * 0.015;
        slope *= calm * far * (1.0 + 0.6 * uRain);
        float rainFleck = 0.0;
        if (uRain > 0.02 && px < 0.1) {
          float rate = uRain * 0.85;
          vec3 ra = rainLayer(vRest, seconds, 0.9, rate, 0.0);
          vec3 rb = rainLayer(vRest, seconds * 1.07, 1.7, rate * 0.8, 11.0);
          float fa = 1.0 - smoothstep(0.012, 0.05, px), fb = 1.0 - smoothstep(0.03, 0.09, px);
          slope += ra.xy * fa + rb.xy * fb;
          rainFleck = ra.z * fa + rb.z * fb;
        }
        N = normalize(vec3(N.x - slope.x, N.y, N.z - slope.y));

        vec3 Lk = uKey.xyz;
        float ndl = max(dot(N, Lk), 0.0) * uKey.w;
        float ndv = max(dot(N, V), 0.02);
        float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
        vec3 R = reflect(-V, N);
        R.y = abs(R.y) + 0.01;
        vec3 reflected = skyColour(normalize(R), seconds, 0.22, 0.0);

        // Ripple texture taps (also modulate the translucent crest glow).
        vec2 wp = vec2(-uWind.y, uWind.x);
        float u = dot(vRest, uWind), v = dot(vRest, wp);
        vec4 F1 = texture(uDetail, vec2(u / 46.0, v / 11.0) + uScroll[1].zw);
        vec4 F2 = texture(uDetail, vec2(u / 17.0, v / 6.5) + uScroll[2].xy);
        float pat = 0.55 * F1.b + 0.45 * F2.b;
        // Absorbing teal body and restrained crest transmission, not cyan height bands.
        float hN = clamp(vHN + 0.18 * max(vBig, 0.0), 0.0, 1.0);
        vec2 vh = normalize(-V.xz + vec2(1e-4));
        float toSun = clamp(dot(vh, normalize(Lk.xz + vec2(1e-5))) * 0.5 + 0.5, 0.0, 1.0);
        float faceTilt = clamp(-dot(N.xz, vh) * 1.6, 0.0, 1.0);
        vec3 body = mix(uWDeep, uWMid, 0.30 + 0.70 * smoothstep(0.0, 1.0, ndl));
        body = mix(body, uWMid * 1.15, (1.0 - ndv) * 0.35);
        float glow = smoothstep(0.55, 0.95, hN) * (0.15 + 0.5 * toSun * faceTilt);
        glow += faceTilt * smoothstep(0.55, 0.95, hN) * 0.12;
        glow += max(vBig, 0.0) * 0.12 * faceTilt;
        body = mix(body, uWTurq * (0.65 + 0.35 * ndl) * (0.92 + 0.16 * pat), clamp(glow, 0.0, 0.52));
        body = mix(body, uWTurq * (0.55 + 0.4 * ndl), 0.12 * (1.0 - smoothstep(0.0, 6.0, dHull)));
        body *= mix(0.72, 1.0, smoothstep(0.0, 2.2, dHull));

        float rough = 1.0 + 4.0 * smoothstep(300.0, 1500.0, dist);
        vec3 H = normalize(uSunDir + V);
        float nh = max(dot(N, H), 0.0);
        float spec = pow(nh, 900.0 / rough) * 1.6 + pow(nh, 180.0 / rough) * 0.6 + pow(nh, 36.0) * 0.04;
        vec3 colour = mix(body, reflected, fres)
          + vec3(1.0, 0.97, 0.91) * spec * smoothstep(0.0, 0.1, max(dot(N, uSunDir), 0.0)) * uSpecAmt.x;
        if (uSpecAmt.y > 0.002) {
          vec3 Hm = normalize(uMoonDir + V);
          float nm = max(dot(N, Hm), 0.0);
          float mspec = pow(nm, 900.0 / rough) * 9.0 + pow(nm, 130.0 / rough) * 1.2 + pow(nm, 20.0) * 0.06;
          colour += uMoonCol * mspec * smoothstep(0.0, 0.1, max(dot(N, uMoonDir), 0.0)) * uSpecAmt.y;
        }

        // Thin bow wash and aerated, widening aft trail. Patterns drift in WORLD
        // water coordinates while pressure and age follow the moving hull.
        vec3 wake = vesselWake(vRest);
        float bowWash = smoothstep(uHullEnds.x - 11.0, uHullEnds.x - 1.0, loc.z);
        float sideWash = exp(-max(dHull, 0.0) / 0.42)
          * (0.16 + 0.85 * bowWash) * (0.75 + 0.25 * vHN) * uHullFoam;
        float rhoWake = wake.y * uHullFoam;
        vec2 dux = dFdx(vRest), duy = dFdy(vRest);
        vec2 drift = uWind * seconds * 0.10;
        vec3 pa = foamPattern(bf.x * 0.85, vRest - bf.zw * (2.6 * (1.0 - exp(-bf.y / 2.0))), bf.zw, 2.8, px, 1.0, dux, duy);
        vec3 pb = foamPattern(max(sideWash, rhoWake), vRest + drift, vec2(0.0, -1.0), 3.4, px, 1.0, dux, duy);
        vec3 pc = foamPattern(vFj * 0.85, vRest + drift, uWind, 1.8, px, 0.0, dux, duy);
        float cover = clamp(max(pa.x, max(pb.x, pc.x)) + max(pa.y, pb.y) * 0.04, 0.0, 0.98);
        float thick = smoothstep(0.25, 0.65, cover);
        float bubbles = mix(0.5, max(pa.z, pb.z), 1.0 - smoothstep(0.04, 0.14, px));
        vec3 foamLit = uFoamAmb + uFoamKey * (0.5 + 0.5 * ndl);
        vec3 thinCol = mix(colour, vec3(0.61, 0.77, 0.79) * foamLit, 0.62);
        vec3 thickCol = vec3(0.83, 0.89, 0.87) * foamLit;
        vec3 foamRGB = mix(thinCol, thickCol, thick) * (0.92 + 0.11 * bubbles);
        foamRGB += uFlash * vec3(0.22, 0.30, 0.44);
        colour = mix(colour, foamRGB, cover);
        colour += vec3(0.70, 0.80, 0.90) * foamLit * rainFleck * 0.55 * smoothstep(0.0, 0.5, uRain);
        colour += uFlash * vec3(0.10, 0.13, 0.22) * (0.3 + fres);

        float distanceXZ = length(cameraPosition.xz - vWorld.xz);
        colour = mix(colour, uHorizonCol * (1.0 + 0.15 * uRain) + uFlash * vec3(0.17, 0.21, 0.33), smoothstep(uFogRange.x, uFogRange.y, distanceXZ));
        gl_FragColor = vec4(colour, 1.0);
        ${OUTPUT}
      }
    `,
  });
}

function skyMaterial(shared) {
  return new THREE.ShaderMaterial({
    name: 'Sunny linear sky (day, dusk, night)',
    defines: { CLOUD_VOLUME: 1 },
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { ...shared, seconds: { value: 0 } },
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = position;
        gl_Position = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
        // Draw last at the far plane: opaque water/deck pixels reject the
        // expensive cloud march, without covering distant ocean geometry.
        gl_Position.z = gl_Position.w;
      }
    `,
    fragmentShader: `
      uniform float seconds;
      varying vec3 vDirection;
      ${NOISE}
      ${SKY}
      void main() {
        gl_FragColor = vec4(skyColour(normalize(vDirection), seconds, 0.0, 1.0), 1.0);
        ${OUTPUT}
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// Spray: stateless GPU particles. Position = f(event age, rim contact time,
// per-particle hash). Droplets leave the hull along the real impact line and
// fly ballistic arcs: fine mist, streaked drops, round drops and hooked claws.
// ---------------------------------------------------------------------------
const SPRAY_COUNT = 3600;
function sprayObject(shared) {
  const rand = mulberry32(0x5EA5EA);
  const aA = new Float32Array(SPRAY_COUNT * 4), aB = new Float32Array(SPRAY_COUNT * 4);
  for (let i = 0; i < SPRAY_COUNT; i++) {
    // 0 = streaked fine droplets, 1 = rising mist, 2 = round drops, 3 = hooked claw splashes.
    const pick = rand();
    const type = pick < 0.39 ? 0 : pick < 0.58 ? 1 : pick < 0.98 ? 2 : 3;
    const delay = 0.5 * Math.pow(rand(), 1.7);
    const life = type === 1 ? 1.8 + 1.8 * rand() : type === 3 ? 1.4 + 1.2 * rand() : type === 2 ? 1.3 + 1.3 * rand() : 1.1 + 1.5 * rand();
    aA.set([delay, life, type, rand()], i * 4);
    aB.set([(i + rand()) / SPRAY_COUNT, rand(), rand(), rand()], i * 4);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPRAY_COUNT * 3), 3));
  geometry.setAttribute('aA', new THREE.BufferAttribute(aA, 4));
  geometry.setAttribute('aB', new THREE.BufferAttribute(aB, 4));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const material = new THREE.ShaderMaterial({
    name: 'Sunny stateless big-wave spray',
    transparent: true,
    depthWrite: false,
    uniforms: {
      uEvA: { value: new THREE.Vector4() },
      uEvB: { value: new THREE.Vector4(0, 0, 1, 1) },
      uLayer: { value: 0 },
      uRim: shared.uRim, uWind: shared.uWind, uSprayCol: shared.uSprayCol, uFlash: shared.uFlash, uVoyage: shared.uVoyage,
    },
    vertexShader: `
      attribute vec4 aA;   // delay, life, type, size random
      attribute vec4 aB;   // rim pick, random 1..3
      uniform vec4 uEvA;   // travel dir x, z, lateral centre, strength
      uniform vec4 uEvB;   // event age (s), active, viewport height (px), aspect
      uniform float uLayer;
      uniform highp sampler2D uRim;
      uniform vec2 uWind;
      uniform vec4 uVoyage;
      varying float vAlpha;
      varying float vType;
      varying float vSeed;
      varying vec2 vDir;
      varying float vStretch;
      const int RIM = ${RIM_COUNT};
      vec3 trajectory(float tau, vec4 geo, vec4 rp, float mist, float fine, float drop, float claw, bool inward) {
        vec2 n = normalize(geo.zw);
        vec2 t = vec2(-n.y, n.x);
        float s = (0.62 + 0.5 * uEvA.w) * (0.5 + 0.5 * rp.y);
        float r1 = aB.y, r2 = aB.z, r3 = aB.w;
        float up = (mist * (2.5 + 4.0 * r2) + fine * (8.0 + 9.0 * pow(r2, 0.8)) + drop * (6.5 + 7.0 * r2) + claw * (10.0 + 5.5 * r2)) * s;
        float outV = (mist * (0.4 + 1.4 * r3) + fine * (2.0 + 4.5 * r3) + drop * (1.6 + 4.2 * r3) + claw * (2.4 + 3.4 * r3)) * s;
        if (inward) outV = -(1.2 + 2.2 * r3) * s;
        vec2 hv = n * outV + t * ((r1 - 0.5) * 3.0 + rp.z * 2.6 * s) + uWind * (1.0 + 1.3 * mist);
        float g = mix(9.8, 3.0, mist);
        float drift = (1.0 - exp(-1.1 * tau)) / 1.1;
        float y0 = ${SEA_Y.toFixed(1)} + 0.3 + (0.4 + 1.6 * r1) * rp.y;
        float inherited = uVoyage.z * (tau - (1.0 - exp(-0.35 * tau)) / 0.35);
        return vec3(geo.x + n.x * 0.15 + hv.x * drift + uVoyage.x, y0 + up * tau - 0.5 * g * tau * tau,
          geo.y + n.y * 0.15 + hv.y * drift + uVoyage.y - inherited);
      }
      void main() {
        vAlpha = 0.0; vType = aA.z; vSeed = aB.w; vDir = vec2(1.0, 0.0); vStretch = 1.0;
        gl_PointSize = 0.0;
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        if (uEvB.y < 0.5) return;
        float tp = aA.z;
        float fine = 1.0 - step(0.5, tp);
        float mist = step(0.5, tp) * (1.0 - step(1.5, tp));
        float drop = step(1.5, tp) * (1.0 - step(2.5, tp));
        float claw = step(2.5, tp);
        // Pick a launch point on the hull rim: inverse CDF of the impact weight.
        int row = int(uLayer + 0.5);
        float idx = texelFetch(uRim, ivec2(int(aB.x * float(RIM - 1) + 0.5), 3 + row), 0).r;
        int k0 = int(floor(idx));
        float kf = idx - float(k0);
        int k1 = (k0 + 1) % RIM;
        k0 = k0 % RIM;
        vec4 geo = mix(texelFetch(uRim, ivec2(k0, 6), 0), texelFetch(uRim, ivec2(k1, 6), 0), kf);
        vec4 rp = mix(texelFetch(uRim, ivec2(k0, row), 0), texelFetch(uRim, ivec2(k1, row), 0), kf);
        float gate = fract(aB.x * 91.7 + aB.y * 13.1 + aB.z * 5.3);
        if (gate > 0.4 + 0.6 * uEvA.w || rp.y < 0.04) return;
        float life = aA.y;
        float tau = uEvB.x - rp.x - aA.x;
        if (tau < 0.0 || tau > life) return;
        bool inward = claw > 0.5 && aB.y < 0.3;
        vec3 pos = trajectory(tau, geo, rp, mist, fine, drop, claw, inward);
        float k = tau / life;
        // Fine droplets are centimetres, not the previous 7–20 cm opaque discs.
        // Only diffuse mist has a large footprint; it must not paint white spots.
        float size = mist > 0.5 ? (0.35 + 0.8 * aA.w) * (0.55 + 1.0 * k)
                   : claw > 0.5 ? 0.06 + 0.10 * aA.w
                   : drop > 0.5 ? 0.008 + 0.02 * aA.w : 0.008 + 0.018 * aA.w;
        vAlpha = smoothstep(0.0, 0.06, k) * pow(1.0 - k, 1.3) * (mist > 0.5 ? 0.055 : claw > 0.5 ? 0.45 : 0.55)
               * smoothstep(${(SEA_Y - 0.4).toFixed(1)}, ${(SEA_Y + 0.5).toFixed(1)}, pos.y);
        if (inward) vAlpha *= smoothstep(0.2, 1.3, pos.y);
        vec4 mv = viewMatrix * vec4(pos, 1.0);
        vec4 c0 = projectionMatrix * mv;
        vec3 pos2 = trajectory(tau + 0.04, geo, rp, mist, fine, drop, claw, inward);
        vec4 c1 = projectionMatrix * viewMatrix * vec4(pos2, 1.0);
        vec2 dv = (c1.xy / c1.w - c0.xy / c0.w) * vec2(uEvB.w, 1.0);
        float dl = length(dv);
        vDir = dl > 1e-6 ? dv / dl : vec2(0.0, -1.0);
        vStretch = clamp(1.0 + dl * 55.0, 1.0, 3.2) * (fine + claw * 0.7 + drop * 0.25) + (mist + drop * 0.75);
        vStretch = max(vStretch, 1.0);
        gl_Position = c0;
        vAlpha *= smoothstep(0.4, 3.0, -mv.z);
        gl_PointSize = clamp(size * max(vStretch, 1.0) * uEvB.z * 0.5 * projectionMatrix[1][1] / max(-mv.z, 0.1), 1.0, 240.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSprayCol;
      uniform float uFlash;
      varying float vAlpha;
      varying float vType;
      varying float vSeed;
      varying vec2 vDir;
      varying float vStretch;
      ${NOISE}
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        c.y = -c.y;
        if (vAlpha <= 0.002) discard;
        vec2 dir = normalize(vDir + vec2(1e-5));
        vec2 pp = vec2(dot(c, dir), dot(c, vec2(-dir.y, dir.x)));
        float shape;
        vec3 tint = vec3(1.0);
        if (vType < 0.5) {
          float r = length(vec2(pp.x, pp.y * max(vStretch, 1.0)));
          shape = exp(-4.0 * r * r) * (1.0 - smoothstep(0.65, 1.0, r));
          tint = vec3(1.0, 1.02, 1.04) * (1.05 - 0.2 * pp.x);
        } else if (vType < 1.5) {
          float r2 = dot(c, c);
          if (r2 > 1.0) discard;
          shape = pow(1.0 - r2, 2.4) * smoothstep(0.15, 0.8, noise21(c * 5.4 + vSeed * 37.0));
        } else if (vType < 2.5) {
          float r = length(vec2(pp.x, pp.y * max(vStretch, 1.0)));
          shape = exp(-3.0 * r * r) * (1.0 - smoothstep(0.65, 1.0, r));
          float hi = smoothstep(0.1, 0.9, dot(c, normalize(vec2(-0.5, 0.8))) * 0.5 + 0.5);
          tint = mix(vec3(0.82, 0.92, 1.0), vec3(1.05), hi);
        } else {
          // Hooked claw: a crescent whose points trail behind the travel direction.
          float outer = length(pp);
          float inner = length(pp - vec2(-0.55, 0.08));
          float ragged = 0.92 + 0.16 * noise21(pp * 3.0 + vSeed * 91.0);
          shape = (1.0 - smoothstep(0.82, 0.95, outer * ragged)) * smoothstep(0.80, 0.93, inner);
          tint = mix(vec3(0.86, 0.94, 1.0), vec3(1.06), smoothstep(-0.6, 0.6, pp.x));
        }
        vec3 colour = uSprayCol * tint + uFlash * vec3(0.4, 0.5, 0.8);
        gl_FragColor = vec4(colour, clamp(shape * vAlpha, 0.0, 1.0));
        ${OUTPUT}
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'Stateless big-wave spray and mist';
  points.frustumCulled = false;
  points.visible = false;
  points.renderOrder = 5;
  const size = new THREE.Vector2();
  points.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(size);
    material.uniforms.uEvB.value.z = size.y;
    material.uniforms.uEvB.value.w = size.x / Math.max(size.y, 1);
  };
  return { points, timing: aA };
}

// ---------------------------------------------------------------------------
// Hull foam sheet: a thin ribbon hugging the hull sides. Run-up sheets climb,
// tear off at a lacy top edge and drain down in vertical streaks; between
// waves a ragged foam strip rides the waterline.
// ---------------------------------------------------------------------------
function hullFoamSheet(shared, outline, maps) {
  const N = RIM_COUNT, V = 16;
  const yMin = -5.9, yMax = -0.4;
  const positions = new Float32Array((N + 1) * (V + 1) * 3);
  const rims = new Float32Array((N + 1) * (V + 1));
  const arcs = new Float32Array((N + 1) * (V + 1));
  const normals = new Float32Array((N + 1) * (V + 1) * 2);
  let arc = 0;
  for (let k = 0; k <= N; k++) {
    const kk = k % N, kp = (k + N - 1) % N;
    if (k > 0) arc += Math.hypot(outline.rim[kk * 4] - outline.rim[kp * 4], outline.rim[kk * 4 + 1] - outline.rim[kp * 4 + 1]);
    const th = TAU * kk / N;
    for (let j = 0; j <= V; j++) {
      const y = yMin + (yMax - yMin) * j / V;
      const r = hullRadiusAt(outline, kk, y) + 0.05;
      const o = k * (V + 1) + j;
      positions[o * 3] = Math.sin(th) * r;
      positions[o * 3 + 1] = y;
      positions[o * 3 + 2] = outline.cz + Math.cos(th) * r;
      rims[o] = k;
      arcs[o] = arc;
      normals[o * 2] = outline.rim[kk * 4 + 2]; normals[o * 2 + 1] = outline.rim[kk * 4 + 3];
    }
  }
  const indices = new Uint32Array(N * V * 6);
  let q = 0;
  for (let k = 0; k < N; k++) {
    for (let j = 0; j < V; j++) {
      const a = k * (V + 1) + j, b = (k + 1) * (V + 1) + j;
      indices[q++] = a; indices[q++] = b; indices[q++] = a + 1;
      indices[q++] = b; indices[q++] = b + 1; indices[q++] = a + 1;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aRim', new THREE.BufferAttribute(rims, 1));
  geometry.setAttribute('aArc', new THREE.BufferAttribute(arcs, 1));
  geometry.setAttribute('aNormal', new THREE.BufferAttribute(normals, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -3, 0), 40);
  const material = new THREE.ShaderMaterial({
    name: 'Sunny hull foam sheet',
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    uniforms: { ...shared, uFoam: { value: maps.foam } },
    vertexShader: `
      ${WATER_GLSL}
      attribute float aRim;
      attribute float aArc;
      attribute vec2 aNormal;
      varying float vRim;
      varying float vArc;
      varying float vWL;
      varying float vY;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vY = wp.y;
        vRim = aRim;
        vArc = aArc;
        // Local free-surface height at the hull (same function as the sea mesh).
        vWL = ${SEA_Y.toFixed(1)} + waterHeight(wp.xz, 0.8, 0.0, aNormal, uHeave);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      ${NOISE}
      ${WATER_GLSL}
      uniform highp sampler2D uRim;
      uniform sampler2D uFoam;
      uniform vec3 uFoamAmb;
      uniform vec3 uFoamKey;
      uniform float uHullFoam;
      uniform vec4 uKey;
      uniform float uFlash;
      varying float vRim;
      varying float vArc;
      varying float vWL;
      varying float vY;
      const int RIM = ${RIM_COUNT};
      void main() {
        float h = vY - vWL;
        if (h < -0.25) discard;
        int k0 = int(floor(vRim));
        float kf = vRim - float(k0);
        k0 = k0 % RIM;
        int k1 = (k0 + 1) % RIM;
        vec4 tA = texture(uFoam, vec2(vArc / 2.6, h / 9.0) + vec2(0.31, 0.12));
        vec4 tB = texture(uFoam, vec2(vArc / 0.9, (h + seconds * 0.35) / 6.0) + vec2(0.77, 0.41));
        vec4 tC = texture(uFoam, vec2(vArc / 1.7, h / 1.2) + vec2(0.52, 0.66));
        // A thin wet waterline, not a permanent opaque collar around the ship.
        float strip = (1.0 - smoothstep(0.015, 0.07 + 0.09 * tC.r, h)) * (0.2 + 0.8 * tC.b);
        float alpha = strip * 0.35 * uHullFoam;
        float film = 0.0;
        for (int i = 0; i < NB; i++) {
          vec4 A = uBigA[i];
          if (A.w <= 0.0) continue;
          vec4 C = uBigC[i];
          int row = int(uBigD[i].x + 0.5);
          vec4 rp = mix(texelFetch(uRim, ivec2(k0, row), 0), texelFetch(uRim, ivec2(k1, row), 0), kf);
          float tau = C.z - rp.x;
          float w = rp.y * (0.55 + 0.45 * C.w);
          if (tau < -0.05 || w < 0.02 || tau > 11.0) continue;
          float peak = 0.9 + 1.8 * w;
          float rise = smoothstep(0.0, 0.30, tau);
          float front = peak * rise * exp(-max(tau - 0.5, 0.0) / 2.2);
          float top = front + 0.85 * (tA.r - 0.5) + 0.35 * (tC.g - 0.5);
          float sheet = (1.0 - smoothstep(top - 0.55, top, h)) * smoothstep(-0.2, 0.05, h) * (0.7 + 0.3 * smoothstep(0.3, 0.6, tB.g + 0.35 * (1.0 - h / max(peak, 0.1))));
          // Drain streaks: irregular columns that start at different heights and slide down the planks.
          float cu = vArc / 0.85;
          float ci = floor(cu);
          float cf = fract(cu + 0.18 * sin(h * 2.3 + ci * 5.1));
          float r1 = hash21(vec2(ci, 3.7)), r2 = hash21(vec2(ci, 9.1));
          float prof = smoothstep(0.0, 0.45, cf) * smoothstep(1.0, 0.55, cf);
          float reachC = peak * (0.35 + 0.65 * r1) + 0.3;
          float env = smoothstep(0.08, 0.45, tau) * exp(-max(tau - 0.4, 0.0) / 3.1);
          float slide = h + 1.5 * tau * (0.6 + 0.8 * r2);
          float drip = (1.0 - smoothstep(reachC - 1.3, reachC, h)) * (0.6 + 0.4 * smoothstep(0.2, 0.8, fract(slide * 0.45 + r2)));
          float streak = prof * drip * env * step(0.18, r1) * smoothstep(-0.2, 0.1, h);
          alpha = max(alpha, max(sheet * 0.95, streak * 0.86) * clamp(w * 1.6, 0.0, 1.0));
          film = max(film, sheet);
        }
        if (alpha < 0.01) discard;
        float lit = 0.35 + 0.65 * max(uKey.y, 0.0);
        vec3 foamLit = uFoamAmb + uFoamKey * lit * uKey.w;
        vec3 colour = mix(vec3(0.74, 0.90, 0.97), vec3(0.96, 0.99, 1.0), smoothstep(0.0, 1.0, h + 0.4 * film)) * foamLit;
        colour += uFlash * vec3(0.3, 0.36, 0.55);
        gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
        ${OUTPUT}
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Hull foam sheet and run-up streaks';
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  return { mesh, geometry, material };
}


// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------
const DETAIL_SIZE = 512;
function latticeNoise(freq, rand) {
  const lat = new Float32Array(freq * freq);
  for (let i = 0; i < lat.length; i++) lat[i] = rand();
  return (x, y) => {
    const fx = x * freq, fy = y * freq;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    let tx = fx - ix, ty = fy - iy;
    tx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
    ty = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
    const x0 = ((ix % freq) + freq) % freq, x1 = (x0 + 1) % freq;
    const y0 = ((iy % freq) + freq) % freq, y1 = (y0 + 1) % freq;
    const a = lat[y0 * freq + x0], b = lat[y0 * freq + x1];
    const c = lat[y1 * freq + x0], d = lat[y1 * freq + x1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

/** Tiling RGBA8 data texture: RG = ripple slope, B = foam coverage noise, A = lace lines. */
function detailTexture() {
  const N = DETAIL_SIZE;
  const rand = mulberry32(0xD37A11);
  const octaves = [];
  for (let o = 0; o < 6; o++) octaves.push({ noise: latticeNoise(4 << o, rand), amp: Math.pow(0.55, o) });
  const height = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let h = 0;
      for (const { noise, amp } of octaves) {
        const n = noise(x / N, y / N);
        h += amp * (0.5 * n + 0.5 * (1 - Math.abs(2 * n - 1)));
      }
      height[y * N + x] = h;
    }
  }
  const gx = new Float32Array(N * N), gy = new Float32Array(N * N);
  let sum2 = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const dx = height[y * N + ((x + 1) % N)] - height[y * N + ((x + N - 1) % N)];
      const dy = height[((y + 1) % N) * N + x] - height[((y + N - 1) % N) * N + x];
      gx[i] = dx; gy[i] = dy; sum2 += dx * dx + dy * dy;
    }
  }
  const sigma = Math.sqrt(sum2 / (2 * N * N));
  const fbmNoise = [latticeNoise(3, rand), latticeNoise(6, rand), latticeNoise(12, rand), latticeNoise(24, rand), latticeNoise(48, rand)];
  // Tileable Worley F2-F1: bright thin lace lines along cell borders.
  const cells = 44;
  const jx = new Float32Array(cells * cells), jy = new Float32Array(cells * cells);
  for (let i = 0; i < jx.length; i++) { jx[i] = rand(); jy[i] = rand(); }
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const u = x / N, v = y / N;
      // Domain-warped cells so the lace reads as organic bubbles, not a honeycomb.
      const wu = u + 0.045 * (fbmNoise[2](u, v) - 0.5) + 0.02 * (fbmNoise[3](u + 0.31, v + 0.17) - 0.5);
      const wv = v + 0.045 * (fbmNoise[2](u + 0.5, v + 0.5) - 0.5) + 0.02 * (fbmNoise[3](u + 0.77, v + 0.63) - 0.5);
      const cx = wu * cells, cy = wv * cells;
      const ix = Math.floor(cx), iy = Math.floor(cy);
      let f1 = 9, f2 = 9;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const wx = (((ix + ox) % cells) + cells) % cells, wy = (((iy + oy) % cells) + cells) % cells;
          const px = ix + ox + jx[wy * cells + wx], py = iy + oy + jy[wy * cells + wx];
          const dd = Math.hypot(cx - px, cy - py);
          if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) f2 = dd;
        }
      }
      let fbmValue = 0, a = 0.5, norm = 0;
      for (const noise of fbmNoise) { fbmValue += a * noise(u, v); norm += a; a *= 0.55; }
      fbmValue /= norm;
      const lace = (1 - smooth01(0, 0.14, f2 - f1)) * smooth01(0.45, 0.66, fbmValue);
      data[i * 4] = Math.round(255 * (Math.max(-1, Math.min(1, gx[i] / (3 * sigma))) * 0.5 + 0.5));
      data[i * 4 + 1] = Math.round(255 * (Math.max(-1, Math.min(1, gy[i] / (3 * sigma))) * 0.5 + 0.5));
      data[i * 4 + 2] = Math.round(255 * Math.max(0, Math.min(1, (fbmValue - 0.5) * 2.4 + 0.5)));
      data[i * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, lace)));
    }
  }
  const texture = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = 'Procedural ocean ripple/foam atlas';
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}


// ---------------------------------------------------------------------------
// Foam atlas (tiling RGBA8): R = turbulent film thickness, G = fine bubble walls,
// B = broken cellular lace, A = ridged billow. No filled bubble discs.
// Sampled with anisotropic, world-advected flow in the sea shader.
// ---------------------------------------------------------------------------
const FOAM_SIZE = 512;
function makeWorley(cells, rand) {
  const jx = new Float32Array(cells * cells), jy = new Float32Array(cells * cells);
  for (let i = 0; i < jx.length; i++) { jx[i] = rand(); jy[i] = rand(); }
  const out = { f1: 0, f2: 0 };
  return (u, v) => {
    const cx = u * cells, cy = v * cells;
    const ix = Math.floor(cx), iy = Math.floor(cy);
    let f1 = 9, f2 = 9;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const wx = (((ix + ox) % cells) + cells) % cells, wy = (((iy + oy) % cells) + cells) % cells;
        const dx = cx - (ix + ox + jx[wy * cells + wx]), dy = cy - (iy + oy + jy[wy * cells + wx]);
        const dd = Math.sqrt(dx * dx + dy * dy);
        if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) f2 = dd;
      }
    }
    out.f1 = f1; out.f2 = f2;
    return out;
  };
}
function foamTexture() {
  const N = FOAM_SIZE;
  const rand = mulberry32(0xF0A4C5);
  const fbmNoise = [latticeNoise(3, rand), latticeNoise(6, rand), latticeNoise(12, rand), latticeNoise(24, rand)];
  const warp = [latticeNoise(5, rand), latticeNoise(9, rand), latticeNoise(7, rand)];
  const wl = [makeWorley(22, rand), makeWorley(26, rand)];
  const R = new Float32Array(N * N), G = new Float32Array(N * N), B = new Float32Array(N * N), A = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x, u = x / N, v = y / N;
      let f = 0, a = 0.5, norm = 0;
      for (const noise of fbmNoise) { f += a * noise(u, v); norm += a; a *= 0.55; }
      f /= norm;
      R[i] = Math.max(0, Math.min(1, (f - 0.5) * 2.7 + 0.5));
      const wu = u + 0.05 * (warp[0](u + 0.2, v + 0.6) - 0.5), wv = v + 0.05 * (warp[1](u + 0.7, v + 0.1) - 0.5);
      const w1 = wl[0](((wu % 1) + 1) % 1, ((wv % 1) + 1) % 1);
      G[i] = 1 - smooth01(0.015, 0.12, w1.f2 - w1.f1);
      const w3 = wl[1](((wu % 1) + 1) % 1, ((wv % 1) + 1) % 1);
      const gate = fbmNoise[2](u + 0.41, v + 0.27) * 0.6 + fbmNoise[1](u + 0.13, v + 0.9) * 0.4;
      B[i] = (1 - smooth01(0, 0.13, w3.f2 - w3.f1)) * smooth01(0.34, 0.52, gate);
      A[i] = 1 - Math.abs(2 * fbmNoise[3](u + 0.6, v + 0.3) - 1);
    }
  }
  // Centre film and fine walls around 0.5 for stable mip-averaged coverage.
  let mean = 0, meanR = 0;
  for (let i = 0; i < G.length; i++) { mean += G[i]; meanR += R[i]; }
  mean /= G.length; meanR /= R.length;
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = Math.round(255 * Math.max(0, Math.min(1, 0.5 + (R[i] - meanR) * 1.5)));
    data[i * 4 + 1] = Math.round(255 * Math.max(0, Math.min(1, 0.5 + (G[i] - mean) * 1.9)));
    data[i * 4 + 2] = Math.round(255 * Math.max(0, Math.min(1, B[i])));
    data[i * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, A[i])));
  }
  const texture = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = 'Procedural aerated-film and bubble-wall foam atlas';
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

// ---------------------------------------------------------------------------
// Cloud noise volume (tiling RGBA8, 64^3): R = smooth value-noise fbm (coverage and
// large shapes), G/B/A = Worley "bubble" fields 1-F1 at 4 / 8 / 16 cells. Combining the
// three bubble octaves gives the rounded, scalloped cauliflower silhouettes of cumulus.
// ---------------------------------------------------------------------------
const CLOUD_TEX = 64;
function cloudNoiseTexture() {
  const N = CLOUD_TEX;
  const rand = mulberry32(0xC10D5);
  const quint = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const octaves = [[3, 1], [6, 0.5], [12, 0.25], [24, 0.125]].map(([f, a]) => {
    const lat = new Float32Array(f * f * f);
    for (let i = 0; i < lat.length; i++) lat[i] = rand();
    return { f, a, lat };
  });
  const worley = [4, 8, 16].map((c) => {
    const pts = new Float32Array(c * c * c * 3);
    for (let i = 0; i < pts.length; i++) pts[i] = 0.08 + 0.84 * rand();
    return { c, pts };
  });
  const data = new Uint8Array(N * N * N * 4);
  let norm = 0;
  for (const o of octaves) norm += o.a;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = x / N, v = y / N, w = z / N;
        const o4 = ((z * N + y) * N + x) * 4;
        // value-noise fbm
        let r = 0;
        for (const o of octaves) {
          const f = o.f;
          const fx = u * f, fy = v * f, fz = w * f;
          const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
          const tx = quint(fx - ix), ty = quint(fy - iy), tz = quint(fz - iz);
          const x0 = ix % f, y0 = iy % f, z0 = iz % f, x1 = (x0 + 1) % f, y1 = (y0 + 1) % f, z1 = (z0 + 1) % f;
          const l = o.lat;
          const i000 = l[(z0 * f + y0) * f + x0], i100 = l[(z0 * f + y0) * f + x1];
          const i010 = l[(z0 * f + y1) * f + x0], i110 = l[(z0 * f + y1) * f + x1];
          const i001 = l[(z1 * f + y0) * f + x0], i101 = l[(z1 * f + y0) * f + x1];
          const i011 = l[(z1 * f + y1) * f + x0], i111 = l[(z1 * f + y1) * f + x1];
          const a0 = i000 + (i100 - i000) * tx, a1 = i010 + (i110 - i010) * tx;
          const b0 = i001 + (i101 - i001) * tx, b1 = i011 + (i111 - i011) * tx;
          const c0 = a0 + (a1 - a0) * ty, c1 = b0 + (b1 - b0) * ty;
          r += o.a * (c0 + (c1 - c0) * tz);
        }
        data[o4] = Math.round(255 * Math.min(1, Math.max(0, (r / norm - 0.5) * 1.55 + 0.5)));
        for (let k = 0; k < 3; k++) {
          const { c, pts } = worley[k];
          const fx = u * c, fy = v * c, fz = w * c;
          const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
          let best = 9;
          for (let dz = -1; dz <= 1; dz++) {
            const cz = (iz + dz + c) % c;
            for (let dy = -1; dy <= 1; dy++) {
              const cy = (iy + dy + c) % c;
              for (let dx = -1; dx <= 1; dx++) {
                const cx = (ix + dx + c) % c;
                const pi = ((cz * c + cy) * c + cx) * 3;
                const ex = ix + dx + pts[pi] - fx, ey = iy + dy + pts[pi + 1] - fy, ez = iz + dz + pts[pi + 2] - fz;
                const d2 = ex * ex + ey * ey + ez * ez;
                if (d2 < best) best = d2;
              }
            }
          }
          data[o4 + 1 + k] = Math.round(255 * Math.min(1, Math.max(0, 1 - Math.sqrt(best) * 1.08)));
        }
      }
    }
  }
  const texture = new THREE.Data3DTexture(data, N, N, N);
  texture.name = 'Cloud noise volume (fbm + 3 Worley octaves)';
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

// Exact squared-distance transform (Felzenszwalb & Huttenlocher), in cells.
function distanceTransform(mask, w, h) {
  const INF = 1e12;
  const f = new Float64Array(Math.max(w, h)), d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = mask[i] ? 0 : INF;
  const pass = (n, read, write) => {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      for (;;) {
        const p = v[k];
        s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
        if (s <= z[k] && k > 0) k--; else break;
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    pass(h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
  return grid;
}

/**
 * Slice the hull at several waterline heights (ship space) and build distance
 * fields from the filled silhouette; interior plank seams never matter because
 * the outline is flood-filled. Also returns half-beam / bow profile tables.
 */
function hullField(entity) {
  entity.updateMatrixWorld(true);
  const { x0, z0, w, d, cell } = HULL_BOX;
  const NX = Math.round(w / cell), NZ = Math.round(d / cell);
  const lo = HULL_LEVELS[0] - 0.1, hi = HULL_LEVELS[3] + 0.1;
  const meshes = [];
  const box = new THREE.Box3();
  entity.traverse((object) => {
    if (!object.isMesh || !object.geometry?.attributes.position) return;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    box.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld);
    if (box.max.y < lo || box.min.y > hi) return;
    const position = object.geometry.attributes.position, index = object.geometry.index;
    const m = object.matrixWorld.elements;
    const count = position.count;
    const world = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      world[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      world[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      world[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    meshes.push({ world, index: index ? index.array : null, count: index ? index.count : count });
  });
  const masks = [];
  let segmentCount = 0;
  for (const level of HULL_LEVELS) {
    const wall = new Uint8Array(NX * NZ);
    const mark = (x, z) => {
      const cx = Math.floor((x - x0) / cell), cz = Math.floor((z - z0) / cell);
      if (cx < 1 || cz < 1 || cx >= NX - 1 || cz >= NZ - 1) return;
      for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) wall[(cz + oz) * NX + cx + ox] = 1;
    };
    const px = [0, 0, 0], py = [0, 0, 0], pz = [0, 0, 0];
    for (const mesh of meshes) {
      for (let t = 0; t < mesh.count; t += 3) {
        let above = 0;
        for (let c = 0; c < 3; c++) {
          const vi = mesh.index ? mesh.index[t + c] : t + c;
          px[c] = mesh.world[vi * 3]; py[c] = mesh.world[vi * 3 + 1]; pz[c] = mesh.world[vi * 3 + 2];
          if (py[c] >= level) above++;
        }
        if (above === 0 || above === 3) continue;
        const hits = [];
        for (let e = 0; e < 3; e++) {
          const a = e, b = (e + 1) % 3;
          if ((py[a] >= level) === (py[b] >= level)) continue;
          const s = (level - py[a]) / (py[b] - py[a]);
          hits.push(px[a] + (px[b] - px[a]) * s, pz[a] + (pz[b] - pz[a]) * s);
        }
        if (hits.length < 4) continue;
        segmentCount++;
        const len = Math.hypot(hits[2] - hits[0], hits[3] - hits[1]);
        const steps = Math.max(1, Math.ceil(len / (cell * 0.5)));
        for (let s = 0; s <= steps; s++) mark(hits[0] + (hits[2] - hits[0]) * s / steps, hits[1] + (hits[3] - hits[1]) * s / steps);
      }
    }
    // Flood the open water from the border; everything unreachable is hull.
    const reached = new Uint8Array(NX * NZ);
    const stack = new Int32Array(NX * NZ);
    let top = 0;
    const push = (i) => { if (!reached[i] && !wall[i]) { reached[i] = 1; stack[top++] = i; } };
    for (let x = 0; x < NX; x++) { push(x); push((NZ - 1) * NX + x); }
    for (let z = 0; z < NZ; z++) { push(z * NX); push(z * NX + NX - 1); }
    while (top) {
      const i = stack[--top], x = i % NX, z = (i / NX) | 0;
      if (x > 0) push(i - 1);
      if (x < NX - 1) push(i + 1);
      if (z > 0) push(i - NX);
      if (z < NZ - 1) push(i + NX);
    }
    const mask = new Uint8Array(NX * NZ);
    let filled = 0;
    for (let i = 0; i < mask.length; i++) { mask[i] = reached[i] ? 0 : 1; filled += mask[i]; }
    masks.push({ mask, filled });
  }
  const empty = masks.some(m => m.filled < 40);
  const texel = new Uint16Array(NX * NZ * 4);
  const half = THREE.DataUtils.toHalfFloat;
  const fields = masks.map(({ mask }) => {
    if (empty) {
      // Analytic fallback ellipse if the asset could not be sliced.
      const field = new Float64Array(NX * NZ);
      for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
        const wx = x0 + (x + 0.5) * cell, wz = z0 + (z + 0.5) * cell;
        const e = Math.hypot(wx / 5.2, (wz + 1) / 17.5);
        field[z * NX + x] = Math.max(0, (e - 1) * 5.2) ** 2 / (cell * cell);
      }
      return field;
    }
    return distanceTransform(mask, NX, NZ);
  });
  for (let i = 0; i < NX * NZ; i++) {
    for (let c = 0; c < 4; c++) texel[i * 4 + c] = half(Math.max(0, Math.sqrt(fields[c][i]) * cell - cell));
  }
  const texture = new THREE.DataTexture(texel, NX, NZ, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.name = 'Hull waterline distance field (ship space, 4 slices)';
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  // Profile tables from the widest slice that waves reach.
  const profile = masks[2].mask;
  const halfBeam = new Float32Array(64), bow = new Float32Array(32);
  for (let j = 0; j < 64; j++) {
    const z = z0 + j * (d / 63);
    const row = Math.min(NZ - 1, Math.max(0, Math.floor((z - z0) / cell)));
    let maxX = 0;
    for (let x = 0; x < NX; x++) if (profile[row * NX + x]) maxX = Math.max(maxX, Math.abs(x0 + (x + 0.5) * cell));
    halfBeam[j] = empty ? 5.2 : maxX;
  }
  for (let j = 0; j < 32; j++) {
    const xw = -12 + j * (24 / 31);
    const col = Math.min(NX - 1, Math.max(0, Math.floor((xw - x0) / cell)));
    let maxZ = 0;
    for (let z = 0; z < NZ; z++) if (profile[z * NX + col]) maxZ = Math.max(maxZ, z0 + (z + 0.5) * cell);
    bow[j] = empty ? 17 : maxZ;
  }
  return { texture, halfBeam, bow, segments: segmentCount, fallback: empty,
    masks: masks.map(m => m.mask), filledCells: masks.map(m => m.filled) };
}


/** Radial grid: dense around the ship, geometric growth to the horizon. */
function oceanGeometry(segments) {
  const radii = [];
  let r = 1.5;
  while (r < 2800) {
    radii.push(r);
    r += Math.max(0.6, 0.025 * r);
  }
  radii.push(2800);
  const rings = radii.length;
  const positions = new Float32Array(rings * segments * 3);
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * TAU;
      const o = (j * segments + i) * 3;
      positions[o] = Math.cos(a) * radii[j];
      positions[o + 2] = Math.sin(a) * radii[j];
    }
  }
  const indices = new Uint32Array((rings - 1) * segments * 6);
  let o = 0;
  for (let j = 0; j < rings - 1; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * segments + i, b = j * segments + (i + 1) % segments;
      const c = (j + 1) * segments + i, d = (j + 1) * segments + (i + 1) % segments;
      // Counter-clockwise seen from +Y.
      indices[o++] = a; indices[o++] = b; indices[o++] = c;
      indices[o++] = b; indices[o++] = d; indices[o++] = c;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, SEA_Y, 0), 2900);
  return { geometry, rings, vertices: rings * segments };
}


function collectResources(root, geometries, materials, textures, skeletons) {
  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.skeleton) skeletons.add(object.skeleton);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) textures.add(value);
      }
      for (const uniform of Object.values(material.uniforms ?? {})) {
        if (uniform.value?.isTexture) textures.add(uniform.value);
      }
    }
  });
}

const wrapTau = (x) => { const r = x % TAU; return r < 0 ? r + TAU : r; };
const fractPhase = (x) => x - Math.floor(x);
const clamp01 = (x) => (x > 0 ? (x < 1 ? x : 1) : 0);

// ---------------------------------------------------------------------------
// Atmosphere: three keyed phases (day, twilight, night) blended by the sun
// elevation that `night` drives, then desaturated / darkened by rain.
// All colours are linear-light.
// ---------------------------------------------------------------------------
const PAL = Object.freeze({
  horizon: [[0.22, 0.57, 0.90], [0.16, 0.085, 0.15], [0.040, 0.092, 0.135]],
  zenith: [[0.012, 0.17, 0.60], [0.014, 0.034, 0.17], [0.004, 0.009, 0.046]],
  cloudLit: [[0.98, 0.985, 1.0], [1.0, 0.44, 0.20], [0.12, 0.19, 0.30]],
  cloudShade: [[0.98, 0.985, 1.0], [0.30, 0.14, 0.26], [0.018, 0.030, 0.062]],
  cumLit: [[1.06, 1.06, 1.05], [1.0, 0.50, 0.24], [0.12, 0.19, 0.34]],
  cumShade: [[0.50, 0.60, 0.76], [0.26, 0.17, 0.30], [0.012, 0.020, 0.050]],
  volRim: [[0.50, 0.66, 1.0], [1.0, 0.55, 0.28], [0.22, 0.36, 0.78]],
  stormGlow: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
  wDeep: [[0.006, 0.052, 0.052], [0.005, 0.028, 0.10], [0.0010, 0.0085, 0.032]],
  wMid: [[0.012, 0.13, 0.112], [0.012, 0.062, 0.18], [0.0038, 0.030, 0.092]],
  wTurq: [[0.04, 0.26, 0.20], [0.05, 0.22, 0.30], [0.013, 0.125, 0.185]],
  foamAmb: [[0.62, 0.62, 0.62], [0.42, 0.37, 0.40], [0.080, 0.135, 0.160]],
  foamKey: [[0.50, 0.50, 0.50], [0.22, 0.17, 0.15], [0.12, 0.21, 0.24]],
  spray: [[1.25, 1.31, 1.35], [0.95, 0.80, 0.80], [0.40, 0.54, 0.60]],
});
const WET = Object.freeze({
  horizon: [[0.36, 0.41, 0.45], [0.22, 0.17, 0.21], [0.030, 0.045, 0.060]],
  zenith: [[0.15, 0.18, 0.22], [0.06, 0.06, 0.10], [0.007, 0.011, 0.020]],
  cloudLit: [[0.60, 0.64, 0.70], [0.45, 0.35, 0.36], [0.08, 0.11, 0.15]],
  cloudShade: [[0.30, 0.33, 0.38], [0.17, 0.14, 0.18], [0.014, 0.022, 0.038]],
  cumLit: [[0.50, 0.55, 0.64], [0.42, 0.30, 0.32], [0.030, 0.050, 0.115]],
  cumShade: [[0.14, 0.16, 0.24], [0.09, 0.08, 0.14], [0.006, 0.010, 0.028]],
  volRim: [[0.30, 0.45, 0.85], [0.55, 0.35, 0.45], [0.12, 0.30, 0.95]],
  stormGlow: [[0.18, 0.26, 0.36], [0.16, 0.11, 0.20], [0.020, 0.075, 0.230]],
  wDeep: [[0.003, 0.022, 0.060], [0.003, 0.014, 0.040], [0.0008, 0.0060, 0.020]],
  wMid: [[0.008, 0.050, 0.105], [0.006, 0.034, 0.080], [0.0026, 0.018, 0.052]],
  wTurq: [[0.025, 0.17, 0.21], [0.03, 0.14, 0.19], [0.009, 0.080, 0.120]],
});
const MOON_COLOUR = Object.freeze([1.0, 0.62, 0.30]);
const SUN_BASE = new THREE.Vector3(-0.45, 0.74, 0.50).normalize();
const SUN_ELEV0 = Math.asin(SUN_BASE.y);
const SUN_AZ = Math.hypot(SUN_BASE.x, SUN_BASE.z);
const MOON_AZ = new THREE.Vector2(-0.52, -0.80).normalize();

// Lightning schedule (seeded): a flash every 6-14 s; each is a double or triple stroke.
const flashStarts = [];
function flashStart(i) {
  while (flashStarts.length <= i) {
    const n = flashStarts.length;
    flashStarts.push(n === 0 ? 3.5 + 3 * hash1(0, 41) : flashStarts[n - 1] + 6 + 8 * hash1(n - 1, 43));
  }
  return flashStarts[i];
}
const flashEnv = (x) => (x <= 0 ? 0 : (1 - Math.exp(-x / 0.012)) * Math.exp(-x / 0.085) / 0.72);
/** Instantaneous lightning intensity 0..1 at absolute time t; `dir` receives the flash azimuth. */
function lightningAt(t, dir) {
  let i = Math.max(0, Math.floor((t - 3.5) / 14) - 1);
  while (flashStart(i + 1) <= t) i++;
  const a = TAU * hash1(i, 47), e = 0.22 + 0.30 * hash1(i, 48);
  dir.set(Math.cos(a) * 0.85, e, Math.sin(a) * 0.85).normalize();
  const tau = t - flashStart(i);
  if (tau < 0 || tau > 1.6) return 0;
  const gap = 0.13 + 0.10 * hash1(i, 44), gap2 = gap + 0.20 + 0.12 * hash1(i, 45);
  const flicker = 0.88 + 0.12 * Math.sin(tau * 95);
  const third = hash1(i, 46) < 0.5 ? 0.38 : 0;
  return Math.min(1, Math.max(0.82 * flashEnv(tau), flashEnv(tau - gap), third * flashEnv(tau - gap2)) * flicker);
}


/**
 * Add the native Sunny plus its owned ocean/sky to an existing Three Scene.
 * GLTFLoader already maps native Z-up/-Y-bow to world Y-up/+Z-bow: do not rotate
 * the loaded ship. Suggested viewer setup: far=3000, no fog, HemisphereLight
 * (#d5efff,#789573,2) and DirectionalLight(#fff4dc,3) at [25,45,20]. Deck camera
 * [10,7,18] -> [0,2,0]; exterior [46,24,53] -> [0,12,0]. Lights/camera remain
 * caller-owned. Does not modify Scene.background/environment/fog or start a RAF.
 *
 * The ship is `entity`, a child of `deck`. `deck` is the rocking pivot group: it
 * has an identity transform until the first update(); afterwards its quaternion
 * and position rotate the hull about (0,-3,0) so deck-local coordinates equal
 * rest-pose world coordinates. Attach anything that must ride the ship to `deck`.
 *
 * `setAtmosphere({ night, rain, lightning })` (each 0..1) drives sunset, the
 * Halloween night, rain and lightning; the read-only `atmosphere` object exposes
 * what the caller needs to light its own characters.
 */
export async function loadSunnyEnvironment(scene, loader) {
  // Await before allocating owned GPU resources; a failed asset load leaves the
  // caller's scene unchanged rather than inserting an incomplete environment.
  const gltf = await loader.loadAsync(SHIP_URL);
  const entity = gltf.scene;
  entity.name = 'Thousand Sunny native exterior';
  entity.traverse(object => {
    if (object.isMesh) { object.castShadow = true; object.receiveShadow = true; }
  });
  const deck = new THREE.Group();
  deck.name = 'Sunny rocking deck pivot';
  deck.add(entity);
  deck.updateMatrixWorld(true);
  const hull = hullField(entity);
  const outline = hullOutline(hull);
  const S = buildFieldStatic(hull);
  const detail = detailTexture();
  const cloudTex = cloudNoiseTexture();
  const foam = foamTexture();
  // Wave-front fields: 3 event layers x (incident, reflected), half-float RGBA per cell.
  const layerSize = FIELD.nx * FIELD.nz * 4;
  const fieldData = new Uint16Array(layerSize * FIELD_LAYERS * 2);
  const field = new THREE.DataArrayTexture(fieldData, FIELD.nx, FIELD.nz, FIELD_LAYERS * 2);
  field.name = 'Wave-front arrival fields (incident + reflected, 3 events)';
  field.format = THREE.RGBAFormat;
  field.type = THREE.HalfFloatType;
  field.minFilter = field.magFilter = THREE.LinearFilter;
  field.wrapS = field.wrapT = THREE.ClampToEdgeWrapping;
  field.generateMipmaps = false;
  field.needsUpdate = true;
  // Rim table: rows 0-2 per-event contact data, 3-5 inverse CDF, 6 static geometry.
  const rimData = new Float32Array(RIM_COUNT * 7 * 4);
  rimData.set(outline.rim, RIM_COUNT * 6 * 4);
  const rim = new THREE.DataTexture(rimData, RIM_COUNT, 7, THREE.RGBAFormat, THREE.FloatType);
  rim.name = 'Hull rim contact table';
  rim.minFilter = rim.magFilter = THREE.NearestFilter;
  rim.generateMipmaps = false;
  rim.needsUpdate = true;

  const shared = makeSharedUniforms({ hull: hull.texture, field, rim, cloud: cloudTex }, hull);
  const world = new THREE.Group();
  world.name = 'Sunny owned sea and sky environment';
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1400, 48, 24), skyMaterial(shared));
  sky.name = 'Day, dusk and night sky';
  sky.renderOrder = 100;
  sky.frustumCulled = false;
  const ocean = oceanGeometry(OCEAN_SEGMENTS);
  const water = new THREE.Mesh(ocean.geometry, oceanMaterial(shared, { detail, foam }));
  water.name = 'Gerstner open sea around native Z minus five';
  water.frustumCulled = false;
  const spray = sprayObject(shared);
  const sheet = hullFoamSheet(shared, outline, { foam });
  world.add(sky, water, spray.points);
  deck.add(sheet.mesh);
  scene.add(world, deck);
  let destroyed = false;
  let seconds = 0;
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const skeletons = new Set();
  // Include alternate glTF scenes as their geometries/images can share resources.
  for (const root of gltf.scenes ?? [entity]) {
    collectResources(root, geometries, materials, textures, skeletons);
  }
  collectResources(world, geometries, materials, textures, skeletons);
  collectResources(sheet.mesh, geometries, materials, textures, skeletons);
  textures.add(field); textures.add(rim); textures.add(foam); textures.add(detail);

  const U = shared;
  const motionState = { roll: 0, pitch: 0, heave: 0, waveEvent: null, voyage: { x: 0, z: 0, distance: 0, speed: CRUISE_SPEED } };
  const euler = new THREE.Euler();
  const pivot = new THREE.Vector3(PIVOT.x, PIVOT.y, PIVOT.z);
  const rotatedPivot = new THREE.Vector3();
  const slotEvent = makeEvent();
  const sprayEvent = makeEvent();
  const prefetchEvent = makeEvent();
  // Detail drift: [metres/s along the wave direction, tile metres] per layer.
  const drift = [[0.35, 17], [0.6, 5.3], [0.9, 1.9], [0.8, 46], [0.5, 17]];
  let sprayAge = -1;
  let activeSlots = 0;
  let lastFieldMs = 0;
  let prefetch = null;
  const layerOwner = new Int32Array(FIELD_LAYERS).fill(-1);
  const rowCache = new Map();

  // Extract the actual waterline endpoints for bow pressure and the aft trail.
  {
    let bow = -Infinity, stern = Infinity, beam = 0;
    for (let k = 0; k < RIM_COUNT; k++) {
      const x = outline.rim[k * 4], z = outline.rim[k * 4 + 1];
      bow = Math.max(bow, z); stern = Math.min(stern, z); beam = Math.max(beam, Math.abs(x));
    }
    U.uHullEnds.value.set(bow, stern, beam, 0.35);
  }

  /** Make the GPU tables hold event `e`; returns its layer. */
  function bindEvent(e) {
    const layer = e.index % FIELD_LAYERS;
    if (layerOwner[layer] !== e.index) {
      const started = typeof performance !== 'undefined' ? performance.now() : 0;
      const cached = fieldCache.has(e.index);
      const f = eventField(e, S);
      if (!cached && started) lastFieldMs = performance.now() - started;
      fieldData.set(f.inc, layer * 2 * layerSize);
      fieldData.set(f.ref, (layer * 2 + 1) * layerSize);
      let rows = rowCache.get(e.index);
      if (!rows) {
        rows = computeRimRows(e, f, outline);
        rowCache.set(e.index, rows);
        if (rowCache.size > 12) rowCache.delete(rowCache.keys().next().value);
      }
      rimData.set(rows.props, layer * RIM_COUNT * 4);
      rimData.set(rows.cdf, (3 + layer) * RIM_COUNT * 4);
      field.needsUpdate = true;
      rim.needsUpdate = true;
      layerOwner[layer] = e.index;
    }
    return layer;
  }

  // ---- atmosphere ---------------------------------------------------------------------------
  const state = { night: 0, rain: 0, lightning: 0, flash: 0, sunLit: 1, moonLit: 0 };
  const sunDirection = U.uSunDir.value, moonDirection = U.uMoonDir.value;
  const horizon = new THREE.Color(), ambient = new THREE.Color();
  const tmpDry = [0, 0, 0], tmpWet = [0, 0, 0];
  let wDay = 1, wTwi = 0, wNight = 0;
  const phase = (out, table) => {
    out[0] = table[0][0] * wDay + table[1][0] * wTwi + table[2][0] * wNight;
    out[1] = table[0][1] * wDay + table[1][1] * wTwi + table[2][1] * wNight;
    out[2] = table[0][2] * wDay + table[1][2] * wTwi + table[2][2] * wNight;
    return out;
  };
  const blend = (target, key, wetMix, scale = 1) => {
    phase(tmpDry, PAL[key]);
    if (wetMix > 0 && WET[key]) {
      phase(tmpWet, WET[key]);
      target.set((tmpDry[0] + (tmpWet[0] - tmpDry[0]) * wetMix) * scale, (tmpDry[1] + (tmpWet[1] - tmpDry[1]) * wetMix) * scale,
        (tmpDry[2] + (tmpWet[2] - tmpDry[2]) * wetMix) * scale);
    } else target.set(tmpDry[0] * scale, tmpDry[1] * scale, tmpDry[2] * scale);
  };
  const flashDir = U.uFlashDir.value;
  function applyAtmosphere() {
    const n = clamp01(state.night), rn = clamp01(state.rain);
    const sunElev = SUN_ELEV0 - 66 * DEG * smooth01(0, 0.85, n);
    const sinE = Math.sin(sunElev), cosE = Math.cos(sunElev);
    sunDirection.set(SUN_BASE.x / SUN_AZ * cosE, sinE, SUN_BASE.z / SUN_AZ * cosE);
    const moonElev = (-8 + 28 * smooth01(0.30, 1.0, n)) * DEG;
    moonDirection.set(MOON_AZ.x * Math.cos(moonElev), Math.sin(moonElev), MOON_AZ.y * Math.cos(moonElev));
    wDay = smooth01(0.02, 0.38, sinE);
    wNight = 1 - smooth01(-0.30, -0.06, sinE);
    wTwi = smooth01(-0.30, -0.03, sinE) * (1 - smooth01(0.03, 0.38, sinE));
    const sum = wDay + wTwi + wNight;
    wDay /= sum; wTwi /= sum; wNight /= sum;
    const wet = rn * 0.9;
    blend(U.uHorizonCol.value, 'horizon', wet);
    blend(U.uZenithCol.value, 'zenith', wet);
    blend(U.uCloudLit.value, 'cloudLit', wet);
    blend(U.uCloudShade.value, 'cloudShade', wet);
    blend(U.uCumLit.value, 'cumLit', wet);
    blend(U.uCumShade.value, 'cumShade', wet);
    blend(U.uVolRim.value, 'volRim', wet);
    blend(U.uStormGlow.value, 'stormGlow', wet);
    {
      // Cloud slab: fair-weather cumulus -> low, dense, towering storm deck.
      const stormK = smooth01(0.05, 0.85, rn);
      U.uCloudA.value.set(700 - 160 * stormK, 3300 + 1700 * stormK, 0.50 + 0.13 * stormK + 0.06 * wTwi, 0.60 + 0.4 * stormK);
      U.uCloudB.value.set(0.004 + 0.012 * stormK, 0.5, 0, 0);
    }
    blend(U.uWDeep.value, 'wDeep', wet);
    blend(U.uWMid.value, 'wMid', wet);
    blend(U.uWTurq.value, 'wTurq', wet);
    blend(U.uFoamAmb.value, 'foamAmb', 0);
    blend(U.uFoamKey.value, 'foamKey', 0);
    blend(U.uSprayCol.value, 'spray', 0);
    U.uTwiWarm.value.set(0.95, 0.30, 0.05).multiplyScalar(1 - 0.75 * rn);
    U.uTwiCool.value.set(0.34, 0.09, 0.26).multiplyScalar(1 - 0.75 * rn);
    U.uMoonCol.value.set(MOON_COLOUR[0], MOON_COLOUR[1], MOON_COLOUR[2]);
    const sunLit = smooth01(-0.02, 0.15, sinE) * (1 - 0.6 * rn);
    const moonUp = smooth01(-0.02, 0.22, moonDirection.y);
    state.sunLit = sunLit;
    state.moonLit = moonUp * (1 - 0.5 * rn);
    const moonLit = 0.38 * state.moonLit;
    const moonKey = (1 - smooth01(-0.12, 0.08, sinE)) * moonUp;
    const key = U.uKey.value;
    key.set(0, 0, 0, 0);
    const kx = sunDirection.x * (1 - moonKey) + moonDirection.x * moonKey;
    const ky = sunDirection.y * (1 - moonKey) + moonDirection.y * moonKey;
    const kz = sunDirection.z * (1 - moonKey) + moonDirection.z * moonKey;
    const kl = Math.hypot(kx, ky, kz) || 1;
    key.set(kx / kl, ky / kl, kz / kl, sunLit * (1 - moonKey) + moonLit * moonKey);
    U.uCumLight.value.set(key.x, key.y, key.z);
    U.uSkyMix.value.set(wTwi, wNight, moonUp * (1 - wDay) * (1 - 0.8 * rn), smooth01(-0.05, 0.12, sinE) * (1 - 0.9 * rn));
    U.uSpecAmt.value.set(smooth01(-0.02, 0.15, sinE) * (1 - 0.9 * rn), moonUp * (1 - wDay) * (1 - 0.7 * rn));
    U.uFogRange.value.set(500 - 430 * rn, 1800 - 1100 * rn);
    U.uHullFoam.value = 1 - 0.45 * wNight;
    U.uNight.value = n; U.uRain.value = rn; U.uFlash.value = state.flash;
    horizon.setRGB(U.uHorizonCol.value.x, U.uHorizonCol.value.y, U.uHorizonCol.value.z);
    const lift = 1 + 3 * state.flash;
    ambient.setRGB((U.uHorizonCol.value.x + U.uZenithCol.value.x) * 0.5 * lift, (U.uHorizonCol.value.y + U.uZenithCol.value.y) * 0.5 * lift,
      (U.uHorizonCol.value.z + U.uZenithCol.value.z) * 0.5 * lift);
  }
  function applyLightning() {
    const gate = smooth01(0.4, 0.6, clamp01(state.rain)) * clamp01(state.lightning);
    state.flash = gate * lightningAt(seconds, flashDir);
    U.uFlash.value = state.flash;
    U.uBolt.value = gate;
  }
  const atmosphere = {};
  Object.defineProperties(atmosphere, {
    night: { get: () => clamp01(state.night), enumerable: true },
    rain: { get: () => clamp01(state.rain), enumerable: true },
    flash: { get: () => state.flash, enumerable: true },
    moonPhase: { get: () => U.uMoonPhase.value, enumerable: true },
    sunDirection: { value: sunDirection, enumerable: true },
    moonDirection: { value: moonDirection, enumerable: true },
    horizon: { value: horizon, enumerable: true },
    ambient: { value: ambient, enumerable: true },
    sunIntensity: { get: () => state.sunLit, enumerable: true },
    moonIntensity: { get: () => state.moonLit, enumerable: true },
  });
  Object.freeze(atmosphere);
  function setAtmosphere(options) {
    if (destroyed || !options) return atmosphere;
    if (Number.isFinite(options.night)) state.night = clamp01(options.night);
    if (Number.isFinite(options.rain)) state.rain = clamp01(options.rain);
    if (Number.isFinite(options.lightning)) state.lightning = clamp01(options.lightning);
    applyLightning();
    applyAtmosphere();
    applyChop();
    return atmosphere;
  }
  // Rain roughens the sea: the short chop components grow, the ship-driving swell does not.
  function applyChop() {
    const rn = clamp01(state.rain);
    for (let i = 0; i < GERSTNER_COUNT; i++) {
      const w = WAVES[i];
      U.uWA.value[i].w = w.A * (w.lambda < 30 ? 1 + 0.7 * rn : 1);
    }
  }

  function applyWater(t) {
    for (let i = 0; i < GERSTNER_COUNT; i++) {
      U.uWB.value[i].y = wrapTau(WAVES[i].phase0 - WAVES[i].omega * t);
    }
    const scroll = water.material.uniforms.uScroll.value;
    const rate = (index) => drift[index][0] / drift[index][1];
    scroll[0].set(fractPhase(rate(0) * t), fractPhase(rate(0) * t * 0.37), fractPhase(-rate(1) * t * 0.5), fractPhase(rate(1) * t));
    scroll[1].set(fractPhase(rate(2) * t * 0.8), fractPhase(-rate(2) * t * 0.6), fractPhase(-rate(3) * t), fractPhase(rate(3) * t * 0.02));
    scroll[2].set(fractPhase(-rate(4) * t), fractPhase(rate(4) * t * 0.05), 0, 0);
    U.seconds.value = t;
    // Big crests: any event whose travelling pulse is currently on the sea.
    let slot = 0;
    const first = firstEventAtOrAfter(t - 12);
    for (let index = first; slot < 3 && eventTime(index) <= t + 12.5; index++) {
      const e = fillEvent(index, slotEvent);
      const age = t - e.time;
      const crest = BIG_SPEED * age - e.wall;
      const envelope = smooth01(-140, -90, crest) * (1 - smooth01(60, 100, crest));
      if (envelope <= 0.002) continue;
      const layer = bindEvent(e);
      U.uBigA.value[slot].set(e.dx, e.dz, e.lateral, e.amplitude * 1.3 * envelope);
      U.uBigB.value[slot].set(crest, e.length, e.width, smooth01(-55, -6, crest));
      // Run-up swells once the crest reaches the hull (contact lags the nominal time).
      const contact = age - CONTACT_LAG;
      const runup = e.strength * 1.35 * Math.exp(-(((contact - 0.15) / 0.9) ** 2));
      U.uBigC.value[slot].set(runup, 0, age, e.strength);
      U.uBigD.value[slot].set(layer, 1, 0, 0);
      slot++;
    }
    activeSlots = slot;
    for (let i = slot; i < 3; i++) {
      U.uBigA.value[i].set(1, 0, 0, 0); U.uBigB.value[i].set(0, 5, 20, 0); U.uBigC.value[i].set(0, 0, 0, 0); U.uBigD.value[i].set(0, 0, 0, 0);
    }
    // Spray: the single event whose burst window contains `t`.
    sprayAge = -1;
    const lo = firstEventAtOrAfter(t - 7.6);
    if (eventTime(lo) <= t + 0.3) {
      const e = fillEvent(lo, sprayEvent);
      sprayAge = t - e.time;
      spray.points.material.uniforms.uLayer.value = bindEvent(e);
      spray.points.material.uniforms.uEvA.value.set(e.dx, e.dz, e.lateral, e.strength);
      spray.points.material.uniforms.uEvB.value.x = sprayAge;
    }
    spray.points.material.uniforms.uEvB.value.y = sprayAge > -0.3 ? 1 : 0;
    spray.points.visible = sprayAge > -0.3;
    // Solve the next events' fields one stage per update, so no single frame pays for a whole solve.
    if (prefetch && fieldCache.has(prefetch.index)) prefetch = null;
    if (!prefetch) {
      for (let index = firstEventAtOrAfter(t), n = 0; n < 3; index++, n++) {
        if (eventTime(index) > t + 45) break;
        if (!fieldCache.has(index)) { prefetch = { index, steps: computeEventFieldSteps(fillEvent(index, prefetchEvent), S) }; break; }
      }
    }
    if (prefetch) {
      const r = prefetch.steps.next();
      if (r.done) { storeField(prefetch.index, r.value); prefetch = null; }
    }
  }
  U.uShipInv.value.identity();
  applyAtmosphere();
  applyChop();
  applyWater(0);
  // Construction contract: identity deck and no motion until the first update().
  U.uHeave.value = 0;

  const api = {
    entity,
    deck,
    voyage: motionState.voyage,
    get motion() {
      return { roll: motionState.roll, pitch: motionState.pitch, heave: motionState.heave,
        voyage: { ...motionState.voyage }, waveEvent: motionState.waveEvent ? { ...motionState.waveEvent } : null };
    },
    atmosphere,
    setAtmosphere,
    update(absoluteSeconds, dt = 0) {
      if (destroyed) return;
      seconds = Number.isFinite(absoluteSeconds) ? absoluteSeconds : 0;
      shipMotionAt(seconds, motionState);
      euler.set(motionState.pitch, 0, motionState.roll, 'XYZ');
      deck.quaternion.setFromEuler(euler);
      // Rotate about the pivot (0,-3,0): deck-local coordinates stay rest-pose world coordinates.
      rotatedPivot.copy(pivot).applyQuaternion(deck.quaternion);
      deck.position.copy(pivot).sub(rotatedPivot);
      deck.position.y += motionState.heave;
      deck.position.x += motionState.voyage.x; deck.position.z += motionState.voyage.z;
      U.uVoyage.value.set(motionState.voyage.x, motionState.voyage.z, CRUISE_SPEED, motionState.voyage.distance);
      // Only this pivot is needed by the water uniforms. The renderer updates
      // ship descendants once, after both characters have sampled their poses.
      deck.updateWorldMatrix(true, false);
      U.uShipInv.value.copy(deck.matrixWorld).invert();
      U.uHeave.value = motionState.heave;
      applyLightning();
      applyAtmosphere();
      applyWater(seconds);
      // Absolute, not accumulated: seek 12 -> 2 produces exactly the t=2 state.
      sky.material.uniforms.seconds.value = seconds;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      deck.removeFromParent();
      world.removeFromParent();
      for (const skeleton of skeletons) skeleton.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      const images = new Set();
      for (const texture of textures) {
        texture.dispose();
        if (Array.isArray(texture.image)) {
          for (const image of texture.image) images.add(image);
        } else if (texture.image) images.add(texture.image);
      }
      for (const image of images) image.close?.();
      geometries.clear();
      materials.clear();
      textures.clear();
      skeletons.clear();
      world.clear();
    },
    snapshot() {
      let liveSpray = 0;
      if (sprayAge > -0.3) {
        const timing = spray.timing;
        for (let i = 0; i < SPRAY_COUNT; i++) {
          const tau = sprayAge - timing[i * 4];
          if (tau >= 0 && tau <= timing[i * 4 + 1]) liveSpray++;
        }
      }
      return {
        asset: SHIP_URL,
        deckHeight: 0,
        seaHeight: SEA_Y,
        nativeUp: '+Z',
        nativeBow: '-Y',
        worldUp: '+Y',
        worldBow: '+Z',
        seconds,
        time: seconds,
        destroyed,
        shipRocking: true,
        clouds: { technique: 'raymarched-cumulus', steps: 24, noiseResolution: CLOUD_TEX },
        features: [...FEATURES],
        wave: {
          gerstnerCount: GERSTNER_COUNT,
          bigWaves: bigWaveSchedule(seconds, 3).map(({ time, side, strength }) => ({ time, side, strength })),
          active: activeSlots,
          fieldCells: FIELD.nx * FIELD.nz,
          fieldSolveMs: lastFieldMs,
        },
        ship: { roll: motionState.roll, pitch: motionState.pitch, heave: motionState.heave, voyage: { ...motionState.voyage } },
        spray: { particles: SPRAY_COUNT, active: liveSpray },
        atmosphere: {
          night: atmosphere.night, rain: atmosphere.rain, lightning: clamp01(state.lightning), flash: state.flash,
          moonPhase: atmosphere.moonPhase,
          sunElevationDeg: Math.asin(sunDirection.y) / DEG, moonElevationDeg: Math.asin(moonDirection.y) / DEG,
          twilight: wTwi, nightWeight: wNight,
        },
        ocean: { vertices: ocean.vertices, rings: ocean.rings, hullSegments: hull.segments, hullFallback: hull.fallback },
      };
    },
  };
  return api;
}
