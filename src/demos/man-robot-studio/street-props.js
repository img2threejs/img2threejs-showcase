// Street dressing for the Vietnamese-inspired street film: sidewalk trees, parked compact cars,
// scooters / bicycles and small street furniture. Original procedural geometry, seeded, no assets.
// World contract: Y up, metres, street along Z, asphalt y=0, sidewalks top y=.14, road x=[-4,4].
// Only the tree crowns move (restrained crown-lobe sway); every driver is a pure function of absolute time t.
export function createStreetProps(THREE, scene) {
  const TAU = Math.PI * 2;
  const SIDEWALK = 0.14;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
  function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = makeRng(90210);
  const hex = (h) => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; };
  const jit = (c, rnd, amt = .12) => { const k = 1 + (rnd() - .5) * 2 * amt; return [c[0] * k, c[1] * k, c[2] * k]; };

  const root = new THREE.Group();
  root.name = 'StreetProps';
  scene.add(root);
  const stats = { triangles: 0, drawCalls: 0, trees: 0, cars: 0, scooters: 0, bicycles: 0 };

  // ---------------------------------------------------------------- scratch + matrix helpers
  const _v = new THREE.Vector3();
  const _nm = new THREE.Matrix3();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _d = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const WHITE = [1, 1, 1];
  const ZERO2 = [0, 0];

  function mat(px, py, pz, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    return new THREE.Matrix4().compose(_p.set(px, py, pz), _q, _s.set(sx, sy, sz));
  }
  const mul = (a, b) => new THREE.Matrix4().multiplyMatrices(a, b);

  // ---------------------------------------------------------------- geometry batch (merged, vertex coloured)
  class Batch {
    constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; }
    vert(x, y, z, nx, ny, nz, u, v, c) {
      this.pos.push(x, y, z); this.nor.push(nx, ny, nz); this.uv.push(u, v); this.col.push(c[0], c[1], c[2]);
    }
    tri(a, b, c, color, ua = ZERO2, ub = ZERO2, uc = ZERO2) {
      const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
      const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-12) return;
      nx /= l; ny /= l; nz /= l;
      this.vert(a[0], a[1], a[2], nx, ny, nz, ua[0], ua[1], color);
      this.vert(b[0], b[1], b[2], nx, ny, nz, ub[0], ub[1], color);
      this.vert(c[0], c[1], c[2], nx, ny, nz, uc[0], uc[1], color);
    }
    triN(a, b, c, n, ca, cb, cc) {
      this.vert(a[0], a[1], a[2], n[0], n[1], n[2], 0, 0, ca);
      this.vert(b[0], b[1], b[2], n[0], n[1], n[2], 0, 0, cb);
      this.vert(c[0], c[1], c[2], n[0], n[1], n[2], 0, 0, cc);
    }
    addGeometry(geo, matrix, color) {
      const g = geo.index ? geo.toNonIndexed() : geo;
      const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, col = g.attributes.color;
      const nm = matrix ? _nm.getNormalMatrix(matrix) : null;
      const c = color || WHITE;
      for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos, i);
        if (matrix) _v.applyMatrix4(matrix);
        this.pos.push(_v.x, _v.y, _v.z);
        _v.fromBufferAttribute(nor, i);
        if (nm) _v.applyMatrix3(nm).normalize();
        this.nor.push(_v.x, _v.y, _v.z);
        this.uv.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
        if (col) this.col.push(col.getX(i) * c[0], col.getY(i) * c[1], col.getZ(i) * c[2]);
        else this.col.push(c[0], c[1], c[2]);
      }
    }
    // rows: array of equal-length arrays of [x,y,z]; two triangles per cell, flat normals from winding
    addPatch(rows, color, matrix, uvRows) {
      const P = rows.map((row) => row.map((p) => {
        _v.set(p[0], p[1], p[2]);
        if (matrix) _v.applyMatrix4(matrix);
        return [_v.x, _v.y, _v.z];
      }));
      for (let r = 0; r < P.length - 1; r++) {
        for (let c = 0; c < P[r].length - 1; c++) {
          const u00 = uvRows ? uvRows[r][c] : ZERO2, u01 = uvRows ? uvRows[r][c + 1] : ZERO2;
          const u10 = uvRows ? uvRows[r + 1][c] : ZERO2, u11 = uvRows ? uvRows[r + 1][c + 1] : ZERO2;
          this.tri(P[r][c], P[r][c + 1], P[r + 1][c + 1], color, u00, u01, u11);
          this.tri(P[r][c], P[r + 1][c + 1], P[r + 1][c], color, u00, u11, u10);
        }
      }
    }
    build() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
      return g;
    }
  }

  function emit(batch, material, name, parent, cast = true, receive = true) {
    if (!batch.pos.length) return null;
    const mesh = new THREE.Mesh(batch.build(), material);
    mesh.name = name; mesh.castShadow = cast; mesh.receiveShadow = receive;
    parent.add(mesh);
    stats.triangles += batch.pos.length / 9; stats.drawCalls++;
    return mesh;
  }
  function emitInstanced(geo, material, name, parent, items, cast = true, receive = true) {
    if (!items.length) return null;
    const mesh = new THREE.InstancedMesh(geo, material, items.length);
    items.forEach((it, i) => { mesh.setMatrixAt(i, it.m); mesh.setColorAt(i, it.c); });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = name; mesh.castShadow = cast; mesh.receiveShadow = receive;
    mesh.computeBoundingSphere();
    parent.add(mesh);
    stats.triangles += (geo.index ? geo.index.count : geo.attributes.position.count) / 3 * items.length;
    stats.drawCalls++;
    return mesh;
  }

  // ---------------------------------------------------------------- primitive adders
  const UB = new THREE.BoxGeometry(1, 1, 1);
  const US = new THREE.SphereGeometry(1, 12, 8);
  const cylCache = new Map();
  function cylGeo(rT, rB, seg) {
    const key = rT.toFixed(4) + '_' + rB.toFixed(4) + '_' + seg;
    let g = cylCache.get(key);
    if (!g) { g = new THREE.CylinderGeometry(rT, rB, 1, seg, 1); cylCache.set(key, g); }
    return g;
  }
  function box(b, M, cx, cy, cz, sx, sy, sz, color, rx = 0, ry = 0, rz = 0) {
    const m = mat(cx, cy, cz, rx, ry, rz, sx, sy, sz);
    b.addGeometry(UB, M ? mul(M, m) : m, color);
  }
  function ell(b, M, cx, cy, cz, sx, sy, sz, color, rx = 0, ry = 0, rz = 0) {
    const m = mat(cx, cy, cz, rx, ry, rz, sx, sy, sz);
    b.addGeometry(US, M ? mul(M, m) : m, color);
  }
  // vertical cylinder (axis Y), height h centred on cy
  function cyl(b, M, cx, cy, cz, rT, rB, h, seg, color, rx = 0, ry = 0, rz = 0) {
    const m = mat(cx, cy, cz, rx, ry, rz, 1, h, 1);
    b.addGeometry(cylGeo(rT, rB, seg), M ? mul(M, m) : m, color);
  }
  // rod from a to c; radius r1 at a, r2 at c
  function rod(b, M, a, c, r1, color, seg = 6, r2 = r1) {
    _d.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    const len = _d.length();
    if (len < 1e-6) return;
    _d.multiplyScalar(1 / len);
    _q.setFromUnitVectors(_up, _d);
    const m = new THREE.Matrix4().compose(_p.set((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2), _q, _s.set(1, len, 1));
    b.addGeometry(cylGeo(r2, r1, seg), M ? mul(M, m) : m, color);
  }

  // tapered tube along a polyline (parallel-transport frames), with bark uvs and per-ring tone jitter
  function addTube(b, pts, radii, radial, color, vTile = 1.2, rnd = null, off = [0, 0, 0], uRep = 1) {
    const n = pts.length;
    const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), prevN = new THREE.Vector3();
    const rings = [];
    let len = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], c = pts[Math.min(n - 1, i + 1)];
      T.subVectors(c, a).normalize();
      if (i === 0) {
        N.set(0, 0, 1);
        if (Math.abs(T.z) > .9) N.set(1, 0, 0);
        N.addScaledVector(T, -N.dot(T)).normalize();
      } else {
        N.copy(prevN).addScaledVector(T, -prevN.dot(T));
        if (N.lengthSq() < 1e-8) N.set(1, 0, 0).addScaledVector(T, -T.x);
        N.normalize();
      }
      prevN.copy(N);
      B.crossVectors(T, N);
      if (i > 0) len += pts[i].distanceTo(pts[i - 1]);
      const k = rnd ? .84 + rnd() * .3 : 1;
      const col = [color[0] * k, color[1] * k, color[2] * k];
      const ring = [];
      for (let j = 0; j <= radial; j++) {
        const th = j / radial * TAU, cs = Math.cos(th), sn = Math.sin(th);
        const nx = N.x * cs + B.x * sn, ny = N.y * cs + B.y * sn, nz = N.z * cs + B.z * sn;
        ring.push([pts[i].x + off[0] + nx * radii[i], pts[i].y + off[1] + ny * radii[i], pts[i].z + off[2] + nz * radii[i], nx, ny, nz, j / radial * uRep, len / vTile, col]);
      }
      rings.push(ring);
    }
    const put = (r) => b.vert(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]);
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < radial; j++) {
        const a = rings[i][j], bb = rings[i][j + 1], c = rings[i + 1][j + 1], d = rings[i + 1][j];
        put(a); put(bb); put(c);
        put(a); put(c); put(d);
      }
    }
  }

  // ---------------------------------------------------------------- canvas textures (all generated in code)
  function canvasTex(w, h, draw, repeat = true) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  }
  const texRng = makeRng(777);
  const barkTex = canvasTex(256, 512, (g, w, h) => {
    g.fillStyle = '#8c7e6c'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) {
      const x = texRng() * w, y = texRng() * h, r = 10 + texRng() * 40;
      g.fillStyle = texRng() < .5 ? 'rgba(96,104,84,.10)' : 'rgba(176,160,132,.10)';
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
    for (let i = 0; i < 260; i++) {
      const x0 = texRng() * w, dark = texRng() < .66;
      g.strokeStyle = dark ? `rgba(36,28,21,${(.12 + texRng() * .3).toFixed(3)})` : `rgba(198,182,156,${(.05 + texRng() * .13).toFixed(3)})`;
      g.lineWidth = 1 + texRng() * 3;
      const path = [];
      let x = x0;
      for (let y = 0; y <= h; y += 32) { x += (texRng() - .5) * 7; path.push([x, y]); }
      for (const off of [-w, 0, w]) {
        g.beginPath();
        path.forEach(([px, py], k) => { if (k) g.lineTo(px + off, py); else g.moveTo(px + off, py); });
        g.stroke();
      }
    }
    for (let i = 0; i < 90; i++) { g.fillStyle = 'rgba(30,22,16,.25)'; g.fillRect(texRng() * w, texRng() * h, 6 + texRng() * 18, 1 + texRng() * 1.5); }
  });
  const woodTex = canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = '#9b7b55'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      const y = texRng() * h;
      g.strokeStyle = texRng() < .6 ? `rgba(60,38,20,${(.08 + texRng() * .16).toFixed(3)})` : `rgba(206,176,134,${(.06 + texRng() * .1).toFixed(3)})`;
      g.lineWidth = .6 + texRng() * 1.8;
      g.beginPath(); g.moveTo(0, y);
      g.bezierCurveTo(w * .3, y + (texRng() - .5) * 5, w * .65, y + (texRng() - .5) * 5, w, y + (texRng() - .5) * 3);
      g.stroke();
    }
  });
  const gritTex = canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#cbc8bf'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 1100; i++) {
      const v = texRng() < .5 ? 0 : 255;
      g.fillStyle = `rgba(${v},${v},${v},${(.03 + texRng() * .08).toFixed(3)})`;
      g.fillRect(texRng() * w, texRng() * h, 1 + texRng() * 2.5, 1 + texRng() * 2.5);
    }
  });
  const PLATE_TEXT = ['51F 123.45', '30A-678.90', '29A 345.67', '51H 889.12', '60A-334.56', '51K 072.31'];
  const plateTex = canvasTex(256, 252, (g, w, h) => {
    const rh = h / 6;
    PLATE_TEXT.forEach((txt, i) => {
      g.fillStyle = '#e6e3d8'; g.fillRect(0, i * rh, w, rh);
      g.strokeStyle = '#2a2a2a'; g.lineWidth = 3; g.strokeRect(2, i * rh + 2, w - 4, rh - 4);
      g.fillStyle = '#1c1c1c'; g.font = 'bold 26px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(txt, w / 2, i * rh + rh / 2 + 1);
    });
  }, false);

  // ---------------------------------------------------------------- materials
  const mats = {
    bark: new THREE.MeshStandardMaterial({ map: barkTex, vertexColors: true, roughness: .95, metalness: 0 }),
    leaf: new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: .74, metalness: 0 }),
    concrete: new THREE.MeshStandardMaterial({ map: gritTex, vertexColors: true, roughness: .95, metalness: 0 }),
    soil: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }),
    iron: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .55, metalness: .55 }),
    wood: new THREE.MeshStandardMaterial({ map: woodTex, vertexColors: true, roughness: .82, metalness: 0 }),
    plastic: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .55, metalness: 0 }),
    ceramic: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .5, metalness: 0 }),
    glass: new THREE.MeshStandardMaterial({ color: '#1b2226', roughness: .08, metalness: .75, side: THREE.DoubleSide }),
    trim: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .62, metalness: .1 }),
    chrome: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .22, metalness: .9 }),
    lampF: new THREE.MeshStandardMaterial({ color: '#d9dcd2', roughness: .12, metalness: .2, side: THREE.DoubleSide }),
    lampR: new THREE.MeshStandardMaterial({ color: '#8c1d1d', roughness: .2, metalness: .1, side: THREE.DoubleSide }),
    plate: new THREE.MeshStandardMaterial({ map: plateTex, roughness: .6, metalness: 0, side: THREE.DoubleSide }),
    tyre: new THREE.MeshStandardMaterial({ color: '#1d1d1f', roughness: .92, metalness: 0 }),
    rim: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .35, metalness: .8 }),
    rubber: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .9, metalness: 0 }),
    fruit: new THREE.MeshStandardMaterial({ roughness: .6, metalness: 0 }),
  };

  // ================================================================= TREES
  function makeLeafUnit() {
    const P = { b: [0, 0, 0], l: [-.25, .36, .02], r: [.25, .36, .02], c: [0, .42, .05], t: [0, 1, -.11] };
    const C = { b: .7, l: .92, r: .92, c: 1, t: 1.12 };
    const tris = [['b', 'r', 'c'], ['b', 'c', 'l'], ['c', 'r', 't'], ['c', 't', 'l']];
    const pos = [], col = [], uv = [];
    for (const tri of tris) for (const k of tri) { pos.push(P[k][0], P[k][1], P[k][2]); col.push(C[k], C[k], C[k]); uv.push(P[k][0] + .5, P[k][1]); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
  }
  const leafUnit = makeLeafUnit();
  // small spray of five thin ovate leaves fanned around +Z (the twig direction)
  const clusterGeo = (() => {
    const rnd = makeRng(4242), b = new Batch();
    const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), m = new THREE.Matrix4(), sv = new THREE.Vector3();
    const n = 5;
    for (let i = 0; i < n; i++) {
      const spread = .35 + .75 * i / (n - 1), az = rnd() * TAU + i * 2.1;
      Y.set(Math.sin(spread) * Math.cos(az), Math.sin(spread) * Math.sin(az), Math.cos(spread));
      X.set(rnd() - .5, rnd() - .5, rnd() - .5);
      X.addScaledVector(Y, -X.dot(Y));
      if (X.lengthSq() < 1e-4) X.set(1, 0, 0).addScaledVector(Y, -Y.x);
      X.normalize();
      Z.crossVectors(X, Y);
      m.makeBasis(X, Y, Z);
      const s = .2 + rnd() * .07;
      m.scale(sv.set(s, s, s));
      m.setPosition(Y.x * .03 + (rnd() - .5) * .04, Y.y * .03 + (rnd() - .5) * .04, .02 + i * .035);
      const br = .88 + rnd() * .24;
      b.addGeometry(leafUnit, m, [br, br, br]);
    }
    return b.build();
  })();

  const TREE_SPECS = [
    // right sidewalk (x>0)
    { x: 4.90, z: -39 }, { x: 4.85, z: -33 }, { x: 4.95, z: -15 }, { x: 4.88, z: -7.5 }, { x: 4.92, z: 7.5 },
    { x: 4.85, z: 34.5 }, { x: 4.90, z: 53 }, { x: 4.85, z: 58 }, { x: 4.95, z: 63 }, { x: 4.88, z: 91 },
    // Curb-side planting keeps trunks outside the shop awnings and leaves a shopfront walkway.
    { x: -4.88, z: -42 }, { x: -4.95, z: -24 }, { x: -4.85, z: -17 }, { x: -4.90, z: 5 }, { x: -4.85, z: 25.5 },
    { x: -4.92, z: 47 }, { x: -4.95, z: 74 }, { x: -4.85, z: 82 }, { x: -4.90, z: 101 },
  ];
  const KINDS = ['rain', 'oval', 'round', 'oval', 'round', 'rain', 'round'];
  const LEAF_PALETTE = ['#4f6d34', '#5b7b3b', '#678140', '#728846', '#476232', '#7d8d48', '#5a743a', '#3f5a2f'].map((h) => new THREE.Color(h));
  const LEAF_WARM = new THREE.Color('#a79b46');
  const BARK = [.74, .68, .6];
  const treesRoot = new THREE.Group(); treesRoot.name = 'StreetTrees'; root.add(treesRoot);
  const trunkB = new Batch(), pitB = new Batch(), soilB = new Batch();
  const lobes = [];
  const clusterM = new THREE.Matrix4(), cX = new THREE.Vector3(), cY = new THREE.Vector3(), cZ = new THREE.Vector3(), cS = new THREE.Vector3();

  function growPath(start, dir0, length, segs, curl, up, rr, clampFn) {
    const pts = [start.clone()];
    const raw = start.clone(), d = dir0.clone(), step = length / segs;
    for (let s = 1; s <= segs; s++) {
      d.x += (rr() - .5) * curl; d.y += (rr() - .5) * curl * .6 + up; d.z += (rr() - .5) * curl;
      d.normalize();
      raw.addScaledVector(d, step);
      const q = raw.clone(); clampFn(q); pts.push(q);
    }
    return pts;
  }
  const radiiFor = (n, r0, r1, pw = .9) => { const a = []; for (let i = 0; i < n; i++) a.push(lerp(r0, r1, Math.pow(i / (n - 1), pw))); return a; };

  function buildTree(ts, ti) {
    const rr = makeRng(1000 + ti * 77 + 13);
    const roadSign = ts.x > 0 ? -1 : 1;
    const kind = KINDS[Math.floor(rr() * KINDS.length)];
    const H = 2.7 + rr() * 1.3;
    const baseR = .165 + rr() * .085;
    const spread = kind === 'rain' ? 1.25 : kind === 'oval' ? .85 : 1;
    const el0 = kind === 'rain' ? .38 : kind === 'oval' ? .85 : .6;
    const el1 = kind === 'rain' ? .85 : kind === 'oval' ? 1.15 : 1.0;
    const upBias = kind === 'rain' ? .03 : .09;
    const density = .85 + rr() * .3;
    const leafBase = LEAF_PALETTE[Math.floor(rr() * LEAF_PALETTE.length)];
    const clampRoad = (p) => { const reach = p.x * roadSign; if (reach > 1.7) p.x = roadSign * (1.7 + (reach - 1.7) * .3); };
    const wx = ts.x, wy = SIDEWALK, wz = ts.z;
    const lean = [(rr() - .5) * .6 + roadSign * .12, (rr() - .5) * .6];

    // trunk: sculpted tapered path with a root flare, closed at the top by a short cap ring
    const hs = [-.05, .08, .22, .42, .7];
    for (let i = 1; i <= 6; i++) hs.push(lerp(.7, H, i / 6));
    const tp = [], tr = [];
    for (const h of hs) {
      const t = clamp(h / H, 0, 1);
      tp.push(new THREE.Vector3(lean[0] * t * t + .06 * Math.sin(t * 5.2 + ti), h, lean[1] * t * t + .05 * Math.cos(t * 4.3 + ti * 1.3)));
      tr.push(lerp(baseR, baseR * .58, Math.pow(t, .85)) + .55 * baseR * Math.exp(-Math.max(h, 0) / .3));
    }
    const topPt = tp[tp.length - 1];
    tp.push(new THREE.Vector3(topPt.x, H + .07, topPt.z));
    tr.push(tr[tr.length - 1] * .3);
    addTube(trunkB, tp, tr, 10, BARK, 1.3, rr, [wx, wy, wz], 2);
    const pivot = tp[tp.length - 2].clone();
    const prevPt = tp[tp.length - 3].clone();
    const topR = tr[tr.length - 2];

    const nL = 3;
    const lobeData = [];
    for (let li = 0; li < nL; li++) lobeData.push({ branch: new Batch(), clusters: [] });
    const off = [-pivot.x, -pivot.y, -pivot.z];

    const sideDir = (tan, tiltUp) => {
      _d.set(rr() - .5, rr() - .5, rr() - .5).normalize().multiplyScalar(.9).addScaledVector(tan, .45);
      _d.y += tiltUp;
      if (_d.y < -.05) _d.y = -_d.y * .4;
      return _d.normalize().clone();
    };
    const pushCluster = (lobe, P, D, s) => {
      cZ.copy(D).normalize();
      cX.set(rr() - .5, rr() - .5, rr() - .5);
      cX.addScaledVector(cZ, -cX.dot(cZ));
      if (cX.lengthSq() < 1e-4) cX.set(1, 0, 0).addScaledVector(cZ, -cZ.x);
      cX.normalize();
      cY.crossVectors(cZ, cX);
      clusterM.makeBasis(cX, cY, cZ);
      clusterM.scale(cS.set(s, s, s));
      clusterM.setPosition(P.x - pivot.x, P.y - pivot.y, P.z - pivot.z);
      const c = new THREE.Color().copy(leafBase);
      c.offsetHSL((rr() - .5) * .03, (rr() - .5) * .1, (rr() - .5) * .08);
      if (rr() < .07) c.lerp(LEAF_WARM, .5);
      lobe.clusters.push({ m: clusterM.clone(), c });
    };
    const tangentAt = (pts, i) => new THREE.Vector3().subVectors(pts[Math.min(pts.length - 1, i)], pts[Math.max(0, i - 1)]).normalize();

    const nP = 4 + Math.floor(rr() * 3);
    const az0 = rr() * TAU;
    for (let i = 0; i < nP; i++) {
      const lobe = lobeData[i % nL];
      const leader = i === 0 && rr() < .75;
      const az = az0 + i * TAU / nP + (rr() - .5) * .9;
      const elev = leader ? 1.2 + rr() * .25 : lerp(el0, el1, rr());
      const ce = Math.cos(elev);
      const dir0 = new THREE.Vector3(ce * Math.cos(az), Math.sin(elev), ce * Math.sin(az));
      const Lp = leader ? 2.4 + rr() * 1.2 : (1.9 + rr() * 1.5) * spread;
      const start = prevPt.clone().lerp(pivot, rr());
      const segs = 6;
      const pts = growPath(start, dir0, Lp, segs, .28, upBias, rr, clampRoad);
      const r0 = topR * (.55 + rr() * .2);
      const prad = radiiFor(segs + 1, r0, .02);
      addTube(lobe.branch, pts, prad, 6, BARK, 1.2, rr, off);
      const nS = leader ? 2 + Math.floor(rr() * 2) : 3 + Math.floor(rr() * 2);
      for (let s = 0; s < nS; s++) {
        const idx = 2 + Math.floor(rr() * (segs - 1));
        const t = idx / segs;
        const sdir = sideDir(tangentAt(pts, idx), .12);
        const ls = (.9 + rr() * 1.1) * spread * (1 - .35 * t);
        const sp = growPath(pts[idx], sdir, ls, 3, .3, upBias * .6, rr, clampRoad);
        const srad = radiiFor(4, prad[idx] * .55, .012);
        addTube(lobe.branch, sp, srad, 5, BARK, 1.2, rr, off);
        const nT = 4 + Math.floor(rr() * 2);
        for (let w = 0; w < nT; w++) {
          const ti2 = 1 + (w % 3);
          const td = sideDir(tangentAt(sp, ti2), .05);
          const tl = .35 + rr() * .4;
          const twig = growPath(sp[ti2], td, tl, 2, .35, upBias * .4, rr, clampRoad);
          addTube(lobe.branch, twig, [Math.max(.008, srad[ti2] * .5), .006, .004], 4, BARK, 1.2, rr, off);
          if (rr() < density) {
            const end = twig[2], tdir = tangentAt(twig, 2);
            tdir.y -= .15 * rr();
            pushCluster(lobe, end, tdir, 1.05 + rr() * .55);
          }
          if (rr() < density) pushCluster(lobe, twig[1], sideDir(tangentAt(twig, 1), 0), .95 + rr() * .5);
          if (rr() < density * .9) pushCluster(lobe, twig[0].clone().lerp(twig[1], .5), sideDir(tangentAt(twig, 1), .08), .9 + rr() * .45);
        }
        const sEnd = tangentAt(sp, 3);
        sEnd.y -= .1 * rr();
        pushCluster(lobe, sp[3], sEnd, 1.2 + rr() * .5);
        pushCluster(lobe, sp[2], sideDir(tangentAt(sp, 2), .1), 1.0 + rr() * .5);
      }
      const pEnd = tangentAt(pts, segs);
      pushCluster(lobe, pts[segs], pEnd, 1.3 + rr() * .5);
      pushCluster(lobe, pts[segs - 1], sideDir(tangentAt(pts, segs - 1), .15), 1.1 + rr() * .5);
      pushCluster(lobe, pts[segs - 2], sideDir(tangentAt(pts, segs - 2), .1), 1.0 + rr() * .5);
    }

    const treeGroup = new THREE.Group();
    treeGroup.name = 'Tree_' + String(ti).padStart(2, '0');
    treeGroup.position.set(wx + pivot.x, wy + pivot.y, wz + pivot.z);
    treesRoot.add(treeGroup);
    lobeData.forEach((ld, li) => {
      const g = new THREE.Group();
      g.name = treeGroup.name + '_CrownLobe' + li;
      treeGroup.add(g);
      emit(ld.branch, mats.bark, g.name + '_Branches', g);
      emitInstanced(clusterGeo, mats.leaf, g.name + '_LeafClusters', g, ld.clusters);
      lobes.push({ g, amp: .008 + rr() * .008, f1: .5 + rr() * .4, f2: 1.7 + rr() * .9, p1: rr() * TAU, p2: rr() * TAU });
    });

    // tree pit: concrete kerb ring (inside the sidewalk, well clear of the road kerb at |x|=4) + dark soil
    const pit = 1.1, tk = .09, hg = .1;
    const cc = jit([.62, .6, .57], rr, .1);
    box(pitB, null, wx, wy + hg / 2, wz - (pit - tk) / 2, pit, hg, tk, cc);
    box(pitB, null, wx, wy + hg / 2, wz + (pit - tk) / 2, pit, hg, tk, cc);
    box(pitB, null, wx - (pit - tk) / 2, wy + hg / 2, wz, tk, hg, pit - 2 * tk, cc);
    box(pitB, null, wx + (pit - tk) / 2, wy + hg / 2, wz, tk, hg, pit - 2 * tk, cc);
    box(soilB, null, wx, wy + .035, wz, pit - 2 * tk, .07, pit - 2 * tk, jit([.2, .15, .11], rr, .2));
    stats.trees++;
  }
  TREE_SPECS.forEach(buildTree);
  emit(trunkB, mats.bark, 'StreetTrees_Trunks', treesRoot);
  emit(pitB, mats.concrete, 'StreetTrees_PitKerbs', treesRoot, true, true);
  emit(soilB, mats.soil, 'StreetTrees_PitSoil', treesRoot, false, true);

  // ================================================================= PARKED CARS (left kerb, front toward +Z)
  const carRoot = new THREE.Group(); carRoot.name = 'ParkedCars'; root.add(carRoot);
  const DARK = [.055, .055, .06];
  const carB = { glass: new Batch(), trim: new Batch(), chrome: new Batch(), lampF: new Batch(), lampR: new Batch(), plate: new Batch() };
  const TRIM = [.07, .07, .075], CHROME = [.78, .8, .82], PLATE_W = [1, 1, 1];
  const tyreInst = [], rimInst = [];

  // unit tyre (radius 1, axis X, width ratio w) and unit alloy wheel built once per proportion
  function makeTyreGeo(w) {
    const hw = w / 2;
    const prof = [[.6, -.36], [.64, -.44], [.72, -.49], [.85, -.5], [.95, -.47], [.995, -.36], [1, -.2], [1, .2], [.995, .36], [.95, .47], [.85, .5], [.72, .49], [.64, .44], [.6, .36]]
      .map(([r, y]) => new THREE.Vector2(r, y / .5 * hw));
    const g = new THREE.LatheGeometry(prof, 28);
    g.rotateZ(Math.PI / 2);
    return g;
  }
  function makeRimGeo(thick, spokes) {
    const b = new Batch();
    const dk = [.1, .1, .11], lt = [1, 1, 1];
    const barrel = new THREE.CylinderGeometry(1, 1, thick, 28, 1, true); barrel.rotateZ(Math.PI / 2);
    b.addGeometry(barrel, null, dk);
    const disc = new THREE.CylinderGeometry(.92, .92, .03, 24); disc.rotateZ(Math.PI / 2);
    b.addGeometry(disc, mat(thick * .28, 0, 0), dk);
    const lip = new THREE.RingGeometry(.82, .97, 28); lip.rotateY(Math.PI / 2);
    b.addGeometry(lip, mat(thick * .33, 0, 0), lt);
    const hub = new THREE.CylinderGeometry(.22, .22, .08, 14); hub.rotateZ(Math.PI / 2);
    b.addGeometry(hub, mat(thick * .4, 0, 0), lt);
    const spoke = new THREE.BoxGeometry(.06, .74, .16);
    for (let k = 0; k < spokes; k++) {
      const th = k / spokes * TAU + .2;
      b.addGeometry(spoke, mul(mat(thick * .36, 0, 0, th, 0, 0), mat(0, .56, 0)), lt);
    }
    return b.build();
  }
  const carTyreGeo = makeTyreGeo(.6), carRimGeo = makeRimGeo(.8, 5);
  const scTyreGeo = makeTyreGeo(.37), scRimGeo = makeRimGeo(.55, 5);

  const CAR_SPECS = [
    { name: 'SedanWhite', x: -3.10, z: -26, yaw: .010, paint: '#d4d1c6', L: 4.40, W: 1.70, ovF: .88, ovR: .86, R: .30, hood: .84, belt: .95, trunk: .94, roof: 1.45, zfB: 3.05, zfT: 2.30, zrT: 1.25, zrB: .62, zB: 1.95, k: .24, rnF: .46, rnR: .40, rails: false, rim: 0, plate: 0 },
    { name: 'HatchRed', x: -3.14, z: -9, yaw: -.012, paint: '#8b3a33', L: 3.75, W: 1.66, ovF: .75, ovR: .62, R: .28, hood: .80, belt: .90, trunk: .93, roof: 1.48, zfB: 2.62, zfT: 1.90, zrT: .85, zrB: .38, zB: 1.48, k: .26, rnF: .44, rnR: .34, rails: false, rim: 1, plate: 1 },
    { name: 'SuvGraphite', x: -3.08, z: 13, yaw: .006, paint: '#4b5258', L: 4.15, W: 1.76, ovF: .85, ovR: .75, R: .33, hood: .97, belt: 1.08, trunk: 1.10, roof: 1.66, zfB: 3.02, zfT: 2.38, zrT: .50, zrB: .28, zB: 1.85, k: .17, rnF: .48, rnR: .30, rails: true, rim: 0, plate: 2 },
    { name: 'SedanNavy', x: -3.12, z: 39, yaw: -.008, paint: '#2e405c', L: 4.50, W: 1.72, ovF: .90, ovR: .90, R: .31, hood: .86, belt: .97, trunk: .96, roof: 1.47, zfB: 3.12, zfT: 2.35, zrT: 1.30, zrB: .66, zB: 2.00, k: .24, rnF: .46, rnR: .40, rails: false, rim: 1, plate: 3 },
    { name: 'HatchSand', x: -3.10, z: 61, yaw: .014, paint: '#b2a584', L: 3.68, W: 1.65, ovF: .74, ovR: .60, R: .28, hood: .79, belt: .89, trunk: .92, roof: 1.47, zfB: 2.56, zfT: 1.86, zrT: .82, zrB: .36, zB: 1.42, k: .27, rnF: .44, rnR: .34, rails: false, rim: 0, plate: 4 },
    { name: 'MpvSage', x: -3.12, z: 89, yaw: -.006, paint: '#6b7d6a', L: 4.35, W: 1.72, ovF: .80, ovR: .72, R: .30, hood: .91, belt: 1.01, trunk: 1.12, roof: 1.70, zfB: 3.18, zfT: 2.58, zrT: .45, zrB: .22, zB: 2.05, k: .19, rnF: .46, rnR: .30, rails: true, rim: 1, plate: 5 },
  ];

  function carProfile(sp, z) {
    const hl = sp.L / 2;
    const e = Math.min(z + hl, hl - z);
    const rn = z > 0 ? sp.rnF : sp.rnR;
    const q = (e + .06) / rn;
    const f = q >= 1 ? 1 : Math.max(.5, Math.sqrt(Math.max(0, 1 - (1 - q) * (1 - q))));
    const hw = sp.W / 2 * f;
    const yb = sp.yb + .10 * smooth(1 - e / .5);
    let ya = yb;
    for (const az of [sp.zFA, sp.zRA]) {
      const dz = z - az;
      if (Math.abs(dz) < sp.ra) ya = Math.max(ya, sp.R - .07 + Math.sqrt(sp.ra * sp.ra - dz * dz));
    }
    const yH = sp.hood - .07 * smooth(1 - e / .5);
    const yT = sp.trunk - .05 * smooth(1 - e / .4);
    let yd = sp.belt;
    if (z > sp.zfB) yd = lerp(sp.belt, yH, smooth((z - sp.zfB) / .4));
    else if (z < sp.zrB) yd = lerp(sp.belt, yT, smooth((sp.zrB - z) / .35));
    let top = yd;
    if (z < sp.zfB && z > sp.zrB) {
      if (z >= sp.zfT) top = sp.belt + (sp.roof - sp.belt) * (sp.zfB - z) / (sp.zfB - sp.zfT);
      else if (z >= sp.zrT) top = sp.roof;
      else top = sp.belt + (sp.roof - sp.belt) * (z - sp.zrB) / (sp.zrT - sp.zrB);
    }
    return { e, hw, yb, ya, yd, h: Math.max(0, top - yd) };
  }

  // half cross-section at one station: indices 0..15 right side (bottom centre -> roof crown), 16 = top centre
  function carRing(sp, z) {
    const s = carProfile(sp, z);
    const { hw, yb, ya, yd, h } = s;
    const hwC = hw - .075, k = sp.k;
    const xin = Math.max(.12, hw - .27);
    const lo = ya + .07, hi = yd - .03;
    const rs = .03 * Math.min(1, h / .1);
    const xr = hwC - k * h - rs;
    const B = s.e < .33 ? DARK : WHITE;
    const crown = (f) => yd + h + .012 * (1 - f * f);
    return [
      [0, yb, DARK], [xin, yb, DARK], [xin, ya, DARK], [Math.max(xin, hw - .05), ya, DARK],
      [hw, lo, B], [hw + .012, lo + (hi - lo) * .38, B], [hw + .012, lo + (hi - lo) * .78, WHITE], [hw - .02, hi, WHITE],
      [hwC, yd, WHITE],
      [hwC - k * .14 * h, yd + .14 * h, WHITE], [hwC - k * .86 * h, yd + .86 * h, WHITE], [hwC - k * h, yd + h - rs, WHITE],
      [.9 * xr, crown(.9), WHITE], [.7 * xr, crown(.7), WHITE], [.45 * xr, crown(.45), WHITE], [.2 * xr, crown(.2), WHITE],
      [0, crown(0), WHITE],
    ];
  }

  function carStations(sp) {
    const hl = sp.L / 2;
    const list = [-hl, hl, sp.zfB, sp.zfT, sp.zrT, sp.zrB, sp.zfB + .4, sp.zrB - .35];
    for (let z = -hl; z < hl; z += .16) list.push(z);
    for (const e of [.07, .14, .22, .31, .34]) { list.push(-hl + e, hl - e); }
    for (const az of [sp.zFA, sp.zRA]) for (const d of [0, .07, .14, .21, .28, sp.ra]) { list.push(az + d, az - d); }
    list.sort((a, b) => a - b);
    const out = [];
    for (const z of list) {
      if (z < -hl - 1e-6 || z > hl + 1e-6) continue;
      if (!out.length || z - out[out.length - 1] > .012) out.push(clamp(z, -hl, hl));
    }
    out[0] = -hl; out[out.length - 1] = hl;
    return out;
  }

  function capTris(b, ring, z, front) {
    const V = (i, side) => [side * ring[i][0], ring[i][1], z];
    const n = [0, 0, front ? 1 : -1];
    const put = (a, bb, c, ca, cb, cc) => { if (front) b.triN(a, bb, c, n, ca, cb, cc); else b.triN(a, c, bb, n, ca, cc, cb); };
    for (let i = 1; i <= 14; i++) {
      const Li = V(i, -1), Ri = V(i, 1), Rj = V(i + 1, 1), Lj = V(i + 1, -1);
      const ci = ring[i][2], cj = ring[i + 1][2];
      put(Li, Ri, Rj, ci, ci, cj);
      put(Li, Rj, Lj, ci, cj, cj);
    }
    put(V(15, -1), V(15, 1), [0, ring[16][1], z], ring[15][2], ring[15][2], ring[16][2]);
  }

  function buildCarBody(sp) {
    const zs = carStations(sp);
    const S = zs.length, N = 32;
    const pos = new Float32Array(S * N * 3), col = new Float32Array(S * N * 3);
    const rings = zs.map((z) => carRing(sp, z));
    const place = (s, idx, x, y, z, c) => {
      const o = (s * N + idx) * 3;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z; col[o] = c[0]; col[o + 1] = c[1]; col[o + 2] = c[2];
    };
    rings.forEach((r, s) => {
      for (let i = 0; i <= 16; i++) place(s, i, r[i][0], r[i][1], zs[s], r[i][2]);
      for (let i = 1; i <= 15; i++) place(s, 32 - i, -r[i][0], r[i][1], zs[s], r[i][2]);
    });
    const idx = [];
    for (let s = 0; s < S - 1; s++) {
      for (let i = 0; i < N; i++) {
        const a = s * N + i, b2 = s * N + (i + 1) % N, c = (s + 1) * N + (i + 1) % N, d = (s + 1) * N + i;
        idx.push(a, b2, d, b2, c, d);
      }
    }
    const loft = new THREE.BufferGeometry();
    loft.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    loft.setAttribute('color', new THREE.BufferAttribute(col, 3));
    loft.setIndex(idx);
    loft.computeVertexNormals();
    const body = new Batch();
    body.addGeometry(loft, null, WHITE);
    capTris(body, rings[S - 1], zs[S - 1], true);
    capTris(body, rings[0], zs[0], false);
    return body;
  }

  function buildCar(src) {
    const sp = Object.assign({}, src);
    const hl = sp.L / 2;
    for (const k of ['zfB', 'zfT', 'zrT', 'zrB', 'zB']) sp[k] -= hl;
    sp.zFA = hl - sp.ovF; sp.zRA = -hl + sp.ovR;
    sp.ra = sp.R + .075;
    sp.yb = sp.R - .10;
    const carM = mat(sp.x, 0, sp.z, 0, sp.yaw, 0);
    const W2 = sp.W / 2, belt = sp.belt, roof = sp.roof, k = sp.k;
    const hwC = W2 - .075;

    // continuous lofted body + cabin (wheel arches are cut into the loft itself)
    const g = new THREE.Group();
    g.name = 'Car_' + sp.name; g.position.set(sp.x, 0, sp.z); g.rotation.y = sp.yaw;
    carRoot.add(g);
    const paintMat = new THREE.MeshStandardMaterial({ color: sp.paint, vertexColors: true, roughness: .38, metalness: .25 });
    emit(buildCarBody(sp), paintMat, g.name + '_Body', g);

    // glass: side panes, windscreen and rear window as patches lying on the cabin surface
    const xAt = (y) => hwC - k * (y - belt) + .012;
    const yb = belt + .07, yt = roof - .08;
    const zA = (y) => sp.zfB + (sp.zfT - sp.zfB) * (y - belt) / (roof - belt);
    const zC = (y) => sp.zrB + (sp.zrT - sp.zrB) * (y - belt) / (roof - belt);
    for (const sx of [1, -1]) {
      const P = (z, y) => [sx * xAt(y), y, z];
      carB.glass.addPatch([[P(zA(yb) - .055, yb), P(sp.zB + .05, yb)], [P(zA(yt) - .055, yt), P(sp.zB + .05, yt)]], WHITE, carM);
      carB.glass.addPatch([[P(zC(yb) + .055, yb), P(sp.zB - .05, yb)], [P(zC(yt) + .055, yt), P(sp.zB - .05, yt)]], WHITE, carM);
    }
    const F = [.9, .7, .45, .2, 0, -.2, -.45, -.7, -.9];
    const rampGlass = (zBase, zTop) => {
      const rows = [];
      for (const t of [.08, .93]) {
        const z = zBase + (zTop - zBase) * t, h = (roof - belt) * t;
        const rs = .03 * Math.min(1, h / .1), xr = hwC - k * h - rs;
        rows.push(F.map((f) => [f * xr, belt + h + .012 * (1 - f * f) + .007, z]));
      }
      carB.glass.addPatch(rows, WHITE, carM);
    };
    rampGlass(sp.zfB, sp.zfT);
    rampGlass(sp.zrB, sp.zrT);

    // lamps wrap around the rounded nose / tail; plates, grille, bumper details
    const endLamp = (endSign, batch) => {
      const zEnd = endSign * hl;
      const stEnd = carProfile(sp, zEnd);
      const lo = stEnd.ya + .07, hi = stEnd.yd - .03;
      const y0 = lo + (hi - lo) * .40, y1 = lo + (hi - lo) * .80;
      const cols = [];
      for (const e of [.30, .22, .14, .07, 0]) {
        const zz = endSign * (hl - e);
        const hw0 = carProfile(sp, zz).hw;
        const dz = .01;
        const dxdz = (carProfile(sp, zz + dz).hw - carProfile(sp, zz - dz).hw) / (2 * dz);
        const nl = Math.hypot(1, dxdz);
        cols.push([hw0 + .012 + 1 / nl * .014, zz - dxdz / nl * .014]);
      }
      cols.push([stEnd.hw * .72, zEnd + endSign * .014], [stEnd.hw * .42, zEnd + endSign * .014]);
      for (const sx of [1, -1]) {
        batch.addPatch([cols.map(([x, z]) => [sx * x, y0, z]), cols.map(([x, z]) => [sx * x, y1, z])], WHITE, carM);
      }
      return (y0 + y1) / 2;
    };
    const yLampF = endLamp(1, carB.lampF);
    endLamp(-1, carB.lampR);
    box(carB.trim, carM, 0, yLampF, hl + .004, .30, .11, .026, TRIM);
    box(carB.chrome, carM, 0, yLampF, hl + .018, .32, .012, .006, CHROME);
    const plateRow = sp.plate;
    const vv0 = 1 - (plateRow + 1) / 6, vv1 = 1 - plateRow / 6;
    for (const [endSign, py] of [[1, .35], [-1, .37]]) {
      const zp = endSign * (hl + .016);
      const xs = endSign > 0 ? [-.26, .26] : [.26, -.26];
      const rows = [[[xs[0], py, zp], [xs[1], py, zp]], [[xs[0], py + .11, zp], [xs[1], py + .11, zp]]];
      carB.plate.addPatch(rows, PLATE_W, carM, [[[0, vv0], [1, vv0]], [[0, vv1], [1, vv1]]]);
    }
    // exhaust tip, mirrors, handles, door seams
    rod(carB.chrome, carM, [.42, sp.yb + .06, -hl + .08], [.42, sp.yb + .06, -hl - .04], .028, CHROME, 8);
    for (const sx of [1, -1]) {
      box(carB.trim, carM, sx * (W2 + .02), belt + .10, sp.zfB - .10, .15, .10, .11, TRIM, 0, sx * .2, 0);
      for (const hz of [sp.zB + .22, sp.zB - .34]) box(carB.trim, carM, sx * (W2 + .016), belt - .14, hz, .014, .025, .12, TRIM);
      for (const sz of [sp.zFA - sp.ra - .04, sp.zB, sp.zRA + sp.ra + .03]) box(carB.trim, carM, sx * (W2 + .012), .54, sz, .01, .44, .006, DARK);
    }
    if (sp.rails) {
      const xr = hwC - k * (roof - belt) - .03 - .09;
      const len = (sp.zfT - sp.zrT) - .2;
      for (const sx of [1, -1]) box(carB.chrome, carM, sx * xr, roof + .03, (sp.zfT + sp.zrT) / 2, .03, .03, len, CHROME);
    }

    // wheels (instanced tyre + alloy)
    const xw = W2 - .025 - sp.R * .3;
    const rimCol = new THREE.Color(sp.rim ? '#cfd2d4' : '#4d5154');
    for (const za of [sp.zFA, sp.zRA]) {
      for (const sx of [1, -1]) {
        const ry = sx > 0 ? 0 : Math.PI;
        tyreInst.push({ m: mul(carM, mat(sx * xw, sp.R, za, 0, ry, 0, sp.R)), c: new THREE.Color(1, 1, 1) });
        rimInst.push({ m: mul(carM, mat(sx * xw, sp.R, za, 0, ry, 0, sp.R * .63)), c: rimCol });
      }
    }
    stats.cars++;
  }
  CAR_SPECS.forEach(buildCar);
  emit(carB.glass, mats.glass, 'ParkedCars_Glass', carRoot);
  emit(carB.trim, mats.trim, 'ParkedCars_Trim', carRoot);
  emit(carB.chrome, mats.chrome, 'ParkedCars_Chrome', carRoot);
  emit(carB.lampF, mats.lampF, 'ParkedCars_Headlamps', carRoot);
  emit(carB.lampR, mats.lampR, 'ParkedCars_Taillamps', carRoot);
  emit(carB.plate, mats.plate, 'ParkedCars_Plates', carRoot);
  emitInstanced(carTyreGeo, mats.tyre, 'ParkedCars_Tyres', carRoot, tyreInst);
  emitInstanced(carRimGeo, mats.rim, 'ParkedCars_Rims', carRoot, rimInst);

  // ================================================================= SCOOTERS + BICYCLES (storefront side)
  const twoWheelRoot = new THREE.Group(); twoWheelRoot.name = 'Scooters_Bicycles'; root.add(twoWheelRoot);
  const twB = { trim: new Batch(), chrome: new Batch(), lampF: new Batch(), lampR: new Batch(), plate: new Batch(), rubber: new Batch() };
  const scTyreInst = [], scRimInst = [];
  const SEAT = [.05, .05, .055];
  const IRONC = [.17, .18, .17];

  function profileGeo(pts, width, bevel = .02) {
    const shape = new THREE.Shape();
    pts.forEach((p, i) => { if (i) shape.lineTo(p[0], p[1]); else shape.moveTo(p[0], p[1]); });
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(.01, width - 2 * bevel), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 4, steps: 1 });
    g.computeBoundingBox();
    g.translate(0, 0, -(g.boundingBox.min.z + g.boundingBox.max.z) / 2);
    g.rotateY(-Math.PI / 2); // shape x -> forward (+Z); extrusion depth -> lateral X
    return g;
  }
  function fenderGeo(r, tube, arc) {
    const g = new THREE.TorusGeometry(r, tube, 6, 14, arc);
    g.rotateZ(Math.PI / 2 - arc / 2);
    g.rotateY(Math.PI / 2);
    return g;
  }
  const scBody = {
    shield: profileGeo([[.46, .30], [.50, .52], [.45, .82], [.36, .96], [.30, .92], [.32, .60], [.28, .34]], .34, .03),
    rear: profileGeo([[-.18, .31], [-.70, .30], [-.93, .44], [-.97, .68], [-.84, .76], [-.30, .72], [-.16, .50]], .30, .03),
    seat: profileGeo([[-.10, .745], [-.18, .82], [-.78, .84], [-.90, .78], [-.84, .72], [-.30, .71]], .27, .025),
  };
  const scFender = fenderGeo(.29, .02, 1.6);
  const bikeFender = fenderGeo(.355, .01, 1.7);

  function buildScooter(sp, idx) {
    const roll = -sp.lean;
    const place = mul(mat(sp.x, SIDEWALK + (sp.lean ? .008 : 0), sp.z, 0, sp.yaw, 0), mat(0, 0, 0, 0, 0, roll));
    const paint = new Batch();
    const paintCol = WHITE;
    const R = .26;
    const A = (b, geo, local, color) => b.addGeometry(geo, mul(place, local), color);
    // bodywork
    A(paint, scBody.shield, mat(0, 0, 0), paintCol);
    A(paint, scBody.rear, mat(0, 0, 0), paintCol);
    A(twB.trim, scBody.seat, mat(0, 0, 0), SEAT);
    A(paint, scFender, mat(0, R, .62, 0, 0, 0, 3.4, 1, 1), paintCol);
    ell(paint, place, 0, 1.05, .46, .20, .08, .13, paintCol);
    box(twB.trim, place, 0, .31, .02, .38, .04, .44, TRIM);
    // front end
    for (const sx of [1, -1]) {
      rod(twB.chrome, place, [sx * .07, R, .62], [sx * .065, .93, .47], .014, CHROME, 6);
      rod(twB.chrome, place, [sx * .28, 1.05, .43], [sx * .33, 1.22, .40], .007, CHROME, 5);
      ell(twB.chrome, place, sx * .33, 1.23, .40, .045, .03, .01, CHROME);
      rod(twB.trim, place, [sx * .30, 1.04, .43], [sx * .37, 1.04, .43], .017, TRIM, 6);
      rod(twB.trim, place, [sx * .09, R, -.60], [sx * .09, .28, -.25], .018, TRIM, 6);
    }
    rod(twB.trim, place, [0, .9, .47], [0, 1.04, .44], .02, TRIM, 6);
    rod(twB.chrome, place, [-.36, 1.04, .43], [.36, 1.04, .43], .011, CHROME, 6);
    ell(twB.lampF, place, 0, .99, .58, .10, .07, .06, WHITE);
    box(twB.lampR, place, 0, .66, -.975, .18, .05, .03, WHITE);
    box(twB.trim, place, 0, .26, -.50, .18, .20, .34, TRIM);
    rod(twB.chrome, place, [.13, .20, -.15], [.16, .22, -.78], .045, CHROME, 8);
    const plateRow = (idx + 2) % 6;
    const pv0 = 1 - (plateRow + 1) / 6, pv1 = 1 - plateRow / 6;
    twB.plate.addPatch([[[.1, .43, -.972], [-.1, .43, -.972]], [[.1, .51, -.972], [-.1, .51, -.972]]], PLATE_W, place, [[[0, pv0], [1, pv0]], [[0, pv1], [1, pv1]]]);
    // stand
    if (sp.stand === 'side') {
      const xs = sp.lean > 0 ? .20 : -.20;
      rod(twB.trim, place, [.02 * Math.sign(xs), .24, -.20], [xs, -xs * Math.tan(roll), -.28], .012, TRIM, 5);
    } else {
      for (const sx of [1, -1]) rod(twB.trim, place, [sx * .07, .24, -.36], [sx * .08, 0, -.52], .012, TRIM, 5);
    }
    // wheels
    for (const zc of [.62, -.60]) {
      scTyreInst.push({ m: mul(place, mat(0, R, zc, 0, 0, 0, R)), c: new THREE.Color(1, 1, 1) });
      scRimInst.push({ m: mul(place, mat(0, R, zc, 0, 0, 0, R * .6)), c: new THREE.Color('#a9acae') });
    }
    const gm = new THREE.Group();
    gm.name = 'Scooter_' + idx;
    twoWheelRoot.add(gm);
    const pm = new THREE.MeshStandardMaterial({ color: sp.paint, vertexColors: true, roughness: .42, metalness: .15 });
    emit(paint, pm, gm.name + '_Bodywork', gm);
    stats.scooters++;
  }

  function buildBicycle(sp, idx) {
    const place = mul(mat(sp.x, SIDEWALK + .006, sp.z, 0, sp.yaw, 0), mat(0, 0, 0, 0, 0, -sp.lean));
    const paint = new Batch();
    const R = .335;
    const A = [0, R, -.52], Fw = [0, R, .52], BB = [0, .30, -.08], S = [0, .90, -.24], H1 = [0, .64, .40], H2 = [0, .80, .44];
    const pc = WHITE;
    rod(paint, place, A, BB, .014, pc, 6);
    rod(paint, place, A, S, .012, pc, 6);
    rod(paint, place, BB, S, .017, pc, 6);
    rod(paint, place, BB, H1, .019, pc, 6);
    rod(paint, place, [0, .85, -.2], H2, .016, pc, 6);
    rod(paint, place, H1, H2, .02, pc, 6);
    rod(twB.chrome, place, S, [0, .96, -.255], .013, CHROME, 6);
    ell(twB.rubber, place, 0, .975, -.25, .065, .03, .14, SEAT);
    for (const sx of [1, -1]) {
      rod(twB.chrome, place, [sx * .045, R, .52], [sx * .04, .68, .43], .011, CHROME, 5);
      rod(twB.chrome, place, [sx * .27, .96, .37], [sx * .30, .93, .25], .011, CHROME, 5);
      rod(twB.rubber, place, [sx * .30, .93, .25], [sx * .30, .93, .16], .016, SEAT, 6);
    }
    rod(twB.chrome, place, H2, [0, .94, .40], .013, CHROME, 5);
    rod(twB.chrome, place, [-.27, .96, .37], [.27, .96, .37], .011, CHROME, 5);
    // drivetrain
    const cyd = new THREE.CylinderGeometry(.09, .09, .008, 18); cyd.rotateZ(Math.PI / 2);
    twB.chrome.addGeometry(cyd, mul(place, mat(.05, .30, -.08)), CHROME);
    rod(twB.trim, place, [.075, .30, -.08], [.075, .19, -.04], .01, TRIM, 5);
    box(twB.trim, place, .10, .19, -.04, .09, .015, .045, TRIM);
    // front basket + rear rack
    const bx = [-.15, .15], bz = [.50, .70];
    const wire = [.5, .5, .52];
    for (const x of bx) for (const z of bz) rod(twB.chrome, place, [x, .62, z], [x, .80, z], .004, wire, 4);
    for (const y of [.62, .80]) {
      rod(twB.chrome, place, [bx[0], y, bz[0]], [bx[1], y, bz[0]], .004, wire, 4);
      rod(twB.chrome, place, [bx[0], y, bz[1]], [bx[1], y, bz[1]], .004, wire, 4);
      rod(twB.chrome, place, [bx[0], y, bz[0]], [bx[0], y, bz[1]], .004, wire, 4);
      rod(twB.chrome, place, [bx[1], y, bz[0]], [bx[1], y, bz[1]], .004, wire, 4);
    }
    for (const x of [-.05, .05]) rod(twB.chrome, place, [x, .62, bz[0]], [x, .62, bz[1]], .004, wire, 4);
    box(twB.trim, place, 0, .66, -.55, .14, .012, .30, IRONC);
    // fenders
    paint.addGeometry(bikeFender, mul(place, mat(0, R, .52, 0, 0, 0, 3, 1, 1)), pc);
    paint.addGeometry(bikeFender, mul(place, mat(0, R, -.52, 0, 0, 0, 3, 1, 1)), pc);
    // wheels: tyre torus, rim ring, hub and spokes
    for (const zc of [.52, -.52]) {
      const tyre = new THREE.TorusGeometry(R - .02, .02, 6, 28); tyre.rotateY(Math.PI / 2);
      twB.rubber.addGeometry(tyre, mul(place, mat(0, R, zc)), SEAT);
      const rimg = new THREE.TorusGeometry(R - .05, .007, 4, 28); rimg.rotateY(Math.PI / 2);
      twB.chrome.addGeometry(rimg, mul(place, mat(0, R, zc)), CHROME);
      const hub = new THREE.CylinderGeometry(.02, .02, .09, 8); hub.rotateZ(Math.PI / 2);
      twB.chrome.addGeometry(hub, mul(place, mat(0, R, zc)), CHROME);
      for (let s = 0; s < 18; s++) {
        const a = s / 18 * TAU;
        rod(twB.chrome, place, [0, R, zc], [0, R + Math.cos(a) * (R - .055), zc + Math.sin(a) * (R - .055)], .0025, wire, 3);
      }
    }
    const gm = new THREE.Group();
    gm.name = 'Bicycle_' + idx;
    twoWheelRoot.add(gm);
    const pm = new THREE.MeshStandardMaterial({ color: sp.paint, vertexColors: true, roughness: .4, metalness: .3 });
    emit(paint, pm, gm.name + '_Frame', gm);
    stats.bicycles++;
  }

  const SCOOTER_SPECS = [
    { x: 6.30, z: -20.0, yaw: .06, lean: .20, stand: 'side', paint: '#b8b2a0' },
    { x: 6.35, z: 12.5, yaw: Math.PI - .05, lean: 0, stand: 'center', paint: '#3d5f63' },
    { x: 6.25, z: 24.6, yaw: .02, lean: .20, stand: 'side', paint: '#7b2f2c' },
    { x: -6.30, z: -10.0, yaw: Math.PI - .04, lean: -.20, stand: 'side', paint: '#a89a72' },
    { x: -6.30, z: 22.0, yaw: 0, lean: 0, stand: 'center', paint: '#5a6b78' },
    { x: -6.30, z: 66.0, yaw: Math.PI + .04, lean: -.20, stand: 'side', paint: '#8c8f86' },
  ];
  const BIKE_SPECS = [
    { x: 6.90, z: 33.5, yaw: .05, lean: .26, paint: '#33523f' },
    { x: -6.90, z: 37.5, yaw: Math.PI - .04, lean: -.26, paint: '#8a8f94' },
  ];
  SCOOTER_SPECS.forEach(buildScooter);
  BIKE_SPECS.forEach(buildBicycle);
  emit(twB.trim, mats.trim, 'Scooters_Trim', twoWheelRoot);
  emit(twB.chrome, mats.chrome, 'Scooters_Chrome', twoWheelRoot);
  emit(twB.lampF, mats.lampF, 'Scooters_Headlamps', twoWheelRoot);
  emit(twB.lampR, mats.lampR, 'Scooters_Taillamps', twoWheelRoot);
  emit(twB.plate, mats.plate, 'Scooters_Plates', twoWheelRoot);
  emit(twB.rubber, mats.rubber, 'Bicycles_Rubber', twoWheelRoot);
  emitInstanced(scTyreGeo, mats.tyre, 'Scooters_Tyres', twoWheelRoot, scTyreInst);
  emitInstanced(scRimGeo, mats.rim, 'Scooters_Rims', twoWheelRoot, scRimInst);

  // ================================================================= STREET FURNITURE
  const furnRoot = new THREE.Group(); furnRoot.name = 'SidewalkFurniture'; root.add(furnRoot);
  const fB = { iron: new Batch(), wood: new Batch(), plastic: new Batch(), ceramic: new Batch(), soil: new Batch(), lens: new Batch() };
  const fr = makeRng(5151);
  const WOODC = hex('#a58660');
  const GY = SIDEWALK;
  const fruitInst = [];
  const plantInst = [];

  // --- slim street lamps (unlit luminaires, daytime): tapered pole, plinth, curved arm, flat head
  function addLamp(x, z) {
    const s = x > 0 ? -1 : 1; // arm reaches toward the road
    const ic = jit([.17, .19, .17], fr, .15);
    cyl(fB.iron, null, x, GY + .30, z, .11, .14, .6, 10, ic);
    cyl(fB.iron, null, x, GY + .64, z, .095, .095, .06, 10, ic);
    rod(fB.iron, null, [x, GY + .6, z], [x, GY + 6.0, z], .075, ic, 10, .042);
    addTube(fB.iron, [new THREE.Vector3(0, 0, 0), new THREE.Vector3(s * .25, .26, 0), new THREE.Vector3(s * .7, .42, 0), new THREE.Vector3(s * 1.1, .4, 0), new THREE.Vector3(s * 1.4, .3, 0)], [.034, .03, .028, .026, .024], 6, ic, 1, null, [x, GY + 6.0, z]);
    box(fB.iron, null, x + s * 1.45, GY + 6.3, z, .64, .07, .26, ic);
    box(fB.lens, null, x + s * 1.45, GY + 6.255, z, .5, .02, .2, [.78, .8, .74]);
    ell(fB.iron, null, x + s * 1.45, GY + 6.34, z, .22, .05, .1, ic);
    ell(fB.iron, null, x, GY + 6.04, z, .05, .05, .05, ic);
  }
  for (const z of [-30, 17.5, 49, 76, 108]) addLamp(4.6, z);
  for (const z of [-12, 24, 57, 92]) addLamp(-4.6, z);

  // --- benches (wooden slats on cast-iron ends); face: +1 seat faces +x, -1 faces -x
  function addBench(x, z, face) {
    const M = mat(x, GY, z, 0, face > 0 ? 0 : Math.PI, 0);
    const len = 1.7;
    for (const dx of [-.13, .01, .15]) box(fB.wood, M, dx, .44, 0, .12, .035, len, jit(WOODC, fr, .12));
    for (const [y, dx] of [[.66, -.235], [.80, -.263]]) box(fB.wood, M, dx, y, 0, .022, .11, len, jit(WOODC, fr, .12), 0, 0, .18);
    const ic = jit(IRONC, fr, .1);
    for (const sz of [-.75, .75]) {
      rod(fB.iron, M, [.18, 0, sz], [.18, .44, sz], .02, ic, 6);
      rod(fB.iron, M, [-.2, 0, sz], [-.27, .88, sz], .02, ic, 6);
      rod(fB.iron, M, [.2, .42, sz], [-.22, .42, sz], .018, ic, 6);
      rod(fB.iron, M, [.2, .62, sz], [-.25, .66, sz], .016, ic, 6);
      rod(fB.iron, M, [.2, .44, sz], [.2, .62, sz], .016, ic, 6);
      box(fB.iron, M, .08, .015, sz, .4, .03, .05, ic);
    }
  }
  addBench(6.55, -27.5, -1);
  addBench(6.6, 66, -1);
  addBench(-6.6, 58, 1);

  // --- bins
  function addRoundBin(x, z, col) {
    cyl(fB.plastic, null, x, GY + .36, z, .185, .155, .72, 14, col);
    cyl(fB.plastic, null, x, GY + .74, z, .2, .2, .04, 14, [col[0] * .7, col[1] * .7, col[2] * .7]);
    rod(fB.iron, null, [x - .06, GY + .77, z], [x + .06, GY + .77, z], .012, IRONC, 5);
  }
  function addWheeledBin(x, z, yaw, col) {
    const M = mat(x, GY, z, 0, yaw, 0);
    box(fB.plastic, M, 0, .44, 0, .5, .8, .55, col);
    box(fB.plastic, M, 0, .84, -.03, .54, .05, .6, [col[0] * .75, col[1] * .75, col[2] * .75], .08, 0, 0);
    for (const sx of [-.2, .2]) cyl(fB.plastic, M, sx, .08, -.25, .08, .08, .05, 12, [.06, .06, .06], 0, 0, Math.PI / 2);
    box(fB.plastic, M, 0, .78, .3, .3, .035, .035, [col[0] * .6, col[1] * .6, col[2] * .6]);
  }
  addRoundBin(7.05, -22, hex('#4a5d49'));
  addRoundBin(7.05, 46, hex('#8a5b3a'));
  addWheeledBin(-7.0, 13, 0, hex('#3f5a44'));
  addWheeledBin(-7.0, 71, .1, hex('#3c5878'));
  addWheeledBin(7.05, 4.8, -.08, hex('#566057'));

  // --- planter pots with plants (plants reuse the leaf-spray geometry)
  const potProfile = [[.001, 0], [.16, 0], [.2, .08], [.26, .3], [.3, .44], [.31, .5], [.28, .5], [.27, .46]].map(([r, y]) => new THREE.Vector2(r, y));
  const potGeo = new THREE.LatheGeometry(potProfile, 16);
  const POT_COLS = ['#a65a3a', '#4f6b66', '#8f6a4b', '#6e6d66', '#a1503a'].map(hex);
  function addPot(x, z) {
    const s = .75 + fr() * .5;
    const col = jit(POT_COLS[Math.floor(fr() * POT_COLS.length)], fr, .1);
    fB.ceramic.addGeometry(potGeo, mat(x, GY, z, 0, fr() * TAU, 0, s), col);
    cyl(fB.soil, null, x, GY + .465 * s, z, .26 * s, .26 * s, .02, 14, jit([.18, .13, .1], fr, .2));
    const n = 8 + Math.floor(fr() * 4);
    for (let i = 0; i < n; i++) {
      const a = fr() * TAU, rad = fr() * .12 * s;
      const dir = new THREE.Vector3(Math.cos(a) * .55, .85 + fr() * .3, Math.sin(a) * .55).normalize();
      cZ.copy(dir); cX.set(fr() - .5, fr() - .5, fr() - .5); cX.addScaledVector(cZ, -cX.dot(cZ));
      if (cX.lengthSq() < 1e-4) cX.set(1, 0, 0).addScaledVector(cZ, -cZ.x);
      cX.normalize(); cY.crossVectors(cZ, cX);
      const m = new THREE.Matrix4().makeBasis(cX, cY, cZ);
      const sc = 1.1 + fr() * .8;
      m.scale(cS.set(sc, sc, sc));
      m.setPosition(x + Math.cos(a) * rad, GY + .47 * s, z + Math.sin(a) * rad);
      const c = new THREE.Color('#4f7d3c').offsetHSL((fr() - .5) * .04, (fr() - .5) * .1, (fr() - .5) * .08);
      plantInst.push({ m, c });
    }
  }
  for (const [x, z] of [[6.95, -3.2], [6.9, 3.5], [7.0, 20.4], [6.95, 36.5], [6.85, 44.5], [-6.95, -14.5], [-6.9, 2], [-7.0, 31], [-6.9, 63], [-6.95, 88]]) addPot(x, z);

  // --- cafe sets: low plastic stools + low tables, bistro table with two chairs
  const STOOL_COLS = ['#a8402f', '#3d5f8a', '#5f7f4d', '#c07a2e'].map(hex);
  function addStool(x, z, col) {
    cyl(fB.plastic, null, x, GY + .38, z, .15, .14, .035, 16, col);
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + Math.PI / 4;
      rod(fB.plastic, null, [x + Math.cos(a) * .1, GY + .37, z + Math.sin(a) * .1], [x + Math.cos(a) * .135, GY, z + Math.sin(a) * .135], .012, col, 5);
    }
    cyl(fB.plastic, null, x, GY + .22, z, .125, .125, .012, 14, col);
  }
  function addLowTable(x, z) {
    cyl(fB.wood, null, x, GY + .52, z, .3, .3, .03, 20, jit(WOODC, fr, .1));
    for (let k = 0; k < 3; k++) {
      const a = k * TAU / 3 + .4;
      rod(fB.iron, null, [x + Math.cos(a) * .18, GY + .5, z + Math.sin(a) * .18], [x + Math.cos(a) * .24, GY, z + Math.sin(a) * .24], .014, IRONC, 5);
    }
  }
  function addBistroTable(x, z) {
    cyl(fB.wood, null, x, GY + .74, z, .33, .33, .03, 22, jit(WOODC, fr, .1));
    rod(fB.iron, null, [x, GY, z], [x, GY + .73, z], .025, IRONC, 6);
    cyl(fB.iron, null, x, GY + .012, z, .2, .2, .024, 16, IRONC);
  }
  function addChair(x, z, tx, tz) {
    const yaw = Math.atan2(tx - x, tz - z);
    const M = mat(x, GY, z, 0, yaw, 0);
    const ic = jit([.14, .22, .17], fr, .1);
    box(fB.wood, M, 0, .45, 0, .38, .03, .38, jit(WOODC, fr, .1));
    for (const sx of [-.16, .16]) for (const sz of [-.16, .16]) rod(fB.iron, M, [sx, 0, sz], [sx, .44, sz], .011, ic, 5);
    for (const sx of [-.16, .16]) rod(fB.iron, M, [sx, .45, -.17], [sx, .88, -.19], .011, ic, 5);
    box(fB.iron, M, 0, .86, -.19, .36, .035, .018, ic);
    box(fB.wood, M, 0, .72, -.185, .32, .07, .016, jit(WOODC, fr, .1));
  }
  // cafe A (z ~ 0) and cafe B (z ~ 40)
  addBistroTable(6.55, -1.2); addChair(6.2, -1.2, 6.55, -1.2); addChair(6.9, -1.25, 6.55, -1.2);
  addLowTable(6.6, 1.6);
  [[6.35, 1.35], [6.85, 1.45], [6.55, 1.95]].forEach(([x, z], i) => addStool(x, z, STOOL_COLS[i % 4]));
  addLowTable(6.65, 40.2);
  [[6.4, 39.95], [6.9, 40.1], [6.6, 40.65], [6.7, 39.7]].forEach(([x, z], i) => addStool(x, z, STOOL_COLS[(i + 1) % 4]));
  addBistroTable(6.5, 42.8); addChair(6.15, 42.8, 6.5, 42.8); addChair(6.85, 42.75, 6.5, 42.8);

  // --- small produce stall near z ~ 18: slatted crates with fruit
  function addCrate(x, z, yaw, y0, plasticCol, fruitCols) {
    const M = mat(x, GY + y0, z, 0, yaw, 0);
    const wc = () => (plasticCol ? jit(plasticCol, fr, .08) : jit(WOODC, fr, .15));
    const b = plasticCol ? fB.plastic : fB.wood;
    box(b, M, 0, .012, 0, .52, .02, .36, wc());
    for (const sz of [-.17, .17]) for (const y of [.09, .22]) box(b, M, 0, y, sz, .52, .11, .02, wc());
    for (const sx of [-.25, .25]) for (const y of [.09, .22]) box(b, M, sx, y, 0, .02, .11, .32, wc());
    if (!plasticCol) for (const sx of [-.25, .25]) for (const sz of [-.17, .17]) box(b, M, sx, .15, sz, .035, .3, .035, wc());
    if (!fruitCols) return;
    const fc = fruitCols[Math.floor(fr() * fruitCols.length)];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
      const rr2 = .04 + fr() * .008;
      const m = mul(M, mat(-.19 + i * .126 + (fr() - .5) * .02, .26 + fr() * .015, -.12 + j * .12 + (fr() - .5) * .02, 0, 0, 0, rr2, rr2 * .92, rr2));
      fruitInst.push({ m, c: new THREE.Color(fc).offsetHSL((fr() - .5) * .03, (fr() - .5) * .1, (fr() - .5) * .08) });
    }
    for (let i = 0; i < 3; i++) {
      const rr2 = .04 + fr() * .008;
      const m = mul(M, mat(-.1 + i * .12 + (fr() - .5) * .02, .32, (fr() - .5) * .05, 0, 0, 0, rr2));
      fruitInst.push({ m, c: new THREE.Color(fc).offsetHSL((fr() - .5) * .03, (fr() - .5) * .1, (fr() - .5) * .08) });
    }
  }
  const FRUIT = ['#d98a2b', '#a9b43f', '#b9382c', '#d5bf49', '#8fae4a'];
  addCrate(6.85, 17.0, .10, 0, null, FRUIT);
  addCrate(6.9, 17.0, .25, .30, null, FRUIT);
  addCrate(6.88, 17.75, -.05, 0, null, FRUIT);
  addCrate(6.45, 18.45, -.30, 0, hex('#a8453a'), FRUIT);
  addCrate(6.95, 18.5, .15, 0, hex('#4a7a52'), FRUIT);

  emit(fB.iron, mats.iron, 'Furniture_IronWork', furnRoot);
  emit(fB.wood, mats.wood, 'Furniture_Wood', furnRoot);
  emit(fB.plastic, mats.plastic, 'Furniture_Plastic', furnRoot);
  emit(fB.ceramic, mats.ceramic, 'Furniture_Pots', furnRoot);
  emit(fB.soil, mats.soil, 'Furniture_PotSoil', furnRoot, false, true);
  emit(fB.lens, mats.lampF, 'Furniture_LampLenses', furnRoot, false, true);
  emitInstanced(clusterGeo, mats.leaf, 'Furniture_PotPlants', furnRoot, plantInst);
  const fruitGeo = new THREE.IcosahedronGeometry(1, 1);
  emitInstanced(fruitGeo, mats.fruit, 'Furniture_Fruit', furnRoot, fruitInst);

  // ================================================================= animation (absolute time only)
  function update(t) {
    const gust = .62 + .38 * Math.sin(t * .21 + 1.3) * Math.sin(t * .067 + .4);
    for (const l of lobes) {
      const a = l.amp * gust;
      l.g.rotation.z = a * (Math.sin(t * l.f1 + l.p1) + .45 * Math.sin(t * l.f2 + l.p2));
      l.g.rotation.x = a * .6 * (Math.sin(t * l.f1 * .87 + l.p2) + .35 * Math.sin(t * l.f2 * 1.13 + l.p1));
    }
  }
  update(0);

  return { update, group: root, stats };
}
