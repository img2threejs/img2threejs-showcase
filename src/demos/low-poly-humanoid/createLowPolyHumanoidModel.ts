import * as THREE from 'three';

export type LowPolyHumanoidOptions = {
  castShadow?: boolean;
  receiveShadow?: boolean;
  facetVariation?: boolean;
};

export type LowPolyHumanoidAnimationName =
  | 'run'
  | 'jump'
  | 'kick'
  | 't-pose-breathing'
  | 'fan-salute'
  | 'wave-left'
  | 'wave-right'
  | 'roundhouse'
  | 'dodge';

export type LowPolyHumanoidAnimationController = {
  actions: ReadonlyArray<{
    id: LowPolyHumanoidAnimationName;
    label: string;
    loop: boolean;
  }>;
  readonly active: 'idle' | LowPolyHumanoidAnimationName;
  play: (name: LowPolyHumanoidAnimationName) => void;
  stop: () => void;
  update: (dt: number) => void;
  subscribe: (listener: (active: 'idle' | LowPolyHumanoidAnimationName) => void) => () => void;
};

export type LowPolyHumanoidRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, THREE.Object3D>;
  destructionGroups: Record<string, string[]>;
  animationController?: LowPolyHumanoidAnimationController;
};

const palette = {
  skin: 0xae9680,
  skinLight: 0xbda88d,
  skinShadow: 0x8c7059,
  // 0x130e0c, not 0x1c1512. Measured, not chosen: the baseline's hair renders at luma 27.7 and this
  // model sat at 40.9 with roughness already near its ceiling, so the remaining 1.48x is diffuse.
  // 27.7 / 40.9 = 0.677, and (28,21,18) * 0.677 = (19,14,12).
  //
  // Darker leaves less room for value variation, and that is fine: the reference is this dark AND
  // shows striation, because its striation comes from a NORMAL MAP. A normal perturbs the diffuse
  // term, which survives on a dark surface; the roughness variation this model was relying on does
  // not, which is why the flow was invisible here at every setting tried.
  hair: 0x0e0b09,
  shorts: 0xd45307,
  shortsDark: 0x9f3b08,
  eyes: 0x2d3f46,
};

function material(color: number, roughness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness: 0,
    flatShading: true,
    side: THREE.DoubleSide,
  });
}

function polyMaterial(color: number, roughness: number): THREE.MeshStandardMaterial {
  return material(color, roughness);
}

/**
 * Strand flow for the hair, as a generated roughness map.
 *
 * WHY ROUGHNESS AND NOT COLOUR. The obvious way to draw streaks is an albedo map, and it would break
 * the measurement this model is scored by: `hair_structure.py` separates hair from skin with a flat
 * `luma < 70` cut, chosen because the hair sits at 0x1c1512 against skin near 0xe8d5c0. Lightening
 * the albedo enough for streaks to read pushes lit pixels over that cut, and the metric would report
 * the hair shrinking while the geometry had not moved — the same class of false reading that had
 * a third of the baseline's hair classified as background for many rounds of this work.
 *
 * Varying roughness instead leaves albedo where the metric expects it and still gives the tangent-
 * aligned highlight banding that reads as flow, because `roughnessMap` multiplies the material's
 * roughness by the texture's GREEN channel.
 *
 * The streaks run along V. `buildHeadShell` lays V down the station axis, which is the direction a
 * strand actually grows, so a stripe pattern in U is a set of strands rather than a set of rings.
 * The values are hashed from the column index rather than drawn from `Math.random`, so a capture is
 * reproducible and two runs can be compared.
 */
/**
 * The strand flow, as a tangent-space normal map.
 *
 * Ridges vary across U and hold along V. On the hair mass those axes are polar about the crown — U is
 * the angle round it, V the distance down from it — so a ridge is a strand running out of the whorl.
 * That layout is doing the work: `scripts/tangent-flow-probe.mjs` established that an authored
 * `tangent` attribute does NOT move the pattern (two spheres, same map, one with a whorl tangent
 * field, came out identical), because the shader samples at `vUv` and only orients with the TBN.
 *
 * A normal perturbs the DIFFUSE term, which is why this and not a roughness variation: the hair sits
 * at luma 25.5 to match the reference, and on a surface that dark a change in gloss is invisible
 * while a change in facing is not.
 *
 * Sixteen lanes, not the eleven the roughness map uses at clump scale. Lane count has to be set
 * against the span the UV covers — eleven across a few centimetres of clump rendered as corduroy;
 * here U wraps the whole head.
 *
 * No colour space is set: a normal map is data, and tagging it sRGB would bend the vectors.
 */
function strandNormalTexture(): THREE.DataTexture {
  const w = 128;
  const h = 16;
  const LANES = 16;
  const data = new Uint8Array(w * h * 4);
  for (let x = 0; x < w; x += 1) {
    const phase = (x / w) * LANES * Math.PI * 2;
    const nx = -0.62 * Math.sin(phase);
    for (let y = 0; y < h; y += 1) {
      // A slow wander along the strand so a lane is not a ruled line for its whole length.
      const ny = 0.13 * Math.sin((y / h) * Math.PI * 2 + phase * 0.2);
      const len = Math.hypot(nx, ny, 1);
      const o = (y * w + x) * 4;
      data[o] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function strandRoughnessTexture(): THREE.DataTexture {
  const w = 64;
  const h = 16;
  // WIDE LANES, NOT PER-COLUMN NOISE. The first version hashed every one of the 64 columns and
  // repeated the result three times round the head. Rendered, it read as corrugated metal: at three
  // repeats a lane is under half a pixel on screen at the temples, so neighbouring lanes alias into
  // a hard rib pattern, and `flatShading` then serves each facet its own slab of that pattern. Hair
  // wants a few broad tonal lanes, so the hash runs per LANE and each lane is several pixels wide.
  const LANES = 11;
  const data = new Uint8Array(w * h * 4);
  for (let x = 0; x < w; x += 1) {
    const lane = Math.floor((x / w) * LANES);
    let s = (lane * 1103515245 + 12345) & 0x7fffffff;
    s = (s >> 7) ^ (s >> 15);
    const tone = (s & 0xff) / 255;
    // Soften the lane boundary so the change is a shading gradient rather than a drawn line.
    const edge = Math.abs(((x / w) * LANES) % 1 - 0.5) * 2;
    for (let y = 0; y < h; y += 1) {
      const drift = 0.06 * Math.sin((y / h) * Math.PI * 2 + tone * 6.283);
      // 0.55-0.95 rather than 0.35-0.85: a narrower swing reads as sheen along the strand, where the
      // wider one read as separate materials stitched together.
      // 0.30-0.50 absolute, because material roughness is now 1.0 and this map IS the value.
      // 0.62-0.88. The target is measured, not chosen: the baseline's hair renders at luma 27.7 and
      // this model's was 54.5 then 44.9 — brighter by 2.0x then 1.6x. Almost all of that excess is
      // specular, so the roughness has to go well past the 0.25-0.45 a flat sheet would want. A dark
      // mass whose value is twice the reference cannot read as hair whatever detail is put on it.
      // 0.62-0.88, kept after SIX material settings were measured against the reference's tonal
      // distribution, one change per capture. The reference is p50 15.3 with p90 81.0 — a near-black
      // mass with a narrow hard highlight, ratio 5.3. This setting reaches ratio 3.2, the best of the
      // six, at a mean of 27.9 against the reference's 27.7.
      //
      //   normalScale 0.9 -> 1.9            range 51.0 -> 51.0
      //   roughness .62-.88 -> .22-.42      range 51.0 -> 50.0
      //   albedo halved                     p75  51.7 -> 50.0
      //   flatShading true -> false         range 49.7 -> 13.3   (far worse; smooth normals over a
      //                                     coarse mesh leave no facet facing the key, so the
      //                                     highlights vanish entirely)
      //   specularIntensity .70 -> 1.0      p90 59 -> 70.7 but p50 18.3 -> 43.3
      //   rough .16-.30 with spec 1.0       range 74.0 - the target! - but mean 46.3, ratio 1.9
      //
      // The last one is the finding: the RANGE is reachable and the SHAPE is not. Every setting that
      // lifts the highlight lifts the bulk with it, because on a flat-shaded 16x13 mesh a facet is
      // uniformly lit and there is no sub-facet variation to make the highlight selective. The
      // reference's ratio needs finer normal variation than this mesh carries — it is a geometry and
      // texture-resolution problem, not a material one.
      //
      // The reference's tonal SHAPE is a near-black mass with a narrow hard highlight — by percentile
      // p25 9.0, p50 15.3, p75 23.0, then p90 81.0. This model is mid-grey throughout: p25 16.7,
      // p50 23.0, p75 51.7, p90 65.0. The obvious reading was that a rough surface spreads specular
      // over everything and a glossier one would concentrate it, so 0.22-0.42 was tried. It moved the
      // range from 51.0 to 50.0 — nothing. `normalScale` 0.9 -> 1.9 moved it 51.0 -> 51.0, and halving
      // the albedo moved p75 51.7 -> 50.0.
      //
      // Four material parameters, none of which touches the contrast gap. It is not a material
      // problem. Recorded here so the next attempt starts from that instead of re-testing these.
      const rough = Math.min(1, Math.max(0, 0.62 + 0.26 * tone * (0.55 + 0.45 * edge) + drift * 0.4));
      const v = Math.round(rough * 255);
      const o = (y * w + x) * 4;
      data[o] = v;
      data[o + 1] = v;      // green is the channel roughnessMap reads
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // One set of lanes from the front midline round to the nape. U folds at both ends, so the pattern
  // mirrors left to right instead of showing a seam.
  tex.repeat.set(1, 1);
  // Mipmaps and sampler anisotropy, because the head is seen at a grazing angle over most of its
  // area and an unmipped 64-wide texture there is what produced the rib pattern. 64x16 is power of
  // two, so mipmapping is available. This is texture filtering, unrelated to the material anisotropy
  // that would need `computeTangents`.
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function ellipsoid(
  name: string,
  scale: [number, number, number],
  position: [number, number, number],
  mat: THREE.Material,
  segments = 1,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, segments), mat);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  return mesh;
}

function taperedBetween(
  name: string,
  start: THREE.Vector3,
  end: THREE.Vector3,
  startRadius: number,
  endRadius: number,
  mat: THREE.Material,
  radialSegments = 6,
): THREE.Mesh {
  const direction = end.clone().sub(start);
  const length = direction.length();
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(endRadius, startRadius, length, radialSegments, 1),
    mat,
  );
  mesh.name = name;
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

function profiledAxis(
  name: string,
  sections: Array<[number, number, number, number, number]>,
  mat: THREE.Material,
  radialSegments = 6,
): THREE.Mesh {
  const vertices: number[] = [];
  const indices: number[] = [];
  const angleOffset = Math.PI / radialSegments;

  for (const [x, y, topRadius, bottomRadius, depthRadius] of sections) {
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = (segment / radialSegments) * Math.PI * 2 + angleOffset;
      const vertical = Math.sin(angle);
      const verticalRadius = vertical >= 0 ? topRadius : bottomRadius;
      vertices.push(x, y + vertical * verticalRadius, Math.cos(angle) * depthRadius);
    }
  }

  for (let section = 0; section < sections.length - 1; section += 1) {
    const current = section * radialSegments;
    const next = (section + 1) * radialSegments;
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const a = current + segment;
      const b = current + (segment + 1) % radialSegments;
      const c = next + segment;
      const d = next + (segment + 1) % radialSegments;
      if ((section + segment) % 2 === 0) {
        indices.push(a, c, b, b, c, d);
      } else {
        indices.push(a, c, d, a, d, b);
      }
    }
  }

  const startCenter = vertices.length / 3;
  vertices.push(sections[0][0], sections[0][1], 0);
  const endCenter = vertices.length / 3;
  const end = sections[sections.length - 1];
  vertices.push(end[0], end[1], 0);
  for (let segment = 0; segment < radialSegments; segment += 1) {
    const next = (segment + 1) % radialSegments;
    const last = (sections.length - 1) * radialSegments;
    indices.push(startCenter, segment, next);
    indices.push(endCenter, last + next, last + segment);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = name;
  return mesh;
}

function footWedge(name: string, centerX: number, mat: THREE.Material): THREE.Mesh {
  // Flatter and narrower than the first blockout. The foot band was the model's most
  // over-built region — 16.6% extra material from the front and 13.2% in profile — because the
  // sections were near-circular, giving a rounded bootie where the baseline has a flat sole with
  // a low instep. Vertical radius carries most of the reduction; width only tapers at the heel,
  // which is where the ankle band was measured 0.0195 too wide.
  const sections: Array<[number, number, number, number]> = [
    [-0.22, 0.125, 0.075, 0.1],
    [-0.04, 0.125, 0.11, 0.155],
    [0.2, 0.13, 0.125, 0.185],
    [0.43, 0.115, 0.105, 0.17],
    [0.64, 0.085, 0.07, 0.135],
  ];
  const vertices: number[] = [];
  const indices: number[] = [];
  const radialSegments = 8;
  for (const [z, centerY, verticalRadius, halfWidth] of sections) {
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = (segment / radialSegments) * Math.PI * 2 + Math.PI / radialSegments;
      vertices.push(
        centerX + Math.cos(angle) * halfWidth,
        centerY + Math.sin(angle) * verticalRadius,
        z,
      );
    }
  }
  for (let section = 0; section < sections.length - 1; section += 1) {
    const current = section * radialSegments;
    const next = (section + 1) * radialSegments;
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const a = current + segment;
      const b = current + (segment + 1) % radialSegments;
      const c = next + segment;
      const d = next + (segment + 1) % radialSegments;
      indices.push(a, c, b, b, c, d);
    }
  }
  const startCenter = vertices.length / 3;
  vertices.push(centerX, sections[0][1], sections[0][0]);
  const endCenter = vertices.length / 3;
  const end = sections[sections.length - 1];
  vertices.push(centerX, end[1], end[0]);
  for (let segment = 0; segment < radialSegments; segment += 1) {
    const next = (segment + 1) % radialSegments;
    const last = (sections.length - 1) * radialSegments;
    indices.push(startCenter, next, segment);
    indices.push(endCenter, last + segment, last + next);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = name;
  return mesh;
}

// --- Continuous body surface ------------------------------------------------
//
// The reference is ONE fused mesh — 1,000,000 triangles, no part decomposition, every macro
// region flowing into its neighbour with no seam (measured, see artifacts/low-poly-humanoid/
// image-analysis.md). `grimoire/intake/surface_topology.md` calls that `continuous-sculpt`:
// "a single, smoothly-varying volume with no internal seams or panel breaks."
//
// Building it from separate `facetedBody` calls cannot reproduce that, because each call emits
// its own closed shell — so the shells meet at a visible ring boundary wherever they overlap.
// That is the measured cause of the one defect signature no parameter sweep could remove: a
// region reporting missing AND extra material at the same time (thigh 2.9%/9.7%, feet 7.7%/9.4%,
// neck-shoulder 8.7%/10.5% in profile). Widening fixes the missing half and worsens the extra
// half; narrowing does the reverse.
//
// So the skin volume is defined as a signed distance field and polygonised once. Smooth-union
// (`smin`) is what makes a deltoid out of a chest and an upper arm instead of two tubes crossing.

/** Signed distance to a capsule segment — the primitive every limb and the trunk are built from. */
function sdCapsule(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  ra: number, rb: number,
): number {
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const baLen2 = bax * bax + bay * bay + baz * baz;
  let h = baLen2 > 0 ? (pax * bax + pay * bay + paz * baz) / baLen2 : 0;
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  // Radius lerps along the segment, so one primitive can taper (wrist to elbow, ankle to calf).
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - (ra + (rb - ra) * h);
}

/**
 * Polynomial smooth minimum. `k` is the blend radius in world units.
 *
 * Research corpus (notebook ab7334f3) gives k = 0.15–0.35 of the primitive radius for large
 * joints — shoulder into chest, thigh into hip — and 0.02–0.08 for small detail. Too large and
 * the figure inflates into a blob; too small and the seam the field exists to remove comes back.
 */
function smax(a: number, b: number, k: number): number {
  if (k <= 0) return Math.max(a, b);
  const h = Math.max(0, Math.min(1, 0.5 - (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h + k * h * (1 - h);
}

function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

type Capsule = {
  a: [number, number, number];
  b: [number, number, number];
  ra: number;
  rb: number;
  /** Non-uniform scale applied to the sample point, so a capsule can read as an ellipse in section. */
  squash?: [number, number, number];
  /**
   * Asymmetry about the capsule's own axis, as `[above, infront]` multipliers.
   *
   * `squash` scales the whole section, so whatever it does above the axis it also does below, and a
   * chain of such sections reads as a string of ellipsoids however carefully the radii are tuned.
   * Anatomy is not symmetric about a bone: a deltoid is full above and outside, an upper arm carries
   * more below than above, an olecranon projects behind. These multiply the offset on the positive
   * side only — larger means SMALLER on that side, matching `squash` — so one capsule can be full
   * above and lean below without moving its axis.
   */
  bias?: [number, number];
  /** Blend radius used when this part joins the accumulated field. */
  k: number;
  /** `carve` subtracts instead of adding — the only operation that creates a crease. */
  op?: 'add' | 'carve';
  /**
   * An oriented rounded BOX instead of a capsule, centred on `a`, with `b` ignored.
   *
   * WHY A BOX HAD TO EXIST. The brief for the chest asks for large readable planes — clavicle plane,
   * upper pec plane, lower pec plane, sternum plane — and a capsule cannot make a plane at any setting.
   * Its surface is an ellipsoidal cap: squash flattens it but never straightens it, so a pec built from
   * capsules is a blob however the radii are tuned, and cutting a dome with more domes only trades one
   * curvature for another. Nor will an actual half-space do, because a plane is infinite and would cut
   * the neck and the belly along with the chest. A rounded box is the primitive that is flat where it
   * matters and bounded everywhere else.
   *
   * `size` is the half-extent on each local axis before rotation; `round` fillets the edges, which is
   * what keeps a plane change from reading as a machined step. `yaw` turns it about y, `pitch` about x,
   * `roll` about z, applied in that order.
   */
  plate?: {
    size: [number, number, number];
    round: number;
    yaw?: number;
    pitch?: number;
    roll?: number;
  };
  /**
   * Exempt from BODY_RADIUS_SCALE.
   *
   * That scalar exists to compensate for blend inflation across the torso and limbs, where the
   * radii were inherited from the old ring stack. Head radii are read straight off the landmark
   * table, so trimming them by 16% put the written number and the rendered number out of step —
   * which is why the first head attempt could not be sized by reasoning.
   */
  exact?: boolean;
};

/**
 * The skin volume, as capsules that smooth-union into one surface.
 *
 * Every y here is read off the measured landmark table in
 * `artifacts/low-poly-humanoid/image-analysis.md`, converted from y/H to this factory's units
 * (H = 6.674 before the root's 1.1 vertical scale, so y_local = (y/H) * 6.674 / 1.1 + 0.036).
 * The widths come from the same table: waist 0.1536 H, chest 0.2310 H, neck 0.0688 H — the
 * 1 : 1.50 waist-to-chest taper and the neck being the narrowest section of the whole figure are
 * both measurements, not styling choices.
 *
 * `squash` carries the depth ratio: the reference is 0.183 H deep against 0.231 H wide at the
 * chest, so the trunk is an ellipse in section, not a circle. Applying that as a sample-space
 * scale keeps one capsule primitive doing the work of a lofted profile.
 */
const BODY_CAPSULES: Capsule[] = [
  // Trunk. Every y and radius below is the measured landmark table converted into this
  // factory's local units, NOT carried over from the old ring stack — carrying them over is what
  // made the first polygonised body 30% too narrow at the chest.
  //   y_local = ((y/H)*6.674 - 0.03 + 0.04) / 1.1      x_local = (w/H)*6.674 / 2 / 1.02
  // giving hip 2.964/0.610, waist 3.577/0.503, chest 4.487/0.756, neck 5.245/0.225.
  // squash z is width/depth from the same table, so the trunk is an ellipse in section: the
  // reference is 0.2310 H wide and 0.1379 H deep at the chest.
  // At y/H 0.56 the hip runs 0.1090 H deep against the baseline's 0.0845 — 29% over — with its
  // centre 0.0042 H behind. The depth comes off through the squash and the centre moves forward
  // with the offset, so the buttock stops overhanging without dragging the front of the hip back.
  { a: [0, 2.78, -0.072], b: [0, 2.964, -0.072], ra: 0.600, rb: 0.610, squash: [1, 1, 2.92], k: 0.24 },
  { a: [0, 2.964, -0.10], b: [0, 3.577, -0.088], ra: 0.560, rb: 0.392, squash: [1, 1, 1.358], bias: [1, 1.08], k: 0.30 },
  // The front bias is now on BOTH trunk sections and the junction has moved up.
  //
  // The upper section had no `bias` while the lower one had 1.16, so its unbiased spherical cap of radius
  // 0.745 reached z 0.411 where the lower section reached 0.341 — the cap won everywhere, and the front
  // of the chest was a sphere centred at y 4.487. A sphere split down the middle by the sternum groove is
  // two round halves, which is exactly how it read.
  //
  // 1.28 WAS TOO FAR, AND THE MEASUREMENT SAID SO: it put the chest's z span 10.4% BELOW the reference at
  // y/H 0.271, 12.1% at 0.312 and 7.3% at 0.354. The dome was gone and so was the chest. 1.09 brings the
  // front from 0.283 out to 0.371, which is the 0.088 local the GLB's own cross-section was short by. The
  // seven chest plates move forward by the same 0.088, or they would carve a surface that has moved out
  // from under them — which is exactly what happened the first time, when flattening left them cutting
  // air. At 1.28 the front sat at z 0.298: the
  // ribcage's forward projection past its own centre drops from 0.531 to 0.418, or 21%, and the pec
  // plates below take it the rest of the way.
  //
  // The junction moves 4.487 → 4.565, which lifts the fullest section of the chest by 0.078 — 12% of the
  // 0.65 chest height, the middle of the 10–15% the brief asks for. Volume was sitting low enough to read
  // as sag; the widest point of a male chest is above the nipple line, not below it.
  { a: [0, 3.577, -0.088], b: [0, 4.565, -0.095], ra: 0.392, rb: 0.580, squash: [1, 1, 1.393], bias: [1, 0.96], k: 0.32 },
  // The trunk's own top cap was the wide thing in the worst band, not the neck and not the traps: a
  // capsule reaches `rb` above `b`, so ending at y 4.86 with rb 0.36 put trunk 0.30 half-wide at local
  // y 5.22, where the reference is 0.229. Narrowing the neck by 30% and dropping the traps moved the band
  // only from +38.3% to +34.6% for exactly this reason — neither of them owned the measurement. 4.82 with
  // rb 0.26 tops out at 5.08, under the band.
  { a: [0, 4.565, -0.095], b: [0, 4.82, -0.105], ra: 0.580, rb: 0.26, squash: [1, 1, 1.393], bias: [1, 0.96], k: 0.16 },
  // THE LAT AND SERRATUS CAPSULES ARE DELETED, and the reason is worth keeping.
  //
  // They were added when the trunk was the visible surface: the flank lost 0.180 of half-width between
  // local y 4.46 and 4.20 where the reference loses 0.078, because a capsule interpolates linearly
  // between its ends and cannot carry a mass that swells between them. Four capsules per side fixed it
  // and took x accuracy from 3.91% to 3.45%.
  //
  // The torso shell then took over the flank, and the same capsules became the small bright lump the
  // review kept seeing on both hips. Measuring shell against body slice by slice says it plainly:
  //
  //     local y   shell |x|   body |x|
  //       3.80      0.4940     0.5161   <- body outside by 0.022
  //       3.90      0.5310     0.5397   <- body outside by 0.009
  //
  // The isosurface was standing proud of the surface meant to cover it, so a piece of it appeared past
  // the flank in three-quarter views. There is nothing to tune here — the mass they add is now the
  // shell's job, and any radius large enough to be a lat is large enough to come through.

  // Trapezius. The baseline carries 0.1315 H of width at y/H 0.18 — local 5.10, the base of the
  // neck — where this model carried 0.0962, because it had no trapezius at all: the neck rose as a
  // bare column and the shoulders began as a near-horizontal shelf below it. The reference instead
  // slopes from the deltoid up to the neck, so the flare starts one head-height higher. These two
  // capsules are the slope; the blend radius is deliberately large so they read as one mass with
  // the chest rather than as a pair of struts.
  //
  // The TOP of these caps was the widest thing in the figure's worst band. A capsule's spherical cap
  // reaches `ra` above its axis, so an axis at y 4.96 with ra 0.175 put trapezius 0.315 wide at local
  // y 5.135 — inside the band 5.09..5.35, where the reference is only 0.229 half-wide because its own
  // traps have already tapered. Dropping the axis to 4.89 and the radius to 0.148 puts the cap's top at
  // 5.038, below the band, and leaves the band's width to the neck and the jaw where it belongs.
  { a: [-0.14, 4.89, -0.16], b: [-0.58, 4.79, -0.11], ra: 0.148, rb: 0.17, k: 0.08 },
  { a: [0.14, 4.89, -0.16], b: [0.58, 4.79, -0.11], ra: 0.148, rb: 0.17, k: 0.08 },
  // REAR VIEW, MEASURED. Half-widths off the rear silhouette, normalised by figure height:
  //     factory y   reference   model     error
  //     5.12        0.0564      0.0349    -38.1%
  //     5.02        0.1225      0.0763    -37.7%
  //     4.96        0.3440      0.2273    -33.9%
  //     4.90        0.5000      0.3674    -26.5%
  //     4.84        0.4903      0.4835     -1.4%
  // The trapezius is a third too narrow over the whole run from the neck base to the shoulder, which is
  // why the rear reads as a bare column dropping onto a flat shelf. It is widened OUTWARD, not upward:
  // the note above is right that a cap reaching past y 5.09 lands in the neck/jaw band where the
  // reference has already tapered, and that band cost +38.3% once. The outer end goes from x 0.58 to
  // 0.82 — the arm chain's own root — so the slope now runs all the way to the deltoid instead of
  // stopping halfway and leaving the shelf. Cap tops: inner 5.05, outer 5.03, both still clear of 5.09.
  // Blend 0.08 -> 0.145 so it unions as one mass rather than reading as a pair of struts.
  //
  // TRAPEZIUS RIDGE — the rear-view deficit, fitted into the only window that is free.
  //
  // Measured off the rear silhouette, half-widths normalised by figure height:
  //     factory y   reference   model     error
  //     5.12        0.0564      0.0349    -38.1%
  //     5.02        0.1225      0.0763    -37.7%
  //     4.96        0.3440      0.2273    -33.9%
  //     4.90        0.5000      0.3674    -26.5%
  //     4.84        0.4903      0.4835     -1.4%
  // The neck-to-shoulder run is a third too narrow, which is why the rear reads as a bare column on a
  // flat shelf. But the cross-section band at the clavicle says the model is already +6.3% too WIDE, so
  // the width cannot be added by widening the trapezius below: taking its outer end to x 0.82 put that
  // band at +23.0%, and 0.645 put it at +10.5%. Both were reverted.
  //
  // This ridge spans y 4.837..5.026 — above the clavicle band, and below 5.09 where the neck/jaw band
  // sits and where a cap once cost +38.3%. It adds the trapezius where the rear view is short and
  // nowhere else.
  { a: [-0.20, 4.955, -0.185], b: [-0.70, 4.925, -0.135], ra: 0.085, rb: 0.105, k: 0.090 },
  { a: [0.20, 4.955, -0.185], b: [0.70, 4.925, -0.135], ra: 0.085, rb: 0.105, k: 0.090 },
  // Trapezius → neck. The neck is the narrowest section measured anywhere on the figure.
  // THE NECK HAD NO TAPER. Between local y 5.48 and 5.22 the reference narrows from 0.327 half-wide to
  // 0.229 — the jaw closing into the neck, and the single largest error anywhere on the figure lives in
  // that band: x +38.3%. The model went 0.321 to 0.317, so the neck was as wide as the skull and the head
  // sat on a column instead of on a neck. Radii come down 30% and the trapezius blend from 0.13 to 0.08,
  // because a wide smooth union with the traps was inflating whatever the neck's own radius said.
  //
  // 0.153/0.120 OVERSHOT. That band went from +38.3% to -19.7% — the trunk's top cap was the thing
  // making it wide, and once that was lowered the neck was carrying the band alone and was far too thin
  // for it. 0.190/0.156 is sized against the reference's own 0.229 half-width there.
  // (deleted — the field's neck column; the `Neck` lathe is the neck, see the note above)
  // THE RIB CREASES ARE GONE. They were two carves running the full width of the chest at y 4.09 and
  // y 4.27, and the second of them sat inside the pec band — a full-width horizontal groove across the
  // centre of the chest, which is precisely what a chest must not have. They were authored as rib lines
  // and they read as a shelf, because a horizontal cut across a rounded front reads as a shelf whatever
  // it was meant to be. Nothing replaces them: rib definition on this reference lives in the abdominal
  // bands lower down, which are additive planes, not grooves.
  // THE CHEST IS CUT BY PLATES, NOT BUILT FROM BLOBS.
  //
  // The old pectorals were two flattened capsules unioned onto the trunk, and the old sternum and
  // lower-pec boundaries were capsule carves. Both had the same problem: a capsule's surface is an
  // ellipsoidal cap, so a pec made of them is a mound and a boundary made of them is a rounded gutter.
  // Neither can produce the thing the reference has, which is a change of PLANE.
  //
  // The carves had also stopped working. They were seated for a chest whose front reached z 0.411, and
  // flattening the dome brought it to 0.298 — the sternum carve's near face sat at 0.358 and the lower
  // pec's at 0.271, both in front of the skin, cutting nothing at all. Anything re-seated here has its
  // depth quoted against the measured surface rather than inherited.
  //
  // Each plate is an oriented rounded box used as a carve, positioned so its flat BACK face lands on the
  // surface it defines: the box swallows everything in front of that plane inside its own bounds, and
  // what survives is the plane. A plate's `pitch` tilts it about x, so the plane it leaves tilts with it.
  //
  // Depth targets come from the GLB's own cross-sections: at local y 4.40 the reference's chest front is
  // at z 0.287 and its half-width 0.696; at y 4.15, z 0.275.

  // STERNUM. A shallow vertical plane, not a trench: it takes the surface from 0.298 back to 0.280, so
  // 0.018 deep. Width is 2 x (0.018 + 0.010) = 0.056, which is 4% of the 1.40 chest width — the top of
  // the 2-4% the brief allows. It stops at y 4.62 so the upper sternum stays flat.
  // RETIRED (sternum carve plate) — replaced by the plate-tiled chest below.
  // { a: [0, 4.40, 0.498], b: [0, 4.40, 0.498], ra: 0, rb: 0, k: 0.010, op: 'carve', exact: true,
  // plate: { size: [0.034, 0.24, 0.20], round: 0.012 } },  // back face z 0.480 - 0.20 - 0.01 = 0.270

  // LOWER-PEC CUT. A plane that tilts back going down, so the chest tucks under the pec instead of
  // hanging below it. The plane is z = 0.272 + 0.309 (y - 4.25): no cut at all at y 4.40, 0.05 of cut by
  // y 4.10. Angled down toward the sternum because the plate is centred at x = +/-0.34 and its own width
  // runs out before the centre line, so the cut is deepest outboard and fades inboard — the chevron the
  // reference has, made as a plane change rather than as a groove.
  //
  // The first seating of this plate cut 0.003 at y 4.15 and nothing at 4.28 — the ribcage already tapers
  // there, so a plane laid ON the taper removes nothing and shows nothing. The plane now runs
  // z = 0.255 + 0.40 (y - 4.28): 0.026 of cut at the boundary, 0.041 by y 4.15, and still clear of the
  // pec at 4.40. A boundary is only visible if the two sides of it are at different depths.
  // RETIRED (lower-pec carve plate L) — replaced by the plate-tiled chest below.
  // { a: [-0.34, 4.199, 0.614], b: [-0.34, 4.199, 0.614], ra: 0, rb: 0, k: 0.016, op: 'carve', exact: true,
  // plate: { size: [0.30, 0.150, 0.30], round: 0.030, pitch: 0.2165 } },
  // RETIRED (lower-pec carve plate R) — replaced by the plate-tiled chest below.
  // { a: [0.34, 4.199, 0.614], b: [0.34, 4.199, 0.614], ra: 0, rb: 0, k: 0.016, op: 'carve', exact: true,
  // plate: { size: [0.30, 0.150, 0.30], round: 0.030, pitch: 0.2165 } },

  // PECTORALS, as two flat heads rather than one blob or one box.
  //
  // The chest had NO pec mass at all after the dome was removed, and the measurement says so as plainly
  // as the eye does: the reference's chest front sits at local z 0.285 at y 4.46, 0.279 at 4.20 and 0.256
  // at 3.95, and the model reached 0.251, 0.222 and 0.186 — behind by 0.034, 0.057 and 0.070 across the
  // whole pec. Total depth was only 3-7% short, so the shortfall was not size, it was that the ribcage's
  // z CENTRE sat 0.021 too far back and nothing stood in front of it. A chest without a pectoralis is a
  // ribcage, and it reads as one.
  //
  // Two heads, because a pectoralis has two and because that is what puts a plane break across the middle
  // of the muscle instead of a single dome over it:
  //   sternal head   — from the sternum out and slightly UP to the humerus, the larger mass, and the one
  //                    the lower-pec plate cuts along its bottom edge
  //   clavicular head — from the collarbone out and slightly DOWN, thinner, sitting proud of the first
  //
  // Each is a capsule squashed hard on z (2.6 and 2.8) so it is a SLAB, and moderately on y so it is
  // wider than it is tall — the fibre direction of the muscle. `exact` keeps their radii literal: the
  // 0.84 global scale exists to compensate for blend inflation on the inherited ring stack, and these are
  // authored against measurements, not inherited.
  //
  // They protrude 0.020 past the ribcage at the sternum and fade to nothing at the armpit, which is the
  // whole of the projection a flat male chest has. The definition comes from the four cuts around them.
  // RETIRED (sternal pec head L) — replaced by the plate-tiled chest below.
  // { a: [-0.215, 4.36, 0.318], b: [-0.47, 4.44, 0.240], ra: 0.150, rb: 0.130, squash: [1, 1.30, 2.6], k: 0.10, exact: true },
  // RETIRED (sternal pec head R) — replaced by the plate-tiled chest below.
  // { a: [0.215, 4.36, 0.318], b: [0.47, 4.44, 0.240], ra: 0.150, rb: 0.130, squash: [1, 1.30, 2.6], k: 0.10, exact: true },
  // RETIRED (clavicular pec head L) — replaced by the plate-tiled chest below.
  // { a: [-0.205, 4.58, 0.320], b: [-0.45, 4.53, 0.242], ra: 0.130, rb: 0.112, squash: [1, 1.40, 2.8], k: 0.09, exact: true },
  // RETIRED (clavicular pec head R) — replaced by the plate-tiled chest below.
  // { a: [0.205, 4.58, 0.320], b: [0.45, 4.53, 0.242], ra: 0.130, rb: 0.112, squash: [1, 1.40, 2.8], k: 0.09, exact: true },

  // THE CHEST IS CARVED OUT OF A FULL RIBCAGE, NOT BUILT UP FROM PLATES.
  //
  // Three representations were tried here and the first two failed for the same reason, which is worth
  // recording so it is not tried a fourth time.
  //
  //   capsules            a capsule's surface is an ellipsoidal cap, so a pec made of one is a
  //                       hemisphere and the pair read as two spheres with a groove between them
  //   plates, ADDED       a plate's face is planar, but to show a plane the face must stand proud of
  //                       the shell — and then all FOUR of its edges stand proud too, so the chest read
  //                       as rectangular slabs laid on the torso. Raising the blend to hide the unwanted
  //                       edges (k 0.05 -> 0.115) erased the wanted ones with them: a smooth union
  //                       blurs a primitive's whole outline and cannot keep one edge while losing
  //                       another. Enlarging the plates so the unwanted edges would sink into the
  //                       shoulder and flank did not help either, because a face that stands 0.06 proud
  //                       stands proud in every direction.
  //
  // So the chest is CARVED. The trunk's front bias goes from 1.09 to 0.96, which fills the ribcage out
  // past the reference on purpose, and the planes are cut back into it. A carving plate's other three
  // edges lie inside solid material where nothing can see them; only the cut face reaches the surface.
  // This is how the sternum, lower-pec, clavicle and armpit cuts have always worked here — they never
  // produced a box — and the mistake was trying to make the pec MASS the same way.
  //
  // Faces are seated on the measured skin of the filled ribcage, not on arithmetic:
  //
  //   sternum       a 0.070 strip at z 0.372, 0.021 behind the pec faces — 5% of the 1.40 chest, and
  //                 shallow enough that it cannot throw the dark vertical line the brief forbids
  //   upper pec     pitched back 0.40 so the chest falls away toward the collarbone; this is the
  //                 upper-chest shelf and the clavicle plane in one plane change rather than a groove
  //   lower pec     pitched forward 0.34 so the chest tucks under, rolled 0.10 so its lower edge runs
  //                 level outboard and dips toward the sternum — the shallow chevron
  { a: [0, 4.46, 0.578], b: [0, 4.46, 0.578], ra: 0, rb: 0, k: 0.012, op: 'carve', exact: true,
    plate: { size: [0.035, 0.30, 0.20], round: 0.010 } },
  { a: [-0.330, 4.870, 0.517], b: [-0.330, 4.870, 0.517], ra: 0, rb: 0, k: 0.030, op: 'carve', exact: true,
    plate: { size: [0.290, 0.230, 0.24], round: 0.030, pitch: -0.40 } },
  { a: [0.330, 4.870, 0.517], b: [0.330, 4.870, 0.517], ra: 0, rb: 0, k: 0.030, op: 'carve', exact: true,
    plate: { size: [0.290, 0.230, 0.24], round: 0.030, pitch: -0.40 } },
  { a: [-0.320, 4.055, 0.524], b: [-0.320, 4.055, 0.524], ra: 0, rb: 0, k: 0.026, op: 'carve', exact: true,
    plate: { size: [0.280, 0.215, 0.24], round: 0.030, pitch: 0.34, roll: -0.10 } },
  { a: [0.320, 4.055, 0.524], b: [0.320, 4.055, 0.524], ra: 0, rb: 0, k: 0.026, op: 'carve', exact: true,
    plate: { size: [0.280, 0.215, 0.24], round: 0.030, pitch: 0.34, roll: 0.10 } },

  // ABDOMEN, carved for the same reason the chest is.
  //
  // Six added plates were built here first and they read as rectangular tiles in the beauty render,
  // exactly as the added pec plates did: a face that stands proud stands proud on all four edges. Abs
  // are grooves between masses anyway — the linea alba down the middle and the tendinous intersections
  // across it — so carving is both the representation that works here and the anatomy.
  //
  // The vertical groove is 0.030 wide and deepens going down: nothing at the sternum, 0.012 by the
  // navel, which is the brief's "only the linea alba below the pec becomes clear". The two horizontal
  // grooves are SHORT — half-width 0.135 against the belly's 0.26 — so they stop well inside the flank
  // and leave the oblique between them and the side of the torso, rather than running the full width
  // the way the three retired capsule bands did.
  { a: [0, 3.78, 0.560], b: [0, 3.78, 0.560], ra: 0, rb: 0, k: 0.020, op: 'carve', exact: true,
    plate: { size: [0.015, 0.30, 0.20], round: 0.010, pitch: 0.05 } },
  { a: [0, 3.925, 0.556], b: [0, 3.925, 0.556], ra: 0, rb: 0, k: 0.022, op: 'carve', exact: true,
    plate: { size: [0.135, 0.014, 0.20], round: 0.010 } },
  { a: [0, 3.700, 0.545], b: [0, 3.700, 0.545], ra: 0, rb: 0, k: 0.022, op: 'carve', exact: true,
    plate: { size: [0.120, 0.013, 0.20], round: 0.010 } },

  // NO ADDITIVE PEC PLATES. Four were built — an upper and a lower plane per side, unioned on at the
  // trunk's own depth so their flat faces would replace its curve. They read as rectangular PANELS: a
  // box has four straight edges and only two of them wanted to be there, so the pec gained a vertical
  // seam on each side that no chest has. Trading a round blob for a rectangular one is not progress.
  //
  // The pec is instead the plateau left BETWEEN the four cuts — sternum inboard, lower-pec cut below,
  // clavicle plane above, armpit outboard. Its surface stays the trunk's own gentle curvature, which is
  // what a pec over a ribcage actually is; the definition comes from the boundaries, which is where the
  // reference's definition comes from too.

  // CLAVICLE PLANE. Tilts the other way, so the chest falls away as it rises to the collarbone. This is
  // what stops the upper chest reading as flat while the lower chest bulges — the brief's inverted
  // volume distribution — without adding any projection lower down.
  { a: [-0.30, 4.822, 0.652], b: [-0.30, 4.822, 0.652], ra: 0, rb: 0, k: 0.045, op: 'carve', exact: true,
    plate: { size: [0.42, 0.20, 0.30], round: 0.05, pitch: -0.42 } },
  { a: [0.30, 4.822, 0.652], b: [0.30, 4.822, 0.652], ra: 0, rb: 0, k: 0.045, op: 'carve', exact: true,
    plate: { size: [0.42, 0.20, 0.30], round: 0.05, pitch: -0.42 } },

  // ANTERIOR ARMPIT. The outer pec has to END somewhere, and on the old chest it dissolved into the
  // deltoid through one wide smooth union. This plate yaws about y so the plane cuts back as x grows,
  // which puts a real edge on the outer pec and makes the front wall of the armpit. It is bounded in y,
  // so it does not follow the arm outward.
  { a: [-0.695, 4.45, 0.585], b: [-0.695, 4.45, 0.585], ra: 0, rb: 0, k: 0.022, op: 'carve', exact: true,
    plate: { size: [0.26, 0.30, 0.30], round: 0.035, yaw: -0.55 } },
  { a: [0.695, 4.45, 0.585], b: [0.695, 4.45, 0.585], ra: 0, rb: 0, k: 0.022, op: 'carve', exact: true,
    plate: { size: [0.26, 0.30, 0.30], round: 0.035, yaw: 0.55 } },
  // Three abdominal bands, upper wider than lower, each a broad plane rather than a rounded muscle.
  // RETIRED (upper abdominal band) — replaced by the plate-tiled chest below.
  // { a: [-0.235, 4.02, 0.204], b: [0.235, 4.02, 0.204], ra: 0.150, rb: 0.150, squash: [1, 1, 2.5], k: 0.070, exact: true },
  // RETIRED (middle abdominal band) — replaced by the plate-tiled chest below.
  // { a: [-0.205, 3.80, 0.188], b: [0.205, 3.80, 0.188], ra: 0.140, rb: 0.140, squash: [1, 1, 2.5], k: 0.070, exact: true },
  // RETIRED (lower abdominal band) — replaced by the plate-tiled chest below.
  // { a: [-0.170, 3.58, 0.162], b: [0.170, 3.58, 0.162], ra: 0.130, rb: 0.130, squash: [1, 1, 2.5], k: 0.070, exact: true },
  // BACK. Until now the back was whatever the trunk's rear half happened to be — one smooth sheet
  // with no anatomy in it, which is exactly how it read. Four features, all shallow planes:
  //
  //   trapezius shelf   broad, from the neck out over the shoulder girdle
  //   scapula planes    a diagonal plane change, not two bony lumps
  //   lat masses        long planes widening under the armpit and tapering into the waist
  //   spine groove      shallow at the top, clearer lower down, never a trench
  //
  // The groove's x half-extent is 0.09 — 3.2 samples at this resolution — because a narrower one
  // does not exist on this grid however deep it is cut.
  // Lat: the only ADDITIVE mass back here, and deliberately small. Six masses at radius 0.185-0.215
  // with blends of 0.13-0.16 merged into a single oval dome — an additive mass of that size is a
  // balloon whatever its squash, and the brief is explicit that the scapula must not be two bony
  // lumps. So the planes are CUT, not piled.
  { a: [-0.34, 4.40, -0.34], b: [-0.42, 3.92, -0.30], ra: 0.150, rb: 0.125, squash: [1, 1, 3.2], k: 0.11, exact: true },
  { a: [0.34, 4.40, -0.34], b: [0.42, 3.92, -0.30], ra: 0.150, rb: 0.125, squash: [1, 1, 3.2], k: 0.11, exact: true },
  // NO scapular or lat-boundary cuts. Two attempts are recorded here because both failed and for the
  // same reason. Additive masses at radius 0.185-0.215 merged into one oval dome; replacing them with
  // carves of radius 0.070-0.085 punched visible GOUGES rather than reading as plane changes. On a
  // rear surface that is one smooth capsule, a carve narrow enough to be a boundary is also narrow
  // enough to be a hole. A plane change needs two planes to change between, which this
  // representation does not have back here — the fix is explicit rear geometry or a much wider and
  // shallower cut, not a smaller one.
  //
  // The spine groove survives because it is long and continuous rather than local, so it reads as a
  // channel instead of a dent. Its x half-extent is 0.09 — 3.2 samples — below which nothing exists.
  { a: [0, 4.58, -0.585], b: [0, 4.06, -0.585], ra: 0.090, rb: 0.090, squash: [1, 1, 4.2], k: 0.030, op: 'carve', exact: true },
  { a: [0, 4.06, -0.575], b: [0, 3.54, -0.568], ra: 0.090, rb: 0.090, squash: [1, 1, 3.0], k: 0.030, op: 'carve', exact: true },
  // Deltoid masses. These exist to be blended — they are what turns a chest plus an arm into a
  // shoulder instead of two tubes crossing at right angles.
  //
  // A real z error lives here and is deliberately NOT corrected. A T-posed arm projects to the same
  // height from the front and the rear only if it lies in the camera plane; the baseline's arm reads
  // 0.005 H higher from the rear than from the front, so it sits behind the body centre, while this
  // one reads 0.006 H lower. Moving the chain back 0.10 to match did fix the rear (+0.010) and the
  // profile, and collapsed BOTH orbit views (-0.139, -0.133): at 35 degrees a z offset becomes a
  // sideways displacement of 0.10*sin35 = 0.057, which is an order of magnitude more silhouette than
  // the rear-view height error it buys. The rear view keeps the error because the orbits outvote it.
  { a: [-0.471, 4.766, -0.10], b: [-0.82, 4.796, -0.08], ra: 0.21, rb: 0.19, k: 0.20 },
  { a: [0.471, 4.766, -0.10], b: [0.82, 4.796, -0.08], ra: 0.21, rb: 0.19, k: 0.20 },
  // ARM: eleven rings, small amplitudes, asymmetric sections.
  //
  // The previous eleven-ring build put a visible extremum at every ring — shoulder peak, upper-arm
  // bulge, elbow valley, forearm bulge, wrist valley, hand bump — and read as a string of beads. The
  // landmarks had been exaggerated to survive a grid that samples y every 0.0462: each one was made
  // big enough to exist, and together they destroyed the long thin line the reference actually has.
  // Amplitudes now follow the reference's own ratios against mid upper arm = 1.00:
  //
  //   pre-elbow 0.91   elbow 0.84   forearm max 0.89   pre-wrist 0.60   wrist 0.48   palm 0.74
  //
  // The elbow is 8% under pre-elbow rather than 28%, and carries its remaining identity in a
  // posterior bias and a rounder section instead of a waist. Only three variations are large enough
  // to see: the deltoid, a subtle elbow, and the proximal forearm.
  //
  // `bias` is what stops this reading as ellipsoids on a stick — deltoid full above, upper arm
  // fuller below, olecranon behind. Depth is deliberately a SIMPLER curve than the vertical one:
  // deepest at the shoulder, easing to the elbow, a moderate rise at the proximal forearm, flat from
  // the wrist out. A landmark should be strong on one or two contours, never on all of them.
  //
  // Blend is per transition, never global: k stays under the feature it joins, or the join erases
  // the landmark — which is what k 0.08 did to a 0.045 elbow last round.
  //
  //   ring                                  x     radius   ratio    k
  //   shoulder root, deltoid full ABOVE    0.82   0.228   1.11   0.160
  //   deltoid insertion, 15% along the shaft 1.08   0.216   1.05   0.090
  //   upper-arm mid = 1.00, fuller BELOW   1.35   0.205   1.00   0.060
  //   pre-elbow = 0.91                     1.60   0.186   0.91   0.030
  //   elbow = 0.84, olecranon BEHIND       1.83   0.172   0.84   0.030
  //   forearm max = 0.89, 23% from elbow   2.05   0.182   0.89   0.045
  //   forearm mid, monotone from here      2.30   0.148   0.72   0.045
  //   pre-wrist = 0.60                     2.55   0.123   0.60   0.020
  //   wrist = 0.48, the narrowest ring     2.80   0.098   0.48   0.018
  //   palm, 1.55x the wrist and flat on y  3.02   0.152   0.74   0.015
  //   finger block, blunt                  3.20   0.138   0.67   0.014
  //
  // Distal length was redistributed rather than added: the wrist-to-fingertip run grew from 0.41 to
  // 0.40 of the forearm's while the forearm's own distal reach shortened, so the span stays at the
  // 0.99437 the GLB carries.
  { a: [-0.82, 4.8, 0.0], b: [-1.08, 4.802, 0.0], ra: 0.216, rb: 0.203, squash: [1, 1.06, 0.92], bias: [0.89, 1.0], k: 0.16 },
  { a: [-1.08, 4.802, 0.0], b: [-1.35, 4.806, 0.0], ra: 0.203, rb: 0.188, squash: [1, 1.08, 0.93], bias: [0.99, 1.0], k: 0.09 },
  { a: [-1.35, 4.806, 0.0], b: [-1.6, 4.81, 0.0], ra: 0.188, rb: 0.172, squash: [1, 0.96, 0.94], bias: [1.07, 1.0], k: 0.06 },
  { a: [-1.6, 4.81, 0.0], b: [-1.83, 4.814, 0.0], ra: 0.172, rb: 0.15, squash: [1, 0.95, 0.97], bias: [1.04, 1.06], k: 0.03 },
  { a: [-1.83, 4.814, 0.0], b: [-2.05, 4.818, 0.0], ra: 0.15, rb: 0.156, squash: [1, 1.02, 0.96], bias: [0.99, 1.07], k: 0.05 },
  { a: [-2.05, 4.818, 0.0], b: [-2.3, 4.829, 0.0], ra: 0.156, rb: 0.124, squash: [1, 1.12, 0.94], bias: [0.96, 1.01], k: 0.045 },
  { a: [-2.3, 4.829, 0.0], b: [-2.52, 4.841, 0.0], ra: 0.124, rb: 0.104, squash: [1, 1.2, 0.94], bias: [0.97, 1.0], k: 0.045 },
  { a: [-2.52, 4.824, 0.0], b: [-2.74, 4.827, 0.0], ra: 0.104, rb: 0.098, squash: [1, 1.08, 0.88], bias: [0.99, 1.0], k: 0.05 },
  { a: [-2.74, 4.827, 0.0], b: [-2.82, 4.828, 0.0], ra: 0.098, rb: 0.096, squash: [1, 1.06, 0.84], k: 0.06 },
  { a: [0.82, 4.8, 0.0], b: [1.08, 4.802, 0.0], ra: 0.216, rb: 0.203, squash: [1, 1.06, 0.92], bias: [0.89, 1.0], k: 0.16 },
  { a: [1.08, 4.802, 0.0], b: [1.35, 4.806, 0.0], ra: 0.203, rb: 0.188, squash: [1, 1.08, 0.93], bias: [0.99, 1.0], k: 0.09 },
  { a: [1.35, 4.806, 0.0], b: [1.6, 4.81, 0.0], ra: 0.188, rb: 0.172, squash: [1, 0.96, 0.94], bias: [1.07, 1.0], k: 0.06 },
  { a: [1.6, 4.81, 0.0], b: [1.83, 4.814, 0.0], ra: 0.172, rb: 0.15, squash: [1, 0.95, 0.97], bias: [1.04, 1.06], k: 0.03 },
  { a: [1.83, 4.814, 0.0], b: [2.05, 4.818, 0.0], ra: 0.15, rb: 0.156, squash: [1, 1.02, 0.96], bias: [0.99, 1.07], k: 0.05 },
  { a: [2.05, 4.818, 0.0], b: [2.3, 4.821, 0.0], ra: 0.156, rb: 0.124, squash: [1, 1.12, 0.94], bias: [0.96, 1.01], k: 0.045 },
  { a: [2.3, 4.821, 0.0], b: [2.52, 4.824, 0.0], ra: 0.124, rb: 0.104, squash: [1, 1.2, 0.94], bias: [0.97, 1.0], k: 0.045 },
  { a: [2.52, 4.824, 0.0], b: [2.74, 4.827, 0.0], ra: 0.104, rb: 0.098, squash: [1, 1.08, 0.88], bias: [0.99, 1.0], k: 0.05 },
  { a: [2.74, 4.827, 0.0], b: [2.82, 4.828, 0.0], ra: 0.098, rb: 0.096, squash: [1, 1.06, 0.84], k: 0.06 },
  // Thumb: it must drop on y as well as spread on z, or it exists only in the side view. The drop
  // Direction and station both come from a fine scan of the baseline's own bottom edge rather than
  // from reading the render, which got the direction backwards. The scan is unambiguous: the
  // reference's thumb occupies x/half 0.82..0.89 and is DEEPEST at 0.88, so its root is proximal and
  // its tip points outward and down. Placed to match, it drops 0.145 — 0.0208 H below the arm's own
  // underside, which is what the baseline carries there.
  //
  // The tip AXIS stops at 2.84 rather than 2.90 because the capsule's own radius carries the surface
  // 0.062 further: an axis ending at 2.90 put material out to x/half 0.897 where the baseline's thumb
  // has already finished at 0.89, and the scan read +0.021 H there.
  //
  // The taper is deliberately shallow, and that is a grid constraint rather than a style choice.
  // Three successive repositionings left the measured bottom edge at x/half 0.85 identical to five
  // digits, because at that station the thumb's radius had tapered to 0.040 — 1.7 samples across in
  // y against a three-sample floor — so the tip did not exist and only the thicker root was ever
  // rendering. A thumb on this grid has to be chunky to be present at all: 0.088 to 0.074 rather than
  // 0.072 to 0.046.
  // HIP DEPTH, cut to the measurement.
  //
  // At local y 2.67 the reference is 0.283 half-deep and the figure was 0.385 — the single worst z band
  // left after the thigh fix, and it is not the thigh. The waist capsule's axis starts at y 2.964 with
  // radius 0.610, so its spherical cap hangs down to 2.354 and is still 0.383 half-deep at 2.68, deeper
  // than the thigh it sits over. The shorts then hug that, so the garment inherits the error.
  //
  // Raising the waist capsule instead was tried on paper and rejected: it fixes 2.68 and puts the band at
  // 3.18 from +0.4% to +9.5%, because that band is the waist itself. A pair of plates cuts only the range
  // that is wrong — y 2.43 to 2.87 — and leaves the waist above it alone.
  { a: [0, 2.65, 0.478], b: [0, 2.65, 0.478], ra: 0, rb: 0, k: 0.018, op: 'carve', exact: true,
    plate: { size: [0.78, 0.22, 0.30], round: 0.05 } },
  { a: [0, 2.65, -0.718], b: [0, 2.65, -0.718], ra: 0, rb: 0, k: 0.018, op: 'carve', exact: true,
    plate: { size: [0.78, 0.22, 0.30], round: 0.05 } },

  // ARM PLANE CUTS — the same sculpting language the chest uses, applied to the limbs.
  //
  // The torso is cut by oriented plates; the arms and legs had no cuts at all, so the figure spoke two
  // languages at once — planes and creases on the trunk, smooth tubes on the limbs. Every value below is
  // seated on the measured skin (scripts/limb-surface.mjs), because a plate two hundredths proud of the
  // surface removes nothing, which has already cost three rounds on the chest.
  //
  // Right arm skin, local: at x 1.05 the surface spans y 4.617..4.999 and z -0.236..0.230; at 1.50,
  // y 4.658..4.949 and z +/-0.182; at 1.80, y 4.681..4.947 and z -0.157..0.148; at 2.10 it swells again
  // to y 4.678..4.961 (the forearm's proximal mass) before tapering to +/-0.073 at the wrist.
  //
  // SHOULDER GIRDLE LOCK — trapezius into clavicle into deltoid, as one continuous run.
  //
  // The three were separate masses blending through the field at whatever radius each happened to have,
  // which is why the shoulder read as parts assembled rather than as anatomy. This capsule spans the gap
  // between the trapezius's outer end at x 0.58 and the deltoid's inner end at 0.72, with a blend radius
  // (0.14) larger than either, so the union between them is a slope rather than a seam. It is what a
  // clavicle does: carry the shoulder mass back to the neck.
  //
  // It has to stay LOW and FLAT. A first version at y 4.955 with a y squash of 1.12 reached up to 5.089,
  // which is inside the band the cross-sections measure at 5.08..5.36 — the jaw and neck band, where the
  // reference is 0.459 wide and the model went to 1.323. That is +188%, from one capsule's cap. A y
  // squash of 1.55 makes it the strap it should be rather than a tube, and the top now stops at 5.02.
  { a: [-0.34, 4.905, -0.250], b: [-0.76, 4.858, -0.185], ra: 0.132, rb: 0.170, squash: [1, 1.55, 1], k: 0.140, exact: true },
  { a: [0.34, 4.905, -0.250], b: [0.76, 4.858, -0.185], ra: 0.132, rb: 0.170, squash: [1, 1.55, 1], k: 0.140, exact: true },

  // ARM ROOT — the intermediate section between the deltoid cap and the upper arm.
  //
  // The chain went cap (ending 0.150 at x 1.22) straight to biceps (0.228 at 0.82, tapering), so the arm
  // emerged from under the cap as a step. This sits across the handover at 1.05..1.40, thicker than the
  // arm and thinner than the cap, so the taper is monotonic from shoulder to elbow.
  { a: [-1.05, 4.825, -0.008], b: [-1.40, 4.808, 0.0], ra: 0.196, rb: 0.176, squash: [1, 1.09, 0.93], bias: [0.94, 1.0], k: 0.105, exact: true },
  { a: [1.05, 4.825, -0.008], b: [1.40, 4.808, 0.0], ra: 0.196, rb: 0.176, squash: [1, 1.09, 0.93], bias: [0.94, 1.0], k: 0.105, exact: true },

  // NIPPLES — landmarks on the lower-middle pec plane, not volume.
  //
  // Placed at x 0.38, which is 65% of the way from the sternum to the outer pec at 0.586 — inside the
  // brief's 60-70%. Squashed 5.5x on z so the capsule's 0.034 radius projects 0.006, far below anything
  // that could alter the silhouette, and carved nowhere near enough to make a mound. They go in last, as
  // instructed, because a landmark placed on a wrong plane just moves the error somewhere visible.
  { a: [-0.380, 4.400, 0.100], b: [-0.380, 4.372, 0.100], ra: 0.034, rb: 0.030, squash: [1, 1, 5.5], k: 0.012, exact: true },
  { a: [0.380, 4.400, 0.100], b: [0.380, 4.372, 0.100], ra: 0.034, rb: 0.030, squash: [1, 1, 5.5], k: 0.012, exact: true },

  // DELTOID CAP — the shoulder as a mass wrapping the head of the humerus, not an arm meeting a wall.
  //
  // The arm chain begins at x 0.82 with a radius of 0.228, so the shoulder was whatever the smooth union
  // of that capsule and the trunk happened to produce: a joint, not a muscle. Measured skin at x 0.90 was
  // 0.206 half-tall against the arm's own 0.163 at x 1.20 — a 26% swell, where a deltoid should read as
  // roughly half again the arm it covers.
  //
  // The cap is one capsule biased DOWN and out. `bias` divides the offset on the positive side, so a value
  // BELOW one makes it fuller ABOVE — and 0.82 did exactly that, putting a band of model-only pixels along
  // the top of both shoulders in the silhouette overlay while the reference's shoulder slopes away. 1.24
  // pulls the mass under the acromion, where a deltoid actually sits: hanging from the joint rather than
  // piling on top of it and squashed so it is wider than deep. It starts inboard of
  // the arm root at x 0.72 so it grows out of the torso rather than sitting on it, and dies at x 1.22
  // where the biceps takes over.
  { a: [-0.72, 4.845, -0.015], b: [-1.22, 4.815, -0.010], ra: 0.208, rb: 0.150, squash: [1, 1.06, 0.94], bias: [1.24, 1.0], k: 0.095, exact: true },
  { a: [0.72, 4.845, -0.015], b: [1.22, 4.815, -0.010], ra: 0.208, rb: 0.150, squash: [1, 1.06, 0.94], bias: [1.24, 1.0], k: 0.095, exact: true },
  // Three planes on the cap, cut rather than added, so only the cut faces reach the surface. Anterior
  // faces forward and slightly in, lateral faces straight out, posterior faces back and in — the three
  // heads, expressed as the boundaries between them rather than as three separate masses.
  { a: [-0.98, 4.86, 0.560], b: [-0.98, 4.86, 0.560], ra: 0, rb: 0, k: 0.055, op: 'carve', exact: true,
    plate: { size: [0.30, 0.24, 0.30], round: 0.04, yaw: 0.38 } },
  { a: [0.98, 4.86, 0.560], b: [0.98, 4.86, 0.560], ra: 0, rb: 0, k: 0.055, op: 'carve', exact: true,
    plate: { size: [0.30, 0.24, 0.30], round: 0.04, yaw: -0.38 } },
  { a: [-0.98, 4.86, -0.585], b: [-0.98, 4.86, -0.585], ra: 0, rb: 0, k: 0.055, op: 'carve', exact: true,
    plate: { size: [0.30, 0.24, 0.30], round: 0.04, yaw: -0.34 } },
  { a: [0.98, 4.86, -0.585], b: [0.98, 4.86, -0.585], ra: 0, rb: 0, k: 0.055, op: 'carve', exact: true,
    plate: { size: [0.30, 0.24, 0.30], round: 0.04, yaw: 0.34 } },
  // ANTERIOR AND POSTERIOR AXILLARY FOLDS: the front and back edges of the armpit, where the pectoral
  // and the lat run into the arm. Squashed flat on y so each is a line under the shoulder rather than a
  // pocket, and stopped short of the torso so neither becomes a cavity.
  { a: [-0.70, 4.640, 0.150], b: [-1.00, 4.660, 0.105], ra: 0.052, rb: 0.040, squash: [1, 2.6, 1], k: 0.030, op: 'carve', exact: true },
  { a: [0.70, 4.640, 0.150], b: [1.00, 4.660, 0.105], ra: 0.052, rb: 0.040, squash: [1, 2.6, 1], k: 0.030, op: 'carve', exact: true },
  { a: [-0.70, 4.640, -0.215], b: [-1.00, 4.660, -0.165], ra: 0.050, rb: 0.038, squash: [1, 2.5, 1], k: 0.030, op: 'carve', exact: true },
  { a: [0.70, 4.640, -0.215], b: [1.00, 4.660, -0.165], ra: 0.050, rb: 0.038, squash: [1, 2.5, 1], k: 0.030, op: 'carve', exact: true },

  // ELBOW EPICONDYLES - item 2. Unequal on purpose: medial larger and lower than lateral, which is what
  // keeps the joint from reading as a sphere.
  { a: [-1.86, 4.792, -0.062], b: [-1.90, 4.788, -0.070], ra: 0.062, rb: 0.052, squash: [1, 1.35, 1.15], k: 0.055, exact: true },
  { a: [1.86, 4.792, -0.062], b: [1.90, 4.788, -0.070], ra: 0.062, rb: 0.052, squash: [1, 1.35, 1.15], k: 0.055, exact: true },
  { a: [-1.85, 4.836, 0.052], b: [-1.88, 4.834, 0.058], ra: 0.046, rb: 0.038, squash: [1, 1.5, 1.2], k: 0.050, exact: true },
  { a: [1.85, 4.836, 0.052], b: [1.88, 4.834, 0.058], ra: 0.046, rb: 0.038, squash: [1, 1.5, 1.2], k: 0.050, exact: true },
  // ELBOW CREASE. Kept, because item 2 asks for a defined joint, but at half its old radius so it is a
  // shading break rather than a cut.
  { a: [-1.84, 4.88, 0.240], b: [-1.84, 4.74, 0.240], ra: 0.026, rb: 0.021, squash: [3.8, 1, 1], k: 0.030, op: 'carve', exact: true },
  { a: [1.84, 4.88, 0.240], b: [1.84, 4.74, 0.240], ra: 0.026, rb: 0.021, squash: [3.8, 1, 1], k: 0.030, op: 'carve', exact: true },

  // LEG PLANE CUTS.
  //
  // Right leg skin, local: at y 2.30 it spans x 0.080..0.548 and z -0.336..0.098; at 1.70, x 0.170..0.544
  // and z -0.308..0.065; the knee swells to x 0.568 at y 1.40; the calf peaks around y 1.10 at x 0.509
  // and tapers to 0.473 at the ankle.
  //
  // ILIOTIBIAL BAND. A long shallow plane down the OUTER thigh, dividing quadriceps from hamstring —
  // the single feature that stops a thigh reading as a tube.
  { a: [-0.607, 2.05, -0.120], b: [-0.607, 2.05, -0.120], ra: 0, rb: 0, k: 0.060, op: 'carve', exact: true,
    plate: { size: [0.055, 0.42, 0.20], round: 0.030, roll: 0.06 } },
  { a: [0.607, 2.05, -0.120], b: [0.607, 2.05, -0.120], ra: 0, rb: 0, k: 0.060, op: 'carve', exact: true,
    plate: { size: [0.055, 0.42, 0.20], round: 0.030, roll: -0.06 } },
  // SUPRAPATELLAR CREASE, across the front just above the knee.
  { a: [-0.52, 1.585, 0.135], b: [-0.22, 1.585, 0.135], ra: 0.042, rb: 0.036, squash: [1, 3.6, 1], k: 0.022, op: 'carve', exact: true },
  { a: [0.22, 1.585, 0.135], b: [0.52, 1.585, 0.135], ra: 0.042, rb: 0.036, squash: [1, 3.6, 1], k: 0.022, op: 'carve', exact: true },
  // POPLITEAL CREASE, the matching one behind the knee.
  { a: [-0.50, 1.520, -0.372], b: [-0.24, 1.520, -0.372], ra: 0.040, rb: 0.034, squash: [1, 3.4, 1], k: 0.022, op: 'carve', exact: true },
  { a: [0.24, 1.520, -0.372], b: [0.50, 1.520, -0.372], ra: 0.040, rb: 0.034, squash: [1, 3.4, 1], k: 0.022, op: 'carve', exact: true },
  // GASTROCNEMIUS BOUNDARY: where the calf mass ends and the achilles begins, on the back of the shin.
  { a: [-0.37, 0.86, -0.290], b: [-0.37, 0.86, -0.290], ra: 0, rb: 0, k: 0.040, op: 'carve', exact: true,
    plate: { size: [0.16, 0.16, 0.045], round: 0.025, pitch: 0.55 } },
  { a: [0.37, 0.86, -0.290], b: [0.37, 0.86, -0.290], ra: 0, rb: 0, k: 0.040, op: 'carve', exact: true,
    plate: { size: [0.16, 0.16, 0.045], round: 0.025, pitch: 0.55 } },
  // MALLEOLUS, a short crease in front of the ankle joint.
  { a: [-0.47, 0.46, 0.115], b: [-0.27, 0.46, 0.115], ra: 0.030, rb: 0.026, squash: [1, 3.8, 1], k: 0.016, op: 'carve', exact: true },
  { a: [0.27, 0.46, 0.115], b: [0.47, 0.46, 0.115], ra: 0.030, rb: 0.026, squash: [1, 3.8, 1], k: 0.016, op: 'carve', exact: true },

  // Hip → thigh → knee → ankle. The hip end blends into the trunk rather than butting against it.
  //
  // THE Z SQUASH WAS INVERTED. It was 0.836 on the thigh and 0.884 on the shin, and squash DIVIDES the
  // extent, so a value below 1 makes the limb DEEPER than its radius — the thigh measured 0.385 half-deep
  // against 0.287 half-wide. A thigh is wider than it is deep, and the GLB's own cross-sections say so:
  // half-depth 0.283 at local y 2.67, 0.282 at 2.42, 0.283 at 2.17, against the model's 0.385, 0.354 and
  // 0.321 — 36%, 25% and 13% over. This was the largest single error anywhere in the figure.
  //
  // The SHIN keeps its 0.884. Changing it to 1.08 alongside the thigh took the three bands at local y
  // 1.15, 0.89 and 0.64 from +3.1%, 0.0% and -1.8% to -18.9%, -18.1% and -19.2%: they were already right,
  // and the +17% that looked like a shin error at y 1.40 belongs to the thigh capsule, which runs down to
  // 1.45. Two changes at once hid that for one round.
  //
  // 1.10 comes from those measurements, not from taste. The reference's thigh depth barely tapers
  // over that range while a capsule's radius does, so the fit is not exact: the residual runs -1% at 2.67
  // to -13% at 2.17, against +36% to +13% before.
  { a: [-0.31, 2.70, -0.07], b: [-0.33, 2.52, -0.07], ra: 0.245, rb: 0.263, squash: [1.08, 1, 1.10], k: 0.22 },
  { a: [-0.33, 2.52, -0.07], b: [-0.35, 2.28, -0.08], ra: 0.263, rb: 0.263, squash: [1.13, 1, 1.10], k: 0.10 },
  { a: [-0.35, 2.28, -0.08], b: [-0.36, 2.04, -0.09], ra: 0.263, rb: 0.263, squash: [1.20, 1, 1.01], k: 0.10 },
  { a: [-0.36, 2.04, -0.09], b: [-0.37, 1.45, -0.07], ra: 0.263, rb: 0.220, squash: [1.26, 1, 1.10], k: 0.14 },
  { a: [-0.37, 1.45, -0.07], b: [-0.37, 0.30, -0.01], ra: 0.220, rb: 0.115, squash: [1.15, 1, 0.884], k: 0.15 },
  { a: [0.31, 2.70, -0.07], b: [0.33, 2.52, -0.07], ra: 0.245, rb: 0.263, squash: [1.08, 1, 1.10], k: 0.22 },
  { a: [0.33, 2.52, -0.07], b: [0.35, 2.28, -0.08], ra: 0.263, rb: 0.263, squash: [1.13, 1, 1.10], k: 0.10 },
  { a: [0.35, 2.28, -0.08], b: [0.36, 2.04, -0.09], ra: 0.263, rb: 0.263, squash: [1.20, 1, 1.01], k: 0.10 },
  { a: [0.36, 2.04, -0.09], b: [0.37, 1.45, -0.07], ra: 0.263, rb: 0.220, squash: [1.26, 1, 1.10], k: 0.14 },
  { a: [0.37, 1.45, -0.07], b: [0.37, 0.30, -0.01], ra: 0.220, rb: 0.115, squash: [1.15, 1, 0.884], k: 0.15 },
  // INNER-THIGH SLIT. The figure forked at y/H 0.627 against the reference's 0.5241 — 0.103 H too
  // low — and the cause was a primitive, not a parameter: the seat capsule is centred on x = 0 with
  // radius 0.600, so its spherical lower cap hangs to y 2.18 and fills the whole space between the
  // thighs. Nothing about the thighs could open a gap the trunk was busy closing.
  //
  // The profile is measured off the baseline render rather than chosen — gap width in figure heights
  // by height: 0.0040 at y/H 0.530, 0.0080 at 0.545, 0.0120 at 0.570, 0.0161 at 0.580, then a pinch
  // to 0.0110 at 0.600 before opening to 0.0251 at 0.620 and 0.0402 at 0.650. Two segments carry the
  // envelope; the pinch is one fold and is not modelled here.
  //
  // squash z of 0.055 is what makes this a SLAB rather than a rod. A rod of radius 0.03 removes
  // material 0.03 deep in z, which leaves the front and back of the crotch intact and the slit
  // invisible from the front — the gap has to cut clean through to show up in a silhouette at all.
  // The radii are the THIGHS' OWN inner edges, read off their capsules rather than chosen: thigh L
  // has axis x -0.31 radius 0.31 with squash x 1.08, so its x half-extent at height y is
  // sqrt(0.31^2 - (2.70 - y)^2) / 1.08 and its inner edge is 0.31 minus that — 0.091 at y 2.90,
  // 0.038 at 2.80, 0.023 at 2.70 where it pinches, 0.057 at 2.40, 0.085 at 2.16. An hourglass, and
  // within 0.01 of the baseline's measured gap through the middle of its length.
  //
  // A first attempt used 0.016 rising to 0.050 and moved the fork by 0.0155 H against the 0.103 H
  // error. It was not too weak, it was aimed wrong: a carve NARROWER than the space the thighs
  // already leave removes nothing that was not going to be gap anyway, and leaves the seat capsule's
  // web on either side of it. What has to be removed is the seat's material out to the thigh, so the
  // carve has to be as wide as the thigh's inner edge, which is 4 to 6 times wider.
  // The two capsules that cut this slit live in CROTCH_SLIT below rather than here, because the garment
  // needs to evaluate the body BOTH ways: with the slit, to wrap each leg, and without it, to know where
  // the front and back of the crotch are. See `bodyFieldNoSlit`.
  // Feet in the field: the wedge was a separate mesh capped at the ankle, which is the discrete
  // joint the reference does not have. Flattened on y (flat sole), tapering heel to toe.
  // THE FOOT WEDGE IS GONE FROM THE FIELD. An explicit foot shell now owns this region, and leaving the
  // capsule in place meant the shell was rendering INSIDE it — the region score read 0.96 while the
  // profile render was unchanged, because it was scoring the capsule. A number that good next to a
  // picture that has not moved is the signature of measuring the wrong object.
  //
  // The ankle capsules below still reach down to y 0.14, which is inside the shell, so the leg still
  // meets the foot through a shared volume rather than a butt joint.
  // THE TEN TOE STUBS ARE GONE, and they were never visible. Each was 0.040 in radius with a y squash of
  // 1.9, so 0.080 across in x and 0.042 in y against a grid of dx 0.0317 and dy 0.0410 — 2.5 samples wide
  // and ONE sample tall, against a floor of about three. They could not be polygonised at any radius that
  // still looked like a toe, and the render shows what that produced: a smooth hoof with no toes at all.
  // Toes are explicit lofts now, next to the hands, for exactly the reason the fingers are.
  // Ankles reach down into the foot wedge so the two overlap; without this the shin ends in a
  // cap and the foot starts in another, which is the discrete joint the reference does not have.
  //
  // The ankle now LEANS FORWARD. At local y 0.382 the reference spans z -0.239..0.207 and the model
  // spanned -0.275..0.043: the back was right and the front was missing 0.164, which is an instep. An
  // ankle whose axis runs from z -0.10 down to -0.03 has none; running it from -0.055 to +0.02 with a
  // shallower z squash puts the front of the band at 0.174.
  { a: [-0.37, 0.42, -0.055], b: [-0.37, 0.14, 0.02], ra: 0.155, rb: 0.145, squash: [1.2, 1, 0.70], k: 0.018 },
  { a: [0.37, 0.42, -0.055], b: [0.37, 0.14, 0.02], ra: 0.155, rb: 0.145, squash: [1.2, 1, 0.70], k: 0.018 },
];

/**
 * Global radius trim for the blended field.
 *
 * The capsule radii above were read off the separate-shell version, where each radius WAS the
 * surface. Under smooth-union it is not: `smin` adds material around every joint, so the same
 * radii inflate. Measured directly after the first polygonisation — missing material fell to
 * ~0% everywhere (the surface covers what the reference has) while extra rose to 23.7% on the
 * thigh and 39.8% at the neck/shoulder. That is one uniform over-thickness, not a shape error,
 * so one scalar corrects it and the per-part numbers stay readable as anatomy.
 */
const BODY_RADIUS_SCALE = 0.84;

/**
 * A capsule whose section may differ above from below and in front from behind.
 *
 * The offset from the axis is scaled AFTER the point is projected onto the segment, so the axis
 * itself does not move — scaling the sample point and both endpoints, as the symmetric path does,
 * would drag the axis with it and there would be no way to say "fuller above" without also saying
 * "moved up".
 */
function sdCapsuleBiased(
  px: number, py: number, pz: number,
  a: [number, number, number], b: [number, number, number],
  ra: number, rb: number,
  sx: number, sy: number, sz: number,
  above: number, infront: number,
): number {
  const pax = px - a[0], pay = py - a[1], paz = pz - a[2];
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const baLen2 = bax * bax + bay * bay + baz * baz;
  let h = baLen2 > 0 ? (pax * bax + pay * bay + paz * baz) / baLen2 : 0;
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  const dx = (pax - bax * h) * sx;
  let dy = (pay - bay * h) * sy;
  let dz = (paz - baz * h) * sz;
  if (dy > 0) dy *= above;
  if (dz > 0) dz *= infront;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - (ra + (rb - ra) * h);
}

/**
 * Signed distance to an oriented rounded box.
 *
 * The point is rotated into the box's frame by the inverse of yaw-then-pitch-then-roll, which is a
 * transpose rather than a matrix inverse because the rotation is orthonormal. `length(max(q, 0))`
 * handles the corners and edges, `min(max(q.x, q.y, q.z), 0)` the interior, and subtracting `round`
 * fillets the whole thing — the standard formulation, and the reason a plate's faces stay planar while
 * its edges stay soft.
 */
function sdPlate(
  x: number, y: number, z: number,
  centre: [number, number, number],
  plate: NonNullable<Capsule['plate']>,
): number {
  let px = x - centre[0];
  let py = y - centre[1];
  let pz = z - centre[2];
  const roll = plate.roll ?? 0;
  if (roll) {
    const c = Math.cos(-roll); const s = Math.sin(-roll);
    const nx = px * c - py * s; py = px * s + py * c; px = nx;
  }
  const pitch = plate.pitch ?? 0;
  if (pitch) {
    const c = Math.cos(-pitch); const s = Math.sin(-pitch);
    const ny = py * c - pz * s; pz = py * s + pz * c; py = ny;
  }
  const yaw = plate.yaw ?? 0;
  if (yaw) {
    const c = Math.cos(-yaw); const s = Math.sin(-yaw);
    const nz = pz * c - px * s; px = pz * s + px * c; pz = nz;
  }
  const qx = Math.abs(px) - plate.size[0];
  const qy = Math.abs(py) - plate.size[1];
  const qz = Math.abs(pz) - plate.size[2];
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  const inside = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
  return outside + inside - plate.round;
}

function evaluateField(capsules: Capsule[], x: number, y: number, z: number): number {
  let d = Infinity;
  for (const raw of capsules) {
    const s = raw.exact ? 1 : BODY_RADIUS_SCALE;
    const c = { ...raw, ra: raw.ra * s, rb: raw.rb * s };
    const sx = c.squash ? c.squash[0] : 1;
    const sy = c.squash ? c.squash[1] : 1;
    const sz = c.squash ? c.squash[2] : 1;
    // The asymmetric path runs only when `bias` is set, so every capsule authored before it keeps
    // its exact previous value. It also scales the offset AFTER projection rather than scaling the
    // sample point, which is what keeps the axis where it was put.
    const v = c.plate
      ? sdPlate(x, y, z, c.a, c.plate)
      : c.bias
      ? sdCapsuleBiased(x, y, z, c.a, c.b, c.ra, c.rb, sx, sy, sz, c.bias[0], c.bias[1])
      : sdCapsule(
        x * sx, y * sy, z * sz,
        c.a[0] * sx, c.a[1] * sy, c.a[2] * sz,
        c.b[0] * sx, c.b[1] * sy, c.b[2] * sz,
        c.ra, c.rb,
      );
    if (c.op === 'carve') d = smax(d, -v, c.k);
    else d = d === Infinity ? v : smin(d, v, c.k);
  }
  return d;
}

/**
 * The shorts ARE the body surface, inflated and cut.
 *
 * Four separate tubes plus a waistband box gave a garment with its own boxy proportions that had
 * to be tuned against the body it covers — and lost that race repeatedly, showing skin at the hip
 * and then at the crotch. Deriving the cloth from `bodyField` instead makes three properties true
 * by construction rather than by tuning:
 *
 *   - its proportions are the body's proportions, so it can never read as a box on a figure;
 *   - it is strictly OUTSIDE the skin (offset by SHORTS_INFLATE), so body colour cannot show
 *     through anywhere in its range;
 *   - the top and bottom are hard cuts, which is what the reference's hem and waistband read as.
 *
 * `max` against the slab is a plain intersection, not a smooth one, precisely because the cut
 * should be a crisp line rather than a rolled edge.
 */
/**
 * The two carves that open the inner-thigh slit, kept apart from the rest of the body.
 *
 * Applying them last is equivalent to applying them where they used to sit: nothing between the thighs
 * and the feet adds material inside their range, and a carve commutes with additions it does not touch.
 */
const CROTCH_SLIT: Capsule[] = [
  { a: [0, 2.92, -0.12], b: [0, 2.70, -0.12], ra: 0.095, rb: 0.070, squash: [1, 1, 0.055], k: 0.015, op: 'carve', exact: true },
  { a: [0, 2.70, -0.12], b: [0, 2.16, -0.12], ra: 0.070, rb: 0.086, squash: [1, 1, 0.055], k: 0.015, op: 'carve', exact: true },
];

function bodyField(x: number, y: number, z: number): number {
  return evaluateField([...BODY_CAPSULES, ...CROTCH_SLIT], x, y, z);
}

/**
 * The body as if the crotch slit had never been cut.
 *
 * WHY THE GARMENT NEEDS BOTH. Cloth SPANS the slit; it does not enter it. Hugging the pelvis rings
 * against the slit-cut field made the field report empty space at x = 0 — which is true of the body and
 * false of the garment — so the front rise and back rise were never pushed out while their immediate
 * neighbours at x = 0.19 were pushed forward to 0.36 to clear the groin. A 0.13 step between adjacent
 * vertices of the same ring, and it read exactly as what it is: a dent pulled into the centre of the
 * crotch. The legs still use the slit-cut field, because a leg does wrap its own inner wall.
 */
function bodyFieldNoSlit(x: number, y: number, z: number): number {
  return evaluateField(BODY_CAPSULES, x, y, z);
}


/**
 * Surface nets rather than marching cubes.
 *
 * Marching cubes needs a 256-entry triangle table; surface nets needs none — one vertex per
 * sign-changing cell, placed at the average of its edge crossings, then quads between adjacent
 * cells that share a sign-changing edge. Fewer than a hundred lines, and it emits quads, which
 * is the right output for a low-poly read. The vertex placement also rounds the result slightly,
 * which suits an organic body better than marching cubes' faceted output.
 */
function polygonizeField(
  name: string,
  field: (x: number, y: number, z: number) => number,
  min: [number, number, number],
  max: [number, number, number],
  /**
   * Samples per axis. A single number is a cubic grid; a triple spends the budget where the
   * features are.
   *
   * WHY THIS IS NOT COSMETIC. The body's box is 7.1 x 5.91 x 1.8, so one cubic resolution gives
   * dx 0.055, dy 0.046, dz 0.014 — z was oversampled FOUR TIMES over x, for a figure whose narrow
   * features (the inner-thigh slit, the crotch) are narrow in X. The reference's slit is 0.025 to
   * 0.10 local wide, which is 0.5 to 1.8 cells of dx: below the floor at which a feature exists at
   * all, so no carve, radius or blend could ever have produced it. [224, 144, 64] gives dx 0.0317,
   * dy 0.0410, dz 0.0281 — near-isotropic instead of 4:1 — for 2.12M samples against the cubic
   * grid's 2.15M. The x axis gets 1.7x finer at no cost, purely by not wasting the budget on z.
   * ([256, 160, 72] was tried first and cost 1.4x, which pushed the synchronous build past the
   * capture's page-load timeout.)
   */
  resolution: number | [number, number, number],
  mat: THREE.Material,
  /**
   * Cells whose centre this returns true for emit no geometry.
   *
   * ONE ANATOMICAL REGION, ONE VISIBLE SURFACE. The torso is covered by an explicit shell, and the
   * isosurface was still being polygonised underneath it — two surfaces competing to own the same
   * outline. Wherever the field bulged past the shell in ANY direction a slice of it appeared beyond
   * the flank, and no amount of widening the shell fixes that: a slice-by-slice width comparison cannot
   * even find such a bulge, because the widest point of each mesh in a slice is not in the same
   * direction. Removing the field where the shell owns the surface removes the competition instead of
   * trying to win it.
   */
  omit?: (x: number, y: number, z: number) => boolean,
): THREE.Mesh {
  const [nx, ny, nz] = typeof resolution === 'number'
    ? [resolution, resolution, resolution] : resolution;
  const dx = (max[0] - min[0]) / nx, dy = (max[1] - min[1]) / ny, dz = (max[2] - min[2]) / nz;
  const at = (i: number, j: number, k: number): number =>
    field(min[0] + i * dx, min[1] + j * dy, min[2] + k * dz);

  // One scalar sample per grid corner, computed once.
  const grid = new Float32Array((nx + 1) * (ny + 1) * (nz + 1));
  const gi = (i: number, j: number, k: number): number => (k * (ny + 1) + j) * (nx + 1) + i;
  for (let k = 0; k <= nz; k += 1) {
    for (let j = 0; j <= ny; j += 1) {
      for (let i = 0; i <= nx; i += 1) grid[gi(i, j, k)] = at(i, j, k);
    }
  }

  const vertexAt = new Int32Array(nx * ny * nz).fill(-1);
  const ci = (i: number, j: number, k: number): number => (k * ny + j) * nx + i;
  const positions: number[] = [];
  const CORNER: Array<[number, number, number]> = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const EDGE: Array<[number, number]> = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const s = CORNER.map(([a, b, c]) => grid[gi(i + a, j + b, k + c)]);
        let neg = 0;
        for (const v of s) if (v < 0) neg += 1;
        if (neg === 0 || neg === 8) continue;
        if (omit && omit(min[0] + (i + 0.5) * dx, min[1] + (j + 0.5) * dy,
          min[2] + (k + 0.5) * dz)) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [e0, e1] of EDGE) {
          const v0 = s[e0], v1 = s[e1];
          if ((v0 < 0) === (v1 < 0)) continue;
          const t = v0 / (v0 - v1);
          const c0 = CORNER[e0], c1 = CORNER[e1];
          sx += c0[0] + (c1[0] - c0[0]) * t;
          sy += c0[1] + (c1[1] - c0[1]) * t;
          sz += c0[2] + (c1[2] - c0[2]) * t;
          n += 1;
        }
        vertexAt[ci(i, j, k)] = positions.length / 3;
        positions.push(
          min[0] + (i + sx / n) * dx,
          min[1] + (j + sy / n) * dy,
          min[2] + (k + sz / n) * dz,
        );
      }
    }
  }

  // A sign change on an axis edge means the four cells around that edge form a quad.
  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c);
    else indices.push(a, b, c, a, c, d);
  };
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const here = grid[gi(i, j, k)] < 0;
        if (i > 0 && j > 0 && k > 0) {
          if (here !== (grid[gi(i + 1, j, k)] < 0)) {
            quad(vertexAt[ci(i, j - 1, k - 1)], vertexAt[ci(i, j, k - 1)], vertexAt[ci(i, j, k)], vertexAt[ci(i, j - 1, k)], here);
          }
          if (here !== (grid[gi(i, j + 1, k)] < 0)) {
            quad(vertexAt[ci(i - 1, j, k - 1)], vertexAt[ci(i, j, k - 1)], vertexAt[ci(i, j, k)], vertexAt[ci(i - 1, j, k)], !here);
          }
          if (here !== (grid[gi(i, j, k + 1)] < 0)) {
            quad(vertexAt[ci(i - 1, j - 1, k)], vertexAt[ci(i, j - 1, k)], vertexAt[ci(i, j, k)], vertexAt[ci(i - 1, j, k)], here);
          }
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = name;
  return mesh;
}

function facetedBody(
  name: string,
  rings: Array<[number, number, number]>,
  mat: THREE.Material | THREE.Material[],
  segments = 8,
  capStart = true,
  capEnd = true,
  zOffsets: number[] = [],
  materialRule?: (ring: number, segment: number, triangle: number) => number,
): THREE.Mesh {
  const vertices: number[] = [];
  const indices: number[] = [];
  const triangleMaterials: number[] = [];
  const materials = Array.isArray(mat) ? mat : [mat];
  const angleOffset = Math.PI / segments;

  const addTriangle = (a: number, b: number, c: number, materialIndex = 0): void => {
    indices.push(a, b, c);
    triangleMaterials.push(Math.max(0, Math.min(materials.length - 1, materialIndex)));
  };

  for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
    const [y, radiusX, radiusZ] = rings[ringIndex];
    const zOffset = zOffsets[ringIndex] ?? 0;
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2 + angleOffset;
      vertices.push(Math.cos(angle) * radiusX, y, zOffset + Math.sin(angle) * radiusZ);
    }
  }

  for (let ring = 0; ring < rings.length - 1; ring += 1) {
    const current = ring * segments;
    const next = (ring + 1) * segments;
    for (let segment = 0; segment < segments; segment += 1) {
      const a = current + segment;
      const b = current + (segment + 1) % segments;
      const c = next + segment;
      const d = next + (segment + 1) % segments;
      if ((ring + segment) % 2 === 0) {
        addTriangle(a, c, b, materialRule?.(ring, segment, 0));
        addTriangle(b, c, d, materialRule?.(ring, segment, 1));
      } else {
        addTriangle(a, c, d, materialRule?.(ring, segment, 0));
        addTriangle(a, d, b, materialRule?.(ring, segment, 1));
      }
    }
  }

  if (capStart) {
    const bottomCenter = vertices.length / 3;
    vertices.push(0, rings[0][0], zOffsets[0] ?? 0);
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      addTriangle(bottomCenter, next, segment);
    }
  }
  if (capEnd) {
    const topCenter = vertices.length / 3;
    vertices.push(0, rings[rings.length - 1][0], zOffsets[rings.length - 1] ?? 0);
    const top = (rings.length - 1) * segments;
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      addTriangle(topCenter, top + segment, top + next);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  if (materials.length > 1) {
    triangleMaterials.forEach((materialIndex, triangleIndex) => {
      geometry.addGroup(triangleIndex * 3, 3, materialIndex);
    });
  }
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, materials.length === 1 ? materials[0] : materials);
  mesh.name = name;
  return mesh;
}

function facetedPatch(
  name: string,
  vertices: Array<[number, number, number]>,
  triangles: Array<[number, number, number, number]>,
  materials: THREE.Material[],
  /**
   * One [u, v] per vertex. Optional because most patches are shaded by flat colour alone.
   *
   * The hair shell needs them: a strand-flow texture has to know which way is along the strand, and
   * `BufferGeometry.computeTangents()` returns early with a console error unless index, position,
   * normal AND uv are all present, so there is no way to get an anisotropic frame without them.
   */
  uvs?: Array<[number, number]>,
): THREE.Mesh {
  const positions = vertices.flat();
  const indices = triangles.flatMap(([a, b, c]) => [a, b, c]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (uvs) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs.flat(), 2));
  geometry.setIndex(indices);
  triangles.forEach(([, , , materialIndex], triangleIndex) => {
    geometry.addGroup(triangleIndex * 3, 3, materialIndex);
  });
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.name = name;
  return mesh;
}

type LoftSection = {
  /** Position along the root-to-tip spine, 0 at the root and 1 at the tip. */
  at: number;
  /** Half-extent along `side` at this section. Zero collapses the ring to a point. */
  width: number;
  /** Half-extent along `lift` at this section. */
  thickness: number;
  /** Displacement of this section's centre off the spine, in model space. */
  offset?: [number, number, number];
  /** Rotation of the cross-section about the spine, in radians. Varying it is twist. */
  roll?: number;
};

/**
 * A spine with a profile of cross-sections along it — hair masses, fingers, a palm, a thumb.
 *
 * Named for what it is rather than what it was first used for: the hand needs exactly this and
 * calling it `hairMass` there would be misleading.
 *
 * This replaces a fixed root-quad / mid-ring / tip shape, which was enough for a small spike and
 * not enough for anything wide and curved. A fringe sweeping across a brow needs to be broad and
 * flat where a crown volume needs to be deep and round, and both need their silhouette to come from
 * where the sections are placed rather than from one `bend` parameter — so the profile is data.
 *
 * Everything the brief asked for is expressible without a flag per effect, which is why there is
 * not one:
 *   twist        vary `roll` between sections
 *   bend         `offset` on the middle sections
 *   tipBias      `offset` on the last section
 *   flatten      thickness much smaller than width
 *   fan          width rising then falling across sections
 *   rootConform  `offset` on the first section, toward the skull
 *
 * `side` and `lift` are the cross-section's frame at zero roll, given as full vectors so the caller
 * controls orientation directly; the spine direction is implied by root and tip.
 */
export function sectionedLoft(
  name: string,
  root: [number, number, number],
  tip: [number, number, number],
  side: [number, number, number],
  lift: [number, number, number],
  sections: LoftSection[],
  mat: THREE.Material,
  ringVertices?: number,
  /** Fraction of the full turn each ring spans, e.g. [0, 0.5] for a front half-shell. */
  arc?: [number, number],
  /** Leave the first and last rings open, for a shell that continues into another component. */
  openEnds?: boolean,
  /**
   * Push every vertex outward until the field reads at least `clearance`.
   *
   * WHY A GARMENT CANNOT BE AUTHORED AS RING WIDTHS. Five rounds of widening these sections by hand
   * still left the body poking through 0.09 H of the front — because a ring is an ELLIPSE and this
   * body's hip cross-section is the union of a hip, a glute and two thigh tops, which is not one.
   * Any single ellipse that clears the widest point is loose at the narrowest and vice versa, so the
   * error moves rather than shrinks. Here the authored width is only a lower bound and the actual
   * radius is MEASURED per vertex, so cloth outside skin is a property of the construction rather
   * than of a number that has to be got right.
   */
  hug?: {
    field: (x: number, y: number, z: number) => number;
    clearance: number;
    /**
     * Furthest a vertex may travel. Required, not a safeguard: a leg tube's INNER vertices have
     * spokes pointing at x = 0, where the body is solid, so an uncapped march walks them through the
     * crotch and out the other side, closing the very gap the tube exists to leave. The panels never
     * need more than about 0.03, so a cap at 0.06 changes nothing there and stops this outright.
     */
    maxPush: number;
  },
): THREE.Mesh {
  type V = [number, number, number];
  const add = (...vs: V[]): V => vs.reduce((a, v) => [a[0] + v[0], a[1] + v[1], a[2] + v[2]] as V,
    [0, 0, 0] as V);
  const mul = (v: V, s: number): V => [v[0] * s, v[1] * s, v[2] * s];

  // Marching along the vertex's OWN radial direction, not along the surface normal of the field, is
  // what keeps the ring a ring: every vertex stays on its own spoke, so the section keeps its vertex
  // order and its seam positions and only its radius changes. The step is `clearance - gap`, which is
  // exact for a true distance field and conservative for this one, since `smin` makes the field read
  // slightly less than the true distance and so understates the step rather than overshooting.
  const outward = (p: V, dir: V): V => {
    if (!hug) return p;
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    if (len < 1e-9) return p;
    const step: V = [dir[0] / len, dir[1] / len, dir[2] / len];
    let out = p;
    let travelled = 0;
    for (let i = 0; i < 24; i += 1) {
      const gap = hug.field(out[0], out[1], out[2]);
      if (gap >= hug.clearance) break;
      const move = Math.min(Math.max(0.004, hug.clearance - gap), hug.maxPush - travelled);
      if (move <= 0) break;
      out = add(out, mul(step, move));
      travelled += move;
    }
    return out;
  };

  const vertices: V[] = [];
  const triangles: Array<[number, number, number, number]> = [];
  const ringStart: number[] = [];
  const isPoint: boolean[] = [];

  for (const section of sections) {
    const centre = add(
      mul(root, 1 - section.at),
      mul(tip, section.at),
      (section.offset ?? [0, 0, 0]) as V,
    );
    ringStart.push(vertices.length);
    if (section.width <= 1e-6 && section.thickness <= 1e-6) {
      isPoint.push(true);
      vertices.push(centre);
      continue;
    }
    isPoint.push(false);
    // Roll rotates the frame about the spine, which is what lets two neighbouring masses read as
    // separate layers rather than one merged block.
    const roll = section.roll ?? 0;
    const c = Math.cos(roll);
    const sn = Math.sin(roll);
    const u = add(mul(side, c), mul(lift, sn));
    const v = add(mul(side, -sn), mul(lift, c));
    if (ringVertices === undefined) {
      // Four corners of a rectangle. Kept as the default because the hair masses were authored
      // against it and a flat-topped section is right for a swept lock.
      for (const [a, b] of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as Array<[number, number]>) {
        const spoke = add(mul(u, a * section.width), mul(v, b * section.thickness));
        vertices.push(outward(add(centre, spoke), spoke));
      }
    } else {
      // An n-gon inscribed in the section's ellipse. A rectangle has four hard corners running the
      // whole length of the loft, which is what made the first explicit palm read as a block and the
      // fingers as blades; eight around a palm and six around a finger give the dorsal, palmar and
      // side planes the brief asks for without the box.
      const [arc0, arc1] = arc ?? [0, 1];
      const closed = arc === undefined;
      for (let i = 0; i < ringVertices; i += 1) {
        // A closed ring places vertices at cell centres so opposite faces are flat; an arc places
        // them at the endpoints so two panels meeting at a seam share that seam's position exactly.
        const f = closed ? (i + 0.5) / ringVertices : arc0 + (arc1 - arc0) * (i / (ringVertices - 1));
        const angle = f * Math.PI * 2;
        const spoke = add(mul(u, Math.cos(angle) * section.width),
          mul(v, Math.sin(angle) * section.thickness));
        vertices.push(outward(add(centre, spoke), spoke));
      }
    }
  }

  const n = ringVertices ?? 4;
  // An arc must not wrap from its last vertex back to its first, or the panel closes into a tube.
  const spans = arc === undefined ? n : n - 1;
  for (let s = 0; s < sections.length - 1; s += 1) {
    const a = ringStart[s];
    const b = ringStart[s + 1];
    if (isPoint[s + 1]) {
      for (let i = 0; i < spans; i += 1) triangles.push([a + i, a + ((i + 1) % n), b, 0]);
    } else if (isPoint[s]) {
      for (let i = 0; i < spans; i += 1) triangles.push([a, b + ((i + 1) % n), b + i, 0]);
    } else {
      for (let i = 0; i < spans; i += 1) {
        const j = (i + 1) % n;
        triangles.push([a + i, a + j, b + j, 0], [a + i, b + j, b + i, 0]);
      }
    }
  }
  // Cap both ends: an open ring reads as a hole from behind, and the last section of a finger is a
  // blunt cap rather than a point, so it needs closing too.
  const caps: Array<[number, boolean]> = openEnds || arc !== undefined
    ? []
    : [[ringStart[0], true], [ringStart[ringStart.length - 1], false]];
  for (const [start, flip] of caps) {
    if (isPoint[start === ringStart[0] ? 0 : ringStart.length - 1]) continue;
    for (let i = 1; i < n - 1; i += 1) {
      triangles.push(flip ? [start, start + i + 1, start + i, 0] : [start, start + i, start + i + 1, 0]);
    }
  }
  return facetedPatch(name, vertices, triangles, [mat]);
}

interface ShellRing {
  y: number;
  halfWidth: number;
  frontDepth: number;
  backDepth: number;
  zCentre: number;
}

interface LegRing {
  y: number;
  xCentre: number;
  halfWidth: number;
  halfDepth: number;
  zCentre: number;
}

/**
 * The shorts as ONE surface: pelvis, crotch and both legs, sharing their vertices.
 *
 * WHY THE EIGHT-COMPONENT VERSION COULD NOT BE FIXED BY NUMBERS. Each component was an independent
 * closed ring, so neighbours could only overlap, never join. Where the pelvis panel met a leg tube the
 * two boundaries differed by 0.09 in depth at the same point in space — the panel's ellipse is
 * 0.653 half-wide and still at 0.973 of full depth by x = 0.15, while the tube's is 0.249 half-wide
 * and already down to 0.643 of its own — and the body showed through the step. Two ellipses of
 * different curvature cannot be made to agree along a curve by choosing better radii. They have to
 * share the curve.
 *
 * THE TOPOLOGY. A tube that splits into two tubes, which is how a real pattern does it:
 *
 *   - the pelvis is a closed ring of N vertices swept down from the waist to the crotch row;
 *   - at the crotch row, index 0 is the front rise (x = 0, front) and index N/2 the back rise;
 *   - a SEAM CHAIN of interior vertices runs front rise -> back rise at x = 0, dipping below the
 *     crotch row to give the gusset its saddle;
 *   - the right leg's first ring is the ring's right arc PLUS the chain; the left leg's is the left
 *     arc plus the SAME chain vertices, traversed the other way.
 *
 * So the gusset is not a patch laid over a gap — it is the neighbourhood of the seam, bounded on four
 * sides by the front rise, the right inner leg root, the back rise and the left inner leg root. Every
 * chain edge carries one face from each leg, so it is interior, not boundary. The only open edges in
 * the whole surface are the waist and the two hems: three loops, by construction rather than by
 * inspection.
 *
 * Ring angles for the legs are read off the crotch ring itself rather than spaced evenly, so the
 * composite ring's uneven spacing — dense on the inner side where the chain is — is carried down the
 * leg instead of being resampled and torn.
 */
function buildShortsShell(
  name: string,
  pelvis: ShellRing[],
  legs: LegRing[],
  /** How far below the crotch row each interior seam vertex hangs, front to back. */
  chainDrop: number[],
  /** Half the gusset's width. Zero would collapse the floor back to a single seam line. */
  gussetHalfWidth: number,
  mat: THREE.Material,
  /**
   * `field` is the body as rendered; `spanField` is the body as if the crotch slit had never been cut.
   *
   * Cloth SPANS the slit, it does not enter it. Measured against the slit-cut field the front and back
   * rises sit in reported empty space and are never pushed out, while their neighbours a fifth of a unit
   * away are pushed forward to 0.36 to clear the groin — a 0.13 step between adjacent vertices of one
   * ring, which is exactly the dent pulled into the centre of the crotch. Pelvis rings and the seam read
   * `spanField`; the legs read `field`, because a leg does wrap its own inner wall.
   */
  hug: {
    field: (x: number, y: number, z: number) => number;
    spanField: (x: number, y: number, z: number) => number;
    clearance: number;
    maxPush: number;
  },
): THREE.Mesh {
  type V3 = [number, number, number];
  const N = 20;
  const HALF = N / 2;

  const position: V3[] = [];
  const spokeOf: V3[] = [];
  const keepOutOf: number[] = [];
  const capOf: number[] = [];
  const triangles: Array<[number, number, number, number]> = [];
  const push = (p: V3, spoke: V3 = [0, 0, 0], keepOut = 0, cap = hug.maxPush): number => {
    position.push(p);
    spokeOf.push(spoke);
    keepOutOf.push(keepOut);
    capOf.push(cap);
    return position.length - 1;
  };

  // Same measured-clearance march as the loft's: the authored ring is a lower bound and the radius
  // that ships is whatever puts the vertex `clearance` outside the body along its own spoke.
  /**
   * `keepOut` is the side of the crotch plane this vertex must stay on, or 0 for no constraint.
   *
   * WHAT REPLACED THE TRAVEL CAP, AND WHY. A leg ring's inner vertices have spokes pointing at x = 0,
   * so an unlimited march walks them through the crotch and closes the gap; capping the distance at
   * 0.05 stopped that but also stopped the legitimate part of the same march. At y 2.845, one quarter
   * of the way from the crotch row to the first thigh ring, the body's front is still at z 0.328
   * because a body does not become thigh-shaped in 0.025 of height — while the ring there is already
   * a thigh ellipse and puts cloth at z 0.147, a fifth of a unit inside. The vertex needed to travel
   * 0.20 forward and was allowed 0.05, so the crotch leaked from the front.
   *
   * The real constraint was never a distance. It is that cloth must not cross to the other leg. So the
   * step's inward-x component is removed instead of its length: the vertex can escape forward, back or
   * down as far as the body demands, and cannot move toward its neighbour at all.
   */
  const hugged = (p: V3, dir: V3, cap = hug.maxPush, keepOut = 0, field = hug.field): V3 => {
    const guarded: V3 = keepOut !== 0 && dir[0] * keepOut < 0 ? [0, dir[1], dir[2]] : dir;
    const len = Math.hypot(guarded[0], guarded[1], guarded[2]);
    if (len < 1e-9) return p;
    const step: V3 = [guarded[0] / len, guarded[1] / len, guarded[2] / len];
    const out: V3 = [p[0], p[1], p[2]];
    let travelled = 0;
    // The step floor is 0.0005, not 0.004. At 0.004 the march overshoots by up to that much and stops
    // wherever the last step happened to land, so neighbouring vertices settle at different distances and
    // the quads between them are not planar — which is what the jagged triangular shading across the
    // garment was. The field is close enough to a true distance that `clearance - gap` is nearly a Newton
    // step, so a small floor converges rather than stalling, and 32 iterations leave room for it.
    for (let i = 0; i < 32; i += 1) {
      const gap = field(out[0], out[1], out[2]);
      if (gap >= hug.clearance - 1e-4) break;
      const move = Math.min(Math.max(0.0005, hug.clearance - gap), cap - travelled);
      if (move <= 0) break;
      out[0] += step[0] * move;
      out[1] += step[1] * move;
      out[2] += step[2] * move;
      travelled += move;
    }
    return out;
  };

  /**
   * Creases, as geometry rather than as shading.
   *
   * NON-NEGATIVE AND ALONG THE OUTWARD SPOKE. A fold can only ADD cloth, never move the surface toward
   * the body, so no fold can reopen a leak — coverage is a property of the hug and stays true whatever
   * the creases do. For a leg's inner vertices the spoke's x component is dropped first, the same guard
   * the march uses, so a crease cannot push cloth across the crotch either.
   *
   * The wave is diagonal in (u, v): u runs around the ring, v runs down the garment. That is what makes
   * the creases travel outward and downward AWAY from the crotch instead of converging on it — a wave in
   * v alone would ring the garment in horizontal bands, and a wave in u alone would run straight down and
   * meet its mirror at the centre line, which is the pinch again in another form.
   *
   * `max(0, .)` raised to a power keeps the troughs flat and the ridges narrow, which is how cloth
   * actually creases: broad relaxed panels separated by tight folds, not a sine wave.
   */
  const fold = (u: number, v: number, turns: number, pitch: number, gain: number): number => {
    if (gain <= 0) return 0;
    const wave = Math.sin(Math.PI * 2 * (turns * u + pitch * v));
    return wave <= 0 ? 0 : gain * wave ** 1.7;
  };

  // Outward winding, checked rather than guessed: for a ring where index 0 sits at +z and the next
  // row is BELOW it, (A[i], B[i], A[i+1]) has its normal along +z at i = 0, which is outward.
  // Region labels are carried per triangle so the component-colour render can show that the regions are
  // JOINED. With one mesh there is nothing to colour by object any more, and "it is one mesh" is not by
  // itself evidence that the pelvis and the legs are the same skin.
  const region: string[] = [];
  const quadRow = (a: number[], b: number[], label: (i: number) => string): void => {
    for (let i = 0; i < a.length; i += 1) {
      const j = (i + 1) % a.length;
      triangles.push([a[i], b[i], a[j], 0], [a[j], b[i], b[j], 0]);
      region.push(label(i), label(i));
    }
  };

  const pelvisRings = pelvis.map((row, r) => {
    // Nothing at the waist, most at the crotch: the seat and groin are where a garment is actually under
    // tension, and the waistband edge has to stay a clean ring.
    const v = pelvis.length > 1 ? r / (pelvis.length - 1) : 0;
    // 0.048, not 0.013: at 0.013 the creases were present in the geometry and invisible in the render.
    const gain = 0.048 * v * v;
    const ring: number[] = [];
    for (let i = 0; i < N; i += 1) {
      const theta = (i / N) * Math.PI * 2;
      // Exact zeroes at the rises: the seam chain has to start and end ON the x = 0 plane, and
      // sin(PI) is 1.2e-16 rather than 0.
      const s = i === 0 || i === HALF ? 0 : Math.sin(theta);
      const c = Math.cos(theta);
      const depth = c > 0 ? row.frontDepth : row.backDepth;
      const spoke: V3 = [s * row.halfWidth, 0, c * depth];
      const seated = hugged([spoke[0], row.y, row.zCentre + spoke[2]], spoke, 0.20, 0, hug.spanField);
      const len = Math.hypot(spoke[0], spoke[2]) || 1;
      // Weighted by how much the vertex faces front or back. Folds belong on the panels, not on the
      // side seams: at the widest point of the garment a crease would push the SILHOUETTE out, and the
      // measured band width is already 0.1893 H against the baseline's 0.1837. Weighting by |cos| leaves
      // the extremes exactly where the hug put them.
      const lift = fold(i / N, v, 5, 1.0, gain * Math.abs(c) ** 1.4);
      ring.push(push(
        [seated[0] + (spoke[0] / len) * lift, seated[1], seated[2] + (spoke[2] / len) * lift],
        spoke, 0, 0.20,
      ));
    }
    return ring;
  });
  // The front half is where cos(theta) > 0, which is index 0..4 and 15..19 on a twenty-vertex ring.
  const pelvisLabel = (i: number): string =>
    (i < HALF / 2 || i >= N - HALF / 2 ? 'pelvis-front' : 'pelvis-back');
  for (let r = 0; r + 1 < pelvisRings.length; r += 1) {
    quadRow(pelvisRings[r], pelvisRings[r + 1], pelvisLabel);
  }

  // THE SEAM CHAIN. Its vertices march along -y rather than radially: a gusset that finds body in
  // front of it should hang below the body, not squeeze sideways into the leg.
  const crotch = pelvisRings[pelvisRings.length - 1];
  const frontRise = crotch[0];
  const backRise = crotch[HALF];
  const crotchY = pelvis[pelvis.length - 1].y;
  const frontZ = position[frontRise][2];
  const backZ = position[backRise][2];
  // Each seam vertex marches along the field's own GRADIENT rather than a fixed axis. A gusset runs
  // front to back through a region where "away from the body" is +z at the front rise, -y under the
  // crotch and -z at the back rise; one direction cannot serve all three, and -y alone let the front of
  // the seam sit inside the body's front.
  const gradient = (x: number, y: number, z: number): V3 => {
    const h = 0.004;
    return [
      hug.field(x + h, y, z) - hug.field(x - h, y, z),
      hug.field(x, y + h, z) - hug.field(x, y - h, z),
      hug.field(x, y, z + h) - hug.field(x, y, z - h),
    ];
  };
  // TWO SEAM CHAINS, NOT ONE, AND A FLOOR BETWEEN THEM.
  //
  // A single chain at x = 0 is a LINE, and cloth arriving from both legs onto a line is a pinch by
  // construction — the crotch reads as a crease pulled into the centre instead of a surface. The same
  // line is where the last body pixels leaked from below, because two sheets meeting along an edge meet
  // at grazing incidence, where a 0.022 offset occludes nothing.
  //
  // A sewn garment does not do this either: it has a gusset PIECE. So the seam splits into a left chain
  // at x = -g and a right chain at x = +g with a floor strip between them — a lens bounded by the front
  // rise, the two chains and the back rise. Each leg's first ring takes its own chain, the floor takes
  // both, and every chain edge still carries exactly two faces, one from a leg and one from the floor.
  // The crotch therefore still has no boundary loop of its own.
  const chainAt = (side: number): number[] => chainDrop.map((drop, k) => {
    const t = (k + 1) / (chainDrop.length + 1);
    const p: V3 = [side * gussetHalfWidth, crotchY - drop, frontZ + (backZ - frontZ) * t];
    // The gradient's x component is dropped. Inside the carved slot the nearest surface is the wall beside
    // the vertex, so the gradient points back at x = 0 — following it would walk both chains onto the
    // centre line and rebuild the pinch this change exists to remove. The gusset's WIDTH is a pattern
    // decision; only its sag is left to the body.
    const g = gradient(p[0], p[1], p[2]);
    const dir: V3 = [0, g[1], g[2]];
    return push(hugged(p, dir, 0.14), dir, 0, 0.14);
  });
  const rightChain = chainAt(1);
  const leftChain = chainAt(-1);

  // The floor. Both polylines run front rise to back rise and collapse to one vertex at each end, so the
  // first and last spans are triangles and the rest are quads. The winding puts the normal on -y, which
  // is outward for the underside of a crotch.
  const floorL = [frontRise, ...leftChain, backRise];
  const floorR = [frontRise, ...rightChain, backRise];
  for (let i = 0; i + 1 < floorL.length; i += 1) {
    const l0 = floorL[i]; const l1 = floorL[i + 1];
    const r0 = floorR[i]; const r1 = floorR[i + 1];
    if (l0 === r0) { triangles.push([l0, l1, r1, 0]); region.push('gusset'); continue; }
    if (l1 === r1) { triangles.push([l0, l1, r0, 0]); region.push('gusset'); continue; }
    triangles.push([l0, l1, r0, 0], [r0, l1, r1, 0]);
    region.push('gusset', 'gusset');
  }

  const tops: Array<[number, number[]]> = [
    [1, [...crotch.slice(0, HALF + 1), ...rightChain.slice().reverse()]],
    [-1, [...crotch.slice(HALF), crotch[0], ...leftChain]],
  ];
  for (const [side, top] of tops) {
    const first = legs[0];
    const xc = side * first.xCentre;
    // atan2(x - xc, z - zc) with the leg's OWN centre, so the same reconstruction formula serves both
    // sides and both traversals come out monotone — hence one winding for both legs.
    const angles = top.map((vi) => Math.atan2(position[vi][0] - xc, position[vi][2] - first.zCentre));
    let previous = top;
    for (let r = 1; r < legs.length; r += 1) {
      const row = legs[r];
      // Strongest a third of the way down the leg and gone by the hem, which is where the baseline
      // carries its two big diagonal folds across each thigh.
      const v = r / (legs.length - 1);
      const gain = 0.055 * Math.sin(Math.PI * Math.min(1, v * 1.25)) ** 0.8;
      const ring = angles.map((angle, j) => {
        const spoke: V3 = [Math.sin(angle) * row.halfWidth, 0, Math.cos(angle) * row.halfDepth];
        const seated = hugged(
          [side * row.xCentre + spoke[0], row.y, row.zCentre + spoke[2]], spoke, 0.24, side,
        );
        // The same crotch-plane guard as the march: an inner vertex creases forward or back, not inward.
        const guarded: V3 = spoke[0] * side < 0 ? [0, 0, spoke[2]] : [spoke[0], 0, spoke[2]];
        const len = Math.hypot(guarded[0], guarded[2]) || 1;
        const lift = fold(j / angles.length, v, 4, 1.3, gain * Math.abs(Math.cos(angle)) ** 1.4);
        return push(
          [seated[0] + (guarded[0] / len) * lift, seated[1], seated[2] + (guarded[2] / len) * lift],
          spoke, side, 0.24,
        );
      });
      // The first leg row is the gusset where it runs along the seam: positions HALF and beyond on the
      // composite ring are the back rise, the chain, and the wrap back to the front rise.
      const leg = side > 0 ? 'leg-r' : 'leg-l';
      quadRow(previous, ring, (i) => (r === 1 && i >= HALF ? 'gusset' : leg));
      previous = ring;
    }
  }

  // NO RELAXATION PASS. One was built and then deleted, and it is worth recording why rather than leaving
  // the idea available to be tried again.
  //
  // It measured the clearance shortfall at edge midpoints and triangle centroids and charged it back to the
  // vertices that own them, each moving along the spoke it was built on — the standard way to make a
  // polyline enclose a curve. It did not converge: over six passes the worst shortfall fell only from
  // 0.0318 to 0.0121 and a hundred vertices were still moving on the last one, because a vertex shared by
  // several triangles takes the maximum of their demands, over-covers its neighbours, and re-creates a
  // shortfall elsewhere. What it produced was thin spikes hanging below the hem and two wedges of exposed
  // body at the legs' outer edges. Deleting it took the underside leak from 4096 pixels to 756, with the
  // front and back staying at zero.
  //
  // The lesson is about ordering. It was aimed at a leak whose real cause was a leftover mesh in the
  // crotch, so it could never have removed that — and while it was in place it added defects of its own
  // that looked like the one being chased.

  // TOPOLOGY GATE, computed here so a regression cannot be argued about. Every edge should carry two
  // faces except the waist and the two hems.
  const edges = new Map<string, number>();
  for (const [a, b, c] of triangles) {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const boundary: Array<[number, number]> = [];
  let nonManifold = 0;
  for (const [key, count] of edges) {
    const [u, v] = key.split(':').map(Number);
    if (count === 1) boundary.push([u, v]);
    else if (count > 2) nonManifold += 1;
  }
  const neighbours = new Map<number, number[]>();
  for (const [u, v] of boundary) {
    if (!neighbours.has(u)) neighbours.set(u, []);
    if (!neighbours.has(v)) neighbours.set(v, []);
    neighbours.get(u)!.push(v);
    neighbours.get(v)!.push(u);
  }
  const seen = new Set<number>();
  let loops = 0;
  for (const start of neighbours.keys()) {
    if (seen.has(start)) continue;
    loops += 1;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      for (const next of neighbours.get(stack.pop()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
  }

  const mesh = facetedPatch(name, position, triangles, [mat]);
  mesh.userData.shellTopology = {
    vertices: position.length,
    triangles: triangles.length,
    boundaryLoops: loops,
    boundaryEdges: boundary.length,
    nonManifoldEdges: nonManifold,
    seamChainVertices: leftChain.length + rightChain.length,
    gussetFloorTriangles: region.filter((r) => r === 'gusset').length,
    expectedLoops: 3,
  };
  mesh.userData.shellRegions = region;
  return mesh;
}

/**
 * One station of the HEAD-AND-NECK shell: a named height carrying a full 360-degree contour.
 *
 * WHY A FULL RING RATHER THAN A MIRRORED HALF. `TorsoStation` authors nine points for the right side and
 * mirrors them, which is right for a torso and wrong here: it can express front-to-back shape but not a
 * skull that differs left from right. This one lists every point, so a station can be asymmetric in
 * both axes.
 *
 * WHY NOT A LATHE. `facetedBody` is a surface of revolution — every section is a scaled n-gon centred on
 * the axis — so a jaw angle, a chin point and a temple hollow are not expressible in it at any setting.
 * That is the root limitation this replaces, not a tuning problem.
 *
 * `frontDepth` and `backDepth` are separate so a receding forehead and a full occiput come from the
 * SHAPE of each ring rather than from tilting the whole vault. Shearing the axis to fake them is what
 * turned the side view into a parallelogram.
 */
interface HeadStation {
  name: string;
  y: number;
  halfWidth: number;
  frontDepth: number;
  backDepth: number;
  zCentre: number;
  /**
   * Radial multiplier per ring point, 1 = the base section. Index 0 is the front midline and the ring
   * runs toward the character's LEFT (+x), so index 4 is the left side, 8 the nape, 12 the right side.
   * This is where a jaw angle lives: pull indices 3..5 out and 2..6 in, and the section stops being an
   * oval without the ring ceasing to be low-poly.
   */
  shape?: number[];
  /** Absolute x shift per point. The only route to genuine left-right asymmetry; 0 keeps it symmetric. */
  shiftX?: number[];
}

const HEAD_RING_POINTS = 16;

/**
 * One point of a station's ring, by the same arithmetic the shell itself uses.
 *
 * Exists so a face patch can be built ON the head rather than NEAR it. Every previous attempt at a nose
 * on this figure placed its boundary at coordinates worked out separately from the surface it was
 * supposed to join, and the two then disagreed by however much the surface had since moved — which is
 * what a visible seam is. Sharing this function means the patch's boundary and the shell's ring are the
 * same computation, so they cannot drift apart.
 */
function headRingPoint(s: HeadStation, i: number): [number, number, number] {
  const theta = (i / HEAD_RING_POINTS) * Math.PI * 2;
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);
  const k = s.shape ? s.shape[i] : 1;
  const depth = cos >= 0 ? s.frontDepth : s.backDepth;
  return [
    sin * s.halfWidth * k + (s.shiftX ? s.shiftX[i] : 0),
    s.y,
    s.zCentre + cos * depth * k,
  ];
}

/**
 * Head and neck as ONE indexed surface, stitched station to station.
 *
 * Two meshes meeting at a coincident ring are flush, not continuous: the previous build welded them to
 * 0.00000 and the join still read as a join, because a weld pins positions while normals, shading and
 * topology stay separate. One mesh removes the question.
 */
/**
 * The hair mass, terminated at an authored boundary rather than faded out by a tuck.
 *
 * WHY A SEPARATE BUILDER. `buildHeadShell` puts every ring at a station height, so its lower edge is
 * a horizontal circle. The only way to shape a hairline with it was `SCALP_FRONT_TUCK`, which pulls
 * ring points INSIDE the skull and lets the skull hide them — and a surface that fades behind another
 * surface produces a smooth crossing curve. **A tuck gradient cannot make a corner.** That is why
 * every hairline attempt in this file came out round, including the ones built specifically to be
 * jagged, and it is the single feature the four-view reference is most identified by: its hairline,
 * sideburn and nape are a CUT, straight runs meeting at sharp corners.
 *
 * Here each column of the mesh has its OWN bottom, taken from `hairline[i]`, and the rows are sampled
 * between that height and the crown. The boundary is therefore authored directly and a corner is just
 * two neighbouring entries that differ.
 *
 * The bottom edge folds inward to a second ring, so the cut has thickness. Without it the termination
 * renders as a paper edge — visible in the reference as a solid mass ending in an edge, not a cutout.
 */
function buildHairMass(
  name: string,
  stations: HeadStation[],
  hairline: number[],
  mat: THREE.Material,
  opts: { rows?: number; rim?: number; columns?: number; creaseCount?: number; creaseDepth?: number;
    edgeTuck?: number[];
    sideburns?: Array<{ at: number; drop: number; width: number }> } = {},
): THREE.Mesh {
  // 17 rows, and biased toward the top. Seven evenly spaced in Y put barely one row across the two
  // dome rings that sit within 0.09 of the crown, so the mass ran almost straight from the last
  // sampled ring to the apex and rendered as a cone again. The rows are placed on a curve so the
  // sampling is dense where the profile changes fastest.
  const ROWS = opts.rows ?? 17;
  const RIM = opts.rim ?? 0.030;
  type V3 = [number, number, number];
  const position: V3[] = [];
  const uv: Array<[number, number]> = [];
  const triangles: Array<[number, number, number, number]> = [];

  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

  // The station profile as a continuous function of height, so a column can be sampled anywhere
  // between two authored stations instead of only at them.
  const sampleStation = (y: number): HeadStation => {
    let lo = stations[0];
    let hi = stations[stations.length - 1];
    for (let k = 0; k + 1 < stations.length; k += 1) {
      if (y >= stations[k].y && y <= stations[k + 1].y) { lo = stations[k]; hi = stations[k + 1]; break; }
      if (y < stations[0].y) { lo = stations[0]; hi = stations[1]; break; }
      if (y > stations[stations.length - 1].y) { lo = stations[stations.length - 2]; hi = stations[stations.length - 1]; break; }
    }
    const t = Math.abs(hi.y - lo.y) < 1e-9 ? 0 : (y - lo.y) / (hi.y - lo.y);
    const shape: number[] = [];
    for (let k = 0; k < HEAD_RING_POINTS; k += 1) {
      shape.push(lerp(lo.shape ? lo.shape[k] : 1, hi.shape ? hi.shape[k] : 1, t));
    }
    return {
      name: 'sampled',
      y,
      halfWidth: lerp(lo.halfWidth, hi.halfWidth, t),
      frontDepth: lerp(lo.frontDepth, hi.frontDepth, t),
      backDepth: lerp(lo.backDepth, hi.backDepth, t),
      zCentre: lerp(lo.zCentre, hi.zCentre, t),
      shape,
    };
  };

  const topY = stations[stations.length - 1].y;
  // EDGE TUCK: how far the surface curls INWARD as it approaches its own boundary, per ring index.
  //
  // Without it the mass ends at the full station clearance, so its lower edge stands off the skull by
  // the same amount as its middle does and flares away from the cap. That is fine over the crown and
  // wrong behind the ear, where the reference has the hair curving back in to meet the head. It is
  // per-index because only that region needs it — everywhere else the edge is already right.
  const EDGE_TUCK = opts.edgeTuck;
  const tuckAt = (u: number): number => {
    if (!EDGE_TUCK) return 0;
    const f = u * HEAD_RING_POINTS;
    const lo = Math.floor(f) % HEAD_RING_POINTS;
    const hi = (lo + 1) % HEAD_RING_POINTS;
    return EDGE_TUCK[lo] + (EDGE_TUCK[hi] - EDGE_TUCK[lo]) * (f - Math.floor(f));
  };
  const CREASE_N = opts.creaseCount ?? 9;
  // 0.045, not 0.016. At 0.016 against a head half-width near 0.42 the wave was under 4% of the
  // radius and rendered as nothing: on a mass this dark a small normal change produces almost no
  // value difference, so a crease has to be large enough to ORGANISE the shading into bands rather
  // than merely perturb it.
  const CREASE_D = opts.creaseDepth ?? 0.045;

  // POLAR UV CENTRED ON THE CROWN, because a `tangent` attribute cannot place a whorl.
  //
  // `scripts/tangent-flow-probe.mjs` renders two spheres with the same normal map — one with
  // `computeTangents()`, one with tangents authored as a whorl field — and they come out the same:
  // stripes along the UV meridians on both. The shader samples the map at `vUv` and only ORIENTS the
  // result with the TBN, so the tangent rotates the perturbation without moving where the pattern is
  // drawn. Authoring tangents was the plan and the probe rejected it.
  //
  // So the whorl has to be in the UV: `u` is the angle about the crown axis and `v` the distance down
  // from it, which makes a feature that varies in `u` and holds along `v` a strand radiating from the
  // crown. The extra column is the seam fix — index HEAD_RING_POINTS repeats column 0's POSITION with
  // u = 1, so no triangle has to interpolate u from 1 back to 0 and sweep the whole texture across
  // itself.
  // COLUMNS ARE THE HAIR'S OWN, NOT THE SKULL'S.
  //
  // I claimed this was blocked because HEAD_RING_POINTS is 16 and raising it changes
  // cos(PI/segments) from 0.924 to 0.966, breaking the neck weld that was solved against 0.924. That
  // is true of the SKULL and irrelevant here: this builder samples the station profile itself, so it
  // can take as many columns as it likes by reading ring points at fractional indices. The skull keeps
  // its 16.
  //
  // The reason to want more: the reference's tonal ratio p90/p50 is 5.3 and six material settings
  // reached at most 3.2, because on a flat-shaded mesh a facet is lit uniformly and there is no
  // sub-facet variation to make a highlight selective. Smaller facets are that variation.
  const RING_STEPS = opts.columns ?? HEAD_RING_POINTS;
  const COLS = RING_STEPS + 1;
  const ringAt = (st: HeadStation, u: number): [number, number, number] => {
    const f = u * HEAD_RING_POINTS;
    const lo = Math.floor(f) % HEAD_RING_POINTS;
    const hi = (lo + 1) % HEAD_RING_POINTS;
    const t = f - Math.floor(f);
    const a = headRingPoint(st, lo);
    const b = headRingPoint(st, hi);
    return [a[0] + (b[0] - a[0]) * t, a[1], a[2] + (b[2] - a[2]) * t];
  };
  // The boundary is piecewise linear between the authored entries, so its CORNERS stay exactly where
  // the table puts them however finely the surface is sampled.
  // SIDEBURNS ARE A SEPARATE FEATURE, NOT A TABLE ENTRY.
  //
  // The boundary table has one value per ring index, so its narrowest possible feature is one whole
  // interval — 22.5 degrees of the head. Every sideburn authored that way came out as a broad shallow
  // dip, because a dip two intervals wide is what the table can say and nothing narrower. The
  // reference's is a narrow wedge tapering to a point.
  //
  // So it is added on top: a drop at a FRACTIONAL index with its own half-width, falling off linearly
  // so the tip is a corner rather than a curve. `at` can sit between authored indices, which is where
  // the reference puts it — just forward of the ear at index 4.
  const SIDEBURNS = opts.sideburns ?? [];
  const sideburnDrop = (u: number): number => {
    if (!SIDEBURNS.length) return 0;
    const fi = u * HEAD_RING_POINTS;
    let d = 0;
    for (const sb of SIDEBURNS) {
      let t = Math.abs(fi - sb.at);
      if (t > HEAD_RING_POINTS / 2) t = HEAD_RING_POINTS - t;
      if (t < sb.width) d = Math.max(d, sb.drop * (1 - t / sb.width));
    }
    return d;
  };
  const hairlineAt = (u: number): number => {
    const f = u * HEAD_RING_POINTS;
    const lo = Math.floor(f) % HEAD_RING_POINTS;
    const hi = (lo + 1) % HEAD_RING_POINTS;
    const base = hairline[lo] + (hairline[hi] - hairline[lo]) * (f - Math.floor(f));
    return base - sideburnDrop(u);
  };
  const grid: number[][] = [];
  for (let r = 0; r < ROWS; r += 1) {
    const ring: number[] = [];
    for (let c = 0; c < COLS; c += 1) {
      const u = (c % RING_STEPS) / RING_STEPS;
      const rowT = r / (ROWS - 1);
      const y = lerp(hairlineAt(u), topY, Math.pow(rowT, 0.72));
      const st = sampleStation(y);
      const p = ringAt(st, u);
      // CREASES AS GEOMETRY, NOT AS A TEXTURE.
      //
      // The normal map already draws fine striations and the mass still reads as a helmet, because a
      // normal map cannot change a silhouette or cast a facet into shadow — it only tilts the shading
      // within a face. In every reference view the hair carries WAVES big enough to break the surface
      // into alternating ridges and grooves, with the ridge edges visible against the outline.
      //
      // The wave varies in u and holds along v, which on this polar layout means it radiates from the
      // crown — the same direction as the flow map, so the two agree instead of beating. It fades to
      // nothing at the boundary (rowT 0) so the authored hairline keeps its exact corners, and it is
      // strongest over the crown where the references show it most.
      // A HUMP, ZERO AT BOTH ENDS. This used to rise to its maximum at the crown, which is the one
      // place it must not: every column converges on the apex there, so the angular spacing between
      // them goes to zero and any variation in u is pinched into a hard radial crease. The result was
      // a folded-umbrella star at the top of the head — straight cut lines meeting at a point, where
      // hair should read as a rounded whorl.
      //
      // Zero at rowT 0 keeps the authored hairline's corners exact, as before; zero at rowT 1 lets the
      // crown close smoothly. The creases now live in the middle of the mass, where there is room for
      // them to be waves rather than folds.
      const fade = Math.sin(Math.PI * Math.min(1, rowT * 1.04)) ** 1.15;
      // ONE-SIDED. A signed sine sinks the troughs BELOW the base surface by the full amplitude, and
      // once the clearance was cut to hug the skull that put them under the scalp cap — the cap showed
      // through the mass as grey patches. Offsetting to 0..1 keeps the ridge-and-valley shape while
      // guaranteeing the mass never goes inward of where it started.
      const crease = CREASE_D * (0.5 + 0.5 * Math.sin(u * Math.PI * 2 * CREASE_N)) * fade;
      // Strongest at the boundary and gone by a third of the way up, so the curl is a lip rather than
      // a change of overall volume.
      const tuck = tuckAt(u) * Math.max(0, 1 - rowT / 0.34) ** 1.5;
      const dx = p[0];
      const dz = p[2] - st.zCentre;
      const len = Math.hypot(dx, dz) || 1;
      uv.push([c / RING_STEPS, 1 - rowT]);
      ring.push(position.push([p[0] + (dx / len) * (crease - tuck), p[1],
        p[2] + (dz / len) * (crease - tuck)]) - 1);
    }
    grid.push(ring);
  }
  // Inner lip: the boundary row pulled toward the skull, giving the cut a thickness.
  const lip: number[] = [];
  for (let c = 0; c < COLS; c += 1) {
    const u = (c % RING_STEPS) / RING_STEPS;
    const st = sampleStation(hairlineAt(u));
    const q = ringAt(st, u);
    const len = Math.hypot(q[0], q[2] - st.zCentre) || 1;
    uv.push([c / RING_STEPS, 1]);
    lip.push(position.push([q[0] - (q[0] / len) * RIM, q[1] + RIM * 0.35,
      q[2] - ((q[2] - st.zCentre) / len) * RIM]) - 1);
  }

  const quad = (a: number, b: number, c: number, d: number): void => {
    triangles.push([a, b, c, 0], [a, c, d, 0]);
  };
  for (let r = 0; r + 1 < ROWS; r += 1) {
    for (let c = 0; c + 1 < COLS; c += 1) {
      quad(grid[r][c], grid[r + 1][c], grid[r + 1][c + 1], grid[r][c + 1]);
    }
  }
  for (let c = 0; c + 1 < COLS; c += 1) {
    quad(grid[0][c], grid[0][c + 1], lip[c + 1], lip[c]);
  }

  // NO SILHOUETTE SPIKES. They displaced vertices of `grid[ROWS - 1]`, which was the crown's widest
  // ring when the mass ended there — but once the mass closed over the top, that row became the tiny
  // POLE ring, so the spikes turned into horns standing above the dome.
  //
  // Measured: the five highest vertices in the entire mass were at ring 8, 2, 14, 6 and 11 with
  // uv.v = 0, which is exactly the spike list on exactly the top row.
  //
  // Removed rather than relocated. The reference's upper edge is essentially smooth, the creases
  // already give the silhouette its irregularity, and this feature produced a visible artefact twice.

  // Crown cap, fanned from the top ring.
  const top = stations[stations.length - 1];
  let cx = 0;
  let cz = 0;
  for (let c = 0; c < RING_STEPS; c += 1) {
    cx += position[grid[ROWS - 1][c]][0];
    cz += position[grid[ROWS - 1][c]][2];
  }
  cx /= RING_STEPS;
  cz /= RING_STEPS;
  // The apex is the whorl's centre, so v = 0 there and every strand runs out of it.
  uv.push([0.5, 0]);
  // 0.05. With the last ring down at 0.08 of the crown's radius the apex only has to close a very
  // small hole, so it sits almost in the plane of that ring rather than standing above it.
  const apex = position.push([cx, top.y + top.frontDepth * 0.05, cz]) - 1;
  for (let c = 0; c + 1 < COLS; c += 1) {
    triangles.push([apex, grid[ROWS - 1][c + 1], grid[ROWS - 1][c], 0]);
  }

  return facetedPatch(name, position, triangles, [mat], uv);
}

function buildHeadShell(
  name: string,
  stations: HeadStation[],
  mat: THREE.Material,
  opts: { capBottom?: boolean } = {},
): THREE.Mesh {
  type V3 = [number, number, number];
  const position: V3[] = [];
  const uv: Array<[number, number]> = [];
  const triangles: Array<[number, number, number, number]> = [];

  // UV, laid out so the texture's V axis is the direction hair actually grows.
  //
  // A strand runs from the hairline up over the skull, which on this parameterisation means holding
  // the ring index and stepping through STATIONS — so `v` is the station axis and `u` is across the
  // strand, which is the way round a streak texture needs.
  //
  // `u` folds rather than wraps: it runs 0 at the front midline to 1 at the nape and back to 0, so
  // index 15 and index 1 both land on 0.125. A plain `i / n` would jump 0.94 -> 0 across the front
  // seam and mirror a band of texture there; folding removes the seam entirely and costs only a
  // left-right mirror of the streak pattern, which a symmetric skull wants anyway.
  const halfRing = HEAD_RING_POINTS / 2;
  const lastStation = Math.max(1, stations.length - 1);

  const rings = stations.map((s, stationIndex) => {
    const ring: number[] = [];
    for (let i = 0; i < HEAD_RING_POINTS; i += 1) {
      const theta = (i / HEAD_RING_POINTS) * Math.PI * 2;
      const sin = Math.sin(theta);
      const cos = Math.cos(theta);
      const k = s.shape ? s.shape[i] : 1;
      // Front and back depth meet at cos = 0, so switching between them at the sides is continuous.
      const depth = cos >= 0 ? s.frontDepth : s.backDepth;
      const x = sin * s.halfWidth * k + (s.shiftX ? s.shiftX[i] : 0);
      const z = s.zCentre + cos * depth * k;
      uv.push([1 - Math.abs(i - halfRing) / halfRing, stationIndex / lastStation]);
      ring.push(position.push([x, s.y, z]) - 1);
    }
    return ring;
  });

  const span = (a: number, b: number): number => {
    const p = position[a];
    const q = position[b];
    return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  };

  for (let r = 0; r + 1 < rings.length; r += 1) {
    const lo = rings[r];
    const hi = rings[r + 1];
    for (let i = 0; i < HEAD_RING_POINTS; i += 1) {
      const j = (i + 1) % HEAD_RING_POINTS;
      // The shorter diagonal is the one that lies along the surface rather than across its curvature.
      if (span(lo[i], hi[j]) <= span(lo[j], hi[i])) {
        triangles.push([lo[i], hi[i], hi[j], 0], [lo[i], hi[j], lo[j], 0]);
      } else {
        triangles.push([lo[i], hi[i], lo[j], 0], [lo[j], hi[i], hi[j], 0]);
      }
    }
  }

  // Caps. The crown is a real surface and needs one; the base sits inside the torso shell and cannot be
  // seen, but it is capped anyway so the mesh is closed and the topology gate has something to check.
  const capFan = (ring: number[], y: number, flip: boolean, vAt: number): void => {
    let cx = 0;
    let cz = 0;
    for (const v of ring) { cx += position[v][0]; cz += position[v][2]; }
    // The apex is where every strand converges, which is what a crown whorl is. Putting it at u 0.5
    // means the streak texture spirals into it instead of ending on a hard edge.
    uv.push([0.5, vAt]);
    const apex = position.push([cx / ring.length, y, cz / ring.length]) - 1;
    for (let i = 0; i < HEAD_RING_POINTS; i += 1) {
      const j = (i + 1) % HEAD_RING_POINTS;
      triangles.push(flip ? [apex, ring[j], ring[i], 0] : [apex, ring[i], ring[j], 0]);
    }
  };
  const top = stations[stations.length - 1];
  capFan(rings[rings.length - 1], top.y + top.frontDepth * 0.34, true, 1);
  if (opts.capBottom !== false) capFan(rings[0], stations[0].y - 0.05, false, 0);

  const mesh = facetedPatch(name, position, triangles, [mat], uv);
  mesh.userData.headShell = { stations: stations.map((s) => s.name), ringPoints: HEAD_RING_POINTS };
  return mesh;
}

/**
 * One station of the torso's cross-section: a named height with its own polygon, not a radius.
 *
 * Nine control points describe the right half, sternum round to spine, and the left half mirrors them.
 * `front`, `side` and `back` are fractions of that station's own depth or width, so the SHAPE of the
 * section is authored independently of its SIZE — which is the whole point. A single radiusZ across the
 * front makes an ellipse, and an ellipse is why every pec built on this torso so far has been a blob.
 */
interface TorsoStation {
  name: string;
  y: number;
  halfWidth: number;
  frontDepth: number;
  backDepth: number;
  zCentre: number;
  /**
   * z at the midline as a fraction of frontDepth. Below 1 makes the midline a GROOVE — the sternum in
   * the chest, the linea alba over the abdomen. It was pinned at 1.00 while its neighbour sat at 0.94,
   * which put a ridge exactly where both of those are furrows.
   */
  zMid?: number;
  /** Vertical offset at the front midline. Enables a chevron costal arch within one section. */
  yMid?: number;
  /** x as fractions of halfWidth, midline outward. Every station must carry the same count. */
  xFront: number[];
  /** z as fractions of frontDepth at those same points. */
  zFront: number[];
  /** Vertical offsets at the corresponding front control points. */
  yFront?: number[];
  /** x fractions: back-side, scapula/lat. */
  xBack: number[];
  /** z fractions of backDepth at those same points. */
  zBack: number[];
  /** Vertical offsets across the sampled back profile, lat-to-spine. */
  yBack?: number[];
  /** Additive back-depth fractions across the sampled profile, lat-to-spine. */
  zBackRelief?: number[];
  /**
   * Skip the clearance march at this station.
   *
   * The march is `max(authored, body + clearance)`, which is right everywhere the shell is the visible
   * surface and wrong at the bottom, where the shell must end up INSIDE the waistband. A station that
   * hugs there is pushed back out to the body's own width — the same width the waistband has — and
   * comes through it.
   */
  noHug?: boolean;
}

/**
 * The torso as explicit polygonal geometry, replacing what an isosurface cannot express.
 *
 * WHY THIS EXISTS. Three representations of the chest were tried inside the body field — capsules,
 * added plates, carved plates — and the third worked structurally while still reading as a smooth
 * shell with shallow creases. The reason is not the primitives. A field is sampled on a grid, so its
 * edges land where the grid puts them rather than where anatomy does; and its normals come from the
 * field's gradient, so "hard crease here, smooth there" is not expressible at all. Large planes met at
 * intentional edges is exactly what the reference's low-poly language is made of, and a smooth union
 * of primitives cannot produce it at any parameter setting.
 *
 * So the torso's front and back are authored as sections with named control points, quads are run
 * between consecutive stations, and the material is flat-shaded: each quad becomes a plane, and every
 * edge between two stations or two control points is a crease that was put there on purpose.
 *
 * `hug` guarantees the shell stays outside the body field it covers — the same march the shorts use —
 * so the underlying isosurface can never show through a station that was authored too tight.
 */
function buildTorsoShell(
  name: string,
  stations: TorsoStation[],
  mat: THREE.Material,
  hug?: { field: (x: number, y: number, z: number) => number; clearance: number; maxPush: number },
): THREE.Mesh {
  type V3 = [number, number, number];
  const position: V3[] = [];
  const triangles: Array<[number, number, number, number]> = [];

  const hugged = (p: V3): V3 => {
    if (!hug) return p;
    // Radially outward from the station's own axis, so a vertex pushed clear keeps its angle and the
    // section keeps the shape it was authored with.
    const dx = p[0];
    const dz = p[2];
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) return p;
    const out: V3 = [p[0], p[1], p[2]];
    let travelled = 0;
    for (let i = 0; i < 24; i += 1) {
      const gap = hug.field(out[0], out[1], out[2]);
      if (gap >= hug.clearance - 1e-4) break;
      const move = Math.min(Math.max(0.0005, hug.clearance - gap), hug.maxPush - travelled);
      if (move <= 0) break;
      out[0] += (dx / len) * move;
      out[2] += (dz / len) * move;
      travelled += move;
    }
    return out;
  };

  const rings = stations.map((s) => {
    const seat = (v: V3): V3 => (s.noHug ? v : hugged(v));
    // Right half, sternum round to spine: 9 points. The mirror re-uses 7 of them, so a ring is 16.
    const sourceBack = [...s.xBack.map((x, index) => [x, s.zBack[index]] as [number, number]), [0, 1] as [number, number]];
    const sampleBack = (x: number): number => {
      for (let i = 0; i + 1 < sourceBack.length; i += 1) {
        const [ax, az] = sourceBack[i];
        const [bx, bz] = sourceBack[i + 1];
        if (x > ax || x < bx) continue;
        const t = (ax - x) / Math.max(1e-6, ax - bx);
        return az + (bz - az) * t;
      }
      return 1;
    };
    const scapulaWeight = Math.max(0, 1 - Math.abs(s.y - BACK_SCULPT_PARAMS.scapulaY)
      / BACK_SCULPT_PARAMS.scapulaSpan);
    const lumbarWeight = Math.max(0, 1 - Math.abs(s.y - BACK_SCULPT_PARAMS.lumbarY)
      / BACK_SCULPT_PARAMS.lumbarSpan);
    const backProfile = BACK_SCULPT_PARAMS.xProfile.map((x, index): [number, number] => {
      let z = sampleBack(x) + (s.zBackRelief?.[index] ?? 0);
      if (index === 1) z += BACK_SCULPT_PARAMS.scapulaDepth * scapulaWeight;
      if (index === 2) z += BACK_SCULPT_PARAMS.scapulaDepth * scapulaWeight * 0.45
        + BACK_SCULPT_PARAMS.erectorDepth * lumbarWeight * 0.30;
      if (index === 3) z += BACK_SCULPT_PARAMS.erectorDepth * (0.35 + lumbarWeight * 0.65);
      if (index === 4) z += BACK_SCULPT_PARAMS.spineRailDepth;
      return [x, z];
    });
    const right: V3[] = [
      [0, s.y + (s.yMid ?? 0), s.zCentre + (s.zMid ?? 1) * s.frontDepth],
      ...s.xFront.map((xf, i): V3 => (
        [xf * s.halfWidth, s.y + (s.yFront?.[i] ?? 0), s.zCentre + s.zFront[i] * s.frontDepth]
      )),
      [s.halfWidth, s.y, s.zCentre],
      ...backProfile.map(([xb, zb], index): V3 => (
        [xb * s.halfWidth,
          s.y + (s.yBack?.[index] ?? (BACK_SCULPT_PARAMS.scapulaSlope * scapulaWeight
            * (1 - index / Math.max(1, backProfile.length - 1) * 2))),
          s.zCentre - zb * s.backDepth]
      )),
      [0, s.y - BACK_SCULPT_PARAMS.scapulaSlope * scapulaWeight,
        s.zCentre - s.backDepth + BACK_SCULPT_PARAMS.spineGrooveDepth],
    ];
    const ring: number[] = [];
    for (const v of right) {
      position.push(seat(v));
      ring.push(position.length - 1);
    }
    for (let i = right.length - 2; i >= 1; i -= 1) {
      const v = right[i];
      position.push(seat([-v[0], v[1], v[2]]));
      ring.push(position.length - 1);
    }
    return ring;
  });

  // THE DIAGONAL FOLLOWS THE SURFACE, NOT THE INDEX ORDER.
  //
  // Splitting every quad the same way put every diagonal in the same direction across the whole torso —
  // visible as a uniform grain that has nothing to do with anatomy. A quad on a curved surface has one
  // diagonal that lies closer to it and one that cuts across the curvature, and the shorter of the two
  // is the closer one. Choosing per quad makes the triangulation follow where the form actually turns:
  // vertical over the sternum where the section is nearly flat, diagonal across the pec where it swells
  // outboard and down.
  const span = (u: number, v: number): number => {
    const p1 = position[u];
    const p2 = position[v];
    return (p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2 + (p1[2] - p2[2]) ** 2;
  };
  for (let r = 0; r + 1 < rings.length; r += 1) {
    const a = rings[r];
    const b = rings[r + 1];
    for (let i = 0; i < a.length; i += 1) {
      const j = (i + 1) % a.length;
      if (span(a[i], b[j]) <= span(a[j], b[i])) {
        triangles.push([a[i], b[i], b[j], 0], [a[i], b[j], a[j], 0]);
      } else {
        triangles.push([a[i], b[i], a[j], 0], [a[j], b[i], b[j], 0]);
      }
    }
  }

  // Torso muscle cuts are deliberately shallow. Give them a lower normal-split threshold than the
  // limbs so a 0.015-0.020 plane change stays legible without turning the abdomen into deep steps.
  const mesh = creasedPatch(name, position, triangles, mat, BODY_SCULPT_PARAMS.torsoCreaseAngle);
  mesh.userData.torsoStations = stations.map((s) => s.name);
  return mesh;
}

interface ArmStation {
  name: string;
  /** Distance from the centre line along the T-pose arm. */
  x: number;
  /** Vertical centre of this cross-section. */
  yCentre: number;
  /** Distance from the centre to the upper silhouette. */
  topHeight: number;
  /** Distance from the centre to the lower silhouette. */
  bottomHeight: number;
  /** Forward (+Z) depth. */
  frontDepth: number;
  /** Rear (-Z) depth. */
  backDepth: number;
  /** Front/back centre of the cross-section. */
  zCentre: number;
}

interface LegStation {
  name: string;
  /** Height of this cross-section. */
  y: number;
  /** Distance of the leg axis from the body centre. */
  xCentre: number;
  /** Width from the axis toward the other leg. */
  innerWidth: number;
  /** Width from the axis toward the outside silhouette. */
  outerWidth: number;
  /** Forward (+Z) depth. */
  frontDepth: number;
  /** Rear (-Z) depth. */
  backDepth: number;
  /** Front/back centre of the cross-section. */
  zCentre: number;
}

/**
 * Join coarse authored rings with the same large-plane language used by `buildTorsoShell`.
 * Eight vertices per section produce front/back/top/bottom planes plus four broad bevels; there is
 * no high-frequency ring tessellation that could turn an arm or leg back into a smooth tube.
 */
function buildBroadCutShell(
  name: string,
  rings: Array<Array<[number, number, number]>>,
  stationNames: string[],
  mat: THREE.Material,
  mirrored: boolean,
  caps: { start?: boolean; end?: boolean } = {},
): THREE.Mesh {
  const position = rings.flat();
  const triangles: Array<[number, number, number, number]> = [];
  const ringSize = rings[0].length;
  const span = (u: number, v: number): number => {
    const a = position[u];
    const b = position[v];
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  };
  for (let r = 0; r + 1 < rings.length; r += 1) {
    const a0 = r * ringSize;
    const b0 = (r + 1) * ringSize;
    for (let i = 0; i < ringSize; i += 1) {
      const j = (i + 1) % ringSize;
      const ai = a0 + i;
      const aj = a0 + j;
      const bi = b0 + i;
      const bj = b0 + j;
      if (span(ai, bj) <= span(aj, bi)) {
        triangles.push([ai, bi, bj, 0], [ai, bj, aj, 0]);
      } else {
        triangles.push([ai, bi, aj, 0], [aj, bi, bj, 0]);
      }
    }
  }
  const last = (rings.length - 1) * ringSize;
  for (let i = 1; i + 1 < ringSize; i += 1) {
    if (caps.start !== false) triangles.push([0, i + 1, i, 0]);
    if (caps.end !== false) triangles.push([last, last + i, last + i + 1, 0]);
  }
  if (mirrored) {
    for (const triangle of triangles) {
      const b = triangle[1];
      triangle[1] = triangle[2];
      triangle[2] = b;
    }
  }
  const mesh = creasedPatch(name, position, triangles, mat, BODY_SCULPT_PARAMS.creaseAngle);
  mesh.userData.sculptStations = stationNames;
  mesh.userData.sculptStyle = 'broad-cut-stations';
  return mesh;
}

function buildArmShell(
  name: string,
  side: number,
  stations: ArmStation[],
  mat: THREE.Material,
): THREE.Mesh {
  const bevel = BODY_SCULPT_PARAMS.bevel;
  // The authored shoulder-anchor ring sits on the visible torso/arm boundary. Leaving that ring as
  // the open end of a separate shell exposed two small triangular sight-lines in the T-pose. Prepend
  // a derived ring deep inside the ribcage so the open rim is buried and the visible shoulder span is
  // real overlapping geometry. It follows the tuned anchor dimensions instead of adding a floating
  // corrective patch, so rebuilding from the tune panel preserves the same continuous junction.
  const shoulder = stations[0];
  const buriedShoulder: ArmStation = {
    ...shoulder,
    name: 'shoulder-buried-seam',
    x: Math.max(0.04, shoulder.x - 0.18),
    topHeight: shoulder.topHeight * 0.82,
    bottomHeight: shoulder.bottomHeight * 0.82,
    frontDepth: shoulder.frontDepth * 0.72,
    backDepth: shoulder.backDepth * 0.84,
  };
  // Seat the authored anchor at the same front depth as the next shoulder-root ring. The raw anchor
  // is intentionally roomy for rigging, but exposing all of that depth puts its lower-front facet in
  // front of the clavicle and the dark facet reads as a hole in T-pose. This derived station preserves
  // the tune value while moving only the hidden attachment surface behind the chest.
  const seatedShoulder: ArmStation = {
    ...shoulder,
    name: 'shoulder-seated-anchor',
    frontDepth: shoulder.frontDepth * 0.72,
  };
  const shellStations = [buriedShoulder, seatedShoulder, ...stations.slice(1)];
  const rings = shellStations.map((s): Array<[number, number, number]> => {
    const x = side * s.x;
    return [
      [x, s.yCentre, s.zCentre + s.frontDepth],
      [x, s.yCentre + s.topHeight * bevel, s.zCentre + s.frontDepth * bevel],
      [x, s.yCentre + s.topHeight, s.zCentre],
      [x, s.yCentre + s.topHeight * bevel, s.zCentre - s.backDepth * bevel],
      [x, s.yCentre, s.zCentre - s.backDepth],
      [x, s.yCentre - s.bottomHeight * bevel, s.zCentre - s.backDepth * bevel],
      [x, s.yCentre - s.bottomHeight, s.zCentre],
      [x, s.yCentre - s.bottomHeight * bevel, s.zCentre + s.frontDepth * bevel],
    ];
  });
  // Both ends are embedded in neighbouring shells. Buried flat caps previously leaked out as a
  // triangular shoulder chip and a bracelet-like plate at the wrist.
  return buildBroadCutShell(name, rings, shellStations.map((s) => s.name), mat, side < 0,
    { start: false, end: false });
}

/**
 * A recessed skin surface behind the independent torso and arm shells.
 *
 * This is deliberately not part of the visible silhouette: every point sits behind the authored
 * chest/arm fronts and inside their outer edge. It exists only so a grazing camera can never see the
 * background through the unavoidable T-junction between two independently triangulated skinned
 * surfaces. Keep it to the narrow clavicle/shoulder overlap. A previous broad plane did close the
 * sight-line, but also became a visible rectangular shoulder plate from high and oblique cameras.
 */
function buildShoulderSeamUnderlay(
  name: string,
  side: number,
  shoulder: ArmStation,
  mat: THREE.Material,
): THREE.Mesh {
  const innerX = Math.max(0.12, shoulder.x - 0.04);
  const middleX = shoulder.x + 0.13;
  const outerX = shoulder.x + 0.30;
  // Roughly one third of the way to the arm front: far enough forward to block the background, but
  // still recessed behind both the pec and deltoid surfaces at the join.
  const zInner = shoulder.zCentre + shoulder.frontDepth * 0.45;
  const zMiddle = shoulder.zCentre + shoulder.frontDepth * 0.52;
  const zOuter = shoulder.zCentre + shoulder.frontDepth * 0.40;
  const vertices: Array<[number, number, number]> = [
    [side * innerX, shoulder.yCentre + 0.060, zInner],
    [side * middleX, shoulder.yCentre + 0.082, zMiddle],
    [side * outerX, shoulder.yCentre + 0.052, zOuter],
    [side * innerX, shoulder.yCentre - 0.008, zInner],
    [side * middleX, shoulder.yCentre - 0.035, zMiddle],
    [side * outerX, shoulder.yCentre - 0.018, zOuter],
  ];
  const triangles: Array<[number, number, number, number]> = side < 0
    ? [[0, 4, 3, 0], [0, 1, 4, 0], [1, 5, 4, 0], [1, 2, 5, 0]]
    : [[0, 3, 4, 0], [0, 4, 1, 0], [1, 4, 5, 0], [1, 5, 2, 0]];
  const mesh = creasedPatch(name, vertices, triangles, mat, BODY_SCULPT_PARAMS.creaseAngle);
  mesh.userData.recessedShoulderSeam = true;
  return mesh;
}

function buildLegShell(
  name: string,
  side: number,
  stations: LegStation[],
  mat: THREE.Material,
): THREE.Mesh {
  const bevel = BODY_SCULPT_PARAMS.bevel;
  const rings = stations.map((s): Array<[number, number, number]> => {
    const centre = side * s.xCentre;
    const inner = side * (s.xCentre - s.innerWidth);
    const outer = side * (s.xCentre + s.outerWidth);
    return [
      [centre, s.y, s.zCentre + s.frontDepth],
      [centre + (inner - centre) * bevel, s.y, s.zCentre + s.frontDepth * bevel],
      [inner, s.y, s.zCentre],
      [centre + (inner - centre) * bevel, s.y, s.zCentre - s.backDepth * bevel],
      [centre, s.y, s.zCentre - s.backDepth],
      [centre + (outer - centre) * bevel, s.y, s.zCentre - s.backDepth * bevel],
      [outer, s.y, s.zCentre],
      [centre + (outer - centre) * bevel, s.y, s.zCentre + s.frontDepth * bevel],
    ];
  });
  // The ankle enters the foot and the hip enters the shorts/torso, so their overlap closes the visible
  // surface without a second flat plate at either attachment.
  return buildBroadCutShell(name, rings, stations.map((s) => s.name), mat, side < 0,
    { start: false, end: false });
}

const TORSO_STATIONS: TorsoStation[] = [
  { name: 'collar', y: 5.03, halfWidth: 0.118, frontDepth: 0.225, backDepth: 0.191, zCentre: -0.164, xFront: [0.04, 0.186, 0.368, 0.536, 0.73, 0.882, 0.944], zFront: [0.988, 0.998, 0.994, 0.968, 0.93, 0.855, 0.7], xBack: [0.9, 0.52], zBack: [0.72, 1.006], noHug: true },
  { name: 'trap-high', y: 4.982, halfWidth: 0.314, frontDepth: 0.278, backDepth: 0.308, zCentre: -0.168, xFront: [0.066, 0.2, 0.38, 0.558, 0.74, 0.882, 0.92], zFront: [0.968, 0.93, 0.852, 0.892, 0.804, 0.748, 0.604], xBack: [0.912, 0.524], zBack: [0.7, 1.024], noHug: true },
  { name: 'trap-mid', y: 4.896, halfWidth: 0.4, frontDepth: 0.302, backDepth: 0.312, zCentre: -0.17, xFront: [0.04, 0.186, 0.378, 0.554, 0.74, 0.88, 0.95], zFront: [1, 0.998, 0.992, 0.958, 0.898, 0.775, 0.583], xBack: [0.9, 0.52], zBack: [0.68, 1.008] },
  { name: 'trap-low', y: 4.82, halfWidth: 0.535, frontDepth: 0.325, backDepth: 0.325, zCentre: -0.156, xFront: [0.06, 0.2, 0.38, 0.55, 0.74, 0.88, 0.95], zFront: [1, 0.998, 0.992, 0.954, 0.884, 0.82, 0.76], xBack: [0.9, 0.52], zBack: [0.67, 1.02] },
  { name: 'clavicle', y: 4.738, halfWidth: 0.675, frontDepth: 0.372, backDepth: 0.338, zCentre: -0.146, zMid: 0.926, xFront: [0.06, 0.204, 0.38, 0.554, 0.73, 0.864, 0.95], zFront: [0.96, 0.942, 1.042, 1.028, 0.972, 0.852, 0.449], xBack: [0.9, 0.46], zBack: [0.7, 1.09] },
  { name: 'upper-pec', y: 4.59, halfWidth: 0.665, frontDepth: 0.398, backDepth: 0.39, zCentre: -0.141, zMid: 0.978, xFront: [0.06, 0.204, 0.38, 0.55, 0.74, 0.87, 0.926], zFront: [0.976, 1.002, 1.034, 1.016, 0.95, 0.852, 0.678], xBack: [0.9, 0.44], zBack: [0.702, 1.096], yBack: [0.1, 0.078, 0.056, -0.004, -0.03], zBackRelief: [-0.004, 0.04, 0.038, 0.048, 0.026] },
  { name: 'pec-max', y: 4.45, halfWidth: 0.65, frontDepth: 0.398, backDepth: 0.4, zCentre: -0.136, zMid: 0.962, xFront: [0.06, 0.196, 0.38, 0.542, 0.74, 0.88, 0.95], zFront: [0.986, 1.018, 1.052, 1.044, 0.92, 0.846, 0.67], xBack: [0.9, 0.42], zBack: [0.71, 1.11], yBack: [0.03, 0.01, -0.02, -0.05, -0.07], zBackRelief: [0, 0.08, 0.03, -0.02, -0.04] },
  { name: 'pec-edge', y: 4.37, halfWidth: 0.635, frontDepth: 0.397, backDepth: 0.397, zCentre: -0.135, zMid: 0.972, xFront: [0.06, 0.2, 0.38, 0.552, 0.74, 0.88, 0.95], zFront: [0.98, 1.012, 1.04, 1.02, 0.952, 0.852, 0.698], xBack: [0.9, 0.42], zBack: [0.71, 1.11], yBack: [-0.02, -0.03, -0.04, -0.05, -0.06], zBackRelief: [0, 0.05, 0.02, -0.01, -0.03] },
  { name: 'under-pec-cut', y: 4.29, halfWidth: 0.62, frontDepth: 0.395, backDepth: 0.395, zCentre: -0.132, zMid: 0.885, xFront: [0.06, 0.2, 0.38, 0.55, 0.74, 0.862, 0.95], zFront: [0.886, 0.9, 0.92, 0.91, 0.88, 0.8, 0.64], yFront: [0, 0, 0, 0, 0, 0, 0], xBack: [0.9, 0.45], zBack: [0.71, 1.09], yBack: [-0.02, -0.02, -0.02, -0.03, -0.04], zBackRelief: [0, 0.01, 0, 0, -0.01] },
  { name: 'costal-arch-high', y: 4.23, halfWidth: 0.595, frontDepth: 0.39, backDepth: 0.39, zCentre: -0.128, zMid: 0.92, xFront: [0.06, 0.2, 0.38, 0.55, 0.74, 0.88, 0.95], zFront: [0.925, 0.935, 0.94, 0.92, 0.84, 0.68, 0.4], yFront: [0, 0, 0, 0, 0, 0, 0], xBack: [0.91, 0.5], zBack: [0.7, 1.06] },
  { name: 'costal-arch-low', y: 4.17, halfWidth: 0.58, frontDepth: 0.382, backDepth: 0.382, zCentre: -0.124, zMid: 0.9, xFront: [0.06, 0.2, 0.38, 0.55, 0.74, 0.88, 0.954], zFront: [0.905, 0.915, 0.92, 0.9, 0.81, 0.65, 0.39], yFront: [0, 0, 0, 0, 0, -0.002, 0.002], xBack: [0.91, 0.5], zBack: [0.632, 1.062] },
  { name: 'ab-bulge-1', y: 4.02, halfWidth: 0.568, frontDepth: 0.373, backDepth: 0.373, zCentre: -0.113, zMid: 0.97, xFront: [0.058, 0.2, 0.376, 0.542, 0.74, 0.88, 0.95], zFront: [0.98, 1, 1.01, 0.986, 0.88, 0.696, 0.432], xBack: [0.91, 0.52], zBack: [0.7, 1.05] },
  { name: 'upper-ab-cut', y: 3.93, halfWidth: 0.552, frontDepth: 0.358, backDepth: 0.358, zCentre: -0.105, zMid: 0.87, xFront: [0.048, 0.188, 0.352, 0.528, 0.728, 0.88, 0.954], zFront: [0.894, 0.9, 0.91, 0.898, 0.828, 0.648, 0.42], xBack: [0.91, 0.52], zBack: [0.7, 1.05] },
  { name: 'lower-rib-2', y: 3.84, halfWidth: 0.528, frontDepth: 0.346, backDepth: 0.346, zCentre: -0.108, zMid: 0.97, xFront: [0.06, 0.2, 0.38, 0.55, 0.74, 0.88, 0.95], zFront: [0.98, 1, 1.01, 0.98, 0.86, 0.684, 0.422], xBack: [0.91, 0.52], zBack: [0.7, 1.05] },
  { name: 'mid-ab-cut', y: 3.75, halfWidth: 0.52, frontDepth: 0.334, backDepth: 0.334, zCentre: -0.112, zMid: 0.88, xFront: [0.06, 0.198, 0.384, 0.556, 0.744, 0.89, 0.962], zFront: [0.906, 0.9, 0.91, 0.9, 0.81, 0.65, 0.428], xBack: [0.91, 0.53], zBack: [0.7, 1.06] },
  { name: 'ab-bulge-3', y: 3.68, halfWidth: 0.502, frontDepth: 0.328, backDepth: 0.328, zCentre: -0.114, zMid: 0.96, xFront: [0.06, 0.2, 0.38, 0.55, 0.74, 0.88, 0.95], zFront: [0.97, 0.99, 1, 0.97, 0.83, 0.648, 0.39], xBack: [0.92, 0.54], zBack: [0.71, 1.08] },
  { name: 'navel', y: 3.6, halfWidth: 0.482, frontDepth: 0.322, backDepth: 0.322, zCentre: -0.117, zMid: 0.904, xFront: [0.064, 0.204, 0.386, 0.554, 0.748, 0.892, 0.956], zFront: [0.976, 0.982, 0.99, 0.964, 0.82, 0.65, 0.38], xBack: [0.92, 0.54], zBack: [0.71, 1.08] },
  { name: 'lumbar', y: 3.53, halfWidth: 0.505, frontDepth: 0.318, backDepth: 0.34, zCentre: -0.116, xFront: [0.06, 0.2, 0.38, 0.55, 0.748, 0.88, 0.95], zFront: [0.976, 0.975, 1, 0.95, 0.9, 0.7, 0.517], xBack: [0.92, 0.54], zBack: [0.71, 1.1] },
  { name: 'waist-break', y: 3.47, halfWidth: 0.499, frontDepth: 0.3, backDepth: 0.228, zCentre: -0.124, xFront: [0.06, 0.2, 0.38, 0.55, 0.74, 0.88, 0.95], zFront: [1, 1, 1, 0.978, 0.947, 0.775, 0.66], xBack: [0.92, 0.56], zBack: [0.72, 1.04], noHug: true },
  { name: 'tuck', y: 3.43, halfWidth: 0.45, frontDepth: 0.29, backDepth: 0.3, zCentre: -0.116, xFront: [0.06, 0.2, 0.38, 0.55, 0.74, 0.88, 0.95], zFront: [1, 1, 1, 0.978, 0.947, 0.775, 0.66], xBack: [0.92, 0.56], zBack: [0.72, 1.04], noHug: true },
];

// One table drives both arms by sagittal reflection. The values are deliberately coarse landmarks:
// shoulder, upper arm, elbow, forearm and wrist. Each neighbouring pair is one large longitudinal cut.
const ARM_STATIONS: ArmStation[] = [
  { name: 'shoulder-anchor', x: 0.24, yCentre: 4.82, topHeight: 0.18, bottomHeight: 0.18, frontDepth: 0.25, backDepth: 0.22, zCentre: -0.06 },
  { name: 'shoulder-root', x: 0.48, yCentre: 4.8, topHeight: 0.19, bottomHeight: 0.18, frontDepth: 0.22, backDepth: 0.22, zCentre: -0.105 },
  { name: 'deltoid', x: 0.98, yCentre: 4.776, topHeight: 0.167, bottomHeight: 0.167, frontDepth: 0.208, backDepth: 0.208, zCentre: -0.146 },
  { name: 'upper-arm-high', x: 1.22, yCentre: 4.779, topHeight: 0.159, bottomHeight: 0.159, frontDepth: 0.197, backDepth: 0.197, zCentre: -0.15 },
  { name: 'upper-arm-mid', x: 1.48, yCentre: 4.785, topHeight: 0.139, bottomHeight: 0.139, frontDepth: 0.167, backDepth: 0.167, zCentre: -0.15 },
  { name: 'pre-elbow', x: 1.68, yCentre: 4.781, topHeight: 0.147, bottomHeight: 0.147, frontDepth: 0.174, backDepth: 0.174, zCentre: -0.148 },
  { name: 'elbow', x: 1.83, yCentre: 4.783, topHeight: 0.151, bottomHeight: 0.151, frontDepth: 0.187, backDepth: 0.187, zCentre: -0.145 },
  { name: 'forearm-high', x: 2.05, yCentre: 4.797, topHeight: 0.132, bottomHeight: 0.132, frontDepth: 0.173, backDepth: 0.173, zCentre: -0.144 },
  { name: 'forearm-mid', x: 2.3, yCentre: 4.808, topHeight: 0.1, bottomHeight: 0.1, frontDepth: 0.146, backDepth: 0.146, zCentre: -0.146 },
  { name: 'pre-wrist', x: 2.554, yCentre: 4.784, topHeight: 0.113, bottomHeight: 0.057, frontDepth: 0.162, backDepth: 0.136, zCentre: -0.147 },
  { name: 'wrist', x: 2.744, yCentre: 4.786, topHeight: -0.003, bottomHeight: 0.019, frontDepth: 0.037, backDepth: 0.059, zCentre: -0.052 },
];

// One table drives both legs. `innerWidth` and `outerWidth` are separate so the medial line and the
// outer silhouette can be sculpted independently instead of sliding the whole leg sideways.
const LEG_STATIONS: LegStation[] = [
  { name: 'ankle', y: 0.28, xCentre: 0.347, innerWidth: 0.118, outerWidth: 0.118, frontDepth: 0.162, backDepth: 0.162, zCentre: -0.054 },
  { name: 'shin-low', y: 0.48, xCentre: 0.339, innerWidth: 0.114, outerWidth: 0.114, frontDepth: 0.162, backDepth: 0.162, zCentre: -0.054 },
  { name: 'calf-low', y: 0.712, xCentre: 0.338, innerWidth: 0.118, outerWidth: 0.122, frontDepth: 0.137, backDepth: 0.145, zCentre: -0.09 },
  { name: 'calf-max', y: 1, xCentre: 0.351, innerWidth: 0.159, outerWidth: 0.159, frontDepth: 0.166, backDepth: 0.166, zCentre: -0.108 },
  { name: 'knee-low', y: 1.23, xCentre: 0.345, innerWidth: 0.193, outerWidth: 0.193, frontDepth: 0.201, backDepth: 0.201, zCentre: -0.108 },
  { name: 'knee', y: 1.42, xCentre: 0.343, innerWidth: 0.216, outerWidth: 0.216, frontDepth: 0.219, backDepth: 0.219, zCentre: -0.108 },
  { name: 'thigh-low', y: 1.68, xCentre: 0.341, innerWidth: 0.188, outerWidth: 0.188, frontDepth: 0.2, backDepth: 0.2, zCentre: -0.103 },
  { name: 'thigh-mid', y: 2.16, xCentre: 0.338, innerWidth: 0.222, outerWidth: 0.222, frontDepth: 0.256, backDepth: 0.256, zCentre: -0.066 },
  { name: 'thigh-high', y: 2.586, xCentre: 0.32, innerWidth: 0.22, outerWidth: 0.24, frontDepth: 0.25, backDepth: 0.28, zCentre: -0.1 },
  { name: 'hip-root', y: 2.88, xCentre: 0.3, innerWidth: 0.26, outerWidth: 0.25, frontDepth: 0.28, backDepth: 0.31, zCentre: -0.1 },
];

const BODY_SCULPT_PARAMS = {
  name: 'broad-cut-style',
  /** Where each diagonal corner sits between an axis plane and a front/back plane. */
  bevel: 0.707,
  /** Radians: turns sharper than this keep a hard normal split. */
  creaseAngle: 0.5,
  /** Torso-only threshold; shallow horizontal muscle bands must still retain their plane break. */
  torsoCreaseAngle: 0.35,
};

const BACK_SCULPT_PARAMS = {
  name: 'back-broad-cuts',
  xProfile: [0.9, 0.72, 0.52, 0.28, 0.1],
  scapulaY: 4.55,
  scapulaSpan: 0.48,
  scapulaDepth: 0.1,
  scapulaSlope: 0.085,
  lumbarY: 3.8,
  lumbarSpan: 0.52,
  erectorDepth: 0.035,
  spineRailDepth: 0.05,
  spineGrooveDepth: 0.045,
};

/**
 * Is this point inside the region the torso shell owns?
 *
 * The shell's stations are ellipses about the y axis, so a point is inside when its radial distance is
 * under the interpolated half-width and half-depth for its height. The margin is 1.30 rather than 1.00:
 * the field must be removed slightly BEYOND the shell, or the very bulges that were showing past it —
 * which are outside it by definition — would be the one thing left behind.
 *
 * The band stops short of the shell's own ends (3.40 to 4.78 against 3.35 to 4.86) so the field still
 * closes the shell's open rims at the hips and the neck, and still carries the arms out of the
 * shoulders. Those are the transitions that need two surfaces meeting; the flank is not one of them.
 */
function insideTorsoShell(x: number, y: number, z: number): boolean {
  if (y < 3.40 || y > 5.06) return false;
  // NEVER out where the arm meets the body. The margin below is 1.30, and at the clavicle station that
  // is 0.760 x 1.30 = 0.988 — past the arm chain's root at x 0.82. The field was being removed from the
  // shoulder and the armpit, and what showed there was the ragged edge of the cells that survived: the
  // hollow the review found under the deltoid. Ownership of the flank does not extend to the shoulder
  // girdle, which is a junction where two surfaces genuinely have to meet.
  // A hard plane through a smooth field leaves a wall of cut cells standing on the shoulder, so this
  // guard applies only where it is still earning its keep: below the clavicle, where the margin is 1.30
  // and would otherwise reach past the shell into the deltoid. Above it the margin is 1.0 and the
  // ellipse test alone already removes only what the shell stands in for.
  if (y <= 4.73 && Math.abs(x) > 0.66) return false;
  let lo = TORSO_STATIONS[0];
  let hi = TORSO_STATIONS[0];
  for (let i = 0; i + 1 < TORSO_STATIONS.length; i += 1) {
    const a = TORSO_STATIONS[i];
    const b = TORSO_STATIONS[i + 1];
    if (y <= a.y && y >= b.y) { lo = b; hi = a; break; }
  }
  const span = hi.y - lo.y;
  const t = span > 1e-6 ? (y - lo.y) / span : 0;
  const halfWidth = lo.halfWidth + (hi.halfWidth - lo.halfWidth) * t;
  const depth = lo.frontDepth + (hi.frontDepth - lo.frontDepth) * t;
  const zCentre = lo.zCentre + (hi.zCentre - lo.zCentre) * t;
  // Margin: 1.30 over the ribcage, where a field bulge showing past the shell is exactly what has to go.
  // Above the clavicle the shell narrows from 0.675 to 0.200 in a third of a unit, so 1.30 reaches past
  // what the shell covers and deletes field the shell never replaces — the serrated strip over each
  // shoulder. There the margin is 1.0: remove only what the shell genuinely stands in for.
  const margin = y > 4.73 ? 1.0 : 1.30;
  const u = x / (halfWidth * margin);
  const v = (z - zCentre) / (depth * margin);
  return u * u + v * v <= 1;
}


/**
 * A patch whose edges are hard only where the surface actually turns.
 *
 * `flatShading` gives every triangle its own normal, so every edge is a crease and a torso reads as a
 * field of facets competing with each other. Smooth shading averages every normal, so no edge survives
 * and the anatomical boundaries disappear. The reference does neither: large planes with soft interiors,
 * meeting at a small number of hard lines.
 *
 * So normals are averaged per vertex ACROSS NEIGHBOURING FACES ONLY WHEN THE ANGLE BETWEEN THEM IS
 * BELOW A THRESHOLD. Inside a pec plane the neighbouring faces are nearly parallel and merge into one
 * smooth surface; at the lower-pec cut, the outer-pec turn, the clavicle transition and the abdominal
 * row boundaries the angle is large and the normals stay separate, which is what makes those edges
 * read. The threshold is the only control, and it names the thing it controls: how sharp a turn has to
 * be before it counts as anatomy rather than tessellation.
 *
 * Emits a non-indexed geometry because a vertex on a crease needs a different normal per side, which an
 * indexed one cannot express.
 */
function creasedPatch(
  name: string,
  vertices: Array<[number, number, number]>,
  triangles: Array<[number, number, number, number]>,
  mat: THREE.Material,
  /** Radians. Faces meeting at more than this keep separate normals. 0.62 rad is 35 degrees. */
  creaseAngle: number,
): THREE.Mesh {
  const faceNormal: Array<[number, number, number]> = [];
  for (const [a, b, c] of triangles) {
    const p = vertices[a];
    const q = vertices[b];
    const r = vertices[c];
    const e1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const e2 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const n: [number, number, number] = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    faceNormal.push([n[0] / len, n[1] / len, n[2] / len]);
  }

  const facesOf = new Map<number, number[]>();
  triangles.forEach(([a, b, c], f) => {
    for (const v of [a, b, c]) {
      if (!facesOf.has(v)) facesOf.set(v, []);
      facesOf.get(v)!.push(f);
    }
  });

  const cosLimit = Math.cos(creaseAngle);
  const positions: number[] = [];
  const normals: number[] = [];
  triangles.forEach(([a, b, c], f) => {
    const own = faceNormal[f];
    for (const v of [a, b, c]) {
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (const g of facesOf.get(v) ?? []) {
        const other = faceNormal[g];
        if (own[0] * other[0] + own[1] * other[1] + own[2] * other[2] < cosLimit) continue;
        nx += other[0];
        ny += other[1];
        nz += other[2];
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      positions.push(vertices[v][0], vertices[v][1], vertices[v][2]);
      normals.push(nx / len, ny / len, nz / len);
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = name;
  return mesh;
}

interface PalmStation {
  /** Distance along the hand's axis, in local units. */
  x: number;
  /** Half the palm's spread across the knuckles. */
  halfSpread: number;
  /** Half the palm's thickness back to front. */
  halfThickness: number;
  /** Optional asymmetric dorsal/top extent. Feet use this to build an instep above a flat sole. */
  topThickness?: number;
  /** Optional asymmetric palmar/sole extent. */
  bottomThickness?: number;
  /** Centre of the section across the spread, so the palm can lean toward the thumb. */
  zCentre: number;
  /** Centre of the section in height. */
  yCentre: number;
  /** Optional authored lane coordinates. Hands use these to preserve the uneven finger-web fan. */
  across?: number[];
  /** Per-lane dorsal offsets for metacarpal ridges. */
  topOffsets?: number[];
  /** Per-lane palmar offsets for thenar/hypothenar relief and the central cup. */
  bottomOffsets?: number[];
}

interface FingerSpec {
  id: string;
  /** Length from the knuckle line. */
  length: number;
  /** How far short of the middle finger this one's knuckle starts — the fan. */
  setback: number;
  /** Scale on the width the palm hands it, so fingers differ in girth as well as length. */
  girth: number;
  /** Independent dorsal-palmar scale; keeping this separate avoids slab-like digits in oblique views. */
  thickness?: number;
  /** Sideways drift of the tip, as a fraction of length. */
  splay: number;
}

interface ThumbSpec {
  name: string;
  rootX: number;
  rootY: number;
  rootZ: number;
  midX: number;
  midY: number;
  midZ: number;
  tipX: number;
  tipY: number;
  tipZ: number;
}

interface ThumbProfilePoint {
  at: number;
  width: number;
  thickness: number;
}

interface HandOutlinePoint {
  name: string;
  /** Position along the arm, measured from the GLB envelope in factory-local coordinates. */
  x: number;
  /** Position across the hand: negative is pinky-side, positive is thumb-side. */
  z: number;
  /** Dorsal surface height. */
  topY: number;
  /** Palmar surface height. Thumb points descend here instead of branching from a capped palm. */
  bottomY: number;
}

/**
 * One concave outline, extruded between independently sculpted dorsal and palmar surfaces.
 *
 * The station-and-branch hand was manifold, but it still exposed the topology of its construction:
 * the thumb came out of a six-sided hole and the four fingers began at four rectangular caps. In the
 * baseline, all five digits are cuts in ONE broad hand plate. This outline traces that plate around
 * every fingertip and web; triangulating it makes the palm, webs and digits share both surfaces and
 * every side wall. Per-point top/bottom heights retain the thumb's real three-dimensional descent.
 */
function buildPlanarOutlineShell(
  name: string,
  side: number,
  outline: HandOutlinePoint[],
  mat: THREE.Material,
  parts: string[] = ['palm', 'pinky', 'ring', 'middle', 'index', 'thumb'],
  opening: HandOutlinePoint[] = [],
): THREE.Mesh {
  const contour = outline.map((point) => new THREE.Vector2(point.x, point.z));
  const hole = opening.map((point) => new THREE.Vector2(point.x, point.z));
  const faces = THREE.ShapeUtils.triangulateShape(contour, hole.length ? [hole] : []);
  const position: Array<[number, number, number]> = [];
  const triangles: Array<[number, number, number, number]> = [];
  const count = outline.length;
  const holeCount = opening.length;

  for (const point of outline) position.push([side * point.x, point.topY, point.z]);
  const topHole = position.length;
  for (const point of opening) position.push([side * point.x, point.topY, point.z]);
  const bottomOuter = position.length;
  for (const point of outline) position.push([side * point.x, point.bottomY, point.z]);
  const bottomHole = position.length;
  for (const point of opening) position.push([side * point.x, point.bottomY, point.z]);

  const bottomIndex = (index: number): number => (
    index < count ? bottomOuter + index : bottomHole + index - count
  );

  // In x/z space a counter-clockwise contour points DOWN when embedded in x/y/z, hence the reversed
  // top face. The bottom keeps ShapeUtils' order. Reflection is corrected once at the end.
  for (const face of faces) {
    triangles.push([face[0], face[2], face[1], 0]);
    triangles.push([bottomIndex(face[0]), bottomIndex(face[1]), bottomIndex(face[2]), 0]);
  }
  for (let i = 0; i < count; i += 1) {
    const next = (i + 1) % count;
    triangles.push([i, next, bottomOuter + next, 0], [i, bottomOuter + next, bottomOuter + i, 0]);
  }
  // Stitch the opening downward with the opposite winding from the outer wall. The result is one
  // watertight ring shell, not a top plate intersected by a leg tube.
  for (let i = 0; i < holeCount; i += 1) {
    const next = (i + 1) % holeCount;
    triangles.push([topHole + i, bottomHole + next, bottomHole + i, 0],
      [topHole + i, topHole + next, bottomHole + next, 0]);
  }
  if (side < 0) {
    for (const triangle of triangles) {
      const swap = triangle[1];
      triangle[1] = triangle[2];
      triangle[2] = swap;
    }
  }

  const mesh = creasedPatch(name, position, triangles, mat, 0.72);
  mesh.userData.handParts = parts;
  mesh.userData.sharedHandOutline = true;
  return mesh;
}

/**
 * The hand as ONE surface: palm and four fingers sharing their vertices.
 *
 * WHY THE SIX-LOFT VERSION COULD NOT BE FIXED. Palm, index, middle, ring and pinky were five separate
 * closed lofts that only overlapped. Two things follow from that and no parameter changes either:
 *
 *   - the palm ends in a ring perpendicular to its own axis, which is a STRAIGHT EDGE. The knuckle fan
 *     is a staggered edge, so however carefully the finger roots were set back, the boundary the eye
 *     sees was flat;
 *   - webbing has to be continuous with both the palm and the fingers. Three separate web patches were
 *     built at three sizes and every one rendered as a tooth, because a separate loft in a 0.038 gap has
 *     a silhouette of its own.
 *
 * Here the palm's distal ring is authored as a strip — nine vertices across the back of the hand and
 * nine across the palm — and each finger takes THREE of the back and THREE of the palm as its own first
 * ring. Neighbouring fingers share the vertex between them, so:
 *
 *   - the boundary between palm and fingers is wherever each finger's first ring is placed, which is
 *     the fan, expressed as geometry rather than approximated by setback;
 *   - the shared vertex IS the web. It cannot be a tooth because it is not a separate object.
 */
function buildHandShell(
  name: string,
  side: number,
  palm: PalmStation[],
  fingers: FingerSpec[],
  profile: Array<[number, number]>,
  mat: THREE.Material,
  /**
   * Which world axis the limb runs along.
   *
   * A foot is a palm with five toes: the same strip of paired vertices, the same shared vertex between
   * neighbours giving the web, the same fan of differing lengths. It runs along z with the spread on x
   * rather than along x with the spread on z. One flag is cheaper and safer than a second builder that
   * would drift from this one.
   */
  axis: 'x' | 'z' = 'x',
  thumb?: ThumbSpec,
  thumbProfile: ThumbProfilePoint[] = [],
  closeWrist = true,
): THREE.Mesh {
  // A LEFT/RIGHT PAIR IS A REFLECTION, NEVER A ROTATION. Negate the LEFT-RIGHT axis and nothing
  // else: (x, y, z) -> (-x, y, z). That is the sagittal mirror, and it is what makes the two limbs
  // opposite-handed.
  //
  // This used to read `[side * along, height, side * across]` for `axis === 'x'`, negating BOTH x
  // and z. Two negations is not a mirror -- it is a 180-degree rotation about Y, and a rotation
  // PRESERVES handedness. So the left hand came out as the right hand, turned around: measured on
  // the thumb, whose tip sat at z +0.288 on one side and -0.288 on the other, where a true mirror
  // leaves z alone. Both thumbs must point the same way; no T-pose has them pointing opposite.
  //
  // The foot (`axis === 'z'`) already negated only its across, which IS x there, so its pair was
  // correct. Its bug was a different one, in the order of the toes.
  const place = (along: number, height: number, across: number): [number, number, number] => (
    axis === 'x' ? [side * along, height, across] : [side * across, height, along]
  );
  type V3 = [number, number, number];
  const position: V3[] = [];
  const triangles: Array<[number, number, number, number]> = [];
  const push = (p: V3): number => (position.push(p), position.length - 1);

  // Two vertices per digit plus one, so every digit gets three and shares one with each neighbour. A
  // fixed 9 works for four fingers and silently reads past the end of the back row for five toes,
  // taking two palm-side vertices as if they were back-side ones — the foot came out inside out and the
  // page never finished building.
  const ACROSS = fingers.length * 2 + 1;
  const ring = (s: PalmStation): number[] => {
    const back: number[] = [];
    const front: number[] = [];
    for (let i = 0; i < ACROSS; i += 1) {
      const f = i / (ACROSS - 1);
      const z = s.across?.[i] ?? s.zCentre + (f * 2 - 1) * s.halfSpread;
      // The section is a rounded rectangle rather than an ellipse: a hand is flat, and its thickness
      // holds most of the way across before falling at the edges. cos^0.6 does that; cos alone gives an
      // ellipse and the knuckles come out pointed.
      // Do not collapse the two side walls to a line. Besides producing zero-area triangles, that
      // made the thumb root meet a knife edge instead of a palm volume. Feet keep an even broader
      // edge because their medial/lateral walls remain tall down to the sole.
      const edgeFloor = axis === 'x' ? 0.42 : 0.86;
      const t = edgeFloor + (1 - edgeFloor)
        * Math.cos((f * 2 - 1) * Math.PI * 0.5) ** (axis === 'x' ? 0.72 : 0.42);
      back.push(push(place(s.x, s.yCentre + (s.topThickness ?? s.halfThickness) * t
        + (s.topOffsets?.[i] ?? 0), z)));
      front.push(push(place(s.x, s.yCentre - (s.bottomThickness ?? s.halfThickness) * t
        + (s.bottomOffsets?.[i] ?? 0), z)));
    }
    return [...back, ...front];
  };

  const rings = palm.map(ring);
  // Winding: back vertices run 0..8 and palm vertices 9..17, so a quad between two stations is
  // (a[i], b[i], b[i+1], a[i+1]) with the pair reversed on the palm side.
  const bridge = (a: number[], b: number[], segment: number): void => {
    for (let i = 0; i < ACROSS - 1; i += 1) {
      triangles.push([a[i], b[i], b[i + 1], 0], [a[i], b[i + 1], a[i + 1], 0]);
      const j = ACROSS + i;
      triangles.push([a[j + 1], b[j + 1], b[j], 0], [a[j + 1], b[j], a[j], 0]);
    }
    // The two side edges of the strip, so the palm is a closed tube rather than two sheets.
    triangles.push([a[0], a[ACROSS], b[ACROSS], 0], [a[0], b[ACROSS], b[0], 0]);
    const e = ACROSS - 1;
    // The thumb owns this boundary on hand stations 0..2. Leaving these two quads out makes a real
    // six-edge opening; the branch below reuses those exact vertices, so there is no buried cap,
    // overlap seam or detached thenar wedge.
    if (!(thumb && axis === 'x' && segment < 2)) {
      triangles.push([a[2 * ACROSS - 1], a[e], b[e], 0],
        [a[2 * ACROSS - 1], b[e], b[2 * ACROSS - 1], 0]);
    }
  };
  for (let r = 0; r + 1 < rings.length; r += 1) bridge(rings[r], rings[r + 1], r);

  // When the forearm overlaps this ring it owns the closure. Keeping both caps created a flat plate
  // whose edge escaped the overlap and read as a bracelet.
  if (closeWrist) {
    const w = rings[0];
    for (let i = 0; i < ACROSS - 1; i += 1) {
      triangles.push([w[i], w[ACROSS + i], w[ACROSS + i + 1], 0],
        [w[i], w[ACROSS + i + 1], w[i + 1], 0]);
    }
  }

  const knuckle = rings[rings.length - 1];
  const last = palm[palm.length - 1];
  fingers.forEach((finger, fi) => {
    // Three back and three palm vertices, sharing one with each neighbour.
    const b0 = fi * 2;
    const root = [knuckle[b0], knuckle[b0 + 1], knuckle[b0 + 2],
      knuckle[ACROSS + b0 + 2], knuckle[ACROSS + b0 + 1], knuckle[ACROSS + b0]];
    const centre = root.reduce((acc, v) => [acc[0] + position[v][0] / 6, acc[1] + position[v][1] / 6,
      acc[2] + position[v][2] / 6] as V3, [0, 0, 0] as V3);
    let previous = root;
    for (let s = 1; s < profile.length; s += 1) {
      const [at, scale] = profile[s];
      const along = finger.length * at;
      const ringVerts = root.map((v) => {
        const p = position[v];
        // `position` holds WORLD coordinates — `place` has already applied `side` — while `place` will
        // apply it again. So the across component is converted back to local first (side is +/-1, so
        // multiplying is the inverse of itself) and the drift is applied in local terms too. Scaling the
        // world value directly put a factor of `side` where it did not belong: on the left foot the toes
        // mirrored back through the ankle, and the pair rendered as one bar across the figure.
        const acrossWorld = axis === 'x' ? p[2] : p[0];
        const centreWorld = axis === 'x' ? centre[2] : centre[0];
        const acrossMirrored = axis === 'z';
        const acrossLocal = acrossMirrored ? acrossWorld * side : acrossWorld;
        const centreLocal = acrossMirrored ? centreWorld * side : centreWorld;
        const across = centreLocal + (acrossLocal - centreLocal) * scale * finger.girth
          + finger.splay * finger.length * at;
        return push(place(
          last.x - finger.setback + along,
          centre[1] + (p[1] - centre[1]) * scale * (finger.thickness ?? finger.girth),
          across,
        ));
      });
      for (let i = 0; i < 6; i += 1) {
        const j = (i + 1) % 6;
        triangles.push([previous[i], ringVerts[i], ringVerts[j], 0],
          [previous[i], ringVerts[j], previous[j], 0]);
      }
      previous = ringVerts;
    }
    // Blunt tip cap.
    for (let i = 1; i < 5; i += 1) {
      triangles.push([previous[0], previous[i], previous[i + 1], 0]);
    }
  });

  // Thumb branch stitched into the palm opening above. The first ring is not copied: it is composed
  // of six existing palm vertices. Subsequent rings follow a bent quadratic spine and share the same
  // six-sided broad-cut language as the fingers. This turns palm + thenar + thumb into one manifold
  // surface instead of two closed solids that merely intersect.
  if (thumb && axis === 'x' && thumbProfile.length > 1 && rings.length >= 3) {
    const e = ACROSS - 1;
    const root = [
      rings[0][e], rings[1][e], rings[2][e],
      rings[2][2 * ACROSS - 1], rings[1][2 * ACROSS - 1], rings[0][2 * ACROSS - 1],
    ];
    const rootCentre = root.reduce((acc, v) => [
      acc[0] + position[v][0] / root.length,
      acc[1] + position[v][1] / root.length,
      acc[2] + position[v][2] / root.length,
    ] as V3, [0, 0, 0] as V3);
    const rootTarget: V3 = [side * thumb.rootX, thumb.rootY, thumb.rootZ];
    const p0: V3 = rootCentre;
    // The opening itself must stay on the palm. Root controls therefore define the local origin for
    // the authored mid/tip offsets; changing rootX/Y/Z moves the branch's direction and length without
    // tearing that shared boundary away from the hand.
    const p1: V3 = [p0[0] + side * thumb.midX - rootTarget[0],
      p0[1] + thumb.midY - rootTarget[1], p0[2] + thumb.midZ - rootTarget[2]];
    const p2: V3 = [p0[0] + side * thumb.tipX - rootTarget[0],
      p0[1] + thumb.tipY - rootTarget[1], p0[2] + thumb.tipZ - rootTarget[2]];
    const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const norm = (v: V3): V3 => {
      const length = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / length, v[1] / length, v[2] / length];
    };
    const spine = norm(sub(p2, p0));
    const xAxis: V3 = [side, 0, 0];
    const xDot = dot(xAxis, spine);
    const widthAxis = norm([xAxis[0] - spine[0] * xDot, xAxis[1] - spine[1] * xDot,
      xAxis[2] - spine[2] * xDot]);
    const yAxis: V3 = [0, 1, 0];
    const ySpine = dot(yAxis, spine);
    const yWidth = dot(yAxis, widthAxis);
    const thickAxis = norm([yAxis[0] - spine[0] * ySpine - widthAxis[0] * yWidth,
      yAxis[1] - spine[1] * ySpine - widthAxis[1] * yWidth,
      yAxis[2] - spine[2] * ySpine - widthAxis[2] * yWidth]);
    let previous = root;
    for (let pi = 1; pi < thumbProfile.length; pi += 1) {
      const point = thumbProfile[pi];
      const t = point.at;
      const omt = 1 - t;
      const centre: V3 = [
        omt * omt * p0[0] + 2 * omt * t * p1[0] + t * t * p2[0],
        omt * omt * p0[1] + 2 * omt * t * p1[1] + t * t * p2[1],
        omt * omt * p0[2] + 2 * omt * t * p1[2] + t * t * p2[2],
      ];
      const angles = [150, 90, 30, -30, -90, -150];
      const next = angles.map((degrees) => {
        const angle = degrees * Math.PI / 180;
        const cw = Math.cos(angle) * point.width;
        const ct = Math.sin(angle) * point.thickness;
        return push([centre[0] + widthAxis[0] * cw + thickAxis[0] * ct,
          centre[1] + widthAxis[1] * cw + thickAxis[1] * ct,
          centre[2] + widthAxis[2] * cw + thickAxis[2] * ct]);
      });
      for (let i = 0; i < root.length; i += 1) {
        const j = (i + 1) % root.length;
        triangles.push([previous[i], next[i], next[j], 0], [previous[i], next[j], previous[j], 0]);
      }
      previous = next;
    }
    for (let i = 1; i < previous.length - 1; i += 1) {
      triangles.push([previous[0], previous[i], previous[i + 1], 0]);
    }
  }

  // A reflection inverts triangle winding, so the mirrored limb's normals would point INTO the
  // solid. `DoubleSide` hides that from the silhouette, but `flatShading` derives every normal from
  // the winding, so the left limb would light as though lit from behind -- and an exported GLB
  // would carry the inverted normals to whatever reads it next. Flipping the winding back is the
  // other half of mirroring; doing only the coordinate negation is doing half the job.
  if (side < 0) {
    for (const triangle of triangles) {
      const swap = triangle[1];
      triangle[1] = triangle[2];
      triangle[2] = swap;
    }
  }

  const mesh = creasedPatch(name, position, triangles, mat, 0.70);
  mesh.userData.handParts = [...fingers.map((f) => f.id), ...(thumb ? [thumb.name] : [])];
  mesh.userData.sharedHandTopology = true;
  mesh.userData.topologyIntent = 'station-grid palm with shared finger webs and stitched thumb branch';
  return mesh;
}

function markPart(
  object: THREE.Object3D,
  id: string,
  parentId: string,
  role: string,
  runtime: LowPolyHumanoidRuntime,
): void {
  object.userData.sculptComponent = {
    id,
    parent: parentId,
    role,
    inferred: ['rear depth', 'lateral surface continuation'],
  };
  object.userData.actionProfile = {
    animationRole: role,
    pivot: { mode: 'semantic-root', axis: [0, 1, 0] },
    sockets: [`${id}-socket`],
  };
  runtime.nodes[id] = object;
  const socket = new THREE.Object3D();
  socket.name = `${id}-socket`;
  socket.userData.socketFor = id;
  object.add(socket);
  runtime.sockets[id] = socket;
  runtime.colliders[id] = object;
}

function addMesh(
  root: THREE.Group,
  parent: THREE.Object3D,
  id: string,
  mesh: THREE.Mesh,
  parentId: string,
  role: string,
  runtime: LowPolyHumanoidRuntime,
  options: LowPolyHumanoidOptions,
): void {
  const node = new THREE.Group();
  node.name = `${id}__pivot`;
  markPart(node, id, parentId, role, runtime);
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  mesh.userData.partId = id;
  node.add(mesh);
  parent.add(node);
  runtime.meshes[id] = mesh;
  if (parent === root) runtime.destructionGroups.body.push(node.name);
}

/** Install a weighted action rig without changing the authored rest-pose topology. */
function installLowPolyHumanoidAnimations(
  root: THREE.Group,
  runtime: LowPolyHumanoidRuntime,
  handStations: PalmStation[],
  handFingers: FingerSpec[],
  handThumb: ThumbSpec,
  footOutline: HandOutlinePoint[],
): LowPolyHumanoidAnimationController {
  const motionRoot = new THREE.Group();
  motionRoot.name = 'character_motion_root';
  motionRoot.userData.animationRole = 'character-root';

  // Put the assembled character under a neutral motion root. `attach` preserves every authored
  // world transform, so installing the rig cannot move a vertex in the rest pose.
  const assembledChildren = [...root.children];
  root.add(motionRoot);
  root.updateMatrixWorld(true);
  for (const child of assembledChildren) motionRoot.attach(child);

  runtime.nodes['motion-root'] = motionRoot;

  const rigRoot = new THREE.Bone();
  rigRoot.name = 'motion_rig_root';
  rigRoot.userData.animationRole = 'skeleton-root';
  motionRoot.add(rigRoot);

  const makeBone = (
    parent: THREE.Bone,
    name: string,
    localPosition: [number, number, number],
    role: string,
  ): THREE.Bone => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(...localPosition);
    bone.rotation.order = 'ZXY';
    bone.userData.animationRole = role;
    parent.add(bone);
    runtime.nodes[name] = bone;
    return bone;
  };

  // A compact humanoid hierarchy. All points are authored in the model's +Y-up, +Z-front rest
  // space and converted to local offsets here. Keeping the rest rotations at identity makes every
  // action composable and gives skeleton.pose() a deterministic neutral pose.
  const pelvis = makeBone(rigRoot, 'motion_pelvis', [0, 2.96, -0.10], 'pelvis');
  const spine = makeBone(pelvis, 'motion_spine', [0, 0.51, -0.016], 'lower-spine');
  const abdomen = makeBone(spine, 'motion_abdomen', [0, 0.43, 0.006], 'abdomen');
  const chest = makeBone(abdomen, 'motion_chest', [0, 0.55, -0.03], 'chest');
  const upperChest = makeBone(chest, 'motion_upper_chest', [0, 0.33, -0.01], 'upper-chest');
  const neck = makeBone(upperChest, 'motion_neck', [0, 0.32, 0.086], 'neck');
  const head = makeBone(neck, 'motion_head', [0, 0.45, 0], 'head');

  // The two inner shoulder rings remain on an anchor. Parenting those anchors to upperChest lets
  // punches originate in the ribs and scapula instead of looking like isolated arm rotations.
  const armAnchorL = makeBone(upperChest, 'motion_arm_anchor_l', [-0.24, 0.04, 0.09], 'left-clavicle-anchor');
  const armL = makeBone(armAnchorL, 'motion_arm_l', [-0.38, -0.02, -0.045], 'left-shoulder');
  const armTwistL = makeBone(armL, 'motion_arm_twist_l', [0, 0, 0], 'left-upper-arm-twist');
  const elbowL = makeBone(armTwistL, 'motion_elbow_l', [-1.21, -0.017, -0.04], 'left-elbow');
  const wristL = makeBone(elbowL, 'motion_wrist_l', [-0.914, 0.003, 0.093], 'left-wrist');
  const armAnchorR = makeBone(upperChest, 'motion_arm_anchor_r', [0.24, 0.04, 0.09], 'right-clavicle-anchor');
  const armR = makeBone(armAnchorR, 'motion_arm_r', [0.38, -0.02, -0.045], 'right-shoulder');
  const armTwistR = makeBone(armR, 'motion_arm_twist_r', [0, 0, 0], 'right-upper-arm-twist');
  const elbowR = makeBone(armTwistR, 'motion_elbow_r', [1.21, -0.017, -0.04], 'right-elbow');
  const wristR = makeBone(elbowR, 'motion_wrist_r', [0.914, 0.003, 0.093], 'right-wrist');

  const legL = makeBone(pelvis, 'motion_leg_l', [-0.30, -0.08, 0], 'left-hip');
  const clothL = makeBone(legL, 'motion_shorts_l', [0, 0, 0], 'left-shorts-lag');
  const kneeL = makeBone(legL, 'motion_knee_l', [-0.043, -1.46, -0.008], 'left-knee');
  const ankleL = makeBone(kneeL, 'motion_ankle_l', [-0.004, -1.14, 0.054], 'left-ankle');
  const legR = makeBone(pelvis, 'motion_leg_r', [0.30, -0.08, 0], 'right-hip');
  const clothR = makeBone(legR, 'motion_shorts_r', [0, 0, 0], 'right-shorts-lag');
  const kneeR = makeBone(legR, 'motion_knee_r', [0.043, -1.46, -0.008], 'right-knee');
  const ankleR = makeBone(kneeR, 'motion_ankle_r', [0.004, -1.14, 0.054], 'right-ankle');

  type FingerRig = {
    id: string;
    centre: number;
    rootAlong: number;
    length: number;
    /** Distal metacarpal: cups the palm and carries the knuckle before the finger curls. */
    metacarpal: THREE.Bone;
    proximal: THREE.Bone;
    middle: THREE.Bone;
    distal: THREE.Bone;
  };
  type HandRig = {
    side: number;
    palm: THREE.Bone;
    fingers: FingerRig[];
    thumb: [THREE.Bone, THREE.Bone, THREE.Bone];
  };
  const makeHandRig = (side: number, label: 'l' | 'r', wrist: THREE.Bone): HandRig => {
    const wristWorld: [number, number, number] = [side * 2.744, 4.786, -0.052];
    const distalStation = handStations[handStations.length - 1];
    const palmWorld: [number, number, number] = [
      side * ((handStations[0].x + distalStation.x) * 0.5),
      (handStations[0].yCentre + distalStation.yCentre) * 0.5,
      (handStations[0].zCentre + distalStation.zCentre) * 0.5,
    ];
    const palm = makeBone(wrist, `motion_palm_${label}`, [
      palmWorld[0] - wristWorld[0], palmWorld[1] - wristWorld[1], palmWorld[2] - wristWorld[2],
    ], `${label === 'l' ? 'left' : 'right'}-palm`);
    const across = distalStation.across ?? [];
    const fingers = handFingers.map((finger, index): FingerRig => {
      const centre = across[index * 2 + 1]
        ?? distalStation.zCentre + ((index + 0.5) / handFingers.length * 2 - 1) * distalStation.halfSpread;
      const rootAlong = distalStation.x - finger.setback;
      const metacarpalAlong = handStations[Math.max(0, handStations.length - 3)].x;
      const metacarpalWorld: [number, number, number] = [
        side * metacarpalAlong, distalStation.yCentre, centre,
      ];
      const rootWorld: [number, number, number] = [side * rootAlong, distalStation.yCentre, centre];
      const midWorld: [number, number, number] = [
        side * (rootAlong + finger.length * 0.38), distalStation.yCentre, centre,
      ];
      const distalWorld: [number, number, number] = [
        side * (rootAlong + finger.length * 0.72), distalStation.yCentre, centre,
      ];
      const metacarpal = makeBone(palm, `motion_${finger.id}_metacarpal_${label}`, [
        metacarpalWorld[0] - palmWorld[0], metacarpalWorld[1] - palmWorld[1],
        metacarpalWorld[2] - palmWorld[2],
      ], `${label}-${finger.id}-metacarpal`);
      const proximal = makeBone(metacarpal, `motion_${finger.id}_proximal_${label}`, [
        rootWorld[0] - metacarpalWorld[0], rootWorld[1] - metacarpalWorld[1],
        rootWorld[2] - metacarpalWorld[2],
      ], `${label}-${finger.id}-proximal`);
      const middle = makeBone(proximal, `motion_${finger.id}_middle_${label}`, [
        midWorld[0] - rootWorld[0], midWorld[1] - rootWorld[1], midWorld[2] - rootWorld[2],
      ], `${label}-${finger.id}-middle`);
      const distal = makeBone(middle, `motion_${finger.id}_distal_${label}`, [
        distalWorld[0] - midWorld[0], distalWorld[1] - midWorld[1], distalWorld[2] - midWorld[2],
      ], `${label}-${finger.id}-distal`);
      return { id: finger.id, centre, rootAlong, length: finger.length,
        metacarpal, proximal, middle, distal };
    });
    const thumbRootWorld: [number, number, number] = [side * handThumb.rootX, handThumb.rootY, handThumb.rootZ];
    const thumbMidWorld: [number, number, number] = [side * handThumb.midX, handThumb.midY, handThumb.midZ];
    const thumbTipWorld: [number, number, number] = [side * handThumb.tipX, handThumb.tipY, handThumb.tipZ];
    const thumbRoot = makeBone(palm, `motion_thumb_proximal_${label}`, [
      thumbRootWorld[0] - palmWorld[0], thumbRootWorld[1] - palmWorld[1], thumbRootWorld[2] - palmWorld[2],
    ], `${label}-thumb-proximal`);
    const thumbMid = makeBone(thumbRoot, `motion_thumb_middle_${label}`, [
      thumbMidWorld[0] - thumbRootWorld[0], thumbMidWorld[1] - thumbRootWorld[1],
      thumbMidWorld[2] - thumbRootWorld[2],
    ], `${label}-thumb-middle`);
    const thumbTip = makeBone(thumbMid, `motion_thumb_distal_${label}`, [
      thumbTipWorld[0] - thumbMidWorld[0], thumbTipWorld[1] - thumbMidWorld[1],
      thumbTipWorld[2] - thumbMidWorld[2],
    ], `${label}-thumb-distal`);
    return { side, palm, fingers, thumb: [thumbRoot, thumbMid, thumbTip] };
  };
  const handRigL = makeHandRig(-1, 'l', wristL);
  const handRigR = makeHandRig(1, 'r', wristR);

  type ToeRig = {
    id: string;
    centre: number;
    rootZ: number;
    tipZ: number;
    proximal: THREE.Bone;
    distal: THREE.Bone;
  };
  type FootRig = { side: number; foot: THREE.Bone; toes: ToeRig[] };
  const outlinePoint = (name: string): HandOutlinePoint => {
    const point = footOutline.find((candidate) => candidate.name === name);
    if (!point) throw new Error(`Missing foot rig landmark: ${name}`);
    return point;
  };
  const makeFootRig = (side: number, label: 'l' | 'r', ankle: THREE.Bone): FootRig => {
    const ankleWorld: [number, number, number] = [side * 0.347, 0.28, -0.054];
    const footWorld: [number, number, number] = [side * 0.347, 0.13, -0.03];
    const foot = makeBone(ankle, `motion_foot_${label}`, [
      footWorld[0] - ankleWorld[0], footWorld[1] - ankleWorld[1], footWorld[2] - ankleWorld[2],
    ], `${label === 'l' ? 'left' : 'right'}-foot`);
    const toeLandmarks = [
      ['toe-5', 'little-tip-outer', 'little-tip-inner'],
      ['toe-4', 'toe-4-tip-outer', 'toe-4-tip-inner'],
      ['toe-3', 'toe-3-tip-outer', 'toe-3-tip-inner'],
      ['toe-2', 'toe-2-tip-outer', 'toe-2-tip-inner'],
      ['toe-1', 'big-tip-outer', 'big-tip-inner'],
    ] as const;
    const rootZ = 0.48;
    const toes = toeLandmarks.map(([id, outerName, innerName]): ToeRig => {
      const outer = outlinePoint(outerName);
      const inner = outlinePoint(innerName);
      const centre = (outer.x + inner.x) * 0.5;
      const tipZ = (outer.z + inner.z) * 0.5;
      const rootWorld: [number, number, number] = [side * centre, 0.14, rootZ];
      const midZ = rootZ + (tipZ - rootZ) * 0.58;
      const midWorld: [number, number, number] = [side * centre, 0.14, midZ];
      const proximal = makeBone(foot, `motion_${id}_proximal_${label}`, [
        rootWorld[0] - footWorld[0], rootWorld[1] - footWorld[1], rootWorld[2] - footWorld[2],
      ], `${label}-${id}-proximal`);
      const distal = makeBone(proximal, `motion_${id}_distal_${label}`, [
        midWorld[0] - rootWorld[0], midWorld[1] - rootWorld[1], midWorld[2] - rootWorld[2],
      ], `${label}-${id}-distal`);
      return { id, centre, rootZ, tipZ, proximal, distal };
    });
    return { side, foot, toes };
  };
  const footRigL = makeFootRig(-1, 'l', ankleL);
  const footRigR = makeFootRig(1, 'r', ankleR);

  const bones = [
    rigRoot,
    pelvis, spine, abdomen, chest, upperChest, neck, head,
    armAnchorL, armL, armTwistL, elbowL, wristL,
    armAnchorR, armR, armTwistR, elbowR, wristR,
    legL, clothL, kneeL, ankleL,
    legR, clothR, kneeR, ankleR,
    handRigL.palm, ...handRigL.fingers.flatMap((finger) => [
      finger.metacarpal, finger.proximal, finger.middle, finger.distal,
    ]),
    ...handRigL.thumb,
    handRigR.palm, ...handRigR.fingers.flatMap((finger) => [
      finger.metacarpal, finger.proximal, finger.middle, finger.distal,
    ]),
    ...handRigR.thumb,
    footRigL.foot, ...footRigL.toes.flatMap((toe) => [toe.proximal, toe.distal]),
    footRigR.foot, ...footRigR.toes.flatMap((toe) => [toe.proximal, toe.distal]),
  ];
  motionRoot.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  skeleton.calculateInverses();
  const boneIndex = new Map(bones.map((bone, index) => [bone, index]));
  type Influence = [THREE.Bone, number];
  const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
  const smooth = (value: number): number => {
    const t = clamp01(value);
    return t * t * (3 - 2 * t);
  };
  const blend = (a: THREE.Bone, b: THREE.Bone, t: number): Influence[] => {
    const k = smooth(t);
    return [[a, 1 - k], [b, k]];
  };

  const convertToSkinned = (
    id: string,
    resolve: (x: number, y: number, z: number) => Influence[],
  ): THREE.SkinnedMesh | null => {
    const old = runtime.meshes[id];
    const parent = old?.parent;
    if (!old || !parent) return null;
    const skinned = new THREE.SkinnedMesh(old.geometry, old.material);
    skinned.name = old.name;
    skinned.position.copy(old.position);
    skinned.quaternion.copy(old.quaternion);
    skinned.scale.copy(old.scale);
    skinned.visible = old.visible;
    skinned.castShadow = old.castShadow;
    skinned.receiveShadow = old.receiveShadow;
    skinned.renderOrder = old.renderOrder;
    skinned.userData = { ...old.userData };
    skinned.frustumCulled = false;
    parent.add(skinned);
    parent.remove(old);
    runtime.meshes[id] = skinned;

    const applyRigAttributes = (): void => {
      const position = skinned.geometry.getAttribute('position') as THREE.BufferAttribute;
      const indices = new Uint16Array(position.count * 4);
      const weights = new Float32Array(position.count * 4);
      for (let i = 0; i < position.count; i += 1) {
        const influences = resolve(position.getX(i), position.getY(i), position.getZ(i))
          .filter(([, weight]) => weight > 1e-5)
          .slice(0, 4);
        const total = influences.reduce((sum, [, weight]) => sum + weight, 0) || 1;
        for (let j = 0; j < influences.length; j += 1) {
          indices[i * 4 + j] = boneIndex.get(influences[j][0]) ?? 0;
          weights[i * 4 + j] = influences[j][1] / total;
        }
      }
      skinned.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
      skinned.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    };
    skinned.userData.applyRigAttributes = applyRigAttributes;
    applyRigAttributes();
    motionRoot.updateMatrixWorld(true);
    skinned.bind(skeleton, skinned.matrixWorld);
    skinned.normalizeSkinWeights();
    return skinned;
  };

  const armWeights = (
    anchor: THREE.Bone,
    shoulder: THREE.Bone,
    elbow: THREE.Bone,
    wrist: THREE.Bone,
  ) => (x: number): Influence[] => {
    const along = Math.abs(x);
    // The first two broad-cut shoulder stations must bend as one continuous sleeve. Extending this
    // blend across the deltoid prevents a rigid anchor block from ending abruptly above a lowered arm.
    if (along <= 0.40) return [[anchor, 1]];
    if (along < 1.08) return blend(anchor, shoulder, (along - 0.40) / 0.68);
    if (along <= 1.60) return [[shoulder, 1]];
    if (along < 2.05) return blend(shoulder, elbow, (along - 1.60) / 0.45);
    if (along <= 2.40) return [[elbow, 1]];
    return blend(elbow, wrist, (along - 2.40) / 0.34);
  };
  // The twist bones share the shoulder pivot but sit below the elevation bones. Weighting the arm
  // surface to them lets axial rotation travel through the whole limb without changing its direction.
  convertToSkinned('arm-shell-l', armWeights(armAnchorL, armTwistL, elbowL, wristL));
  convertToSkinned('arm-shell-r', armWeights(armAnchorR, armTwistR, elbowR, wristR));
  const seamWeights = (anchor: THREE.Bone) => (x: number): Influence[] => {
    const outward = smooth((Math.abs(x) - 0.18) / 0.48);
    return [[upperChest, 1 - outward], [anchor, outward]];
  };
  convertToSkinned('shoulder-seam-underlay-l', seamWeights(armAnchorL));
  convertToSkinned('shoulder-seam-underlay-r', seamWeights(armAnchorR));

  const legWeights = (hip: THREE.Bone, knee: THREE.Bone, ankle: THREE.Bone) => (
    _x: number, y: number,
  ): Influence[] => {
    if (y >= 1.72) return [[hip, 1]];
    if (y > 1.18) return blend(knee, hip, (y - 1.18) / 0.54);
    if (y >= 0.68) return [[knee, 1]];
    return blend(ankle, knee, (y - 0.28) / 0.40);
  };
  convertToSkinned('leg-shell-l', legWeights(legL, kneeL, ankleL));
  convertToSkinned('leg-shell-r', legWeights(legR, kneeR, ankleR));

  const torsoWeights = (x: number, y: number): Influence[] => {
    let base: Influence[];
    if (y <= 3.35) base = [[pelvis, 1]];
    else if (y < 3.62) base = blend(pelvis, spine, (y - 3.35) / 0.27);
    else if (y < 3.98) base = blend(spine, abdomen, (y - 3.62) / 0.36);
    else if (y < 4.42) base = blend(abdomen, chest, (y - 3.98) / 0.44);
    else if (y < 4.76) base = blend(chest, upperChest, (y - 4.42) / 0.34);
    else base = [[upperChest, 1]];

    // Carry only the lateral clavicle/deltoid surface with the corresponding shoulder anchor. The
    // sternum and pec stay chest-owned, while the outer torso edge deforms with the arm instead of
    // remaining as the square shoulder ledge visible in lowered poses.
    const lateral = smooth((Math.abs(x) - 0.36) / 0.315);
    const shoulderBand = smooth((y - 4.56) / 0.22);
    const anchorWeight = Math.min(0.68, lateral * shoulderBand * 0.68);
    if (anchorWeight <= 1e-5) return base;
    const anchor = x < 0 ? armAnchorL : armAnchorR;
    return [...base.map(([bone, weight]) => [bone, weight * (1 - anchorWeight)] as Influence),
      [anchor, anchorWeight]];
  };
  convertToSkinned('torso-shell', torsoWeights);

  const handWeights = (rig: HandRig) => (x: number, y: number, z: number): Influence[] => {
    const along = Math.abs(x);
    const thumbRoot = handThumb.rootX;
    const thumbMid = handThumb.midX;
    const thumbTip = handThumb.tipX;
    const isThumb = z > 0.025 && y < 4.75 && along > Math.min(2.70, thumbRoot);
    if (isThumb) {
      if (along < thumbRoot) return blend(rig.palm, rig.thumb[0], (along - 2.70) / (thumbRoot - 2.70));
      if (along < thumbMid) return blend(rig.thumb[0], rig.thumb[1], (along - thumbRoot) / (thumbMid - thumbRoot));
      return blend(rig.thumb[1], rig.thumb[2], (along - thumbMid) / Math.max(0.001, thumbTip - thumbMid));
    }
    const palmStart = handStations[0].x;
    const fingerRoot = handStations[handStations.length - 1].x;
    let finger = rig.fingers[0];
    for (const candidate of rig.fingers) {
      if (Math.abs(z - candidate.centre) < Math.abs(z - finger.centre)) finger = candidate;
    }
    const metacarpalStart = handStations[Math.max(0, handStations.length - 3)].x - 0.045;
    if (along < metacarpalStart) {
      const wrist = rig.side < 0 ? wristL : wristR;
      return blend(wrist, rig.palm, (along - palmStart) / Math.max(0.001, metacarpalStart - palmStart));
    }
    if (along < fingerRoot - 0.025) {
      return blend(rig.palm, finger.metacarpal,
        (along - metacarpalStart) / Math.max(0.001, fingerRoot - 0.025 - metacarpalStart));
    }
    const t = clamp01((along - finger.rootAlong) / Math.max(0.001, finger.length));
    if (t < 0.16) return blend(finger.metacarpal, finger.proximal, t / 0.16);
    if (t < 0.54) return blend(finger.proximal, finger.middle, (t - 0.16) / 0.38);
    return blend(finger.middle, finger.distal, (t - 0.54) / 0.46);
  };
  convertToSkinned('hand-l', handWeights(handRigL));
  convertToSkinned('hand-r', handWeights(handRigR));

  const footWeights = (rig: FootRig) => (x: number, _y: number, z: number): Influence[] => {
    if (z < 0.44) return [[rig.foot, 1]];
    const across = Math.abs(x);
    let toe = rig.toes[0];
    for (const candidate of rig.toes) {
      if (Math.abs(across - candidate.centre) < Math.abs(across - toe.centre)) toe = candidate;
    }
    const t = clamp01((z - toe.rootZ) / Math.max(0.001, toe.tipZ - toe.rootZ));
    if (t < 0.25) return blend(rig.foot, toe.proximal, t / 0.25);
    return blend(toe.proximal, toe.distal, (t - 0.25) / 0.75);
  };
  convertToSkinned('foot-shell-l', footWeights(footRigL));
  convertToSkinned('foot-shell-r', footWeights(footRigR));

  // The waistband remains pelvis-bound. Toward each hem the cloth uses the same hip bone as the
  // corresponding thigh, reaching full hip motion at the opening; a smaller child-bone share adds
  // delayed cloth motion without allowing the leg to escape through a stationary shorts shell.
  convertToSkinned('shorts-shell', (x, y): Influence[] => {
    // Full hip binding is reached by y=3.10, well above the 2.91 hem. The older 0.46 transition
    // reached full weight only at the hem itself, leaving the upper thigh faster than the cloth and
    // exposing small skin wedges during a kick. Only the exact x=0 rise remains pelvis-bound; each
    // side of the gusset follows its own leg so the opening and thigh have the same speed and range.
    const lower = smooth((3.38 - y) / 0.28);
    const lateral = smooth((Math.abs(x) - 0.005) / 0.025);
    const moving = lower * lateral;
    if (moving < 1e-5) return [[pelvis, 1]];
    const hip = x < 0 ? legL : legR;
    const cloth = x < 0 ? clothL : clothR;
    const lagShare = moving * 0.24;
    return [[pelvis, 1 - moving], [hip, moving - lagShare], [cloth, lagShare]];
  });

  const attachPart = (bone: THREE.Bone, id: string): void => {
    const node = runtime.nodes[id];
    if (!node) return;
    motionRoot.updateMatrixWorld(true);
    bone.attach(node);
  };
  attachPart(head, 'head');

  const rigDebug = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('rigDebug') === '1';
  if (rigDebug) {
    const helper = new THREE.SkeletonHelper(rigRoot);
    helper.name = 'low_poly_humanoid_skeleton_helper';
    (helper.material as THREE.LineBasicMaterial).depthTest = false;
    helper.renderOrder = 100;
    motionRoot.add(helper);
  }

  const track = (
    object: THREE.Object3D,
    property:
      | 'position[x]'
      | 'position[y]'
      | 'position[z]'
      | 'rotation[x]'
      | 'rotation[y]'
      | 'rotation[z]'
      | 'scale[x]'
      | 'scale[y]'
      | 'scale[z]',
    times: number[],
    values: number[],
  ): THREE.NumberKeyframeTrack => new THREE.NumberKeyframeTrack(
    `${object.name}.${property}`,
    times,
    values,
  );
  const constant = (value: number, duration = 1): [number[], number[]] => [[0, duration], [value, value]];
  const eyeL = runtime.nodes['eye-l'];
  const eyeR = runtime.nodes['eye-r'];
  if (!eyeL || !eyeR) throw new Error('Eye pivots must exist before installing the animation rig');

  const appendFingerCurl = (
    tracks: THREE.KeyframeTrack[],
    rig: HandRig,
    times: number[],
    values: number[],
  ): void => {
    const direction = -rig.side;
    const ones = times.map(() => 1);
    tracks.push(track(rig.palm, 'scale[x]', times, ones));
    tracks.push(track(rig.palm, 'scale[y]', times, ones));
    tracks.push(track(rig.palm, 'scale[z]', times, ones));
    for (const finger of rig.fingers) {
      tracks.push(track(finger.metacarpal, 'rotation[x]', times, times.map(() => 0)));
      tracks.push(track(finger.metacarpal, 'rotation[y]', times, times.map(() => 0)));
      tracks.push(track(finger.metacarpal, 'rotation[z]', times, times.map(() => 0)));
      tracks.push(track(finger.metacarpal, 'scale[x]', times, ones));
      tracks.push(track(finger.metacarpal, 'scale[y]', times, ones));
      tracks.push(track(finger.metacarpal, 'scale[z]', times, ones));
      tracks.push(track(finger.proximal, 'rotation[z]', times, values.map((v) => v * direction * 0.82)));
      tracks.push(track(finger.middle, 'rotation[z]', times, values.map((v) => v * direction * 1.08)));
      tracks.push(track(finger.distal, 'rotation[z]', times, values.map((v) => v * direction * 0.92)));
    }
    tracks.push(track(rig.thumb[0], 'rotation[z]', times, values.map((v) => v * direction * 0.42)));
    tracks.push(track(rig.thumb[1], 'rotation[z]', times, values.map((v) => v * direction * 0.68)));
    tracks.push(track(rig.thumb[2], 'rotation[z]', times, values.map((v) => v * direction * 0.54)));
    for (const thumbBone of rig.thumb) {
      tracks.push(track(thumbBone, 'scale[x]', times, ones));
      tracks.push(track(thumbBone, 'scale[y]', times, ones));
      tracks.push(track(thumbBone, 'scale[z]', times, ones));
    }
  };
  const appendOpenHand = (
    tracks: THREE.KeyframeTrack[],
    rig: HandRig,
    times: number[],
  ): void => {
    const zeros = times.map(() => 0);
    const ones = times.map(() => 1);
    const handChain: THREE.Object3D[] = [
      rig.palm,
      ...rig.fingers.flatMap((finger) => [
        finger.metacarpal, finger.proximal, finger.middle, finger.distal,
      ]),
      ...rig.thumb,
    ];
    for (const joint of handChain) {
      tracks.push(track(joint, 'rotation[x]', times, zeros));
      tracks.push(track(joint, 'rotation[y]', times, zeros));
      tracks.push(track(joint, 'rotation[z]', times, zeros));
      tracks.push(track(joint, 'scale[x]', times, ones));
      tracks.push(track(joint, 'scale[y]', times, ones));
      tracks.push(track(joint, 'scale[z]', times, ones));
    }
  };
  const appendLockedTPoseArms = (
    tracks: THREE.KeyframeTrack[],
    times: number[],
  ): void => {
    const zeros = times.map(() => 0);
    const armChain: THREE.Object3D[] = [
      armAnchorL, armL, armTwistL, elbowL, wristL, handRigL.palm,
      ...handRigL.fingers.flatMap((finger) => [
        finger.metacarpal, finger.proximal, finger.middle, finger.distal,
      ]),
      ...handRigL.thumb,
      armAnchorR, armR, armTwistR, elbowR, wristR, handRigR.palm,
      ...handRigR.fingers.flatMap((finger) => [
        finger.metacarpal, finger.proximal, finger.middle, finger.distal,
      ]),
      ...handRigR.thumb,
    ];
    for (const joint of armChain) {
      tracks.push(track(joint, 'rotation[x]', times, zeros));
      tracks.push(track(joint, 'rotation[y]', times, zeros));
      tracks.push(track(joint, 'rotation[z]', times, zeros));
      tracks.push(track(joint, 'scale[x]', times, times.map(() => 1)));
      tracks.push(track(joint, 'scale[y]', times, times.map(() => 1)));
      tracks.push(track(joint, 'scale[z]', times, times.map(() => 1)));
    }
  };
  const appendToeCurl = (
    tracks: THREE.KeyframeTrack[],
    rig: FootRig,
    times: number[],
    values: number[],
  ): void => {
    for (const toe of rig.toes) {
      tracks.push(track(toe.proximal, 'rotation[x]', times, values.map((v) => v * 0.62)));
      tracks.push(track(toe.distal, 'rotation[x]', times, values.map((v) => v * 0.88)));
    }
  };
  const appendEyeLook = (
    tracks: THREE.KeyframeTrack[],
    times: number[],
    xValues: number[],
    yValues: number[],
  ): void => {
    for (const eye of [eyeL, eyeR]) {
      tracks.push(track(eye, 'position[x]', times, xValues));
      tracks.push(track(eye, 'position[y]', times, yValues));
    }
  };

  const idleTracks: THREE.KeyframeTrack[] = [];
  const [idleTimes, idleValues] = constant(0);
  idleTracks.push(track(motionRoot, 'position[y]', idleTimes, idleValues));
  for (const pivot of bones.filter((bone) => bone !== rigRoot && bone !== clothL && bone !== clothR)) {
    idleTracks.push(track(pivot, 'rotation[x]', idleTimes, idleValues));
    idleTracks.push(track(pivot, 'rotation[y]', idleTimes, idleValues));
    idleTracks.push(track(pivot, 'rotation[z]', idleTimes, idleValues));
    idleTracks.push(track(pivot, 'scale[x]', idleTimes, [1, 1]));
    idleTracks.push(track(pivot, 'scale[y]', idleTimes, [1, 1]));
    idleTracks.push(track(pivot, 'scale[z]', idleTimes, [1, 1]));
  }
  appendEyeLook(idleTracks, idleTimes, idleValues, idleValues);

  const runTimes = [0, 0.2, 0.4, 0.6, 0.8];
  // Knees need an extra passing key between the broad hip beats. With only the five hip keys both
  // knees interpolated toward almost-straight at the passing pose, so the rig existed but read as two
  // rigid legs. The stance knee now keeps a small load bend while the recovering knee folds farther,
  // then the roles swap half a cycle later. Values remain deliberately below the kick/jump range.
  const runKneeTimes = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const runTracks: THREE.KeyframeTrack[] = [
    track(motionRoot, 'position[y]', runTimes, [0.01, 0.065, 0.01, 0.065, 0.01]),
    track(legL, 'rotation[x]', runTimes, [-0.58, 0, 0.58, 0, -0.58]),
    track(legR, 'rotation[x]', runTimes, [0.58, 0, -0.58, 0, 0.58]),
    track(legL, 'rotation[z]', runTimes, [0.035, 0.02, 0.035, 0.02, 0.035]),
    track(legR, 'rotation[z]', runTimes, [-0.035, -0.02, -0.035, -0.02, -0.035]),
    track(kneeL, 'rotation[x]', runKneeTimes, [0.52, 0.40, 0.22, 0.16, 0.12, 0.22, 0.42, 0.58, 0.52]),
    track(kneeR, 'rotation[x]', runKneeTimes, [0.12, 0.22, 0.42, 0.58, 0.52, 0.40, 0.22, 0.16, 0.12]),
  ];
  runTracks.push(
    track(head, 'rotation[y]', runTimes, [0.035, 0, -0.035, 0, 0.035]),
    track(footRigL.foot, 'rotation[x]', runTimes, [0.08, -0.04, -0.12, 0, 0.08]),
    track(footRigR.foot, 'rotation[x]', runTimes, [-0.12, 0, 0.08, -0.04, -0.12]),
  );
  // Running keeps the authored T-pose arm chain. Lowered-arm clips caused the lateral shoulder shell
  // to fold over the arm root, so locomotion now comes entirely from the torso, pelvis and legs.
  appendLockedTPoseArms(runTracks, runTimes);
  appendToeCurl(runTracks, footRigL, runTimes, [0.18, 0.04, 0.02, 0.12, 0.18]);
  appendToeCurl(runTracks, footRigR, runTimes, [0.02, 0.12, 0.18, 0.04, 0.02]);
  appendEyeLook(runTracks, runTimes, [0.003, 0, -0.003, 0, 0.003], [0, 0.001, 0, 0.001, 0]);

  const jumpTimes = [0, 0.16, 0.36, 0.58, 0.82, 1.08];
  const jumpTracks: THREE.KeyframeTrack[] = [
    track(motionRoot, 'position[y]', jumpTimes, [0, -0.10, 0.72, 0.92, 0.28, 0]),
    track(armL, 'rotation[z]', jumpTimes, [0, 0.45, -1.34, -1.42, -0.50, 0]),
    track(armR, 'rotation[z]', jumpTimes, [0, -0.45, 1.34, 1.42, 0.50, 0]),
    track(armL, 'rotation[x]', jumpTimes, [0, -0.10, -0.22, -0.12, 0, 0]),
    track(armR, 'rotation[x]', jumpTimes, [0, 0.10, 0.22, 0.12, 0, 0]),
    track(elbowL, 'rotation[z]', jumpTimes, [0, 0.12, 0.28, 0.22, 0.08, 0]),
    track(elbowR, 'rotation[z]', jumpTimes, [0, -0.12, -0.28, -0.22, -0.08, 0]),
    track(legL, 'rotation[x]', jumpTimes, [0, 0.12, -0.28, -0.34, -0.12, 0]),
    track(legR, 'rotation[x]', jumpTimes, [0, 0.12, -0.28, -0.34, -0.12, 0]),
    track(legL, 'rotation[z]', jumpTimes, [0, -0.04, -0.12, -0.10, -0.03, 0]),
    track(legR, 'rotation[z]', jumpTimes, [0, 0.04, 0.12, 0.10, 0.03, 0]),
    track(kneeL, 'rotation[x]', jumpTimes, [0, 0.32, 0.72, 0.80, 0.28, 0]),
    track(kneeR, 'rotation[x]', jumpTimes, [0, 0.32, 0.72, 0.80, 0.28, 0]),
  ];
  jumpTracks.push(
    track(spine, 'rotation[x]', jumpTimes, [0, 0.14, -0.08, -0.12, 0.04, 0]),
    track(chest, 'rotation[x]', jumpTimes, [0, 0.10, -0.12, -0.16, 0.02, 0]),
    track(head, 'rotation[x]', jumpTimes, [0, -0.05, 0.08, 0.10, -0.02, 0]),
    track(footRigL.foot, 'rotation[x]', jumpTimes, [0, 0.18, -0.22, -0.24, 0.12, 0]),
    track(footRigR.foot, 'rotation[x]', jumpTimes, [0, 0.18, -0.22, -0.24, 0.12, 0]),
  );
  appendFingerCurl(jumpTracks, handRigL, jumpTimes, [0.18, 0.48, 0.20, 0.12, 0.30, 0]);
  appendFingerCurl(jumpTracks, handRigR, jumpTimes, [0.18, 0.48, 0.20, 0.12, 0.30, 0]);
  appendToeCurl(jumpTracks, footRigL, jumpTimes, [0, 0.38, 0.08, 0.04, 0.30, 0]);
  appendToeCurl(jumpTracks, footRigR, jumpTimes, [0, 0.38, 0.08, 0.04, 0.30, 0]);
  appendEyeLook(jumpTracks, jumpTimes, [0, 0, 0, 0, 0, 0], [-0.001, -0.003, 0.004, 0.005, 0, 0]);

  const kickTimes = [0, 0.16, 0.34, 0.54, 0.76, 1.08];
  const kickTracks: THREE.KeyframeTrack[] = [
    track(motionRoot, 'position[y]', kickTimes, [0, -0.035, 0.035, 0.055, 0.01, 0]),
    track(legL, 'rotation[x]', kickTimes, [0, -0.06, 0.05, 0.08, 0.02, 0]),
    track(legL, 'rotation[z]', kickTimes, [0, -0.03, -0.06, -0.06, -0.02, 0]),
    track(kneeL, 'rotation[x]', kickTimes, [0, 0.08, 0.16, 0.12, 0.04, 0]),
    track(legR, 'rotation[x]', kickTimes, [0, 0.18, -0.82, -1.04, -0.24, 0]),
    track(legR, 'rotation[z]', kickTimes, [0, 0.04, 0.08, 0.06, 0.02, 0]),
    track(kneeR, 'rotation[x]', kickTimes, [0, 0.72, 0.54, 0.08, 0.18, 0]),
  ];
  kickTracks.push(
    track(pelvis, 'rotation[y]', kickTimes, [0, -0.08, -0.22, -0.30, -0.08, 0]),
    track(spine, 'rotation[z]', kickTimes, [0, 0.04, 0.12, 0.15, 0.05, 0]),
    track(chest, 'rotation[y]', kickTimes, [0, 0.10, 0.24, 0.30, 0.08, 0]),
    track(head, 'rotation[y]', kickTimes, [0, -0.04, -0.10, -0.12, -0.03, 0]),
    track(footRigR.foot, 'rotation[x]', kickTimes, [0, 0.24, -0.18, -0.30, 0.10, 0]),
  );
  appendLockedTPoseArms(kickTracks, kickTimes);
  appendToeCurl(kickTracks, footRigL, kickTimes, [0, 0.28, 0.38, 0.34, 0.12, 0]);
  appendToeCurl(kickTracks, footRigR, kickTimes, [0, 0.12, 0.04, 0.02, 0.10, 0]);
  appendEyeLook(kickTracks, kickTimes, [0, -0.002, -0.004, -0.005, -0.002, 0], [0, 0, 0.002, 0.002, 0, 0]);

  // Replacement for Stand Attention: retain the safe authored T-pose and animate only breathing,
  // balance and gaze. No animation in this neutral loop lowers either shoulder chain.
  const tPoseBreathingTimes = [0, 0.6, 1.2];
  const tPoseBreathingTracks: THREE.KeyframeTrack[] = [
    track(motionRoot, 'position[y]', tPoseBreathingTimes, [0, 0.008, 0]),
    track(pelvis, 'rotation[y]', tPoseBreathingTimes, [0, 0.012, 0]),
    track(spine, 'rotation[x]', tPoseBreathingTimes, [0.015, 0.028, 0.015]),
    track(chest, 'rotation[x]', tPoseBreathingTimes, [-0.008, -0.016, -0.008]),
    track(head, 'rotation[x]', tPoseBreathingTimes, [-0.012, -0.02, -0.012]),
    track(legL, 'rotation[z]', tPoseBreathingTimes, [-0.018, -0.012, -0.018]),
    track(legR, 'rotation[z]', tPoseBreathingTimes, [0.018, 0.012, 0.018]),
    track(kneeL, 'rotation[x]', tPoseBreathingTimes, [0.035, 0.045, 0.035]),
    track(kneeR, 'rotation[x]', tPoseBreathingTimes, [0.035, 0.045, 0.035]),
  ];
  appendLockedTPoseArms(tPoseBreathingTracks, tPoseBreathingTimes);
  appendEyeLook(tPoseBreathingTracks, tPoseBreathingTimes, [0, 0.0015, 0], [0, 0.001, 0]);

  // Friendly fan interactions replace the former fighting trio. The original articulated hands stay
  // visible and fully open; motion comes from shoulders, elbows and wrists, avoiding fist deformation.
  const saluteTimes = [0, 0.4, 0.8, 1.2, 1.6];
  const saluteTracks: THREE.KeyframeTrack[] = [
    track(motionRoot, 'position[y]', saluteTimes, [0, 0.018, 0, 0.018, 0]),
    track(pelvis, 'rotation[y]', saluteTimes, [-0.04, -0.02, 0, 0.02, -0.04]),
    track(spine, 'rotation[x]', saluteTimes, [0.025, 0.04, 0.025, 0.01, 0.025]),
    track(chest, 'rotation[y]', saluteTimes, [0.04, 0.02, 0, -0.02, 0.04]),
    track(head, 'rotation[x]', saluteTimes, [-0.04, -0.02, -0.04, -0.06, -0.04]),
    track(head, 'rotation[y]', saluteTimes, [-0.06, -0.02, 0.04, 0, -0.06]),
    track(armL, 'rotation[y]', saluteTimes, [1.46, 1.50, 1.46, 1.42, 1.46]),
    track(armR, 'rotation[y]', saluteTimes, [-1.46, -1.42, -1.46, -1.50, -1.46]),
    track(armL, 'rotation[z]', saluteTimes, [0.30, 0.27, 0.30, 0.33, 0.30]),
    track(armR, 'rotation[z]', saluteTimes, [-0.30, -0.33, -0.30, -0.27, -0.30]),
    track(elbowL, 'rotation[z]', saluteTimes, [-2.30, -2.24, -2.30, -2.36, -2.30]),
    track(elbowR, 'rotation[z]', saluteTimes, [2.30, 2.36, 2.30, 2.24, 2.30]),
    track(wristL, 'rotation[x]', saluteTimes, [0.06, 0.14, 0.06, -0.04, 0.06]),
    track(wristR, 'rotation[x]', saluteTimes, [0.06, -0.04, 0.06, 0.14, 0.06]),
    track(wristL, 'rotation[y]', saluteTimes, [0.10, 0.04, 0.10, 0.16, 0.10]),
    track(wristR, 'rotation[y]', saluteTimes, [-0.10, -0.16, -0.10, -0.04, -0.10]),
    track(legL, 'rotation[x]', saluteTimes, [-0.05, -0.03, -0.05, -0.07, -0.05]),
    track(legR, 'rotation[x]', saluteTimes, [0.05, 0.07, 0.05, 0.03, 0.05]),
    track(kneeL, 'rotation[x]', saluteTimes, [0.08, 0.11, 0.08, 0.05, 0.08]),
    track(kneeR, 'rotation[x]', saluteTimes, [0.08, 0.05, 0.08, 0.11, 0.08]),
  ];
  appendOpenHand(saluteTracks, handRigL, saluteTimes);
  appendOpenHand(saluteTracks, handRigR, saluteTimes);
  appendToeCurl(saluteTracks, footRigL, saluteTimes, [0.06, 0.10, 0.06, 0.03, 0.06]);
  appendToeCurl(saluteTracks, footRigR, saluteTimes, [0.06, 0.03, 0.06, 0.10, 0.06]);
  appendEyeLook(saluteTracks, saluteTimes, [-0.003, 0.002, 0.004, -0.001, -0.003], [0.001, 0.002, 0.001, 0, 0.001]);

  const waveLeftTimes = [0, 0.18, 0.38, 0.58, 0.78, 0.98, 1.18, 1.40];
  const waveLeftTracks: THREE.KeyframeTrack[] = [
    track(motionRoot, 'position[y]', waveLeftTimes, [0, 0.006, 0.014, 0.010, 0.014, 0.010, 0.006, 0]),
    track(chest, 'rotation[y]', waveLeftTimes, [0, 0.025, 0.055, 0.025, 0.055, 0.025, 0.012, 0]),
    track(head, 'rotation[y]', waveLeftTimes, [0, -0.04, -0.08, -0.04, -0.08, -0.04, -0.02, 0]),
    track(head, 'rotation[z]', waveLeftTimes, [0, -0.015, -0.03, -0.015, -0.03, -0.015, 0, 0]),
    // Raise a straight arm from T-pose, then sweep it left-right. A separate child twist bone applies
    // the axial quarter-turn after elevation, rotating the whole limb without changing its direction.
    track(armAnchorL, 'rotation[x]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armAnchorL, 'rotation[y]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armAnchorL, 'rotation[z]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armL, 'rotation[x]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armL, 'rotation[y]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armL, 'rotation[z]', waveLeftTimes, [0, -0.90, -1.46, -1.08, -1.48, -1.10, -0.88, 0]),
    track(armTwistL, 'rotation[x]', waveLeftTimes, [0, -1.20, -1.52, -1.52, -1.52, -1.52, -1.20, 0]),
    track(armTwistL, 'rotation[y]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armTwistL, 'rotation[z]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(elbowL, 'rotation[x]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(elbowL, 'rotation[y]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(elbowL, 'rotation[z]', waveLeftTimes, [-0.10, 0, 0, 0, 0, 0, 0, -0.10]),
    track(wristL, 'rotation[x]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(wristL, 'rotation[y]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(wristL, 'rotation[z]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armAnchorR, 'rotation[x]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armAnchorR, 'rotation[y]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armAnchorR, 'rotation[z]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armR, 'rotation[x]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armR, 'rotation[y]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armR, 'rotation[z]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(elbowR, 'rotation[z]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(wristR, 'rotation[x]', waveLeftTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
  ];
  appendOpenHand(waveLeftTracks, handRigL, waveLeftTimes);
  appendOpenHand(waveLeftTracks, handRigR, waveLeftTimes);
  appendEyeLook(waveLeftTracks, waveLeftTimes, [0, -0.003, -0.005, -0.003, -0.005, -0.003, -0.001, 0], [0, 0.001, 0.002, 0.001, 0.002, 0.001, 0, 0]);

  const waveRightTimes = [0, 0.18, 0.38, 0.58, 0.78, 0.98, 1.18, 1.40];
  const waveRightTracks: THREE.KeyframeTrack[] = [
    track(motionRoot, 'position[y]', waveRightTimes, [0, 0.006, 0.014, 0.010, 0.014, 0.010, 0.006, 0]),
    track(chest, 'rotation[y]', waveRightTimes, [0, -0.025, -0.055, -0.025, -0.055, -0.025, -0.012, 0]),
    track(head, 'rotation[y]', waveRightTimes, [0, 0.04, 0.08, 0.04, 0.08, 0.04, 0.02, 0]),
    track(head, 'rotation[z]', waveRightTimes, [0, 0.015, 0.03, 0.015, 0.03, 0.015, 0, 0]),
    track(armAnchorR, 'rotation[x]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armAnchorR, 'rotation[y]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armAnchorR, 'rotation[z]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armR, 'rotation[x]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armR, 'rotation[y]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armR, 'rotation[z]', waveRightTimes, [0, 0.90, 1.46, 1.08, 1.48, 1.10, 0.88, 0]),
    track(armTwistR, 'rotation[x]', waveRightTimes, [0, 1.20, 1.52, 1.52, 1.52, 1.52, 1.20, 0]),
    track(armTwistR, 'rotation[y]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armTwistR, 'rotation[z]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(elbowR, 'rotation[x]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(elbowR, 'rotation[y]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(elbowR, 'rotation[z]', waveRightTimes, [0.10, 0, 0, 0, 0, 0, 0, 0.10]),
    track(wristR, 'rotation[x]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(wristR, 'rotation[y]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(wristR, 'rotation[z]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armAnchorL, 'rotation[x]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armAnchorL, 'rotation[y]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armAnchorL, 'rotation[z]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armL, 'rotation[x]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armL, 'rotation[y]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(armL, 'rotation[z]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(elbowL, 'rotation[z]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
    track(wristL, 'rotation[x]', waveRightTimes, [0, 0, 0, 0, 0, 0, 0, 0]),
  ];
  appendOpenHand(waveRightTracks, handRigL, waveRightTimes);
  appendOpenHand(waveRightTracks, handRigR, waveRightTimes);
  appendEyeLook(waveRightTracks, waveRightTimes, [0, 0.003, 0.005, 0.003, 0.005, 0.003, 0.001, 0], [0, 0.001, 0.002, 0.001, 0.002, 0.001, 0, 0]);

  const roundhouseTimes = [0, 0.16, 0.36, 0.56, 0.82, 1.16];
  const roundhouseTracks: THREE.KeyframeTrack[] = [
    track(motionRoot, 'position[y]', roundhouseTimes, [0, -0.04, 0.08, 0.15, 0.03, 0]),
    track(pelvis, 'rotation[y]', roundhouseTimes, [-0.08, 0.08, 0.42, 0.68, 0.18, -0.08]),
    track(pelvis, 'rotation[z]', roundhouseTimes, [0.025, 0.08, 0.20, 0.24, 0.08, 0.025]),
    track(spine, 'rotation[z]', roundhouseTimes, [-0.025, -0.08, -0.18, -0.24, -0.08, -0.025]),
    track(chest, 'rotation[y]', roundhouseTimes, [0.08, -0.10, -0.34, -0.48, -0.10, 0.08]),
    track(head, 'rotation[y]', roundhouseTimes, [-0.05, 0.12, 0.34, 0.44, 0.10, -0.05]),
    track(armL, 'rotation[y]', roundhouseTimes, [1.76, 1.70, 1.58, 1.50, 1.65, 1.76]),
    track(armR, 'rotation[y]', roundhouseTimes, [-1.76, -1.70, -1.58, -1.50, -1.65, -1.76]),
    track(armL, 'rotation[z]', roundhouseTimes, [0.12, 0.18, 0.24, 0.28, 0.18, 0.12]),
    track(armR, 'rotation[z]', roundhouseTimes, [-0.12, -0.18, -0.24, -0.28, -0.18, -0.12]),
    track(elbowL, 'rotation[z]', roundhouseTimes, [-2.50, -2.46, -2.40, -2.36, -2.44, -2.50]),
    track(elbowR, 'rotation[z]', roundhouseTimes, [2.50, 2.46, 2.40, 2.36, 2.44, 2.50]),
    track(wristL, 'rotation[x]', roundhouseTimes, [0.55, 0.57, 0.60, 0.62, 0.57, 0.55]),
    track(wristR, 'rotation[x]', roundhouseTimes, [0.55, 0.57, 0.60, 0.62, 0.57, 0.55]),
    track(wristL, 'rotation[y]', roundhouseTimes, [0.42, 0.40, 0.38, 0.36, 0.40, 0.42]),
    track(wristR, 'rotation[y]', roundhouseTimes, [-0.42, -0.40, -0.38, -0.36, -0.40, -0.42]),
    track(legL, 'rotation[x]', roundhouseTimes, [-0.12, -0.08, 0.02, 0.08, -0.04, -0.12]),
    track(kneeL, 'rotation[x]', roundhouseTimes, [0.18, 0.28, 0.38, 0.32, 0.22, 0.18]),
    track(legR, 'rotation[x]', roundhouseTimes, [0.12, 0.28, -0.72, -1.36, -0.48, 0.12]),
    track(legR, 'rotation[z]', roundhouseTimes, [0.055, 0.12, 0.34, 0.42, 0.14, 0.055]),
    track(kneeR, 'rotation[x]', roundhouseTimes, [0.18, 0.88, 0.76, 0.10, 0.42, 0.18]),
    track(footRigR.foot, 'rotation[x]', roundhouseTimes, [-0.02, 0.28, -0.12, -0.30, 0.12, -0.02]),
  ];
  appendOpenHand(roundhouseTracks, handRigL, roundhouseTimes);
  appendOpenHand(roundhouseTracks, handRigR, roundhouseTimes);
  appendToeCurl(roundhouseTracks, footRigL, roundhouseTimes, [0.18, 0.30, 0.40, 0.44, 0.28, 0.18]);
  appendToeCurl(roundhouseTracks, footRigR, roundhouseTimes, [0.18, 0.10, 0.04, 0.02, 0.12, 0.18]);
  appendEyeLook(roundhouseTracks, roundhouseTimes, [-0.002, 0.002, 0.005, 0.006, 0.002, -0.002], [0, 0.001, 0.003, 0.003, 0.001, 0]);

  const dodgeTimes = [0, 0.14, 0.32, 0.52, 0.78];
  const dodgeTracks: THREE.KeyframeTrack[] = [
    track(motionRoot, 'position[y]', dodgeTimes, [0, -0.14, -0.34, -0.16, 0]),
    track(pelvis, 'rotation[y]', dodgeTimes, [-0.08, -0.18, -0.32, -0.18, -0.08]),
    track(pelvis, 'rotation[z]', dodgeTimes, [0.025, 0.12, 0.24, 0.12, 0.025]),
    track(spine, 'rotation[x]', dodgeTimes, [0.055, 0.16, 0.30, 0.16, 0.055]),
    track(spine, 'rotation[z]', dodgeTimes, [-0.025, -0.18, -0.34, -0.18, -0.025]),
    track(chest, 'rotation[z]', dodgeTimes, [0, -0.12, -0.24, -0.12, 0]),
    track(head, 'rotation[x]', dodgeTimes, [-0.025, 0.08, 0.18, 0.08, -0.025]),
    track(head, 'rotation[z]', dodgeTimes, [0, 0.14, 0.28, 0.14, 0]),
    track(armL, 'rotation[y]', dodgeTimes, [1.76, 1.78, 1.82, 1.78, 1.76]),
    track(armR, 'rotation[y]', dodgeTimes, [-1.76, -1.78, -1.82, -1.78, -1.76]),
    track(armL, 'rotation[z]', dodgeTimes, [0.12, 0.16, 0.22, 0.16, 0.12]),
    track(armR, 'rotation[z]', dodgeTimes, [-0.12, -0.16, -0.22, -0.16, -0.12]),
    track(elbowL, 'rotation[z]', dodgeTimes, [-2.50, -2.54, -2.60, -2.54, -2.50]),
    track(elbowR, 'rotation[z]', dodgeTimes, [2.50, 2.54, 2.60, 2.54, 2.50]),
    track(wristL, 'rotation[x]', dodgeTimes, [0.55, 0.58, 0.64, 0.58, 0.55]),
    track(wristR, 'rotation[x]', dodgeTimes, [0.55, 0.58, 0.64, 0.58, 0.55]),
    track(wristL, 'rotation[y]', dodgeTimes, [0.42, 0.44, 0.48, 0.44, 0.42]),
    track(wristR, 'rotation[y]', dodgeTimes, [-0.42, -0.44, -0.48, -0.44, -0.42]),
    track(legL, 'rotation[z]', dodgeTimes, [-0.055, -0.12, -0.20, -0.12, -0.055]),
    track(legR, 'rotation[z]', dodgeTimes, [0.055, 0.12, 0.20, 0.12, 0.055]),
    track(kneeL, 'rotation[x]', dodgeTimes, [0.18, 0.48, 0.82, 0.48, 0.18]),
    track(kneeR, 'rotation[x]', dodgeTimes, [0.18, 0.48, 0.82, 0.48, 0.18]),
    track(footRigL.foot, 'rotation[x]', dodgeTimes, [0.02, 0.08, 0.16, 0.08, 0.02]),
    track(footRigR.foot, 'rotation[x]', dodgeTimes, [-0.02, 0.04, 0.10, 0.04, -0.02]),
  ];
  appendOpenHand(dodgeTracks, handRigL, dodgeTimes);
  appendOpenHand(dodgeTracks, handRigR, dodgeTimes);
  appendToeCurl(dodgeTracks, footRigL, dodgeTimes, [0.18, 0.30, 0.46, 0.30, 0.18]);
  appendToeCurl(dodgeTracks, footRigR, dodgeTimes, [0.18, 0.30, 0.46, 0.30, 0.18]);
  appendEyeLook(dodgeTracks, dodgeTimes, [-0.002, 0.002, 0.005, 0.002, -0.002], [0, -0.002, -0.004, -0.002, 0]);

  const clips = {
    idle: new THREE.AnimationClip('Idle', 1, idleTracks),
    run: new THREE.AnimationClip('Run', 0.8, runTracks),
    jump: new THREE.AnimationClip('Jump', 1.08, jumpTracks),
    kick: new THREE.AnimationClip('Kick', 1.08, kickTracks),
    't-pose-breathing': new THREE.AnimationClip('T-Pose Breathing', 1.2, tPoseBreathingTracks),
    'fan-salute': new THREE.AnimationClip('Fan Salute', 1.6, saluteTracks),
    'wave-left': new THREE.AnimationClip('Wave Left', 1.40, waveLeftTracks),
    'wave-right': new THREE.AnimationClip('Wave Right', 1.40, waveRightTracks),
    roundhouse: new THREE.AnimationClip('Roundhouse', 1.16, roundhouseTracks),
    dodge: new THREE.AnimationClip('Dodge', 0.78, dodgeTracks),
  };
  const mixer = new THREE.AnimationMixer(root);
  const actions = {
    idle: mixer.clipAction(clips.idle),
    run: mixer.clipAction(clips.run),
    jump: mixer.clipAction(clips.jump),
    kick: mixer.clipAction(clips.kick),
    't-pose-breathing': mixer.clipAction(clips['t-pose-breathing']),
    'fan-salute': mixer.clipAction(clips['fan-salute']),
    'wave-left': mixer.clipAction(clips['wave-left']),
    'wave-right': mixer.clipAction(clips['wave-right']),
    roundhouse: mixer.clipAction(clips.roundhouse),
    dodge: mixer.clipAction(clips.dodge),
  };
  actions.idle.setLoop(THREE.LoopRepeat, Infinity).play();
  actions.run.setLoop(THREE.LoopRepeat, Infinity);
  actions['t-pose-breathing'].setLoop(THREE.LoopRepeat, Infinity);
  actions['fan-salute'].setLoop(THREE.LoopRepeat, Infinity);
  const oneShotNames = ['jump', 'kick', 'wave-left', 'wave-right', 'roundhouse', 'dodge'] as const;
  for (const name of oneShotNames) {
    actions[name].setLoop(THREE.LoopOnce, 1).setEffectiveTimeScale(1);
    actions[name].clampWhenFinished = true;
  }

  type ActiveName = 'idle' | LowPolyHumanoidAnimationName;
  const listeners = new Set<(active: ActiveName) => void>();
  let active: ActiveName = 'idle';
  let currentAction = actions.idle;
  let oneShotRemaining = 0;
  let oneShotReturn: ActiveName = 'idle';
  let clothLagL = 0;
  let clothLagR = 0;
  let clothVelocityL = 0;
  let clothVelocityR = 0;
  let previousHipL = 0;
  let previousHipR = 0;
  const notify = (): void => listeners.forEach((listener) => listener(active));
  const transition = (nextName: ActiveName, duration = 0.16): void => {
    const next = actions[nextName];
    if (next === currentAction && nextName === active) return;
    next.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).play();
    currentAction.crossFadeTo(next, duration, false);
    currentAction = next;
    active = nextName;
    const isOneShot = (oneShotNames as readonly string[]).includes(nextName);
    oneShotRemaining = isOneShot ? clips[nextName].duration : 0;
    oneShotReturn = ['wave-left', 'wave-right'].includes(nextName)
      ? 't-pose-breathing'
      : ['roundhouse', 'dodge'].includes(nextName)
        ? 'fan-salute'
      : 'idle';
    notify();
  };

  const controller: LowPolyHumanoidAnimationController = {
    actions: [
      { id: 'run', label: 'Run', loop: true },
      { id: 'jump', label: 'Jump', loop: false },
      { id: 'kick', label: 'Kick', loop: false },
      { id: 't-pose-breathing', label: 'T-Pose Breathing', loop: true },
      { id: 'fan-salute', label: 'Fan Salute', loop: true },
      { id: 'wave-left', label: 'Wave Left', loop: false },
      { id: 'wave-right', label: 'Wave Right', loop: false },
      { id: 'roundhouse', label: 'Roundhouse', loop: false },
      { id: 'dodge', label: 'Dodge', loop: false },
    ],
    get active() { return active; },
    play: (name) => transition(name),
    stop: () => transition('idle', 0.12),
    update: (dt) => {
      const safeDt = Math.min(0.05, Math.max(0, dt));
      mixer.update(safeDt);
      if (safeDt > 0) {
        // Small spring-damper counter-motion. The main shorts movement comes from the shared hip
        // weights above; this term only gives the hem the same delayed settle as the hair mass.
        const updateCloth = (
          hip: THREE.Bone,
          cloth: THREE.Bone,
          lag: number,
          velocity: number,
          previousHip: number,
        ): [number, number, number] => {
          const angularVelocity = (hip.rotation.x - previousHip) / safeDt;
          const target = Math.max(-0.09, Math.min(0.09,
            -hip.rotation.x * 0.055 - angularVelocity * 0.008));
          velocity += (58 * (target - lag) - 11 * velocity) * safeDt;
          lag = Math.max(-0.10, Math.min(0.10, lag + velocity * safeDt));
          cloth.rotation.x = lag;
          return [lag, velocity, hip.rotation.x];
        };
        [clothLagL, clothVelocityL, previousHipL] = updateCloth(
          legL, clothL, clothLagL, clothVelocityL, previousHipL,
        );
        [clothLagR, clothVelocityR, previousHipR] = updateCloth(
          legR, clothR, clothLagR, clothVelocityR, previousHipR,
        );
      }
      if (oneShotRemaining > 0) {
        oneShotRemaining -= safeDt;
        if (oneShotRemaining <= 0) transition(oneShotReturn, 0.16);
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(active);
      return () => listeners.delete(listener);
    },
  };
  runtime.animationController = controller;
  root.userData.animationClips = Object.values(clips);
  const previousTick = root.userData.tick as ((dt: number, elapsed: number) => void) | undefined;
  root.userData.tick = (dt: number, elapsed: number): void => {
    previousTick?.(dt, elapsed);
    controller.update(dt);
  };
  return controller;
}

export function createLowPolyHumanoidModel(
  options: LowPolyHumanoidOptions = {},
): THREE.Group {
  const root = new THREE.Group();
  root.name = 'LowPolyHumanoid__root';

  const clayCapture = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('clay') === '1';
  const clayColor = 0xc7c7c7;
  const skin = polyMaterial(clayCapture ? clayColor : palette.skin, 0.92);
  const skinLight = polyMaterial(clayCapture ? clayColor : palette.skinLight, 0.90);
  const skinShadow = polyMaterial(clayCapture ? clayColor : palette.skinShadow, 0.94);
  const skinMid = polyMaterial(clayCapture ? clayColor : 0xae947c, 0.74);
  // Roughness is 1.0 rather than 0.82 because `roughnessMap` MULTIPLIES it: the texture carries the
  // 0.35-0.85 range directly, and leaving 0.82 in place would scale that down to 0.29-0.70 and mute
  // the flow it exists to show. No map under a clay capture — clay exists to strip shading cues.
  // HAIR IS THE ONE MATERIAL ON THIS MODEL THAT IS PHYSICAL, NOT STANDARD.
  //
  // The complaint this answers is "it reads as one solid mass, like a helmet", and region IoU is
  // structurally incapable of seeing it: IoU compares OUTLINES, so a helmet and a head of hair with
  // the same outline score identically. Rounds of optimising that number could never have addressed
  // this, which is why the score kept rising while the render kept reading as a helmet.
  //
  // What separates hair from moulded plastic is a tangent-aligned highlight and a sheen, and both are
  // `MeshPhysicalMaterial` features present in r169. `anisotropy` needs a tangent frame:
  // `normal_fragment_begin.glsl.js:22` takes `USE_TANGENT` or falls back to a UV-derived frame, and
  // `BufferGeometry.computeTangents()` returns early unless index, position, normal AND uv all exist.
  // The shell has had UVs since the flow map went in, so the frame is now reachable.
  //
  // TWO materials, because the tufts are `sectionedLoft` output and carry no UVs. Declaring
  // `anisotropy > 0` on geometry without a tangent frame samples a degenerate TBN, so they get the
  // same physical material minus that one term rather than a silently wrong highlight.
  // `anisotropyRotation` is a quarter turn: `computeTangents` aligns the tangent with +U, and this
  // shell's U runs ACROSS the strand while V runs along it, so the grain is the bitangent.
  const hairPhysical = (anisotropic: boolean): THREE.MeshPhysicalMaterial => {
    const m = new THREE.MeshPhysicalMaterial({
      color: clayCapture ? clayColor : palette.hair,
      // 1.0, and the MAP carries the real range. `roughnessMap` MULTIPLIES this value, so setting
      // 0.30 here against a map of 0.55-0.95 landed the surface at 0.165-0.285 — glossier than the
      // 0.25-0.45 it was meant to be, and glossy enough that one large facet caught a specular patch
      // measuring (90,71,55) against neighbouring hair at (43,39,36). That patch read as a bald spot
      // and survived two wrong guesses (vertex gradient, then sheen) before being sampled.
      roughness: clayCapture ? 0.82 : 1.0,
      metalness: 0,
      // flatShading TRUE per the four-angle analysis: large planes, hard edges, polygon silhouette.
      // I had this false and claimed it was what removed the helmet reading - an attribution I never
      // A/B tested, made while changing five things at once. Following the spec instead of my guess.
      // flatShading TRUE, and this time chosen with a metric that can see it. The earlier A/B picked
      // `true` on region IoU, 8.92 against 8.87 — an OUTLINE metric, which flat shading does not
      // affect at all, so that 0.05 was noise and the decision was right by luck. Measured on the
      // tonal distribution the difference is enormous: range 49.7 flat against 13.3 smooth, p90 59.0
      // against 21.7. Smooth normals over a coarse mesh leave no facet squarely facing the key, so
      // the highlights vanish; the reference's bright tail needs facets with definite orientations.
      flatShading: true,
      side: THREE.DoubleSide,
    });
    if (clayCapture) return m;
    m.roughnessMap = strandRoughnessTexture();
    m.normalMap = strandNormalTexture();
    m.normalScale = new THREE.Vector2(0.9, 0.9);
    // Clearcoat 0.20 on a thin tube reads as METAL BANDING: the strands rendered as bright wires
    // standing over the mass. A stylised hair clearcoat has to stay far below the value that suits a
    // flat sheet, because a cylinder presents a grazing angle to the light along its whole length.
    // Darkening the albedo by 0.677 was predicted to take luma 40.9 -> 27.7 and delivered 37.1, so
    // most of the excess does NOT scale with albedo. For a dielectric the specular term depends on
    // F0, not on base colour, which is exactly the part that would survive darkening — so the knob is
    // `specularIntensity`, not another shade of brown.
    // 0.70, interpolated from two measurements rather than guessed: specularIntensity 1.0 rendered
    // the hair at luma 37.1 and 0.22 at 12.2, against the baseline's 27.7. That is 31.9 luma per unit,
    // so the target sits at 0.706.
    // 0.28 with the albedo at 0x241c17. Chosen on total relative error across four percentiles, not
    // on one number: this pair scores 0.73 against 1.44 for the specular-0.70 alternative, and it is
    // the only setting that matches the reference's BULK — p75 22.3 against 23.0, p50 17.0 against
    // 15.3. What it does not reach is the bright tail, p90 48.7 against 81.0.
    m.specularIntensity = 0.28;
    m.clearcoat = 0.06;
    m.clearcoatRoughness = 0.55;
    // 0.12, not 0.35. Sheen is a broad view-dependent wrap, and on a low-poly mass each large facet
    // caught it as one patch — a warm brown blotch across the crown in `sheenColor`'s own hue, which
    // read as a bald spot. The reference's light comes from thin striations, so the broad term has to
    // be small and the fine one has to carry it.
    m.sheen = 0.12;
    m.sheenColor = new THREE.Color(0x6b5647);
    m.sheenRoughness = 0.55;
    if (anisotropic) {
      m.anisotropy = 0.6;
      m.anisotropyRotation = Math.PI / 2;
    }
    return m;
  };
  const hair = hairPhysical(true);
  // Cloth is smooth-shaded where skin is faceted. The shell is a quad grid whose vertices each march
  // out to their own clearance, so its quads are not planar; under flat shading each quad's two triangles
  // take different normals and the garment reads as diagonal static rather than as fabric. Smooth normals
  // let the FOLDS carry the shape instead of the triangulation.
  const shorts = new THREE.MeshStandardMaterial({
    color: clayCapture ? clayColor : palette.shorts,
    roughness: 0.82,
    metalness: 0,
    flatShading: false,
    side: THREE.DoubleSide,
  });

  const runtime: LowPolyHumanoidRuntime = {
    nodes: {},
    meshes: {},
    sockets: {},
    colliders: {},
    destructionGroups: { body: [] },
  };

  markPart(root, 'root', '', 'root', runtime);

  // The body is kept close to the observed six-head stylized ratio. The GLB
  // baseline exposes a narrower waist, a deeper ribcage and a lower T-pose
  // band than the earlier blockout, so these rings are deliberately measured
  // against the admitted front/profile captures rather than a generic human.
  // THE PELVIS ELLIPSOID IS GONE. It was a skin-shadow blob 0.06 x 0.08 x 0.06 parked at [0, 2.65, 0.1]
  // — inside the crotch — and its own comment said what it was for: "keep the inferred pelvis tucked
  // inside the shorts so orbit views do not expose a large floating hip volume through the two leg
  // openings". It was a patch over the isosurface garment's U-shaped hole, and that garment has been
  // deleted twice over since.
  //
  // It is also what the occlusion gate was catching. Its bounds, y 2.787..2.963 and x -0.061..0.061,
  // are the two slivers beside the crotch slit in the front pass and the rounded blob under the gusset
  // in the underside pass, to the pixel. Four rounds of clearance, subdivision, push caps and midpoint
  // relaxation could not clear it, because it is not part of `bodyField` — `hug` measures against the
  // field, and this mesh was never in it. The measurement was sound and the thing being measured was
  // the wrong object.
  //
  // The part id survives as a bare group so the parts hierarchy keeps its shape; only the geometry goes.
  addMesh(
    root,
    root,
    'torso',
    facetedBody(
      'Torso',
      [
        [2.94, 0.50, 0.28],
        [3.24, 0.50, 0.30],
        [3.56, 0.52, 0.38],
        [3.9, 0.59, 0.39],
        [4.18, 0.70, 0.43],
        [4.48, 0.72, 0.44],
        [4.86, 0.64, 0.36],
      ],
      [skin, skinMid, skinLight],
      8,
      true,
      true,
      [0, -0.05, -0.02, -0.01, -0.02, 0, 0],
      (ring, segment, triangle) => {
        const frontSegment = segment <= 3;
        const ribBands = ring >= 2 && ring <= 5;
        const sparseFacet = (ring + segment + triangle) % 3 === 0;
        const centralChestFacet = (segment === 1 || segment === 2) && (ring + triangle) % 2 === 0;
        if (frontSegment && ribBands && centralChestFacet) return 2;
        return frontSegment && ribBands && sparseFacet ? 1 : 0;
      },
    ),
    'root',
    'torso',
    runtime,
    options,
  );
  runtime.meshes['torso'].position.z = -0.11;
  // The pectoral and abdominal planes are triangulated directly against the
  // torso front. Their shared vertices form one continuous anatomical rhythm
  // instead of the previous pair of floating diamond slabs.
  addMesh(
    root,
    root,
    'chest',
    facetedPatch(
      'Embedded pectoral shell',
      [
        [-0.60, 4.58, 0.28], [0, 4.61, 0.46], [0.60, 4.58, 0.28],
        [-0.56, 4.28, 0.29], [0, 4.20, 0.44], [0.56, 4.28, 0.29],
        [0, 4.47, 0.48],
      ],
      [
        [0, 1, 6, 0], [1, 2, 6, 0], [0, 6, 3, 0],
        [3, 6, 4, 0], [6, 5, 4, 0], [2, 5, 6, 0],
      ],
      [skin, skinMid],
    ),
    'torso',
    'chest',
    runtime,
    options,
  );
  runtime.meshes['chest'].position.z = -0.07;
  runtime.meshes['chest'].renderOrder = 0;
  for (const mat of Array.isArray(runtime.meshes['chest'].material) ? runtime.meshes['chest'].material : [runtime.meshes['chest'].material]) {
    mat.depthTest = true;
    mat.depthWrite = true;
  }
  addMesh(
    root,
    root,
    'abdomen',
    facetedPatch(
      'Three embedded abdominal bands',
      [
        [-0.42, 4.16, 0.25], [0, 4.19, 0.40], [0.42, 4.16, 0.25],
        [-0.39, 3.94, 0.24], [0, 3.96, 0.38], [0.39, 3.94, 0.24],
        [-0.37, 3.82, 0.23], [0, 3.84, 0.37], [0.37, 3.82, 0.23],
        [-0.35, 3.68, 0.22], [0, 3.70, 0.36], [0.35, 3.68, 0.22],
        [-0.33, 3.54, 0.21], [0, 3.56, 0.35], [0.33, 3.54, 0.21],
        [-0.30, 3.40, 0.20], [0, 3.42, 0.34], [0.30, 3.40, 0.20],
      ],
      [
        [0, 1, 4, 0], [0, 4, 3, 1], [1, 2, 5, 0], [1, 5, 4, 1],
        [6, 7, 10, 0], [6, 10, 9, 1], [7, 8, 11, 0], [7, 11, 10, 1],
        [12, 13, 16, 0], [12, 16, 15, 1], [13, 14, 17, 0], [13, 17, 16, 1],
      ],
      [skin, skinMid],
    ),
    'torso',
    'abdomen',
    runtime,
    options,
  );
  runtime.meshes['abdomen'].position.z = -0.07;
  runtime.meshes['abdomen'].renderOrder = 0;
  for (const mat of Array.isArray(runtime.meshes['abdomen'].material) ? runtime.meshes['abdomen'].material : [runtime.meshes['abdomen'].material]) {
    mat.depthTest = true;
    mat.depthWrite = true;
  }
  // Keep the semantic chest/abdomen nodes for the action-ready runtime, but
  // render their facets from the torso mesh above so no detached side plates
  // can distort the profile silhouette.
  runtime.meshes['chest'].visible = false;
  runtime.meshes['abdomen'].visible = false;
  runtime.meshes['chest'].userData.integratedInto = 'torso';
  runtime.meshes['abdomen'].userData.integratedInto = 'torso';

  // Arms: long, almost horizontal, tapered segments dominate the reference silhouette.
  addMesh(root, root, 'shoulders', ellipsoid('Shoulder masses', [1.0, 0.16, 0.34], [0, 4.84, -0.24], skin, 1), 'torso', 'shoulders', runtime, options);
  addMesh(
    root,
    root,
    'upper-arm-l',
    profiledAxis(
      'Upper Arm L',
      [[-0.68, 4.84, 0.12, 0.22, 0.34], [-1.22, 4.83, 0.11, 0.20, 0.145], [-1.68, 4.82, 0.095, 0.17, 0.115]],
      skin,
    ),
    'shoulders',
    'arm',
    runtime,
    options,
  );
  addMesh(
    root,
    root,
    'upper-arm-r',
    profiledAxis(
      'Upper Arm R',
      [[0.68, 4.84, 0.12, 0.22, 0.34], [1.22, 4.83, 0.11, 0.20, 0.145], [1.68, 4.82, 0.095, 0.17, 0.115]],
      skin,
    ),
    'shoulders',
    'arm',
    runtime,
    options,
  );
  addMesh(
    root,
    root,
    'forearm-l',
    profiledAxis(
      'Forearm L',
      [[-1.58, 4.82, 0.105, 0.175, 0.11], [-2.24, 4.82, 0.095, 0.16, 0.09], [-2.78, 4.79, 0.075, 0.135, 0.075]],
      skinLight,
    ),
    'upper-arm-l',
    'arm',
    runtime,
    options,
  );
  addMesh(
    root,
    root,
    'forearm-r',
    profiledAxis(
      'Forearm R',
      [[1.58, 4.82, 0.105, 0.175, 0.11], [2.24, 4.82, 0.095, 0.16, 0.09], [2.78, 4.79, 0.075, 0.135, 0.075]],
      skinLight,
    ),
    'upper-arm-r',
    'arm',
    runtime,
    options,
  );
  addMesh(root, root, 'hand-l', ellipsoid('Hand L', [0.17, 0.065, 0.10], [-3.02, 4.79, 0], skin, 1), 'forearm-l', 'hand', runtime, options);
  addMesh(root, root, 'hand-r', ellipsoid('Hand R', [0.17, 0.065, 0.10], [3.02, 4.79, 0], skin, 1), 'forearm-r', 'hand', runtime, options);
  addMesh(root, root, 'thumb-l', taperedBetween('Thumb L', new THREE.Vector3(-3.0, 4.77, 0), new THREE.Vector3(-3.16, 4.65, 0.02), 0.06, 0.025, skin), 'hand-l', 'appendage', runtime, options);
  addMesh(root, root, 'thumb-r', taperedBetween('Thumb R', new THREE.Vector3(3.0, 4.77, 0), new THREE.Vector3(3.16, 4.65, 0.02), 0.06, 0.025, skin), 'hand-r', 'appendage', runtime, options);

  // Long legs use overlapping open-ended rings so the knee and ankle read as
  // one continuous faceted silhouette instead of separate floating cylinders.
  addMesh(root, root, 'thigh-l', facetedBody('Thigh L', [[1.24, 0.182, 0.207], [1.45, 0.193, 0.227], [1.72, 0.213, 0.237], [2.24, 0.243, 0.227]], skin, 8, false, false), 'root', 'leg', runtime, options);
  runtime.meshes['thigh-l'].position.x = -0.37;
  addMesh(root, root, 'thigh-r', facetedBody('Thigh R', [[1.24, 0.182, 0.207], [1.45, 0.193, 0.227], [1.72, 0.213, 0.237], [2.24, 0.243, 0.227]], skin, 8, false, false), 'root', 'leg', runtime, options);
  runtime.meshes['thigh-r'].position.x = 0.37;
  const kneeRings: Array<[number, number, number]> = [[1.02, 0.168, 0.175], [1.16, 0.179, 0.186], [1.34, 0.191, 0.205]];
  addMesh(root, root, 'knee-l', facetedBody('Continuous paired knee transitions', kneeRings, skin, 8, false, false), 'thigh-l', 'leg', runtime, options);
  runtime.meshes['knee-l'].position.x = -0.37;
  addMesh(root, root, 'knee-r', facetedBody('Knee transition R', kneeRings, skin, 8, false, false), 'thigh-r', 'leg', runtime, options);
  runtime.meshes['knee-r'].position.x = 0.37;
  addMesh(root, root, 'shin-l', facetedBody('Shin L', [[0.22, 0.086, 0.162], [0.42, 0.127, 0.174], [0.72, 0.179, 0.186], [0.98, 0.169, 0.206], [1.12, 0.148, 0.206]], skin, 8, false, false), 'knee-l', 'leg', runtime, options);
  runtime.meshes['shin-l'].position.x = -0.37;
  addMesh(root, root, 'shin-r', facetedBody('Shin R', [[0.22, 0.086, 0.162], [0.42, 0.127, 0.174], [0.72, 0.179, 0.186], [0.98, 0.169, 0.206], [1.12, 0.148, 0.206]], skin, 8, false, false), 'knee-r', 'leg', runtime, options);
  runtime.meshes['shin-r'].position.x = 0.37;
  addMesh(root, root, 'foot-l', footWedge('Foot L', -0.37, skinLight), 'shin-l', 'foot', runtime, options);
  addMesh(root, root, 'foot-r', footWedge('Foot R', 0.37, skinLight), 'shin-r', 'foot', runtime, options);
  for (const id of ['thigh-l', 'thigh-r', 'knee-l', 'knee-r', 'shin-l', 'shin-r']) {
    runtime.meshes[id].position.z = -0.12;
  }
  // The reference carries a small anterior knee swell. Keep the thigh and shin
  // depth baseline fixed and move only the continuous knee transitions forward.
  runtime.meshes['knee-l'].position.z = -0.08;
  runtime.meshes['knee-r'].position.z = -0.08;
  runtime.meshes['foot-l'].position.z = -0.03;
  runtime.meshes['foot-r'].position.z = -0.03;

  // One continuous skin surface replaces the shells above.
  //
  // The parts stay in the tree as semantic nodes — pivots, sockets, colliders and destruction
  // groups all still resolve, so the action-ready and part-coverage gates keep working on the
  // same component list. Only their MESHES stop rendering, exactly as `chest`/`abdomen` already
  // do. Deleting them would trade a silhouette fix for a rig regression.
  addMesh(
    root,
    root,
    'body',
    polygonizeField('Continuous body surface', bodyField, [-3.55, -0.06, -0.9], [3.55, 5.85, 0.9],
      [224, 144, 64], skin, insideTorsoShell),
    'root',
    'body',
    runtime,
    options,
  );
  for (const id of [
    'torso', 'neck', 'shoulders', 'hand-l', 'hand-r', 'foot-l', 'foot-r', 'thumb-l', 'thumb-r',
    'upper-arm-l', 'upper-arm-r', 'forearm-l', 'forearm-r',
    'thigh-l', 'thigh-r', 'knee-l', 'knee-r', 'shin-l', 'shin-r',
  ]) {
    const mesh = runtime.meshes[id];
    if (!mesh) continue;
    mesh.visible = false;
    mesh.userData.integratedInto = 'body';
  }

  // Neck, head, and face landmarks.
  // The profile silhouette put the neck a cell and a half in front of where the baseline has it
  // ("RR###MM" across the whole neck band: missing behind, extra in front), which is why the
  // neck/shoulder region scored 0.549 in profile against 0.83 from the front — a placement error,
  // not a shape one. Seating it back over the spine fixes both halves of that band at once.
  // THE NECK WAS SHALLOW, NOT NARROW. Measured against the reference at local y 5.22 it was 0.246 half-
  // wide against 0.230 — correct, even slightly over — and 0.277 half-DEEP against 0.342, short by 19%.
  // At 5.08 it was 0.266 against about 0.337, short by 21%. A neck that is the right width and a fifth
  // too thin reads as a flat plate from any three-quarter angle, which is what "the neck looks small and
  // narrow" was pointing at: the eye reads the volume, and the volume was missing in z.
  //
  // Ring z values are divided by the 0.924 that facetedBody's 22.5-degree vertex placement costs, so
  // 0.370 delivers 0.342.
  //
  // The LOWEST ring keeps 0.345 rather than joining the others at 0.40: it sits at the shoulder, not in
  // the neck, and deepening it took the band at local y 4.71 to +8.2% on z. Depth belongs to the column,
  // not to where the column meets the trapezius.
  //
  // THE TOP RING FLARES rather than tapering. At local y 5.22 the reference is 0.229 half-wide and
  // 0.343 half-deep — that band is the angle of the JAW, not the column of the neck, and the widest
  // thing in it was this lathe at 0.185 / 0.283. The band measured -19.7% and -17.4%.
  //
  // Widening the trunk's neck capsule did nothing, because this mesh is what occupies the band: the
  // capsule is inside it. A ring value is not the half-width either — facetedBody puts vertices at
  // 22.5 degrees, so the widest reaches 0.924 of the radius. 0.266 x 0.924 lands on 0.229.
  //
  // A straight capsule scored 10.1% missing AND 10.3% extra in the same profile band — the mark
  // of a wrong shape rather than a wrong size, which no amount of moving or scaling fixes. The
  // baseline's neck is not a column: it flares into the trapezius at the base and the column
  // itself sits back over the spine, rising slightly forward toward the skull. Rings with a
  // per-ring z offset reproduce both, where the capsule could reproduce neither.
  // HEAD AND NECK — ONE STATIONED SHELL, replacing two lathes.
  //
  // Both were `facetedBody`, a surface of revolution, so every section was a scaled n-gon centred on the
  // axis. That is why the jaw, the chin, the temple hollow and the cranial profile could never be built:
  // none of them is radially symmetric, and no amount of ring tuning changes that. It is also why the
  // two could only ever MEET — welded to 0.00000 and still reading as a join, because a weld pins
  // positions while normals, shading and topology stay separate.
  //
  // Eleven stations run from the lower neck to the crown as one indexed surface. `frontDepth` and
  // `backDepth` are separate per station, so the receding forehead and the full occiput come from the
  // SHAPE of each ring — the axis stays vertical at zCentre -0.185 all the way up, which is what
  // "straight with the neck" means. Shearing the axis to fake those is what made the side view a
  // parallelogram.
  //
  // `shape` is where the anatomy that a lathe cannot hold lives: at the jaw it pulls the gonion out at
  // ring indices 3-5 and 11-13 while drawing the chin in at 0-2, so the section stops being an oval
  // without the ring ceasing to be low-poly.
  // THE V IS AT THE JAW AND CHIN, WHICH IS WHERE THE MEASUREMENT PUT IT. Width per level in the front
  // view, normalised by the widest part of the cranium, model over baseline:
  //     cranium 1.046 · temple 1.039 · cheekbone 1.091 · cheek-low 1.064 · jaw 1.388 · chin 1.478
  // The upper face was only 4-9% wide; the jaw was 39% and the chin 48%. Narrowing everything evenly
  // would have shrunk a face that was nearly right at the top and still left it square at the bottom,
  // so the correction is graded: chin and jaw hard, cheek and cheekbone lightly, temple untouched.
  const HEAD_STATIONS: HeadStation[] = [
    // APPLIED VERBATIM FROM THE TUNER, in the order given and with every value as given.
    //
    // Two things about this table are worth stating rather than silently correcting, because both
    // were raised, and the values were reaffirmed:
    //
    // ORDER IS THE TUNER'S ARRAY ORDER, not ascending height. `buildHeadShell` stitches consecutive
    // entries, so with these heights the surface climbs to 5.96 at `neck-high`, drops to 5.069 at
    // `jaw-line`, and climbs again — the band between those two spans the whole head backwards.
    //
    // `neck-mid` carries negative depths. A negative depth puts the ring's front behind its back,
    // which turns that band inside out.
    //
    // `shape` is absent from jaw, cheek-low and temple because the dump these came from emitted only
    // numeric and string fields; the arrays were dropped before the values reached the clipboard.
    { name: 'neck-low', y: 5.358, halfWidth: 0.213, frontDepth: 0.04, backDepth: 0.258, zCentre: -0.014 },
    { name: 'neck-mid', y: 5.532, halfWidth: -0.006, frontDepth: -0.122, backDepth: -0.19, zCentre: -0.088 },
    { name: 'neck-high', y: 5.96, halfWidth: 0.21, frontDepth: 0.248, backDepth: 0.074, zCentre: 0.012 },
    { name: 'jaw-line', y: 5.059, halfWidth: 0.225, frontDepth: 0.226, backDepth: 0.245, zCentre: -0.098 },
    { name: 'skull-base', y: 5.602, halfWidth: 0.176, frontDepth: 0.554, backDepth: 0.096, zCentre: -0.112 },
    { name: 'jaw', y: 5.294, halfWidth: 0.132, frontDepth: 0.562, backDepth: 0.11, zCentre: -0.18 },
    { name: 'cheek-low', y: 5.482, halfWidth: 0.314, frontDepth: 0.498, backDepth: 0.173, zCentre: -0.058 },
    { name: 'cheekbone', y: 5.588, halfWidth: 0.354, frontDepth: 0.576, backDepth: 0.109, zCentre: -0.124 },
    { name: 'temple', y: 5.68, halfWidth: 0.394, frontDepth: 0.544, backDepth: 0.21, zCentre: -0.02 },
    { name: 'cranium', y: 5.86, halfWidth: 0.321, frontDepth: 0.527, backDepth: 0.211, zCentre: -0.01 },
    { name: 'upper-cranium', y: 5.962, halfWidth: 0.27, frontDepth: 0.536, backDepth: 0.088, zCentre: -0.098 },
    { name: 'crown', y: 6.012, halfWidth: 0.244, frontDepth: 0.346, backDepth: 0.128, zCentre: 0.002 },
  ];
  addMesh(root, root, 'head', buildHeadShell('Head and neck', HEAD_STATIONS, skin),
    'torso', 'head', runtime, options);
  const headPivot = runtime.nodes.head;
  if (!headPivot) throw new Error('head must be added before its facial features and hair');
  // The three lowest rings are the JAW. At y/H 0.16 — local 5.23, just under the chin — the
  // baseline's profile front edge sits at 0.0886 H while a straight lathe put this head's at 0.0436:
  // a 0.045 H overhang, and the largest single edge error left on the figure. The reference recedes
  // there because the jaw runs back toward the ear rather than dropping vertically.
  //
  // Both parts of the shape are load-bearing. Pulling the jaw back with zOffset alone (-0.28/-0.14)
  // fixed y/H 0.16 but pushed the BACK edge out 0.0193 H at the same row and moved the chin above
  // y/H 0.14, where the reference still projects — net loss. So the recess is cut by SHRINKING the
  // radius with only a small offset, which leaves the back edge within 0.001 of where it was, and
  // ring 5.36 is added to hold the chin point at the height the baseline puts it.
    // THE JAW HAD NO FRONT. At local y 5.22 the reference spans z -0.368..+0.316 and the model spanned
  // -0.352..+0.073: the BACK of the head matched to 0.016 and the front was missing 0.243. That is the
  // chin and the jaw, and it is where the -36% depth error in the figure's worst band came from. At the
  // cheek band above it the two already agree — ref front 0.409, model 0.395 — so nothing above y 5.36
  // changes.
  //
  // The four LOW rings gain depth: the bands at local y 5.48 and 5.22 measured -10.3% and -9.4% on z
  // while 5.73 and 5.99 were already +4.7% and +6.8%, so the deficit is the jaw and cheek, not the
  // skull. Only the rings below 5.60 change.
  //
  // The CHEEK rings widen too, and that is a correction to a compensation. Tucking the ears against the
  // skull took the band at local y 5.48 from -1.8% to -16.9% on width — which means the ears had been
  // carrying the head's width there, standing off a skull too narrow to reach the reference's 0.654 on
  // its own. A feature propping up a proportion is a bug in both.
  //
  // The ring value is not the half-width either. `facetedBody` places vertices at 22.5 degrees and every
  // 45 after, so none sits at 0 or 90 and the widest reaches cos(22.5) = 0.924 of the radius; the head
  // then carries HEAD_X = 0.916 on top. A ring of 0.352 delivers 0.298, which is why widening it from
  // 0.300 moved the band one and a half points instead of fifteen. 0.386 x 0.924 x 0.916 = 0.327, the
  // reference's own half-width there.
  //
  // The two lower rings gain depth and move FORWARD: the old z offsets of -0.11 and -0.078 pulled the
  // jaw back under the skull, which is what made the face read as a flat wedge with no chin in profile.
  // Face features, rebuilt against a 4x zoom crop of the baseline's head rather than the 64x64
  // luma grid the global gate uses — at that grid a nose is sub-pixel, so it is not scored badly,
  // it is absent (`grimoire/review/divine_eye_microscope.md`). The crop showed the previous face
  // was wrong in kind, not degree: a four-sided cone standing off the face as a pyramid where the
  // baseline has a soft wedge, no eyebrows at all where the baseline's are its strongest dark
  // shape, and ears as round pads floating clear of the skull at cheek height.
  //
  // Landmark heights come from the anatomy record: skull 5.08 (chin) to 5.99 (crown), height 0.91,
  // eyeLine 0.50 / noseBase 0.75 / mouthLine 0.85 measured down from the crown.
  //   eyeLine  = 5.99 - 0.50*0.91 = 5.535
  //   noseBase = 5.99 - 0.75*0.91 = 5.308
  //   mouth    = 5.99 - 0.85*0.91 = 5.216

  // Ears: flat plates lying along the skull, spanning eyeLine down to noseBase, not spheres on
  // stalks. Depth is small and negative-biased so they sit behind the cheek plane.
  for (const [id, side] of [['ear-l', -1], ['ear-r', 1]] as Array<[string, number]>) {
    addMesh(root, headPivot, id, ellipsoid(
      id === 'ear-l' ? 'Ear L' : 'Ear R',
      // 0.341, tracking the cheekbone. The ears carry ABSOLUTE coordinates, so narrowing the face for
      // the V-line left them where they were: at 0.368 against a cheekbone half-width that had gone
      // from 0.382 to 0.354, they stopped being tucked against the skull and started sticking out.
      // 0.368 * (0.354 / 0.382) puts them back in the same relation to the head they had before.
      [0.042, 0.094, 0.056], [side * 0.341, 5.586, -0.052], skin, 1,
    ), 'head', 'detail', runtime, options);
  }

  // Nose: a bridge that starts between the brows and widens to a small tip with two nostril
  // planes under it. Nine vertices, eight triangles — small polygons, which is the only way a
  // feature this size reads at all without a texture.
  // The six boundary vertices are the head shell's own ring points at the cheekbone and cheek-low
  // stations, indices 15/0/1 on each — not coordinates authored beside them. Only the tip is free.
  // ONE ANCHOR FOR EVERY FACIAL FEATURE.
  //
  // The nose already shared the head's ring points, but the eyes and the brows carried absolute
  // coordinates — so they floated at whatever depth they were authored at, and when the face was
  // narrowed for the V-line they stayed where they were while the skin moved out from under them.
  // That is what makes them read as separate stickers rather than as parts of one face, and it is the
  // same failure mode that has bitten the hair twice in this work.
  //
  // `faceSurface(y, x)` returns the point ON the head at that height and lateral position. Stations
  // are interpolated by height, then the front half of the ring is sampled to find the angle whose x
  // matches. Symmetry is automatic: the head's own shape arrays are symmetric, so +x and -x return
  // mirrored z without either being authored twice.
  // BRACKETING NEEDS HEIGHT ORDER; STITCHING NEEDS ARRAY ORDER. They are different requirements and
  // the table only satisfies one of them.
  //
  // `buildHeadShell` walks consecutive array entries, which is why the tuned table renders correctly
  // even though its heights are not ascending. This function does something else: it asks what the
  // surface is AT a height, and scanning the raw array for the first bracketing pair found `neck-low`
  // (5.37) and `neck-mid` (5.53) for a y of 5.5 — the collapsed station with negative depths. Every
  // facial feature anchored through here was therefore placed inside the head, which is why the face
  // rendered completely blank.
  //
  // Sorting a COPY for the lookup fixes that and touches no geometry: the mesh still stitches the
  // array in its authored order.
  // DEGENERATE STATIONS ARE EXCLUDED FROM THE LOOKUP, not just sorted into it.
  //
  // Sorting alone was not enough. `neck-mid` sits at y 5.53 — the middle of the FACE once heights are
  // ordered — and carries frontDepth -0.2 with halfWidth 0.002. Interpolating toward it gave a front
  // surface at z -0.077 where the head actually reaches 0.518, so the nose and mouth were placed a
  // quarter of a unit inside the skull and vanished.
  //
  // A station with no positive depth or no width does not describe a surface, so it cannot answer
  // "where is the face at this height". It still builds geometry — the mesh stitches array order and
  // its array neighbours are the other neck stations — it is simply not a valid sample for the lookup.
  const faceSurface = (y: number, x: number): [number, number, number] => {
    // Re-sort for every rebuild. The tuner can move station heights, so a copy sorted once when the
    // model was created becomes stale as soon as a y slider crosses another station.
    const sortedStations = [...HEAD_STATIONS]
      .filter((st) => st.frontDepth > 0.05 && st.halfWidth > 0.05)
      .sort((p2, q) => p2.y - q.y);
    let lo = sortedStations[0];
    let hi = sortedStations[sortedStations.length - 1];
    for (let k = 0; k + 1 < sortedStations.length; k += 1) {
      if (y >= sortedStations[k].y && y <= sortedStations[k + 1].y) {
        lo = sortedStations[k]; hi = sortedStations[k + 1]; break;
      }
    }
    const t = Math.abs(hi.y - lo.y) < 1e-9 ? 0 : (y - lo.y) / (hi.y - lo.y);
    const mix = (a: number, b: number): number => a + (b - a) * t;
    const shape = (i: number): number => mix(lo.shape ? lo.shape[i] : 1, hi.shape ? hi.shape[i] : 1);
    const hw = mix(lo.halfWidth, hi.halfWidth);
    const fd = mix(lo.frontDepth, hi.frontDepth);
    const zc = mix(lo.zCentre, hi.zCentre);
    // Sample the front quarter finely and take the angle whose x is closest to the one asked for.
    let best: [number, number, number] = [x, y, zc + fd];
    let bestErr = Infinity;
    for (let n = 0; n <= 96; n += 1) {
      const th = (n / 96) * Math.PI * 0.5;
      const idx = (th / (Math.PI * 2)) * HEAD_RING_POINTS;
      const k = shape(Math.round(idx) % HEAD_RING_POINTS);
      const px = Math.sin(th) * hw * k * Math.sign(x || 1);
      const err = Math.abs(px - x);
      if (err < bestErr) { bestErr = err; best = [x, y, zc + Math.cos(th) * fd * k]; }
    }
    return best;
  };

  // NOSE: THE ORIGINAL SIX-TRIANGLE FORM, SMALLER AND IN ONE PIECE.
  //
  // The seven-row version made it smoother and wrong: more facets on a face this low-poly read as a
  // separate object stuck to the front, and splitting it across two materials cut it into a light
  // upper half and a dark lower one, which is what broke it into pieces rather than reading as one
  // form. The shape it replaced was already close.
  //
  // So: six triangles from a single tip, as before — but with its base taken from `faceSurface` at
  // half the old width, so it is smaller, and drawn in ONE material so it stays a single mass.
  const NOSE_PARAMS = {
    name: 'nose',
    topY: 5.533,
    baseY: 5.46,
    topHalfWidth: 0,
    baseHalfWidth: 0.058,
    tipY: 5.446,
    tipOut: 0.072,
  };
  const buildNose = (): THREE.Mesh => {
    const rim: Array<[number, number, number]> = [
      faceSurface(NOSE_PARAMS.topY, -NOSE_PARAMS.topHalfWidth),
      faceSurface(NOSE_PARAMS.topY, 0),
      faceSurface(NOSE_PARAMS.topY, NOSE_PARAMS.topHalfWidth),
      faceSurface(NOSE_PARAMS.baseY, NOSE_PARAMS.baseHalfWidth),
      faceSurface(NOSE_PARAMS.baseY, 0),
      faceSurface(NOSE_PARAMS.baseY, -NOSE_PARAMS.baseHalfWidth),
    ];
    // The tip is the only free vertex, exactly as it was: everything else is on the skin, so the nose
    // cannot float off the face however the head changes.
    const tip: [number, number, number] = [
      0, NOSE_PARAMS.tipY, faceSurface(NOSE_PARAMS.tipY, 0)[2] + NOSE_PARAMS.tipOut,
    ];
    return facetedPatch('Nose', [...rim, tip], [
      [6, 0, 1, 0], [6, 1, 2, 0], [6, 2, 3, 0],
      [6, 3, 4, 0], [6, 4, 5, 0], [6, 5, 0, 0],
    ], [skinLight]);
  };
  addMesh(root, headPivot, 'nose', buildNose(), 'head', 'detail', runtime, options);

  // Mouth. The baseline's strongest interior dark band sits at y/H 0.141..0.147 spanning 0.32..0.70
  // of the head width; this face had nothing there at all, and the six-view IoU score cannot say so
  // — every facial feature is inside the silhouette, so a face with no mouth scores exactly as well
  // as one with lips. It is placed at local 5.40 rather than the baseline's own 5.29 because the
  // jaw recess cut at 5.10..5.28 means 5.29 is under the chin on THIS head, not on the face: the
  // chin here sits 0.015 H lower than the baseline's, so the mouth is set by proportion down the
  // face rather than by absolute height. Width is the measured 0.375 of head width.
  addMesh(root, headPivot, 'mouth', facetedPatch(
    'Mouth',
    // ANCHORED, NOT AUTHORED IN Z. These were absolute coordinates with z pinned near 0.42, which was
    // the face's depth on the head this replaced. On the retuned head that plane is inside the skull,
    // so the mouth disappeared along with the nose. Each point now takes its depth from the surface at
    // its own x and y, plus a small forward bias so the lips sit ON the face rather than in it.
    ([
      [-0.060, 5.392, 0.002], [0.060, 5.392, 0.002],        // 0,1 corners, tucked into the cheek
      [-0.026, 5.404, 0.008], [0.026, 5.404, 0.008],        // 2,3 upper lip peaks
      [0, 5.399, 0.010],                                    // 4 cupid's bow
      [-0.026, 5.379, 0.007], [0.026, 5.379, 0.007],        // 5,6 lower lip
      [0, 5.374, 0.004],                                    // 7 lower lip centre
    ] as Array<[number, number, number]>).map(([mx, my, out]) => {
      const q = faceSurface(my, mx);
      return [q[0], q[1], q[2] + out] as [number, number, number];
    }),
    [
      [0, 2, 4, 1], [4, 3, 1, 1],
      [0, 5, 7, 0], [7, 6, 1, 0],
    ],
    [skinLight, skinShadow],
  ), 'head', 'detail', runtime, options);

  // One symmetric parameter set drives both brows. The earlier implementation was accidentally
  // duplicated, leaving two meshes per side with one shared id; this builder creates exactly one per
  // side and reverses winding on the reflected side.
  const BROW_PARAMS = {
    name: 'brows',
    centerX: 0.196,
    baseY: 5.683,
    halfWidth: 0.074,
    innerThickness: 0.024,
    archLift: 0.006,
    archThickness: 0.022,
    outerLift: -0.004,
    outerThickness: 0.006,
    surfaceOut: 0.018,
  };
  const browMat = polyMaterial(clayCapture ? clayColor : 0x2b211a, 0.82);
  const buildBrow = (side: number, name: string): THREE.Mesh => {
    const innerX = BROW_PARAMS.centerX - BROW_PARAMS.halfWidth;
    const outerX = BROW_PARAMS.centerX + BROW_PARAMS.halfWidth;
    const points: Array<[number, number]> = [
      [innerX, BROW_PARAMS.baseY + BROW_PARAMS.innerThickness / 2],
      [innerX, BROW_PARAMS.baseY - BROW_PARAMS.innerThickness / 2],
      [BROW_PARAMS.centerX, BROW_PARAMS.baseY + BROW_PARAMS.archLift + BROW_PARAMS.archThickness / 2],
      [BROW_PARAMS.centerX, BROW_PARAMS.baseY + BROW_PARAMS.archLift - BROW_PARAMS.archThickness / 2],
      [outerX, BROW_PARAMS.baseY + BROW_PARAMS.outerLift + BROW_PARAMS.outerThickness / 2],
      [outerX, BROW_PARAMS.baseY + BROW_PARAMS.outerLift - BROW_PARAMS.outerThickness / 2],
    ];
    const verts: Array<[number, number, number]> = points.map(([px, py]) => {
      const q = faceSurface(py, side * px);
      return [q[0], q[1], q[2] + BROW_PARAMS.surfaceOut];
    });
    const frontTris: Array<[number, number, number, number]> = [
      [0, 1, 2, 0], [2, 1, 3, 0], [2, 3, 4, 0], [4, 3, 5, 0],
    ];
    const tris = side > 0
      ? frontTris
      : frontTris.map(([a, b, c, mat]) => [a, c, b, mat] as [number, number, number, number]);
    return facetedPatch(name, verts, tris, [browMat]);
  };
  addMesh(root, headPivot, 'brow-l', buildBrow(-1, 'Brow L'), 'head', 'detail', runtime, options);
  addMesh(root, headPivot, 'brow-r', buildBrow(1, 'Brow R'), 'head', 'detail', runtime, options);

  // EYES: ROUND, BLACK, AND KEPT VISIBLY BELOW THE BROWS.
  //
  // Their vertical placement is derived from the lowest lower edge of the current brow shape. This
  // keeps a real gap when the brows are tuned instead of leaving the eyes behind at an authored Y.
  // The centre is projected to the face and the low-poly sphere is moved slightly outward. Its depth
  // uses the forward-most skin sample under the whole eye, not only the centre: this head's abrupt
  // skull-base/temple transition otherwise lets the cheek occlude nearly the entire sphere. Projecting
  // every edge vertex independently was worse — it twisted the eye into a narrow black arc.
  const EYE_PARAMS = {
    name: 'eyes',
    radius: 0.026,
    browGap: 0.012,
    surfaceOut: 0.006,
  };
  const eyeMat = polyMaterial(clayCapture ? clayColor : 0x120f0d, 0.88);
  const buildEye = (side: number, name: string): THREE.Mesh => {
    const browLowerY = Math.min(
      BROW_PARAMS.baseY - BROW_PARAMS.innerThickness / 2,
      BROW_PARAMS.baseY + BROW_PARAMS.archLift - BROW_PARAMS.archThickness / 2,
      BROW_PARAMS.baseY + BROW_PARAMS.outerLift - BROW_PARAMS.outerThickness / 2,
    );
    const cx = side * BROW_PARAMS.centerX;
    const cy = browLowerY - EYE_PARAMS.browGap - EYE_PARAMS.radius;
    const centre = faceSurface(cy, cx);
    let surfaceZ = centre[2];
    for (let i = 0; i < 12; i += 1) {
      const th = (i / 12) * Math.PI * 2;
      const q = faceSurface(
        cy + Math.sin(th) * EYE_PARAMS.radius,
        cx + Math.cos(th) * EYE_PARAMS.radius,
      );
      surfaceZ = Math.max(surfaceZ, q[2]);
    }
    const geometry = new THREE.SphereGeometry(EYE_PARAMS.radius, 12, 8);
    // Bake placement into the geometry so the tuner's geometry-only swap also moves the eye when a
    // brow parameter changes; mesh-level head shifts remain independent and do not get reset.
    geometry.translate(centre[0], centre[1], surfaceZ + EYE_PARAMS.surfaceOut);
    geometry.computeVertexNormals();
    const eye = new THREE.Mesh(geometry, eyeMat);
    eye.name = name;
    eye.castShadow = true;
    eye.receiveShadow = true;
    return eye;
  };
  addMesh(root, headPivot, 'eye-l', buildEye(-1, 'Eye L'), 'head', 'detail', runtime, options);
  addMesh(root, headPivot, 'eye-r', buildEye(1, 'Eye R'), 'head', 'detail', runtime, options);


  // Mouth: an upper and a lower lip with a shadowed seam between, not one slot. The baseline's
  // mouth is closed and slightly upturned, which is carried by the outer vertices sitting higher
  // than the centre.

  // A low, faceted cap anchors five pointed locks. The locks sweep
  // asymmetrically across the forehead and terminate in the sharp side tips
  // visible in the supplied front reference.
  // HAIR: a scalp cap plus one shaped mass, terminated at an authored boundary.
  //
  // An earlier generation of this section described a cap plus crown, fringe, three locks, two temple
  // masses, a spike and a nape mass. None of them exist: eight kinds of added detail geometry were
  // built and measured over this work and every one was removed, because the four-view reference has
  // no lock separation in its silhouette from any angle. What it has is a hard angular boundary and a
  // fine flow striation, and those are what `buildHairMass` and the flow normal map provide.
  //
  // What DOES carry over from that generation, because it was structural rather than stylistic:
  // `facetedBody` is a surface of revolution, so an asymmetric hairline is not expressible in it at
  // all. That is why the head and the hair are both stationed shells.
  //
  // Two meshes:
  //   hair-cap    thin, derived from the skull's own stations, its only job being that no skin shows.
  //               It must never be on the silhouette, which is what lets the mass be shaped freely.
  //   hair-mass   the silhouette, with its own per-column boundary and its own column resolution.
  // HUG THE SKULL. Measured: hair area over head area in the FRONT view is 0.418 here against the
  // reference's 0.306, so the mass carries 37% more than it should; in profile 0.631 against 0.575,
  // only 10% over. The excess is therefore mostly LATERAL, which is why `w` comes down by about 45%
  // and the depths by about 25%.
  //
  // FLOOR ON `w`, COMPUTED NOT GUESSED. The skull is a 16-point ring, so the largest gap between its
  // chord and the true curve is r(1 - cos(PI/16)) = r * 0.0192, about 0.0073 at r 0.38. The hair
  // samples the same rings at 48 columns, so anywhere its clearance approaches that figure the skull's
  // own faceting pokes through — which is what put a row of skin-coloured teeth along the hairline
  // above the ear. Measured at (107,93,81) there against cheek skin at (143,122,102) and a cap that
  // would render near 61, so it was skin, not the cap. `w` at the three lowest stations now clears
  // the sagitta with margin.
  const SCALP_CLEARANCE: Record<string, { w: number; df: number; db: number }> = {
    jaw: { w: 0.020, df: 0.034, db: 0.034 },
    cheekbone: { w: 0.024, df: 0.100, db: 0.100 },
    temple: { w: 0.028, df: 0.101, db: 0.101 },
    cranium: { w: 0.026, df: 0.115, db: 0.115 },
    'upper-cranium': { w: 0.029, df: 0.130, db: 0.162 },
    crown: { w: 0.043, df: 0.174, db: 0.147 },
  };
  // SCALP_FRONT_TUCK NO LONGER SETS THE HAIRLINE — `HAIRLINE` does, as an explicit cut. What it still
  // does is shape each ring, so the cap is not a plain ellipse and the mass has somewhere to sit.
  const SCALP_FRONT_TUCK: Record<string, number[]> = {
    // Index 0 is the forehead, 4 the character's left, 8 the nape, 12 the right.
    //
    // A CLOSED RING PROJECTS TO A FILLED SILHOUETTE, so front-view coverage is not "which indices
    // carry hair" — it is the x at which the scalp crosses OUT of the skull. Everything inboard of
    // that crossing shows skin because the skull is in front of it. The front-view x factor is
    // sin(2*pi*i/16): index 1 sits at 0.383 of the half-width, index 2 at 0.707, index 3 at 0.924.
    // So the crossing index is the whole design, and the target comes straight off the baseline:
    //
    //     front y/H     temple 0.060      cheekbone 0.080
    //     baseline           0.303              0.165
    //     implies x_cross    ~0.70 hw           ~0.84 hw
    //     so cross at        index 2            between index 2 and 3
    //
    // `temple` used to be 1.00 all the way round — a full clearance ring, which is a solid band of
    // hair straight across the forehead and measured coverage 1.000 against the baseline's 0.303.
    // The comment that justified it ("the fringe comes forward again") was right that the brow needs
    // hair and wrong that it needs hair everywhere.
    jaw: [0.20, 0.24, 0.42, 0.94, 1.00, 0.96, 1.00, 1.00,
      1.00, 1.00, 1.00, 0.98, 1.00, 0.92, 0.40, 0.24],
    cheekbone: [0.34, 0.44, 0.72, 1.02, 0.88, 1.00, 1.00, 1.00,
      1.00, 1.00, 1.00, 0.96, 1.00, 0.84, 0.68, 0.40],
    // The zigzag lives at indices 3/5 and 11/13, never at 4/12. Those are the widest points a
    // cross-section band measures, and moving them is what cost 1.2 points of front score for 0.5 of
    // band earlier in this work; the diagonals change the hairline's outline without touching the
    // maximum. Left and right differ on purpose — the baseline's tufts are not mirrored.
    temple: [0.58, 0.66, 0.80, 1.06, 0.96, 1.04, 1.00, 1.00,
      1.00, 1.00, 1.00, 1.06, 0.98, 1.02, 0.78, 0.62],
    // Behind the crown the scalp now stands proud of the baseline, and only behind. Indices 7-9 are
    // the nape side of the ring.
    // THE FOREHEAD STAYS COVERED HERE, AND THE SCORE IS WHY — NOT THE COVERAGE READING.
    //
    // `hair_structure.py` says this row should be far barer than it is: the baseline reads 0.303 of
    // the head's width as hair at y/H 0.060 and this model reads 1.000. Tucking indices 15/0/1/2/14
    // to open the forehead did move that number the right way, 1.000 -> 0.546 -> 0.429, and it cost
    //
    //     head profile IoU   0.9184 -> 0.8965      score 8.74 -> 7.86
    //     head front  IoU    0.9358 -> 0.9359      score 9.43 -> 9.44
    //
    // 0.88 of a point of profile bought 0.01 of front. Coverage-per-row and region IoU disagree here
    // and IoU is the acceptance criterion, so the ring goes back to full clearance and the coverage
    // gap is reported rather than optimised away.
    //
    // Worth keeping: the two metrics disagree because they answer different questions. Coverage asks
    // how much of THIS ROW is hair, which is blind to where the row sits on a head that is about 7%
    // wider than the baseline's; IoU asks whether the outlines land on each other. A row-aligned
    // metric on two differently-proportioned heads compares different anatomy at the same number.
    cranium: [1.00, 1.02, 1.07, 1.09, 1.00, 1.06, 0.94, 0.88,
      0.85, 0.88, 0.94, 1.06, 1.00, 1.09, 1.07, 1.02],
    'upper-cranium': [1.00, 1.03, 1.09, 1.11, 1.00, 1.08, 0.90, 0.82,
      0.78, 0.82, 0.90, 1.08, 1.00, 1.11, 1.09, 1.03],
    crown: [1.00, 1.04, 1.10, 1.12, 1.00, 1.09, 0.89, 0.80,
      0.76, 0.80, 0.89, 1.09, 1.00, 1.12, 1.10, 1.04],
  };
  // A FUNCTION, NOT A SNAPSHOT. The scalp is derived from the head's stations, so if the head can be
  // retuned at runtime this must be recomputable — a value captured once would leave the hair sitting
  // on the shape the skull used to have.
  const makeScalpStations = (): HeadStation[] => HEAD_STATIONS
    .filter((s) => s.name in SCALP_CLEARANCE)
    .map((s) => {
      const c = SCALP_CLEARANCE[s.name];
      const tuck = SCALP_FRONT_TUCK[s.name];
      return {
        ...s,
        name: `scalp-${s.name}`,
        halfWidth: s.halfWidth + c.w,
        frontDepth: s.frontDepth + c.df,
        backDepth: s.backDepth + c.db,
        shape: tuck ? tuck.map((k, i) => k * (s.shape ? s.shape[i] : 1)) : s.shape,
      };
    });
  // Every hair mesh registers here as it is created, and the head's post-transforms read this list
  // instead of a literal one. The literal lists went stale the moment masses were removed — they were
  // still naming `hair-crown`, `hair-back`, `hair-fringe`, `hair-side-l`, `hair-side-r` and
  // `hair-tip-a` after all six had gone. They were harmless only because of an `if (m)` guard, and a
  // list that silently names nothing is exactly how a new mass ends up missing HEAD_X and detaching
  // from the skull it was seated on.
  const hairMeshIds: string[] = [];
  // HAIR IS PARENTED TO THE HEAD'S PIVOT, NOT TO THE ROOT.
  //
  // `'head'` was already being passed as the parent id, but that argument only records the logical
  // parent for the destruction hierarchy — the SCENE parent was `root`, so the hair inherited no
  // transform. Rotating `runtime.nodes['head']`, which is how this model is posed, turned the skull
  // and left the hair behind in world space.
  //
  // `head__pivot` carries an identity transform (`addMesh` never writes to the pivot; HEAD_Z and
  // HEAD_X are applied to the MESH inside it), so re-parenting is geometrically a no-op at rest and
  // the captured silhouette must be unchanged. That is asserted, not assumed: see
  // `scripts/head-rig-follow.mjs`.
  //
  // Side effect, stated: hair pivots no longer land in `destructionGroups.body`, because that push is
  // guarded by `parent === root`. They are now nested inside `head__pivot`, which IS in that list, so
  // the hair travels with the head instead of being listed as a separate body part. That is the
  // correct hierarchy for hair, but it is a behaviour change.
  const addHair = (id: string, mesh: THREE.Mesh): void => {
    // Anisotropy is silently degenerate without a tangent frame, so build one wherever the geometry
    // can carry it. `computeTangents` needs index + position + normal + uv and console-errors without
    // them, so the guard is a real precondition rather than a defensive habit.
    const g = mesh.geometry;
    if (g.index && g.getAttribute('uv') && g.getAttribute('normal') && !g.getAttribute('tangent')) {
      g.computeTangents();
    }
    hairMeshIds.push(id);
    addMesh(root, headPivot, id, mesh, 'head', 'hair', runtime, options);
  };

  // A DOME RING ABOVE THE CROWN WAS TRIED AND REVERTED. The shape measurement says the crown is too
  // pointed — depth over own-maximum at y/H 0.005/0.010/0.015 reads 0.197/0.354/0.537 against the
  // baseline's 0.370/0.584/0.695 — and one extra ring at 55% of the crown's radii does fix it:
  // front 9.50 -> 9.61, the best front score measured in this work. It also cost profile 8.83 -> 8.78,
  // and front was already over 9 while profile is the criterion still short of it, so the gain buys
  // nothing and the loss is on the binding axis. Reverted, and recorded so it is not rediscovered.
  // LAYER 1 AND LAYER 2 ARE NOW TWO MESHES, AND THE REASON IS A DEFECT I COULD NOT FIX.
  //
  // One shell was doing both jobs: guaranteeing no skin shows, AND making the silhouette. Those pull
  // against each other — every time the volume was pulled in to correct the outline it opened skin
  // somewhere else, which is exactly the temple gap that survived a mask built specifically for it.
  // With a thin cap underneath, coverage is guaranteed by a mesh that never has to move, and the
  // mass above it is free to be shaped.
  //
  // It also names what made this read as a helmet in the first place: the single shell was the skull
  // offset by a NEARLY UNIFORM clearance (0.132-0.172 from the cheekbone up), and a uniform offset of
  // a skull is a helmet by construction, whatever is layered on top of it.
  //
  // THIS STEP CHANGES NO OUTER DIMENSION. The mass keeps the old shell's numbers exactly and the cap
  // sits inside it, so the capture must come back unchanged; shaping the mass is the next step and a
  // separate measurement. Splitting and shaping at once is how the last four attributions went wrong.
  // 0.006, not 0.018. Once the mass was pulled in to hug the skull its smallest clearance became
  // 0.010 at the jaw, so a cap at 0.018 would have been WIDER than the mass there and poked through
  // it. The cap only has to clear the skull, not the hair.
  const CAP_CLEARANCE = 0.006;
  const makeCapStations = (): HeadStation[] => HEAD_STATIONS
    .filter((s) => s.name in SCALP_CLEARANCE)
    .map((s) => {
      const tuck = SCALP_FRONT_TUCK[s.name];
      return {
        ...s,
        name: `cap-${s.name}`,
        halfWidth: s.halfWidth + CAP_CLEARANCE,
        frontDepth: s.frontDepth + CAP_CLEARANCE,
        backDepth: s.backDepth + CAP_CLEARANCE,
        shape: tuck ? tuck.map((k, i) => k * (s.shape ? s.shape[i] : 1)) : s.shape,
      };
    });
  const CAP_STATIONS = makeCapStations();
  // THE CAP IS NOT THE SAME BLACK AS THE MASS. Every reference view shows it as a lighter grey where
  // it reads through a parting or at the hairline — it is scalp under short hair, not more hair. Using
  // one material for both made the parting invisible and the whole head one flat black.
  const scalpCapMat = polyMaterial(clayCapture ? clayColor : 0x4a423c, 0.92);
  // THE CAP IS CUT HIGHER AT THE FRONT THAN THE MASS, AND LOWER AT THE SIDES AND BACK.
  //
  // The cap is short hair growing under the sweep, so at the FOREHEAD it is always covered — the mass
  // reaches lower there than the cap does, and any cap below that line is a grey band on the brow that
  // exists in no reference view. At the sides and the nape the opposite holds: the cap is what shows
  // beneath the mass, which is where the references do read as lighter grey.
  //
  // Expressing that needs a per-column boundary, so the cap is built with `buildHairMass` too rather
  // than with `buildHeadShell`, whose lower edge can only be a horizontal ring.
  //
  // Against the mass's own HAIRLINE, per ring index (0 front, 4 left, 8 nape, 12 right):
  //   front  14/15/0/1/2   RAISED about 0.12, so the mass covers the cap completely
  //   sides  3-5, 11-13    LOWERED about 0.12, so grey shows under the hair
  //   back   6-10          LOWERED about 0.12, so the nape reads as clipped short hair
  // EVERY ENTRY FORWARD OF THE EAR SITS ABOVE THE MASS'S OWN HAIRLINE. Identified by dyeing this
  // material red and re-rendering: the sawtooth along the temple sampled (107,93,81) before and
  // (184,74,73) after, so it was the CAP, not skin — index 3 and 13 sat at 5.46/5.48 against a mass
  // at 5.72, hanging 0.26 below it exactly where the report says the hair must cover.
  //
  // (An arithmetic argument had said the cap "would render near 61, so 107 must be skin". That was
  // wrong: the cap there catches the key far more directly than the cheek it was compared against.
  // Dyeing the surface settled in one capture what the arithmetic got backwards.)
  //
  // Grey is therefore left showing only from index 5 round to 11 — behind the ear and across the
  // nape — which is where the references have it.
  const CAP_HAIRLINE = [
    6.008, 6.006, 5.994, 5.902, 5.608, 5.566, 5.454, 5.398,
    5.326, 5.374, 5.436, 5.532, 5.734, 5.96, 6.024, 6.026,
  ];
  const CAP_OPTS = {
    // No creases and no spikes: this surface exists to be mostly hidden, and a wave on it would only
    // find new ways to poke through the mass.
    creaseDepth: 0,
    columns: 24,
  };
  addHair('hair-cap', buildHairMass('Scalp cap', CAP_STATIONS, CAP_HAIRLINE, scalpCapMat, CAP_OPTS));
  // THE CROWN WAS A CONE, AND MY OWN CHANGE BUILT IT.
  //
  // `buildHeadShell` fans its top ring straight to ONE apex. Widening the crown ring to add the
  // volume the rows asked for widened the BASE of that fan, so the head grew a faceted spike. The
  // region IoU went UP while it happened, because IoU compares outlines and a taller outline was
  // closer — which is exactly why that number must not be the thing reported.
  //
  // Two shrinking rings above the crown turn ring -> apex into ring -> ring -> ring -> apex. They are
  // synthesised here rather than added to HEAD_STATIONS because the skull must not change: this is
  // hair over the crown, not a taller head.
  const massCrown = makeScalpStations()[makeScalpStations().length - 1];
  const domeRing = (name: string, dy: number, k: number): HeadStation => ({
    ...massCrown,
    name,
    y: massCrown.y + dy,
    halfWidth: massCrown.halfWidth * k,
    frontDepth: massCrown.frontDepth * k,
    backDepth: massCrown.backDepth * k,
  });
  const makeMassStations = (): HeadStation[] => [
    ...makeScalpStations(),
    // Lower and wider than before. The references show a top that is nearly FLAT with a slight rise
    // and a distinct break where it turns down into the side; the taller pair here produced a dome
    // that came to a point, which is the shape the user reported as wrong.
    // A DOME, ON A SPHERICAL PROFILE. The previous five rings shrank from 0.92 to 0.08 of the crown's
    // radius while rising only 0.081, which is not a dome — it is a nearly flat plateau that then
    // falls away. Flat and faceted is exactly what reads as cut lines, and the drop at its edge is
    // what looked like the crown caving in.
    //
    // Heights now follow dy = R*sqrt(1 - k^2) with R = 0.118, the profile of a spherical cap: the
    // ring shrinks and RISES together, so the surface curves over the top instead of lying flat.
    // Measured before this: 50 vertices crammed into a patch 0.09 by 0.12 at the apex.
    domeRing('mass-dome-1', 0.040, 0.94),
    domeRing('mass-dome-2', 0.064, 0.84),
    domeRing('mass-dome-3', 0.087, 0.68),
    domeRing('mass-dome-4', 0.105, 0.46),
    domeRing('mass-dome-5', 0.116, 0.16),
  ];
  const MASS_STATIONS = makeMassStations();
  // THE HAIRLINE, READ OFF THE FOUR REFERENCE VIEWS AND AUTHORED AS HEIGHTS.
  //
  // Ring index 0 is the front midline, 4 the character's left, 8 the nape, 12 the right. Each entry
  // is the height at which the mass ENDS in that direction, so a corner is simply two neighbours that
  // differ and a straight run is a set that changes evenly. The reference's identity lives here:
  //
  //   front    a peak, then a deep notch over one eye, then a long straight run — asymmetric
  //   profile  the sideburn is a hard wedge ending in a corner at about ear-top height
  //   back     the nape closes to a shallow V
  //
  // Station heights for orientation: cranium 5.80, temple 5.66, cheekbone 5.54, jaw 5.30.
  // ANCHORED TO THE EAR, WHICH IS MEASURED, NOT ESTIMATED. `ear-l`/`ear-r` are placed at y 5.586 with
  // a half-height of 0.094 and |x| 0.368, so an ear spans 5.492 to 5.680 and sits at exactly ring
  // index 4 and 12. The first version of this table put those indices at 5.56 and 5.58 — below the
  // top of the ear — which is why the ear came out half covered. Every reference view has the ear
  // fully clear, with the hair rising over it in a sharp step and a sideburn wedge dropping in FRONT
  // of it. Indices 4 and 12 now sit above 5.680 and their neighbours make the step.
  const HAIRLINE = [
    5.864, 5.548, 5.854, 5.782, 5.746, 5.584, 5.548, 5.504,
    5.476, 5.49, 5.524, 5.554, 5.762, 5.782, 5.556, 5.514,
  ];
  const HAIR_SIDEBURNS = [
    { at: 3.45, drop: 0.20, width: 0.85 },
    { at: 12.55, drop: 0.20, width: 0.85 },
  ];
  const MASS_OPTS = {
    // 48 columns against the skull's 16. Six material settings could not reach the reference's tonal
    // ratio (p90/p50 5.3, best of six 3.2) because a flat-shaded facet is lit uniformly and there is
    // nothing below it to make a highlight selective. Smaller facets ARE that something. The skull is
    // untouched — this builder samples the station profile at fractional ring indices.
    columns: 48,
    // Five, irregular, on the top and upper back where the reference puts them. Deliberately uneven:
    // equal spikes at equal spacing read as a crown or a cog, not as hair.
    // Only behind the ear, which is the one place the mass flares away from the cap. Capped below the
    // clearance at those stations (0.024 at the cheekbone, 0.028 at the temple) so the curl cannot
    // take the surface inside the cap and let grey through.
    // Just forward of the ear at index 4 and 12, narrow (0.85 of an index interval each side) and
    // dropping 0.20 — the ear spans 5.492 to 5.680, so the tip lands near its lower third, which is
    // where the reference has it. Linear falloff, so the tip is a point and not a rounded scoop.
    sideburns: HAIR_SIDEBURNS,
    edgeTuck: [
      0, 0, 0, 0.006, 0.012, 0.016, 0.010, 0,
      0, 0, 0.010, 0.016, 0.012, 0.006, 0, 0,
    ],
  };
  addHair('hair-mass', buildHairMass('Hair mass', MASS_STATIONS, HAIRLINE, hair, MASS_OPTS));

  // NO CLUMPS, NO TUFTS, NO TUBE STRANDS. The four-view reference has none of them.
  //
  // Every added piece in this file's history — six lofted masses, fourteen then seven rim tufts, six
  // tube strands proud then flush, clumps as sheets then as closed volumes, clump displacement x2.9 —
  // was answering a question the reference does not ask. Its silhouette is one continuous smooth mass
  // from every angle; nothing separates in outline. The two things it DOES have are a hard angular
  // boundary and a fine flow striation, and neither is a lock.
  //
  // `scalpAt`, `radialAt` and `scalpStation` stay: the boundary work seats against them.

  // Tracing both profile edges row by row against the baseline showed the whole head — skin and
  // hair together — sitting behind where the reference puts it: from the crown down to y/H 0.14 the
  // front edge ran +0.0147 H late and the back edge +0.0201 H late, both the same sign, which is a
  // placement error and not a shape one. Below y/H 0.16 the deltas flip sign, so the body is where
  // it belongs and only this offset was wrong. 0.0174 H is 0.118 in world z, so -0.13 becomes
  // -0.012. Every head part shares the offset, or the face would slide off the skull.
  // -0.064: the authored -0.012 plus the -0.052 found by dragging the tuner's whole-head control.
  const HEAD_Z = -0.064;
  // NEW. The tuner also produced a vertical shift of -0.082 and there was no constant doing that job,
  // so the head sat where the stations put it and nothing could move the assembly down as one piece.
  const HEAD_Y = -0.082;
  for (const id of ['head', 'ear-l', 'ear-r', 'nose', 'mouth', 'eye-l', 'eye-r', 'brow-l', 'brow-r']) {
    const m = runtime.meshes[id];
    if (m) { m.position.z += HEAD_Z; m.position.y += HEAD_Y; }
  }
  for (const id of hairMeshIds) {
    const m = runtime.meshes[id];
    if (m) { m.position.z += HEAD_Z; m.position.y += HEAD_Y; }
  }

  // Head width, sampled every 0.01 H down the front silhouette from the crown to the jaw, ran a flat
  // 18% over the baseline: mean 0.1057 H against 0.0883 across y/H 0.02..0.14, with no height where
  // it was right. A uniform excess is a uniform correction, so the whole head scales on x rather
  // than each ring being retuned. The lathes centre their vertices on x = 0, so scaling the mesh is
  // enough; the features carry absolute positions, so those move with it or the ears would end up
  // floating clear of a narrower skull.
  // MULTIPLY, never assign: `ellipsoid` builds a unit sphere and carries its radii in the mesh's own
  // scale, so `scale.x = HEAD_X` overwrites an eye's 0.048 with 0.835 and renders it seventeen times
  // oversized — a flat disc spanning the whole figure. The lathes are at scale 1, so the same
  // multiply is correct for them too.
  const HEAD_X = 0.916;
  for (const id of ['head', ...hairMeshIds]) {
    const m = runtime.meshes[id];
    if (m) m.scale.x *= HEAD_X;
  }
  for (const id of ['ear-l', 'ear-r', 'nose', 'mouth', 'eye-l', 'eye-r', 'brow-l', 'brow-r']) {
    const m = runtime.meshes[id];
    if (!m) continue;
    m.scale.x *= HEAD_X;
    m.position.x *= HEAD_X;
  }

  // THE ARMS STAY AT z = 0. Moving them to -0.042 was tried, on the reading that the band at local
  // y 4.97 has a z centre of -0.200 on the reference against -0.158 here and that band is mostly arm.
  // It is not: a band's z centre comes from its DEEPEST and shallowest vertices, and the torso is deeper
  // than the arm at the shoulder, so the arm does not set it. The z centre did not move and x accuracy
  // went 2.18% to 2.36%, because these capsules carry `bias`, which scales the offset after projecting
  // onto the axis — moving the axis changes the section shape, not just its place.
  const ARM_Z = 0;

  // HANDS, as explicit lofts rather than as part of the body field.
  //
  // This is not a preference. A finger on this model is 0.101 thick and the body field samples y
  // every 0.0462, so a finger is 2.2 samples across against a three-sample floor: it cannot exist in
  // the field at any radius. Each phalanx is 1.8 samples long, so joints cannot either. Clearing the
  // floor would need resolution 174 — five million samples, each evaluating some fifty capsules.
  // The SDF arm therefore ends in a wrist stub at x 2.82 and the hand is its own geometry from there.
  //
  // Proportions are the brief's, against L = wrist-to-middle-tip = 0.559:
  //   palm 0.47 L, fingers 0.53 L, knuckle line at x 3.003
  //   middle 1.00, ring 0.96, index 0.93, pinky 0.73 in length
  //   knuckle offsets: middle 0, index -0.020 L, ring -0.018 L, pinky -0.055 L
  //   phalanges 0.45 : 0.31 : 0.24, so PIP at 0.455 and DIP at 0.75 of finger length
  //   joint pinch 7% at PIP and 5.5% at DIP, each re-opening slightly after — a plane change, not a
  //   waist, and nowhere near the sausage-and-valley the brief warns about
  //
  // Four vertices per ring gives each finger a dorsal, a palmar and two side planes, which is what
  // the brief asks a finger section to have. It is coarser than the hexagon suggested and it keeps
  // the whole hand inside a low-poly budget.
  // Palm stations, wrist to knuckle line. The proximal one is buried in the forearm so the wrist is a
  // transition rather than a butted cap; the distal one is the knuckle line the fingers grow out of.
  //
  // Proportions are unchanged and were already inside the brief's ranges when measured: wrist to knuckle
  // 46.4% of hand length, middle : ring : index : pinky at 1.00 : 0.954 : 0.925 : 0.711. What changes is
  // that they are now ONE surface.
  // POSITION-only measurements from `scripts/fit-body-stations.py`: the right-hand envelope is
  // x 2.500..3.243, y 4.573..4.897, z -0.330..0.133. The contour deliberately stays a little inside
  // the noisy wrist bound and lands exactly on the distal/thumb extrema. Named points make every broad
  // cut editable in Tune without exposing imported triangles or copying GLB topology.
  const HAND_OUTLINE: HandOutlinePoint[] = [
    { name: 'wrist-pinky', x: 2.550, z: -0.300, topY: 4.895, bottomY: 4.785 },
    { name: 'palm-pinky', x: 2.860, z: -0.330, topY: 4.886, bottomY: 4.792 },
    { name: 'pinky-lower', x: 3.080, z: -0.326, topY: 4.875, bottomY: 4.798 },
    { name: 'pinky-tip-lower', x: 3.145, z: -0.310, topY: 4.870, bottomY: 4.800 },
    { name: 'pinky-tip-upper', x: 3.170, z: -0.252, topY: 4.866, bottomY: 4.801 },
    { name: 'pinky-web', x: 3.050, z: -0.247, topY: 4.876, bottomY: 4.798 },
    { name: 'ring-lower', x: 3.120, z: -0.243, topY: 4.870, bottomY: 4.800 },
    { name: 'ring-tip-lower', x: 3.205, z: -0.213, topY: 4.864, bottomY: 4.801 },
    { name: 'ring-tip-upper', x: 3.220, z: -0.172, topY: 4.862, bottomY: 4.801 },
    { name: 'ring-web', x: 3.060, z: -0.168, topY: 4.875, bottomY: 4.798 },
    { name: 'middle-lower', x: 3.140, z: -0.164, topY: 4.868, bottomY: 4.800 },
    { name: 'middle-tip-lower', x: 3.235, z: -0.138, topY: 4.862, bottomY: 4.801 },
    { name: 'middle-tip-upper', x: 3.243, z: -0.096, topY: 4.860, bottomY: 4.801 },
    { name: 'middle-web', x: 3.070, z: -0.092, topY: 4.875, bottomY: 4.798 },
    { name: 'index-lower', x: 3.130, z: -0.088, topY: 4.868, bottomY: 4.800 },
    { name: 'index-tip-lower', x: 3.215, z: -0.064, topY: 4.863, bottomY: 4.801 },
    { name: 'index-tip-upper', x: 3.205, z: -0.012, topY: 4.862, bottomY: 4.801 },
    { name: 'index-web', x: 3.040, z: -0.007, topY: 4.878, bottomY: 4.795 },
    { name: 'thenar-high', x: 2.820, z: 0.020, topY: 4.888, bottomY: 4.765 },
    { name: 'thumb-root-high', x: 2.740, z: 0.060, topY: 4.825, bottomY: 4.705 },
    { name: 'thumb-mid-high', x: 2.820, z: 0.125, topY: 4.745, bottomY: 4.635 },
    { name: 'thumb-tip-high', x: 2.885, z: 0.140, topY: 4.642, bottomY: 4.595 },
    { name: 'thumb-tip-low', x: 2.840, z: 0.075, topY: 4.650, bottomY: 4.573 },
    { name: 'thumb-mid-low', x: 2.750, z: 0.045, topY: 4.760, bottomY: 4.640 },
    { name: 'thumb-root-low', x: 2.670, z: 0.005, topY: 4.850, bottomY: 4.720 },
    { name: 'wrist-thumb', x: 2.550, z: -0.020, topY: 4.897, bottomY: 4.780 },
  ];
  // Loop 097 replaces the outline-wide Earcut fan with a station grid. The outline remains beside it
  // as exact rollback evidence, but it is not rendered: one concave polygon made every palm triangle
  // converge across the hand and the thumb notch became a visible triangular void. Four transverse
  // rings distribute those cuts through the wrist, palm and knuckle fan instead. Fingers share the
  // two vertices of every web and the thumb reuses the six vertices of a real palm-side opening.
  void HAND_OUTLINE;
  const HAND_STATIONS: PalmStation[] = [
    {
      x: 2.516, halfSpread: 0.116, halfThickness: 0.046,
      topThickness: 0.048, bottomThickness: 0.126, zCentre: -0.154, yCentre: 4.858,
      across: [-0.276, -0.247, -0.2, -0.179, -0.116, -0.099, -0.072, -0.027, 0.01],
      topOffsets: [-0.042, -0.03, -0.026, -0.029, -0.027, -0.023, -0.026, -0.024, -0.09],
      bottomOffsets: [-0.016, -0.002, 0.002, 0.006, 0.008, -0.001, -0.002, -0.006, -0.006],
    },
    {
      x: 2.64, halfSpread: 0.144, halfThickness: 0.044,
      topThickness: 0.07, bottomThickness: 0.1, zCentre: -0.137, yCentre: 4.824,
      across: [-0.301, -0.258, -0.212, -0.177, -0.137, -0.078, -0.07, -0.033, 0.005],
      topOffsets: [0, 0.002, 0.005, 0.002, 0.006, 0.002, 0.005, 0.001, -0.004],
      bottomOffsets: [-0.003, -0.005, 0.003, 0.003, 0.006, 0.004, 0.002, -0.014, -0.022],
    },
    {
      x: 2.876, halfSpread: 0.171, halfThickness: 0.048,
      topThickness: 0.06, bottomThickness: 0.063, zCentre: -0.153, yCentre: 4.838,
      across: [-0.33, -0.286, -0.242, -0.198, -0.154, -0.111, -0.067, -0.023, 0.022],
      topOffsets: [-0.002, 0.014, 0.014, 0.026, 0.008, 0.017, 0.026, 0.014, 0.014],
      bottomOffsets: [0.018, 0.016, 0.016, 0.007, 0.014, 0.036, 0.016, 0.009, -0.006],
    },
    {
      x: 2.988, halfSpread: 0.17, halfThickness: 0.037,
      topThickness: 0.039, bottomThickness: 0.06, zCentre: -0.162, yCentre: 4.835,
      across: [-0.329, -0.286, -0.245, -0.203, -0.162, -0.121, -0.079, -0.037, 0.006],
      topOffsets: [-0.003, 0.001, 0.004, 0.001, 0.005, 0.001, 0.004, 0.001, -0.005],
      bottomOffsets: [-0.003, -0.004, -0.001, 0.002, 0.004, 0.003, -0.001, -0.008, -0.012],
    },
    {
      x: 3.034, halfSpread: 0.16, halfThickness: 0.04,
      topThickness: 0.035, bottomThickness: 0.05, zCentre: -0.166, yCentre: 4.837,
      across: [-0.326, -0.286, -0.247, -0.207, -0.168, -0.130, -0.092, -0.050, -0.007],
      topOffsets: [-0.004, 0, 0.002, 0, 0.003, 0, 0.002, 0, -0.004],
      bottomOffsets: [-0.002, -0.003, 0, 0.002, 0.003, 0.002, -0.001, -0.005, -0.008],
    },
  ];
  const HAND_FINGERS: FingerSpec[] = [
    { id: 'pinky', length: 0.126, setback: 0, girth: 0.86, thickness: 0.68, splay: -0.05 },
    { id: 'ring', length: 0.18, setback: 0, girth: 0.96, thickness: 0.72, splay: -0.015 },
    { id: 'middle', length: 0.203, setback: 0, girth: 1, thickness: 0.72, splay: -0.008 },
    { id: 'index', length: 0.167, setback: 0, girth: 0.94, thickness: 0.75, splay: 0 },
  ];
  const HAND_FINGER_PROFILE: Array<[number, number]> = [
    [0.006, 1.012], [0.3, 1.008], [0.455, 0.938], [0.598, 0.978],
    [0.758, 0.973], [0.888, 0.995], [1.006, 0.83],
  ];
  const HAND_THUMB: ThumbSpec = {
    name: 'thumb', rootX: 2.822, rootY: 4.624, rootZ: 0.132,
    midX: 2.95, midY: 4.564, midZ: 0.166,
    tipX: 3.111, tipY: 4.5, tipZ: 0.143,
  };
  const HAND_THUMB_PROFILE: ThumbProfilePoint[] = [
    { at: 0.01, width: 0.08, thickness: 0.067 },
    { at: 0.04, width: 0.084, thickness: 0.068 },
    { at: 0.1, width: 0.078, thickness: 0.062 },
    { at: 0.2, width: 0.068, thickness: 0.054 },
    { at: 0.3, width: 0.06, thickness: 0.048 },
    { at: 0.62, width: 0.052, thickness: 0.041 },
    { at: 0.82, width: 0.047, thickness: 0.037 },
    { at: 1, width: 0.032, thickness: 0.026 },
  ];
  for (const side of [-1, 1]) {
    const s = side < 0 ? 'l' : 'r';
    addMesh(root, root, `hand-${s}`, buildHandShell(
      `Hand ${s.toUpperCase()}`, side, HAND_STATIONS, HAND_FINGERS,
      HAND_FINGER_PROFILE, skin, 'x', HAND_THUMB, HAND_THUMB_PROFILE, false,
    ), 'root', 'hand', runtime, options);

    // Webs are the concave outline segments between adjacent fingertips. They are therefore shared
    // boundary points of the dorsal, palmar and side surfaces, never small overlapping patches.
  }

  // FEET, as one stitched shell each — the same builder the hands use, running along z.
  //
  // The ten explicit toe lofts this replaces were an improvement on the ten field stubs before them
  // (2.5 grid samples wide and one tall, so the foot rendered as a hoof), but they were still separate
  // objects sitting on a separate foot mass, and in profile the three read as stacked slabs: ankle,
  // plate, toes. The hand's rebuild fixed the identical problem by making the boundary between palm and
  // fingers a shared ring rather than an overlap, and a foot has the same anatomy — one mass, five
  // digits growing out of its front edge, webbed at their roots.
  //
  // Measured skin, right foot: the sole runs z -0.10 at the heel to about 0.42 at the ball, spanning
  // x 0.263..0.477 at y 0.35 and reaching 0.152 forward at that height.
  //
  // The first sizing made the shell 0.17 tall at the heel and it rendered as a thin plate under the
  // shin — profile score 4.55 once the old capsule was gone and the shell was what got measured. A heel
  // is nearly as tall as it is wide: 0.155 half-thickness puts its top at 0.351, which is where the
  // ankle capsules come down to meet it, so the leg and the foot share volume instead of stacking.
  const FOOT_STATIONS: PalmStation[] = [
    { x: -0.216, halfSpread: 0.114, halfThickness: 0.160, topThickness: 0.170, bottomThickness: 0.150, zCentre: 0.348, yCentre: 0.190 },
    { x: -0.150, halfSpread: 0.140, halfThickness: 0.175, topThickness: 0.185, bottomThickness: 0.165, zCentre: 0.354, yCentre: 0.205 },
    { x: -0.020, halfSpread: 0.148, halfThickness: 0.185, topThickness: 0.200, bottomThickness: 0.170, zCentre: 0.357, yCentre: 0.210 },
    { x: 0.120, halfSpread: 0.140, halfThickness: 0.155, topThickness: 0.165, bottomThickness: 0.145, zCentre: 0.368, yCentre: 0.185 },
    { x: 0.280, halfSpread: 0.162, halfThickness: 0.115, topThickness: 0.170, bottomThickness: 0.105, zCentre: 0.369, yCentre: 0.145 },
    { x: 0.420, halfSpread: 0.168, halfThickness: 0.083, topThickness: 0.120, bottomThickness: 0.075, zCentre: 0.370, yCentre: 0.115 },
    { x: 0.520, halfSpread: 0.160, halfThickness: 0.060, topThickness: 0.085, bottomThickness: 0.055, zCentre: 0.352, yCentre: 0.095 },
  ];
  // Across the ball of the foot, BIG TOE FIRST, because index 0 of this array lands on the INNER
  // edge of the foot.
  //
  // `ring()` walks `i = 0 .. ACROSS-1` and places each vertex at `zCentre + (f*2-1) * halfSpread`,
  // so index 0 is the SMALLEST local across and `place()` then multiplies by `side`. Local across
  // here is always positive (0.242..0.502 about a centre of 0.374), so the smallest value is the one
  // nearest the body centreline on both feet. Index 0 is therefore inner, whichever foot it is.
  //
  // Ordered little-first, as it was, that put the little toe inner and the big toe OUTER on both
  // feet. Measured on the emitted geometry: toe-1 landed at |x| 0.480 and toe-5 at |x| 0.268, with
  // the centreline at 0. The two feet still mirrored each other correctly, which is why nothing
  // caught it -- but a foot with its big toe outside IS the other foot, so the pair read as left
  // and right swapped. Confirmed against the reference render, whose big toes face each other.
  const TOE_SPECS: FingerSpec[] = [
    { id: 'toe-1', length: 0.120, setback: 0.000, girth: 1.30, splay: 0.00 },
    { id: 'toe-2', length: 0.105, setback: 0.004, girth: 1.06, splay: 0.00 },
    { id: 'toe-3', length: 0.090, setback: 0.010, girth: 1.00, splay: 0.00 },
    { id: 'toe-4', length: 0.075, setback: 0.018, girth: 0.93, splay: 0.00 },
    { id: 'toe-5', length: 0.060, setback: 0.025, girth: 0.84, splay: 0.00 },
  ];
  const TOE_PROFILE: Array<[number, number]> = [
    [0.000, 1.00], [0.400, 1.00], [0.720, 0.96], [1.000, 0.86],
  ];
  // Measurement-backed inputs from loop 085 are retained beside the replacement footprint so a failed
  // visual gate can be rolled back without reconstructing them from prose.
  void FOOT_STATIONS;
  void TOE_SPECS;
  void TOE_PROFILE;
  // Right-foot footprint traced from the measurement-only z slices. The contour walks from the inner
  // heel around the outer edge and every toe back down the inner edge. Its bottom surface stays within
  // y 0.040..0.057 (the measured sole); topY carries the instep falloff without stacking a second mass.
  const FOOT_OUTLINE: HandOutlinePoint[] = [
    { name: 'heel-inner', x: 0.262, z: -0.167, topY: 0.306, bottomY: 0.041 },
    { name: 'heel-centre', x: 0.348, z: -0.211, topY: 0.311, bottomY: 0.091 },
    { name: 'heel-outer', x: 0.428, z: -0.167, topY: 0.352, bottomY: 0.069 },
    { name: 'outer-rear', x: 0.473, z: -0.042, topY: 0.356, bottomY: 0.108 },
    { name: 'outer-ankle', x: 0.459, z: -0.056, topY: 0.322, bottomY: 0.059 },
    { name: 'outer-instep', x: 0.498, z: 0.098, topY: 0.168, bottomY: 0.042 },
    { name: 'outer-midfoot', x: 0.514, z: 0.238, topY: 0.3, bottomY: 0.056 },
    { name: 'outer-ball-low', x: 0.528, z: 0.33, topY: 0.204, bottomY: 0.04 },
    { name: 'outer-ball-high', x: 0.534, z: 0.482, topY: 0.19, bottomY: 0.048 },
    { name: 'little-outer', x: 0.535, z: 0.53, topY: 0.165, bottomY: 0.052 },
    { name: 'little-tip-outer', x: 0.515, z: 0.565, topY: 0.15, bottomY: 0.052 },
    { name: 'little-tip-inner', x: 0.485, z: 0.57, topY: 0.148, bottomY: 0.052 },
    { name: 'little-web', x: 0.475, z: 0.515, topY: 0.165, bottomY: 0.052 },
    { name: 'toe-4-tip-outer', x: 0.47, z: 0.59, topY: 0.152, bottomY: 0.052 },
    { name: 'toe-4-tip-inner', x: 0.425, z: 0.595, topY: 0.15, bottomY: 0.052 },
    { name: 'toe-4-web', x: 0.415, z: 0.53, topY: 0.17, bottomY: 0.052 },
    { name: 'toe-3-tip-outer', x: 0.41, z: 0.61, topY: 0.154, bottomY: 0.052 },
    { name: 'toe-3-tip-inner', x: 0.36, z: 0.615, topY: 0.152, bottomY: 0.052 },
    { name: 'toe-3-web', x: 0.35, z: 0.54, topY: 0.174, bottomY: 0.052 },
    { name: 'toe-2-tip-outer', x: 0.345, z: 0.625, topY: 0.158, bottomY: 0.052 },
    { name: 'toe-2-tip-inner', x: 0.29, z: 0.63, topY: 0.156, bottomY: 0.052 },
    { name: 'toe-2-web', x: 0.28, z: 0.514, topY: 0.178, bottomY: 0.052 },
    { name: 'big-tip-outer', x: 0.27, z: 0.634, topY: 0.162, bottomY: 0.052 },
    { name: 'big-tip-inner', x: 0.215, z: 0.624, topY: 0.16, bottomY: 0.052 },
    { name: 'big-inner', x: 0.205, z: 0.574, topY: 0.165, bottomY: 0.052 },
    { name: 'inner-ball-high', x: 0.208, z: 0.48, topY: 0.212, bottomY: 0.048 },
    { name: 'inner-ball-low', x: 0.222, z: 0.36, topY: 0.24, bottomY: 0.04 },
    { name: 'inner-midfoot', x: 0.229, z: 0.244, topY: 0.3, bottomY: 0.04 },
    { name: 'inner-instep', x: 0.238, z: 0.124, topY: 0.36, bottomY: 0.048 },
    { name: 'inner-ankle', x: 0.252, z: 0.048, topY: 0.38, bottomY: 0.041 },
    { name: 'inner-rear', x: 0.23, z: -0.054, topY: 0.35, bottomY: 0.04 },
  ];
  for (const side of [-1, 1]) {
    const s = side < 0 ? 'l' : 'r';
    addMesh(root, root, `foot-shell-${s}`, buildPlanarOutlineShell(
      `Foot ${s.toUpperCase()}`, side, FOOT_OUTLINE, skin,
      ['foot', 'toe-1', 'toe-2', 'toe-3', 'toe-4', 'toe-5'],
    ), 'root', 'foot', runtime, options);
  }

  // TORSO SHELL — polygonal anatomical sections over the body field. Sizes come from the GLB's own
  // cross-sections; shape is authored separately as fractions of them, which is what an ellipse cannot
  // do and what every pec on this figure needed.
  //
  // The shell carries its own material because `skin` sets `flatShading: true`, which makes the GPU
  // recompute a flat normal per triangle and discards the selective creasing entirely. Smooth shading
  // here does not mean a smooth surface: the normals are authored with hard edges where the anatomy
  // turns, and this is what lets those be the only hard edges.
  const torsoSkin = new THREE.MeshStandardMaterial({
    color: clayCapture ? clayColor : palette.skin,
    roughness: 0.92,
    metalness: 0,
    flatShading: false,
    side: THREE.DoubleSide,
  });
  addMesh(root, root, 'torso-shell', buildTorsoShell(
    'Torso shell', TORSO_STATIONS, torsoSkin,
  ), 'root', 'torso', runtime, options);

  // Arms and legs now use the torso's explicit station/plane construction. The continuous body field
  // remains available as the fit field for garments, but no longer owns the visible skin: leaving it
  // visible would prevent a tuned station from ever making a limb smaller than the old isosurface.
  for (const side of [-1, 1]) {
    const suffix = side < 0 ? 'l' : 'r';
    addMesh(root, root, `shoulder-seam-underlay-${suffix}`, buildShoulderSeamUnderlay(
      `Shoulder seam underlay ${suffix.toUpperCase()}`, side, ARM_STATIONS[0], torsoSkin,
    ), 'root', 'shoulders', runtime, options);
    addMesh(root, root, `arm-shell-${suffix}`, buildArmShell(
      `Arm shell ${suffix.toUpperCase()}`, side, ARM_STATIONS, torsoSkin,
    ), 'root', 'arm', runtime, options);
    addMesh(root, root, `leg-shell-${suffix}`, buildLegShell(
      `Leg shell ${suffix.toUpperCase()}`, side, LEG_STATIONS, torsoSkin,
    ), 'root', 'leg', runtime, options);
  }
  runtime.meshes.body.visible = false;
  runtime.meshes.body.userData.replacedBy = [
    'torso-shell', 'shoulder-seam-underlay-l', 'shoulder-seam-underlay-r',
    'arm-shell-l', 'arm-shell-r', 'leg-shell-l', 'leg-shell-r',
  ];

  // SHORTS: eight independent surfaces. The body field no longer produces any part of this garment.
  //
  // THE MAIN SHELL. One surface, three openings. The eight-component assembly this replaces is gone
  // entirely — no waistband ring, no half-shell panels, no gusset strip, no leg tubes, no hem bands —
  // because its failure was that its components could only be placed next to one another. The horizontal
  // gap between pelvis and legs, the two skin wings beside the crotch and the narrow hanging gusset were
  // all the same defect: unjoined boundaries. Waistband, hem, seams and folds come back only after this
  // is closed.
  //
  // Pelvis rings, local. Widths and depths are the measured body plus clearance and are a floor only;
  // `hug` sets what ships. Front and back depth differ by 0.020, which is as much asymmetry as this
  // figure's own seat supports.
  // ON CLEARANCE, AND ON A THEORY THAT WAS WRONG.
  //
  // The relaxation pass drove the worst geometric shortfall to 0.0121 — every vertex, edge midpoint and
  // triangle centroid outside the body field — and the crotch still leaked. I concluded the field was not
  // what renders, since a surface-nets triangle can sit up to half a cell from the field's zero level and
  // half this grid's cell diagonal is 0.0294, larger than the clearance. So I raised clearance to 0.046.
  // The leak did not move. The theory was plausible, checkable and false, and running the check is the
  // only reason it did not become a permanent doubling of the garment's offset.
  //
  // The actual cause was a leftover mesh in the crotch that `bodyField` knows nothing about. With that
  // deleted, clearance is back to 0.022 — which is what it should be, because the outer rings are authored
  // as the thigh plus clearance and `hug` only pushes outward, so this number sets the garment's width
  // directly. The measured band width was already right at 0.022.
  const shell = buildShortsShell(
    'Shorts shell',
    [{ y: 3.49, halfWidth: 0.542, frontDepth: 0.377, backDepth: 0.397, zCentre: -0.095 },
     { y: 3.36, halfWidth: 0.552, frontDepth: 0.384, backDepth: 0.404, zCentre: -0.105 },
     { y: 3.20, halfWidth: 0.600, frontDepth: 0.392, backDepth: 0.412, zCentre: -0.105 },
     { y: 3.06, halfWidth: 0.640, frontDepth: 0.392, backDepth: 0.412, zCentre: -0.105 },
     { y: 2.96, halfWidth: 0.638, frontDepth: 0.378, backDepth: 0.398, zCentre: -0.110 },
     { y: 2.91, halfWidth: 0.630, frontDepth: 0.364, backDepth: 0.384, zCentre: -0.112 },
     { y: 2.87, halfWidth: 0.620, frontDepth: 0.348, backDepth: 0.368, zCentre: -0.115 }],
    // Leg rings. The first is the crotch row and supplies only the leg's centre and the angles; its
    // positions come from the pelvis ring, which is what removes the gap. The rest are the thigh's own
    // span at that height plus 0.022 on each side: inner edge 0.070 at y 2.87, 0.016 at 2.80, 0.001 at
    // 2.70 where the thigh pinches, 0.012 at 2.60, 0.030 at 2.45, 0.050 at 2.27; outer edge 0.559,
    // 0.604, 0.619, 0.617, 0.614, 0.611. Six rows rather than three because that inner edge is an
    // hourglass and a chord across a turn leaves the leg outside the cloth.
    // Inner edge = carve radius MINUS clearance, outer edge = thigh outer plus clearance. Carve radius by
    // height: 0.085 at y 2.87, 0.080 at 2.845, 0.071 at 2.80, 0.060 at 2.75, 0.050 at the pinch, then back
    // out to 0.079 at the hem.
    //
    // MINUS, tested against PLUS. Reasoning from how real shorts are cut — the fabric wraps the whole leg,
    // inner side included — says the inner edge belongs OUTSIDE the leg's inner wall, at carve radius plus
    // clearance. That version was built and measured: front leak went from 0 to 3237 pixels, back from 0 to
    // 2180, underside from 3587 to 17300. Worse on every view. Moving the seam outboard opens the cloth
    // away from the slot the gusset has to pass through, and the gusset then spans a wider gap than it can
    // cover. The garment does thread the slot here, and that is not a mistake in it.
    // The three rows nearest the crotch carry their inner edge at carve radius minus 0.040 rather than
    // minus 0.022, which slides the cloth 0.018 further across the leg's inner wall exactly where the
    // underside leak sits. It does not touch the hem, so the visible gap between the legs is unchanged.
    // INNER EDGE IS A CONSTANT 0.030, NOT AN OFFSET FROM THE CARVE RADIUS.
    //
    // coverage-3d.mjs ray-tests every body vertex against the closed shell and found exactly 26 outside
    // it, all at |x| 0.058 to 0.066 between y 2.61 and 2.83 — the inner-thigh wall, and nothing else in
    // the whole garment. The wall is where the carve cuts the leg, and the carve's radius there is 0.070
    // to 0.089, so those vertices are up to a full grid cell INBOARD of where the analytic carve puts the
    // surface. Surface nets places a cell's vertex at the average of its edge crossings, so the rendered
    // wall is fuzzy by about dx = 0.032 — and the cloth's inner edge, authored as carve radius minus a
    // margin, was landing inside that fuzz.
    //
    // 0.030 is inboard of the wall at every height even after a full cell of error (worst case 0.070 -
    // 0.032 = 0.038). It also makes the gap between the two legs' cloth 0.060 local, which is 0.0098 of
    // figure height against the baseline's 0.011 at the same station — closer than the carve-relative
    // version managed. Outer edges are the thigh plus 0.022 and are unchanged.
    [{ y: 2.870, xCentre: 0.2945, halfWidth: 0.2645, halfDepth: 0.263, zCentre: -0.1150 },
     { y: 2.800, xCentre: 0.3170, halfWidth: 0.2870, halfDepth: 0.283, zCentre: -0.1180 },
     { y: 2.750, xCentre: 0.3210, halfWidth: 0.2910, halfDepth: 0.283, zCentre: -0.1190 },
     { y: 2.700, xCentre: 0.3245, halfWidth: 0.2945, halfDepth: 0.283, zCentre: -0.1200 },
     { y: 2.600, xCentre: 0.3235, halfWidth: 0.2935, halfDepth: 0.282, zCentre: -0.1200 },
     { y: 2.530, xCentre: 0.3230, halfWidth: 0.2930, halfDepth: 0.282, zCentre: -0.1210 },
     { y: 2.450, xCentre: 0.3220, halfWidth: 0.2920, halfDepth: 0.282, zCentre: -0.1210 },
     { y: 2.400, xCentre: 0.3215, halfWidth: 0.2915, halfDepth: 0.282, zCentre: -0.1220 },
     { y: 2.270, xCentre: 0.3205, halfWidth: 0.2905, halfDepth: 0.281, zCentre: -0.1220 }],
    // Seven interior seam vertices per chain, not three. Both endpoints of a chord can clear the body
    // while the chord between them cuts through it — the same chord-versus-curve failure as the arm's
    // elbow — and with three the front rise chorded 0.183 straight across the front of the crotch.
    //
    // The deepest drop is 0.042, down from 0.066. Across a floor 0.084 wide, a 0.066 sag reads as a
    // groove pulled into the middle rather than a saddle; the seam should fall away from the rises and
    // flatten under the crotch, not dive.
    [0.010, 0.024, 0.036, 0.042, 0.040, 0.030, 0.016],
    // Half the gusset's width, and the same number as the leg rings' inner edge below, so the floor and
    // the legs' inner seams are continuous instead of fanning between two different widths.
    0.030,
    shorts,
    { field: bodyField, spanField: bodyFieldNoSlit, clearance: 0.040, maxPush: 0.06 },
  );
  addMesh(root, root, 'shorts-shell', shell, 'root', 'garment', runtime, options);

  for (const id of Object.keys(runtime.meshes)) {
    if (/^(palm|index|middle|ring|pinky|thumb|web)-/.test(id)) runtime.meshes[id].position.z += ARM_Z;
  }

  installLowPolyHumanoidAnimations(
    root,
    runtime,
    HAND_STATIONS,
    HAND_FINGERS,
    HAND_THUMB,
    FOOT_OUTLINE,
  );
  root.userData.sculptRuntime = runtime;
  // Final framing correction: the reference is a little wider and shorter
  // than the unscaled blockout while keeping the feet on the same baseline.
  root.position.y = -0.04;
  root.position.z = -0.04;
  root.scale.set(1.02, 1.1, 1);
  root.userData.provenance = {
    route: 'code-only procedural',
    exactnessTier: 'stylized-low-poly',
    inferred: ['rear hair', 'rear torso', 'lateral body depth', 'fine fingers and toes'],
  };
  root.userData.sculptSpec = {
    source: 'artifacts/low-poly-humanoid/object-sculpt-spec.json',
    reference: 'public/references/low-poly-humanoid/reference.png',
    style: 'faceted low-poly humanoid',
    heightUnits: 6.1,
  };
  // HAIR LAG, DRIVEN BY THE HEAD'S OWN ROTATION.
  //
  // The hair is rigidly parented to `head__pivot`, so until now it turned with the skull as one solid
  // piece. Real hair arrives late and overshoots. This gives the mass a single degree of freedom per
  // axis — a spring-damper whose rest state is the authored geometry — and displaces each vertex by a
  // partial COUNTER-rotation about the head's own pivot, weighted so the crown barely moves and the
  // lower edge moves most.
  //
  // The weight comes from the UV that already exists: `v` is 0 at the crown and 1 at the boundary, so
  // it is exactly "distance from the roots" and needs no second attribute.
  //
  // NOT ACTIVE UNDER `?capture=1`. Every measurement in this work compares captures pixel by pixel,
  // and geometry that depends on elapsed time would make two runs of the same build differ. The
  // capture path therefore renders the rest pose, which is the authored geometry exactly.
  const swayCapture = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('capture') === '1';
  const hairMassMesh = runtime.meshes['hair-mass'];
  if (!swayCapture && hairMassMesh && typeof window !== 'undefined') {
    const geo = hairMassMesh.geometry;
    const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
    const uvAttr = geo.getAttribute('uv') as THREE.BufferAttribute;
    const rest = Float32Array.from(posAttr.array as Float32Array);
    // v is 1 at the hairline and 0 at the crown; cubed so the top third is effectively rigid and the
    // motion concentrates in the free edge, which is how short hair actually behaves.
    const flex = new Float32Array(posAttr.count);
    for (let i2 = 0; i2 < posAttr.count; i2 += 1) {
      let w = uvAttr.getY(i2) ** 3;
      // THE SIDEBURNS DO NOT MOVE. They sit at the boundary, where uv.v is 1, so the weighting above
      // would give them the LARGEST displacement of anything on the head — a pointed wedge against
      // the cheek, swinging. They are also the one feature whose position reads against the ear and
      // the jaw, so any motion there looks like the hairline itself sliding about.
      //
      // Faded rather than switched, over half an index beyond each wedge, so the frozen region joins
      // the moving one smoothly instead of creasing where they meet.
      const fi = uvAttr.getX(i2) * HEAD_RING_POINTS;
      for (const sb of HAIR_SIDEBURNS) {
        let t = Math.abs(fi - sb.at);
        if (t > HEAD_RING_POINTS / 2) t = HEAD_RING_POINTS - t;
        const hold = sb.width + 0.5;
        if (t < hold) w *= Math.min(1, Math.max(0, (t - sb.width * 0.6) / (hold - sb.width * 0.6)));
      }
      flex[i2] = w;
    }

    const STIFF = 52;       // spring constant: how hard it pulls back to the authored pose
    const DAMP = 9.5;       // damping: one small overshoot, then still
    const DRIVE = 0.16;     // how much of the swing the hair fails to follow
    const MAX_LAG = 0.055;  // radians, about 3 degrees — a settle, not a swing

    // ROTATE ABOUT THE HEAD'S CENTRE, NOT THE MODEL ORIGIN.
    //
    // The first version rotated each vertex about (0,0,0) while the hair's vertices sit at y 5.3-6.2,
    // so the lever arm for the PITCH axis was the whole height of the figure: a few degrees threw the
    // entire mass a third of a head sideways. That is what broke the layout, and it is why the
    // measured peak deviation was 0.2963 — comparable to the head's own half-width.
    //
    // About the head's centre the lever arm is the hair's own radius, roughly 0.4, so the same angle
    // produces a tenth of the movement and it reads as the mass settling rather than sliding.
    const PIVOT_Y = 5.78;
    const PIVOT_Z = -0.02;

    let lagY = 0;
    let lagX = 0;
    let velY = 0;
    let velX = 0;
    let prevYaw: number | null = null;
    let prevPitch: number | null = null;
    let prevT = 0;
    let settled = false;
    const inv = new THREE.Matrix4();
    const camLocal = new THREE.Vector3();
    const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

    // DRIVEN BY THE HEAD'S ORIENTATION RELATIVE TO THE CAMERA, NOT BY ITS WORLD ROTATION.
    //
    // The first version read `headPivot`'s world quaternion, and in this viewer that never changes:
    // `OrbitControls` is constructed on the CAMERA and nothing in `scene.ts` rotates the root or the
    // model. Dragging orbits the camera around a stationary figure, so the spring was never driven
    // and the hair never moved — the effect worked only in a test that rotated the pivot by hand,
    // which is not something the application does.
    //
    // Taking the camera's position IN THE HEAD'S LOCAL FRAME covers both cases with one expression:
    // it changes when the character turns AND when the viewer orbits, which is the same relative
    // motion and the thing a viewer actually perceives as the character turning.
    hairMassMesh.onBeforeRender = (_r, _s, camera): void => {
      const now = performance.now() / 1000;
      const dt = prevT ? Math.min(0.05, now - prevT) : 0;
      prevT = now;
      if (dt <= 0) return;

      headPivot.updateWorldMatrix(true, false);
      inv.copy(headPivot.matrixWorld).invert();
      camLocal.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv);
      const yaw = Math.atan2(camLocal.x, camLocal.z);
      const pitch = Math.atan2(camLocal.y, Math.hypot(camLocal.x, camLocal.z));
      if (prevYaw !== null && prevPitch !== null) {
        // An impulse proportional to how far the view swung THIS frame, opposing the swing.
        velY -= wrap(yaw - prevYaw) * DRIVE / dt;
        velX -= wrap(pitch - prevPitch) * DRIVE / dt;
      }
      prevYaw = yaw;
      prevPitch = pitch;

      velY += (-STIFF * lagY - DAMP * velY) * dt;
      velX += (-STIFF * lagX - DAMP * velX) * dt;
      lagY = Math.max(-MAX_LAG, Math.min(MAX_LAG, lagY + velY * dt));
      lagX = Math.max(-MAX_LAG, Math.min(MAX_LAG, lagX + velX * dt));

      // Below a twentieth of a degree the pose is the authored one; write it once and then stop
      // touching the buffer, so a still character costs nothing per frame.
      if (Math.abs(lagY) < 1e-3 && Math.abs(lagX) < 1e-3
        && Math.abs(velY) < 1e-3 && Math.abs(velX) < 1e-3) {
        if (settled) return;
        posAttr.array.set(rest);
        posAttr.needsUpdate = true;
        geo.computeVertexNormals();
        settled = true;
        return;
      }
      settled = false;

      const arr = posAttr.array as Float32Array;
      for (let i2 = 0; i2 < posAttr.count; i2 += 1) {
        const w = flex[i2];
        if (w < 1e-4) {
          arr[i2 * 3] = rest[i2 * 3];
          arr[i2 * 3 + 1] = rest[i2 * 3 + 1];
          arr[i2 * 3 + 2] = rest[i2 * 3 + 2];
          continue;
        }
        const ay = lagY * w;
        const ax = lagX * w;
        const x0 = rest[i2 * 3];
        const y0 = rest[i2 * 3 + 1] - PIVOT_Y;
        const z0 = rest[i2 * 3 + 2] - PIVOT_Z;
        // Yaw about the head's axis, then pitch, both small and both about the head's centre.
        const cy = Math.cos(ay);
        const sy = Math.sin(ay);
        const x1 = x0 * cy + z0 * sy;
        const z1 = -x0 * sy + z0 * cy;
        const cx = Math.cos(ax);
        const sx = Math.sin(ax);
        arr[i2 * 3] = x1;
        arr[i2 * 3 + 1] = y0 * cx - z1 * sx + PIVOT_Y;
        arr[i2 * 3 + 2] = y0 * sx + z1 * cx + PIVOT_Z;
      }
      posAttr.needsUpdate = true;
      geo.computeVertexNormals();
    };
  }

  // BODY SCULPT TUNER, behind `?tune=1`. Head, face and hair controls are intentionally absent:
  // their authored values are locked while this pass focuses on chest, arms and legs.
  //
  // Five rounds of adjusting these numbers from captures went wrong in five different directions, and
  // each cost a full render cycle to discover. The station tables ARE the shape, so they are exposed
  // directly and the person who can see the defect moves the thing that causes it.
  //
  // Fields are discovered by reflection rather than listed: every own numeric property of a station
  // becomes a slider, so a new body/limb dimension cannot be silently missing from the panel.
  const tuneMode = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('tune') === '1';
  if (tuneMode && typeof document !== 'undefined') {
    const swap = (id: string, mesh: THREE.Mesh): void => {
      const old = runtime.meshes[id];
      if (!old) return;
      old.geometry.dispose();
      old.geometry = mesh.geometry;
      const applyRigAttributes = old.userData.applyRigAttributes as (() => void) | undefined;
      applyRigAttributes?.();
    };
    const rebuildTorso = (): void => swap('torso-shell', buildTorsoShell(
      'Torso shell', TORSO_STATIONS, torsoSkin,
    ));
    const rebuildArms = (): void => {
      swap('shoulder-seam-underlay-l', buildShoulderSeamUnderlay(
        'Shoulder seam underlay L', -1, ARM_STATIONS[0], torsoSkin));
      swap('shoulder-seam-underlay-r', buildShoulderSeamUnderlay(
        'Shoulder seam underlay R', 1, ARM_STATIONS[0], torsoSkin));
      swap('arm-shell-l', buildArmShell('Arm shell L', -1, ARM_STATIONS, torsoSkin));
      swap('arm-shell-r', buildArmShell('Arm shell R', 1, ARM_STATIONS, torsoSkin));
    };
    const rebuildLegs = (): void => {
      swap('leg-shell-l', buildLegShell('Leg shell L', -1, LEG_STATIONS, torsoSkin));
      swap('leg-shell-r', buildLegShell('Leg shell R', 1, LEG_STATIONS, torsoSkin));
    };
    const rebuildHands = (): void => {
      swap('hand-l', buildHandShell('Hand L', -1, HAND_STATIONS, HAND_FINGERS,
        HAND_FINGER_PROFILE, skin, 'x', HAND_THUMB, HAND_THUMB_PROFILE, false));
      swap('hand-r', buildHandShell('Hand R', 1, HAND_STATIONS, HAND_FINGERS,
        HAND_FINGER_PROFILE, skin, 'x', HAND_THUMB, HAND_THUMB_PROFILE, false));
    };
    const rebuildFeet = (): void => {
      swap('foot-shell-l', buildPlanarOutlineShell('Foot L', -1, FOOT_OUTLINE, skin,
        ['foot', 'toe-1', 'toe-2', 'toe-3', 'toe-4', 'toe-5']));
      swap('foot-shell-r', buildPlanarOutlineShell('Foot R', 1, FOOT_OUTLINE, skin,
        ['foot', 'toe-1', 'toe-2', 'toe-3', 'toe-4', 'toe-5']));
    };
    const rebuildAllBody = (): void => {
      rebuildTorso();
      rebuildArms();
      rebuildLegs();
    };

    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;background:rgba(18,18,20,.94);'
      + 'color:#ddd;font:11px/1.35 ui-monospace,Menlo,monospace;padding:10px 12px;border-radius:6px;'
      + 'max-height:94vh;overflow:auto;width:380px;box-shadow:0 4px 24px rgba(0,0,0,.55)';
    const out = document.createElement('textarea');
    out.style.cssText = 'width:100%;height:150px;background:#0d0d0f;color:#8fd;border:1px solid #333;'
      + 'font:10px/1.3 ui-monospace,monospace;margin-top:8px;padding:4px';

    const num = (v: number): number => +v.toFixed(3);
    const dump = (): void => {
      // EMIT EVERY FIELD, INCLUDING ARRAYS AND BOOLEANS.
      //
      // This used to filter to numbers and strings only. `TorsoStation` also carries xFront, zFront,
      // xBack and zBack — the nine-point contour that IS the cross-section — and `noHug`. Pasting the
      // filtered output back therefore deleted the shape of every torso station while looking like a
      // complete line. A dump that silently drops fields is worse than no dump.
      const fmt = (v: unknown): string => {
        if (typeof v === 'string') return `'${v}'`;
        if (typeof v === 'boolean') return String(v);
        if (Array.isArray(v)) return `[${v.map((n) => num(n as number)).join(', ')}]`;
        return String(num(v as number));
      };
      const line = (st: Record<string, unknown>): string => '    { '
        + Object.keys(st).filter((k) => st[k] !== undefined)
          .map((k) => `${k}: ${fmt(st[k])}`).join(', ') + ' },';
      out.value = [
        '// BODY_SCULPT_PARAMS', line(BODY_SCULPT_PARAMS as unknown as Record<string, unknown>),
        '// BACK_SCULPT_PARAMS', line(BACK_SCULPT_PARAMS as unknown as Record<string, unknown>),
        '// TORSO_STATIONS', ...TORSO_STATIONS.map((st) => line(st as unknown as Record<string, unknown>)),
        '// ARM_STATIONS', ...ARM_STATIONS.map((st) => line(st as unknown as Record<string, unknown>)),
        '// LEG_STATIONS', ...LEG_STATIONS.map((st) => line(st as unknown as Record<string, unknown>)),
        '// HAND_STATIONS', ...HAND_STATIONS.map((st) => line(st as unknown as Record<string, unknown>)),
        '// HAND_FINGERS', ...HAND_FINGERS.map((st) => line(st as unknown as Record<string, unknown>)),
        '// HAND_FINGER_PROFILE', ...HAND_FINGER_PROFILE.map((point) => `[${num(point[0])}, ${num(point[1])}],`),
        '// HAND_THUMB', line(HAND_THUMB as unknown as Record<string, unknown>),
        '// HAND_THUMB_PROFILE', ...HAND_THUMB_PROFILE.map((st) => line(st as unknown as Record<string, unknown>)),
        '// FOOT_OUTLINE', ...FOOT_OUTLINE.map((st) => line(st as unknown as Record<string, unknown>)),
      ].join('\n');
    };

    const section = (label: string, colour: string): HTMLDivElement => {
      const d = document.createElement('div');
      const h = document.createElement('div');
      h.textContent = label;
      h.style.cssText = `font-weight:700;letter-spacing:.06em;margin:10px 0 2px;color:${colour};`
        + 'cursor:pointer;user-select:none';
      const body = document.createElement('div');
      // Collapsed by default: sixty-plus sliders open at once is not usable, and the section you are
      // working on is the only one you need open.
      body.style.display = 'none';
      h.onclick = (): void => { body.style.display = body.style.display === 'none' ? 'block' : 'none'; };
      d.append(h, body);
      panel.appendChild(d);
      return body;
    };

    const slider = (host: HTMLElement, label: string, get: () => number,
      set: (v: number) => void, span: number, after: () => void): void => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:1px 0';
      const lab = document.createElement('span');
      lab.textContent = label;
      lab.style.cssText = 'width:88px;color:#9a9aa2;overflow:hidden;text-overflow:ellipsis';
      const val = document.createElement('span');
      val.textContent = get().toFixed(3);
      val.style.cssText = 'width:48px;text-align:right;color:#ffd479';
      const sl = document.createElement('input');
      sl.type = 'range';
      // Range is centred on the authored value, so every slider starts in the middle and its travel
      // is meaningful whatever the units of that particular field are.
      sl.min = String(get() - span);
      sl.max = String(get() + span);
      sl.step = '0.002';
      sl.value = String(get());
      sl.style.cssText = 'flex:1;accent-color:#7ec8ff';
      sl.oninput = (): void => {
        set(parseFloat(sl.value));
        val.textContent = parseFloat(sl.value).toFixed(3);
        after();
        dump();
      };
      row.append(lab, sl, val);
      host.appendChild(row);
    };

    const stationGroup = (host: HTMLElement, st: Record<string, unknown>, after: () => void): void => {
      const h = document.createElement('div');
      h.textContent = String(st.name ?? st.id ?? '(station)');
      h.style.cssText = 'color:#7ec8ff;margin:6px 0 2px;border-top:1px solid #2c2c30;padding-top:5px';
      host.appendChild(h);
      for (const k of Object.keys(st)) {
        if (typeof st[k] === 'number') {
          slider(host, k, () => st[k] as number, (v) => { st[k] = v; },
            k === 'y' || k === 'x' ? 0.9 : k === 'creaseAngle' ? 0.35 : 0.5, after);
          continue;
        }
        if (!Array.isArray(st[k])) continue;
        const values = st[k] as number[];
        values.forEach((_value, index) => slider(
          host,
          `${k}[${index}]`,
          () => values[index],
          (v) => { values[index] = v; },
          0.35,
          after,
        ));
      }
    };

    const profileGroup = (host: HTMLElement, label: string, profile: Array<[number, number]>,
      after: () => void): void => {
      profile.forEach((point, index) => stationGroup(host, {
        name: `${label}-${index}`,
        get at() { return point[0]; },
        set at(v: number) { point[0] = v; },
        get scale() { return point[1]; },
        set scale(v: number) { point[1] = v; },
      }, after));
    };

    const titleBar = document.createElement('div');
    titleBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px';
    const title = document.createElement('div');
    title.textContent = 'BODY SCULPT TUNER  —  head controls disabled';
    title.style.cssText = 'font-weight:700;color:#fff;letter-spacing:.05em';
    const minimizeButton = document.createElement('button');
    minimizeButton.type = 'button';
    minimizeButton.title = 'Thu nhỏ tune panel để quay video';
    minimizeButton.setAttribute('aria-label', 'Thu nhỏ tune panel');
    minimizeButton.style.cssText = 'border:1px solid #4a4a52;border-radius:5px;background:#24242a;color:#fff;'
      + 'font:700 12px/1 ui-monospace,Menlo,monospace;padding:5px 8px;cursor:pointer;min-width:28px';
    titleBar.append(title, minimizeButton);
    panel.appendChild(titleBar);

    const legend = document.createElement('div');
    legend.textContent = 'torso: width/depth/centre · arms: x, top/bottom, front/back · legs: y, inner/outer, front/back';
    legend.style.cssText = 'margin:6px 0;color:#9a9aa2;line-height:1.45';
    panel.appendChild(legend);

    const styleBody = section('CUT STYLE  (ALL BODY SHELLS)', '#c8a2ff');
    stationGroup(
      styleBody,
      BODY_SCULPT_PARAMS as unknown as Record<string, unknown>,
      rebuildAllBody,
    );

    const backBody = section('BACK  (SCAPULA + SPINE + ERECTORS)', '#d7a9ff');
    stationGroup(
      backBody,
      BACK_SCULPT_PARAMS as unknown as Record<string, unknown>,
      rebuildTorso,
    );

    const torsoBody = section('CHEST + TORSO  (BIG CUTS)', '#8fd694');
    for (const st of TORSO_STATIONS) {
      stationGroup(torsoBody, st as unknown as Record<string, unknown>, rebuildTorso);
    }
    torsoBody.style.display = 'block';

    const armBody = section('ARMS  (BIG CUTS, MIRRORED L/R)', '#7ec8ff');
    for (const st of ARM_STATIONS) {
      stationGroup(armBody, st as unknown as Record<string, unknown>, rebuildArms);
    }

    const legBody = section('LEGS  (BIG CUTS, MIRRORED L/R)', '#ffcf7e');
    for (const st of LEG_STATIONS) {
      stationGroup(legBody, st as unknown as Record<string, unknown>, rebuildLegs);
    }

    const handBody = section('HANDS  (SHARED PALM GRID + DIGIT WEBS)', '#ff9dcf');
    for (const st of HAND_STATIONS) {
      stationGroup(handBody, st as unknown as Record<string, unknown>, rebuildHands);
    }
    for (const st of HAND_FINGERS) {
      stationGroup(handBody, st as unknown as Record<string, unknown>, rebuildHands);
    }
    profileGroup(handBody, 'finger-profile', HAND_FINGER_PROFILE, rebuildHands);
    stationGroup(handBody, HAND_THUMB as unknown as Record<string, unknown>, rebuildHands);
    for (const st of HAND_THUMB_PROFILE) {
      stationGroup(handBody, st as unknown as Record<string, unknown>, rebuildHands);
    }

    const footBody = section('FEET  (ONE SHARED FOOTPRINT)', '#73e0d1');
    for (const st of FOOT_OUTLINE) {
      stationGroup(footBody, st as unknown as Record<string, unknown>, rebuildFeet);
    }

    const hint = document.createElement('div');
    hint.textContent = 'copy these body sculpt parameters back:';
    hint.style.cssText = 'margin-top:10px;color:#9a9aa2';
    panel.append(hint, out);
    dump();
    document.body.appendChild(panel);

    // Keep the tuner available while recording without allowing it to cover the character. The
    // collapsed state is written synchronously so a reload during capture does not reopen the panel.
    const minimizedStorageKey = 'img2threejs-showcase:low-poly-humanoid:tune-panel-minimized';
    const setMinimized = (minimized: boolean, persist = true): void => {
      for (const child of Array.from(panel.children)) {
        if (child !== titleBar) (child as HTMLElement).style.display = minimized ? 'none' : '';
      }
      title.style.display = minimized ? 'none' : '';
      panel.style.width = minimized ? 'auto' : '380px';
      panel.style.maxHeight = minimized ? 'none' : '94vh';
      panel.style.overflow = minimized ? 'hidden' : 'auto';
      panel.style.padding = minimized ? '6px 8px' : '10px 12px';
      minimizeButton.textContent = minimized ? 'TUNE' : '−';
      minimizeButton.title = minimized ? 'Mở tune panel' : 'Thu nhỏ tune panel để quay video';
      minimizeButton.setAttribute('aria-label', minimized ? 'Mở tune panel' : 'Thu nhỏ tune panel');
      panel.dataset.minimized = String(minimized);
      if (persist) {
        try { window.localStorage.setItem(minimizedStorageKey, String(minimized)); } catch { /* noop */ }
      }
    };
    let initiallyMinimized = false;
    try { initiallyMinimized = window.localStorage.getItem(minimizedStorageKey) === 'true'; } catch { /* noop */ }
    minimizeButton.onclick = (): void => setMinimized(panel.dataset.minimized !== 'true');
    setMinimized(initiallyMinimized, false);
  }

  return root;
}

export function createLowPolyHumanoidLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'reference',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = 'Low Poly Humanoid look-dev lights';
  const hemisphere = new THREE.HemisphereLight(0xffead3, 0x222833, mode === 'grazing' ? 0.28 : 0.38);
  lights.add(hemisphere);
  const key = new THREE.DirectionalLight(0xffd09b, mode === 'grazing' ? 2.5 : 2.0);
  key.position.set(-4.5, 7, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -5;
  key.shadow.camera.right = 5;
  key.shadow.camera.top = 5;
  key.shadow.camera.bottom = -5;
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xaec8ff, mode === 'grazing' ? 0.08 : 0.14);
  fill.position.set(4, 3, 4);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0x8e9ebd, mode === 'grazing' ? 0.18 : 0.28);
  rim.position.set(0, 5, -5);
  lights.add(rim);
  lights.userData.lightingFromPhoto = [
    'warm key light from upper front left',
    'low cool fill preserving planar shadow values',
    'restrained rear rim, charcoal background, and foot contact shadow',
  ];
  return lights;
}
