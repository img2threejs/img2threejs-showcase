import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

type ProudRingStack = { rings: [number, number, number, number][] };

// Signed distance to a stack of ellipse rings. Negative inside, positive outside.
//
// The sign is exact; the magnitude is the first-order estimate f / |grad f|, which UNDERSTATES how
// clear an outside point is and OVERSTATES how deep an inside point is. Both errors make the march
// below push slightly further than strictly necessary, which is the safe direction: the failure
// being prevented is a component sinking into the one beneath it and rendering as a bare patch.
function ringStackDistance(stack: ProudRingStack, x: number, y: number, z: number): number {
  const rings = stack.rings;
  const yMin = rings[0][0];
  const yMax = rings[rings.length - 1][0];
  let rx = rings[0][1];
  let rz = rings[0][2];
  let zc = rings[0][3];
  if (y >= yMax) {
    const last = rings[rings.length - 1];
    rx = last[1]; rz = last[2]; zc = last[3];
  } else if (y > yMin) {
    for (let i = 0; i + 1 < rings.length; i += 1) {
      const lo = rings[i];
      const hi = rings[i + 1];
      if (y >= lo[0] && y <= hi[0]) {
        const span = hi[0] - lo[0];
        const t = span > 1e-9 ? (y - lo[0]) / span : 0;
        rx = lo[1] + (hi[1] - lo[1]) * t;
        rz = lo[2] + (hi[2] - lo[2]) * t;
        zc = lo[3] + (hi[3] - lo[3]) * t;
        break;
      }
    }
  }
  const dx = x / rx;
  const dz = (z - zc) / rz;
  const f = dx * dx + dz * dz - 1;
  const gx = (2 * x) / (rx * rx);
  const gz = (2 * (z - zc)) / (rz * rz);
  const grad = Math.hypot(gx, gz);
  const radial = grad < 1e-12 ? -Math.min(rx, rz) : f / grad;
  const axial = Math.max(yMin - y, y - yMax);
  return Math.hypot(Math.max(radial, 0), Math.max(axial, 0)) + Math.min(Math.max(radial, axial), 0);
}

// Push every vertex outward until it stands `clearance` clear of the target's surface.
//
// WHY THE AUTHORED NUMBERS ARE ONLY A LOWER BOUND. A ring is an ELLIPSE, and the surface it has to
// clear generally is not. Any single ellipse that clears the widest point is loose at the narrowest
// and vice versa, so hand-widening moves the error rather than shrinking it -- measured on hair,
// where widening the side masses took closure from 42.2% to 40.9%, worse on all six views, with
// dark coverage DOWN because the widened mass had slid off the skull. Here the authored width is a
// floor and the real radius is MEASURED per vertex.
//
// Each vertex travels along its OWN radial spoke rather than along the field's gradient, so the
// ring keeps its vertex order and its seam positions and only its radius changes. `maxPush` is
// required, not a safeguard: an uncapped march walks inner vertices straight through the target and
// out the far side, closing the very gap the component exists to leave.
function applyStandProud(
  geometry: THREE.BufferGeometry,
  marcher: THREE.Object3D,
  target: THREE.Object3D,
  stack: ProudRingStack,
  clearance: number,
  maxPush: number,
): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  marcher.updateWorldMatrix(true, false);
  target.updateWorldMatrix(true, false);
  const toTarget = new THREE.Matrix4().copy(target.matrixWorld).invert().multiply(marcher.matrixWorld);
  const fromTarget = new THREE.Matrix4().copy(toTarget).invert();
  const p = new THREE.Vector3();
  // A vertex can exhaust `maxPush` and still be inside the target. That is the cap doing its job --
  // an uncapped march walks vertices out the far side -- but it means the clearance this function
  // promises was NOT achieved, and saying nothing there hides exactly the defect the caller asked
  // to be protected from. Measured on the shipped fixture: 2 of 8 sampled hair vertices sat 0.059
  // inside a skull against a 0.04 cap and could never have reached clear.
  let unresolved = 0;

  for (let i = 0; i < position.count; i += 1) {
    p.fromBufferAttribute(position, i).applyMatrix4(toTarget);
    // The spoke is the vertex's own radial direction in the target's frame; marching along it keeps
    // each ring a ring, since every vertex holds its own angle and only its radius changes.
    //
    // A vertex on the axis has no radial direction at all -- and that is precisely the crown, the
    // one place a bald patch is most visible. Skipping it leaves the exact failure this function
    // exists to prevent. So a degenerate spoke marches axially instead, out through whichever cap
    // it is nearer, which is the direction the field itself measures there.
    const spokeLength = Math.hypot(p.x, p.z);
    const onAxis = spokeLength < 1e-9;
    const midHeight = (stack.rings[0][0] + stack.rings[stack.rings.length - 1][0]) / 2;
    const sx = onAxis ? 0 : p.x / spokeLength;
    const sz = onAxis ? 0 : p.z / spokeLength;
    const sy = onAxis ? (p.y >= midHeight ? 1 : -1) : 0;

    let travelled = 0;
    for (let step = 0; step < 24; step += 1) {
      const gap = ringStackDistance(stack, p.x, p.y, p.z);
      if (gap >= clearance) break;
      const move = Math.min(Math.max(0.002, clearance - gap), maxPush - travelled);
      if (move <= 0) break;
      p.x += sx * move;
      p.y += sy * move;
      p.z += sz * move;
      travelled += move;
    }

    if (ringStackDistance(stack, p.x, p.y, p.z) < clearance) unresolved += 1;

    p.applyMatrix4(fromTarget);
    position.setXYZ(i, p.x, p.y, p.z);
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();

  geometry.userData.standProud = { clearance, maxPush, unresolved, total: position.count };
  if (unresolved > 0) {
    console.warn(
      `standProud: ${unresolved}/${position.count} vertices could not reach ${clearance} within ` +
      `maxPush ${maxPush}. They are still inside the target and will render as bare patches. ` +
      `Raise maxPush, or move the component out so it does not start that deep.`,
    );
  }
}

type SdfVector = readonly [number, number, number];
type SdfTransform = { position?: SdfVector; translation?: SdfVector; rotation?: SdfVector; scale?: SdfVector };
type SdfPrimitive = {
  readonly id: string;
  readonly type: 'sphere' | 'capsule' | 'box' | 'cone' | 'ellipsoid';
  readonly center?: SdfVector;
  readonly radius?: number | SdfVector;
  readonly height?: number;
  readonly size?: SdfVector;
  readonly dimensions?: SdfVector;
  readonly radii?: SdfVector;
  readonly transform?: SdfTransform;
};
type SdfOperation = {
  readonly id?: string;
  readonly output?: string;
  readonly type: 'smooth-union' | 'subtract' | 'intersect';
  readonly left: string;
  readonly right: string;
  readonly radius?: number;
};
type SdfDescriptor = {
  readonly primitives: readonly SdfPrimitive[];
  readonly operations?: readonly SdfOperation[];
  readonly resolution: number;
  readonly bounds?: { readonly min: SdfVector; readonly max: SdfVector };
};
type SdfFunction = (point: THREE.Vector3) => number;

function sdfSphere(point: THREE.Vector3, radius: number): number {
  return point.length() - radius;
}

function sdfCapsule(point: THREE.Vector3, radius: number, height: number): number {
  const halfHeight = height * 0.5;
  const y = Math.max(-halfHeight, Math.min(halfHeight, point.y));
  return point.distanceTo(new THREE.Vector3(0, y, 0)) - radius;
}

function sdfBox(point: THREE.Vector3, size: SdfVector): number {
  const q = new THREE.Vector3(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z))
    .sub(new THREE.Vector3(size[0] * 0.5, size[1] * 0.5, size[2] * 0.5));
  return q.clone().max(new THREE.Vector3()).length() + Math.min(Math.max(q.x, q.y, q.z), 0);
}

function sdfCone(point: THREE.Vector3, radius: number, height: number): number {
  const halfHeight = height * 0.5;
  const taper = radius * (1 - (point.y + halfHeight) / height);
  return Math.max(Math.hypot(point.x, point.z) - Math.max(0, taper), Math.abs(point.y) - halfHeight);
}

function sdfEllipsoid(point: THREE.Vector3, radii: SdfVector): number {
  const scaled = new THREE.Vector3(point.x / radii[0], point.y / radii[1], point.z / radii[2]);
  return (scaled.length() - 1) * Math.min(radii[0], radii[1], radii[2]);
}

function sdfRadii(primitive: SdfPrimitive): SdfVector {
  const radius = primitive.radius;
  if (primitive.radii) return primitive.radii;
  if (typeof radius === 'number') return [radius, radius, radius];
  return radius ?? [0.5, 0.5, 0.5];
}

function smin(left: number, right: number, radius: number): number {
  const blend = Math.max(radius - Math.abs(left - right), 0) / radius;
  return Math.min(left, right) - blend * blend * radius * 0.25;
}

function sdfLocalPoint(point: THREE.Vector3, primitive: SdfPrimitive): { point: THREE.Vector3; scale: number } {
  const transform = primitive.transform;
  const translation = transform?.position ?? transform?.translation ?? primitive.center ?? [0, 0, 0];
  const rotation = transform?.rotation ?? [0, 0, 0];
  const scale = transform?.scale ?? [1, 1, 1];
  const local = point.clone().sub(new THREE.Vector3(translation[0], translation[1], translation[2]));
  const inverseRotation = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2]))
    .invert();
  local.applyQuaternion(inverseRotation);
  local.set(local.x / scale[0], local.y / scale[1], local.z / scale[2]);
  return { point: local, scale: Math.min(scale[0], scale[1], scale[2]) };
}

function sdfPrimitive(point: THREE.Vector3, primitive: SdfPrimitive): number {
  const local = sdfLocalPoint(point, primitive);
  let distance: number;
  switch (primitive.type) {
    case 'sphere':
      distance = sdfSphere(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.5);
      break;
    case 'capsule':
      distance = sdfCapsule(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.25, primitive.height ?? 1);
      break;
    case 'box':
      distance = sdfBox(local.point, primitive.size ?? primitive.dimensions ?? [1, 1, 1]);
      break;
    case 'cone':
      distance = sdfCone(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.5, primitive.height ?? 1);
      break;
    case 'ellipsoid':
      distance = sdfEllipsoid(local.point, sdfRadii(primitive));
      break;
  }
  return distance * local.scale;
}

function sdfSample(descriptor: SdfDescriptor): SdfFunction {
  const nodes = new Map<string, SdfFunction>();
  for (const primitive of descriptor.primitives) nodes.set(primitive.id, (point) => sdfPrimitive(point, primitive));
  let result = descriptor.primitives.length > 0 ? nodes.get(descriptor.primitives[0].id) : undefined;
  for (let index = 0; index < (descriptor.operations?.length ?? 0); index += 1) {
    const operation = descriptor.operations?.[index];
    if (!operation) continue;
    const left = nodes.get(operation.left);
    const right = nodes.get(operation.right);
    if (!left || !right) continue;
    let combined: SdfFunction;
    switch (operation.type) {
      case 'smooth-union':
        combined = (point) => smin(left(point), right(point), operation.radius ?? 0.1);
        break;
      case 'subtract':
        combined = (point) => Math.max(left(point), -right(point));
        break;
      case 'intersect':
        combined = (point) => Math.max(left(point), right(point));
        break;
    }
    nodes.set(operation.id ?? operation.output ?? `operation-${index}`, combined);
    result = combined;
  }
  return result ?? (() => Infinity);
}

function polygonizeSdf(descriptor: SdfDescriptor): THREE.BufferGeometry {
  // SURFACE NETS, not a voxel shell.
  //
  // This used to emit one axis-aligned quad per exposed voxel face, which is a Minecraft surface:
  // every face is axis-aligned, every edge is a 90-degree step, and the result is stair-stepped at
  // exactly the scale of the sampling grid. For a subject whose whole identity is smooth blended
  // organic form -- which is the only kind of subject anyone reaches for an implicit surface to
  // build -- that is worse than the assembled primitives it was meant to replace.
  //
  // Naive surface nets places ONE vertex per sign-changing cell, at the average of the linearly
  // interpolated crossings on that cell's edges, and joins the four cells around each crossing
  // edge into a quad. It is compact, manifold, and smooth, and it is a natural fit for a field
  // that can be sampled anywhere rather than only at corners.
  //
  // Normals come from the field GRADIENT, not from face averaging: the gradient is the exact
  // surface normal of the implicit surface, so shading no longer carries the grid's imprint.
  const resolution = Math.max(4, Math.min(64, Math.floor(descriptor.resolution)));
  const defaultBounds: { readonly min: SdfVector; readonly max: SdfVector } = { min: [-2, -2, -2], max: [2, 2, 2] };
  const bounds = descriptor.bounds ?? defaultBounds;
  const min = new THREE.Vector3(bounds.min[0], bounds.min[1], bounds.min[2]);
  const step = new THREE.Vector3(
    (bounds.max[0] - bounds.min[0]) / resolution,
    (bounds.max[1] - bounds.min[1]) / resolution,
    (bounds.max[2] - bounds.min[2]) / resolution,
  );
  const sample = sdfSample(descriptor);
  const scratch = new THREE.Vector3();

  // Corner grid: one more corner than cells on each axis.
  const side = resolution + 1;
  const field = new Float32Array(side * side * side);
  const cornerAt = (x: number, y: number, z: number): number => (z * side + y) * side + x;
  for (let z = 0; z < side; z += 1) {
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        scratch.set(min.x + x * step.x, min.y + y * step.y, min.z + z * step.z);
        field[cornerAt(x, y, z)] = sample(scratch);
      }
    }
  }

  // The 12 cell edges as corner-offset pairs.
  const CUBE_EDGES: readonly (readonly [number, number, number, number, number, number])[] = [
    [0, 0, 0, 1, 0, 0], [1, 0, 0, 1, 1, 0], [0, 1, 0, 1, 1, 0], [0, 0, 0, 0, 1, 0],
    [0, 0, 1, 1, 0, 1], [1, 0, 1, 1, 1, 1], [0, 1, 1, 1, 1, 1], [0, 0, 1, 0, 1, 1],
    [0, 0, 0, 0, 0, 1], [1, 0, 0, 1, 0, 1], [1, 1, 0, 1, 1, 1], [0, 1, 0, 0, 1, 1],
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const cellVertex = new Int32Array(resolution * resolution * resolution).fill(-1);
  const cellAt = (x: number, y: number, z: number): number => (z * resolution + y) * resolution + x;

  // Central-difference gradient, stepped at a fraction of a cell so it follows the field rather
  // than the grid.
  const epsilon = Math.min(step.x, step.y, step.z) * 0.25;
  const gradient = (point: THREE.Vector3): THREE.Vector3 => {
    const gx = sample(scratch.set(point.x + epsilon, point.y, point.z))
      - sample(scratch.set(point.x - epsilon, point.y, point.z));
    const gy = sample(scratch.set(point.x, point.y + epsilon, point.z))
      - sample(scratch.set(point.x, point.y - epsilon, point.z));
    const gz = sample(scratch.set(point.x, point.y, point.z + epsilon))
      - sample(scratch.set(point.x, point.y, point.z - epsilon));
    const normal = new THREE.Vector3(gx, gy, gz);
    // A point where the field is flat has no defined normal; +Y is arbitrary but finite, and
    // leaving a zero vector would poison every lighting calculation downstream.
    return normal.lengthSq() < 1e-20 ? new THREE.Vector3(0, 1, 0) : normal.normalize();
  };

  for (let z = 0; z < resolution; z += 1) {
    for (let y = 0; y < resolution; y += 1) {
      for (let x = 0; x < resolution; x += 1) {
        let crossings = 0;
        let sumX = 0;
        let sumY = 0;
        let sumZ = 0;
        for (const [ax, ay, az, bx, by, bz] of CUBE_EDGES) {
          const a = field[cornerAt(x + ax, y + ay, z + az)];
          const b = field[cornerAt(x + bx, y + by, z + bz)];
          if ((a <= 0) === (b <= 0)) continue;
          const t = a / (a - b);
          sumX += (ax + (bx - ax) * t);
          sumY += (ay + (by - ay) * t);
          sumZ += (az + (bz - az) * t);
          crossings += 1;
        }
        if (crossings === 0) continue;
        const px = min.x + (x + sumX / crossings) * step.x;
        const py = min.y + (y + sumY / crossings) * step.y;
        const pz = min.z + (z + sumZ / crossings) * step.z;
        cellVertex[cellAt(x, y, z)] = positions.length / 3;
        positions.push(px, py, pz);
        const normal = gradient(new THREE.Vector3(px, py, pz));
        normals.push(normal.x, normal.y, normal.z);
      }
    }
  }

  // One quad per sign-changing grid edge, joining the four cells that share it.
  //
  // Winding, worked out rather than guessed. For the +x edge from corner (x,y,z), the four cells
  // around it are (x, y-1, z-1), (x, y, z-1), (x, y, z), (x, y-1, z); in the (y,z) plane that
  // traversal is +y, +z, -y, whose cross product is +x. So when the corner is INSIDE and its
  // neighbour is outside, the unflipped order already faces out, and the flip belongs on the
  // opposite case. Getting this backwards is invisible in the normals -- those come from the
  // gradient and stay correct -- and shows only as back-face culling removing the front surface,
  // i.e. the model rendering as a hollow shell with its interior visible.
  const quad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c);
    else indices.push(a, b, c, a, c, d);
  };
  // Each quad joins the FOUR cells sharing one grid edge, so every one of those cells must exist.
  // Bounding only the edge axis and the lower end of the other two let y/z reach `resolution`, which
  // is a corner index, not a cell index: `cellAt` then strides into an unrelated slot (with
  // resolution 8, `cellAt(3, 8, 1)` is 131 -- the slot for cell (3, 0, 2)) or past the end of the
  // array, where a typed-array read yields `undefined`. `undefined < 0` is false, so the guard in
  // `quad` passed it through to `setIndex`, which coerces it to 0. Measured on a sphere reaching its
  // own bounds at resolution 8: 60 out-of-range reads and 108 aliased reads. A surface that touches
  // the sampling box is therefore left OPEN at that face rather than closed with wrong triangles --
  // pad `bounds` past the surface to get a closed mesh.
  for (let z = 0; z < side; z += 1) {
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const here = field[cornerAt(x, y, z)] <= 0;
        if (x + 1 < side && y > 0 && z > 0 && y < side - 1 && z < side - 1
          && here !== (field[cornerAt(x + 1, y, z)] <= 0)) {
          quad(
            cellVertex[cellAt(x, y - 1, z - 1)], cellVertex[cellAt(x, y, z - 1)],
            cellVertex[cellAt(x, y, z)], cellVertex[cellAt(x, y - 1, z)], !here,
          );
        }
        if (y + 1 < side && x > 0 && z > 0 && x < side - 1 && z < side - 1
          && here !== (field[cornerAt(x, y + 1, z)] <= 0)) {
          quad(
            cellVertex[cellAt(x - 1, y, z - 1)], cellVertex[cellAt(x - 1, y, z)],
            cellVertex[cellAt(x, y, z)], cellVertex[cellAt(x, y, z - 1)], !here,
          );
        }
        if (z + 1 < side && x > 0 && y > 0 && x < side - 1 && y < side - 1
          && here !== (field[cornerAt(x, y, z + 1)] <= 0)) {
          quad(
            cellVertex[cellAt(x - 1, y - 1, z)], cellVertex[cellAt(x, y - 1, z)],
            cellVertex[cellAt(x, y, z)], cellVertex[cellAt(x - 1, y, z)], !here,
          );
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

// THREE.CapsuleGeometry duplicates every UV-seam vertex (measured: 194 boundary
// edges on the default radius/segments below) -- same benign pattern as box/
// cylinder/sphere/torus, all of which weld cleanly to 0 given a CORRECT weld.
// (A naive vertex-only mergeVertices() reports 64 'non-manifold' edges here, but
// that is a counting artifact, not a real defect: it double-counts a handful of
// near-pole triangles that become degenerate once two of their three corners
// coincide -- confirmed by replicating subdivideCatmullClark's own degenerate-
// triangle-aware vertex identity, which finds a perfectly ordinary 2-manifold.)
// A capsule is the primary shape for skinned limbs/torso (PLAN_1.5), and skinning
// weight computation is O(vertices x bones), so fewer, guaranteed-simple vertices
// is worth having regardless -- authored as a deterministic, closed-by-
// construction mesh instead: shared pole vertices, and
// the radial index taken `% radialSegments` so the seam is never a duplicate
// vertex in the first place, rather than something to weld away afterward.
// Adapted from forge/stage5_rig/emit_rig.py's buildWatertightCapsule (verified
// there: 0 boundary edges, 0 non-manifold edges, deterministic across repeated
// runs) -- ported here rather than imported because this factory and the rig
// emitter are separate generated-output surfaces with no shared runtime module;
// see forge/tests/test_primitive_watertightness.py for the measured proof, and
// coordinate with the rig owner before changing either copy independently.
function buildWatertightCapsule(
  radius: number,
  cylLength: number,
  capSegments: number,
  radialSegments: number,
  heightSegments: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  const halfCyl = cylLength / 2;
  const totalSpan = 2 * (Math.PI / 2 * radius) + Math.max(0, cylLength);
  const vOf = (fromBottom: number) => (totalSpan > 0 ? fromBottom / totalSpan : 0);

  const bottomPoleIndex = positions.length / 3;
  positions.push(0, -halfCyl - radius, 0);
  uvs.push(0.5, vOf(0));

  const ringStarts: number[] = [];
  const ringV: number[] = [];
  for (let ring = 1; ring <= capSegments; ring += 1) {
    const phi = (Math.PI / 2) * (ring / capSegments);
    const y = -halfCyl - radius * Math.cos(phi);
    const r = radius * Math.sin(phi);
    const start = positions.length / 3;
    ringStarts.push(start);
    ringV.push(vOf(radius * phi));
    for (let radial = 0; radial < radialSegments; radial += 1) {
      const theta = (radial / radialSegments) * Math.PI * 2;
      positions.push(r * Math.cos(theta), y, r * Math.sin(theta));
      uvs.push(radial / radialSegments, vOf(radius * phi));
    }
  }

  const cylinderRingStarts: number[] = [];
  if (cylLength > 0) {
    for (let step = 1; step <= heightSegments; step += 1) {
      const y = -halfCyl + (cylLength * step) / heightSegments;
      const start = positions.length / 3;
      cylinderRingStarts.push(start);
      const v = vOf(radius * (Math.PI / 2) + halfCyl + y);
      for (let radial = 0; radial < radialSegments; radial += 1) {
        const theta = (radial / radialSegments) * Math.PI * 2;
        positions.push(radius * Math.cos(theta), y, radius * Math.sin(theta));
        uvs.push(radial / radialSegments, v);
      }
    }
  }

  const topRingStarts: number[] = [];
  for (let ring = capSegments - 1; ring >= 1; ring -= 1) {
    const phi = (Math.PI / 2) * (ring / capSegments);
    const y = halfCyl + radius * Math.cos(phi);
    const r = radius * Math.sin(phi);
    const start = positions.length / 3;
    topRingStarts.push(start);
    const v = vOf(radius * (Math.PI / 2) + Math.max(0, cylLength) + radius * (Math.PI / 2 - phi));
    for (let radial = 0; radial < radialSegments; radial += 1) {
      const theta = (radial / radialSegments) * Math.PI * 2;
      positions.push(r * Math.cos(theta), y, r * Math.sin(theta));
      uvs.push(radial / radialSegments, v);
    }
  }

  const topPoleIndex = positions.length / 3;
  positions.push(0, halfCyl + radius, 0);
  uvs.push(0.5, vOf(totalSpan));

  const firstBottomRing = ringStarts[0];
  for (let radial = 0; radial < radialSegments; radial += 1) {
    const next = (radial + 1) % radialSegments;
    indices.push(bottomPoleIndex, firstBottomRing + radial, firstBottomRing + next);
  }

  const allRings = [...ringStarts, ...cylinderRingStarts, ...topRingStarts];
  for (let i = 0; i < allRings.length - 1; i += 1) {
    const a = allRings[i];
    const b = allRings[i + 1];
    for (let radial = 0; radial < radialSegments; radial += 1) {
      const next = (radial + 1) % radialSegments;
      indices.push(a + radial, a + next, b + next);
      indices.push(a + radial, b + next, b + radial);
    }
  }

  const lastRing = allRings[allRings.length - 1];
  for (let radial = 0; radial < radialSegments; radial += 1) {
    const next = (radial + 1) % radialSegments;
    indices.push(topPoleIndex, lastRing + next, lastRing + radial);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Cartoon Courier Explorer
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createCartoonCourierExplorerModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Cartoon Courier Explorer";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 32.0, "aspect": 0.6666666666666666, "orientation": {"yaw": -4.0, "pitch": 1.5, "roll": 0.0}, "positionHint": [0.0, 0.35, 4.2], "note": "Single generated front three-quarter view; final camera is locked by browser overlay during blockout."}, "approximationNotes": []};
  root.userData.materialPipeline = {"schemaVersion": 1, "status": "proceed", "registry": "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json", "analysisArtifact": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/material-analysis.json", "targetThreshold": 0.7, "unresolvedNotObservedMaterials": [], "regions": [{"componentId": "head", "regionId": "skin-face", "specMaterialId": "skin", "profileId": "skin.human.code-only", "status": "proceed"}, {"componentId": "hair", "regionId": "hair-crown", "specMaterialId": "hair", "profileId": "hair.human.code-only", "status": "proceed"}, {"componentId": "jacket-shell", "regionId": "jacket-teal", "specMaterialId": "jacket", "profileId": "fabric.woven-matte.code-only", "status": "proceed"}, {"componentId": "shirt-shell", "regionId": "shirt-cream", "specMaterialId": "shirt", "profileId": "fabric.woven-matte.code-only", "status": "proceed"}, {"componentId": "scarf-wrap", "regionId": "scarf-orange", "specMaterialId": "scarf", "profileId": "fabric.woven-matte.code-only", "status": "proceed"}, {"componentId": "belt", "regionId": "leather-dark", "specMaterialId": "leather-dark", "profileId": "leather.matte", "status": "proceed"}, {"componentId": "boot-l", "regionId": "leather-tan", "specMaterialId": "leather-tan", "profileId": "leather.matte", "status": "proceed"}, {"componentId": "belt-buckle", "regionId": "brass-buckle", "specMaterialId": "brass", "profileId": "metal.brass", "status": "proceed"}, {"componentId": "sole-l", "regionId": "rubber-sole", "specMaterialId": "rubber", "profileId": "rubber.matte", "status": "proceed"}, {"componentId": "eye-l", "regionId": "eye-gloss", "specMaterialId": "eye", "profileId": "plastic.glossy", "status": "proceed"}, {"componentId": "mouth", "regionId": "lip-crease", "specMaterialId": "lips", "profileId": "skin.human.code-only", "status": "proceed"}, {"componentId": "thigh-l", "regionId": "pants-charcoal", "specMaterialId": "pants", "profileId": "fabric.woven-matte.code-only", "status": "proceed"}, {"componentId": "foot-l", "regionId": "shoe-leather", "specMaterialId": "shoes", "profileId": "leather.matte", "status": "proceed"}], "controlledViewsRequired": ["albedo-unlit", "environment-reflection", "grazing", "neutral-studio", "reference-beauty"]};
  root.userData.materialReferenceRegistry = "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json";

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["base"] = createSculptMaterial(
    "base",
    {"id": "base", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#8A7A5F", "color": "#8A7A5F", "albedo": {"dominant": "#8A7A5F", "secondary": ["#6E614B", "#A08F70"], "samplingNotes": "Use image-observed local color zones, not a single averaged color."}, "colorVariation": {"palette": ["#8A7A5F", "#6E614B", "#A08F70"], "pattern": "mottled", "amplitude": 0.15, "heightCorrelation": 0.3}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.75, "variation": 0.15, "map": "independent-procedural-field", "localResponse": "higher roughness in cavities, lower roughness on worn edges"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "qualityTier": "utility"},
    options
  );
  materialMap["hidden"] = createSculptMaterial(
    "hidden",
    {"id": "hidden", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#000000", "color": "#000000", "albedo": {"dominant": "#000000", "secondary": ["#000000"]}, "colorVariation": {"palette": ["#000000", "#000000"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 1.0, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "opacity": {"base": 0.0}, "qualityTier": "utility"},
    options
  );
  materialMap["skin"] = createSculptMaterial(
    "skin",
    {"id": "skin", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#DE9B6C", "color": "#DE9B6C", "albedo": {"dominant": "#DE9B6C", "secondary": ["#F4B689"]}, "colorVariation": {"palette": ["#e8b98f", "#be9875"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.55, "variation": 0.08, "map": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_roughness.png"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "skin-blush", "kind": "stain", "description": "Localized cheek and nose warmth with soft falloff.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "referenceMaterialId": "skin.human.code-only", "materialFamily": "skin", "materialSubtype": "human-code-only", "materialFinish": "natural", "materialReference": {"registry": "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json", "profileId": "skin.human.code-only", "method": "explicit-material-id", "confidence": 1.0, "sourceRefs": ["three.mesh-physical", "nvidia.faceworks"], "requiredMaps": [], "optionalMaps": [], "validationViews": ["albedo-unlit", "neutral-studio", "grazing", "reference-beauty"]}, "clearcoat": {"base": 0.18, "variation": 0.0}, "clearcoatRoughness": {"base": 0.38, "variation": 0.0}, "ior": {"base": 1.4, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_albedo.png", "url": "/references/cartoon-courier/materials/skin_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_roughness.png", "url": "/references/cartoon-courier/materials/skin_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_height.png", "url": "/references/cartoon-courier/materials/skin_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_normal.png", "url": "/references/cartoon-courier/materials/skin_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_ao.png", "url": "/references/cartoon-courier/materials/skin_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 245, "sourceHeight": 190, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 245, "height": 190}, "mask": {"backgroundColor": "#EAE4E0", "backgroundNoise": 306.659, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.8661}, "mapStats": {"valueRange": 0.7393, "heightP90Gradient": 0.08073, "roughnessBase": 0.71, "roughnessVariation": 0.143, "normalStrength": 0.251, "blurRadius": 10}, "palette": ["#1B0E06", "#F1B07F", "#D48B58", "#462816", "#9A582C"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "candy-coat", "recipe": {"metalness": 0.35, "roughness": 0.18, "clearcoat": 0.6, "clearcoatRoughness": 0.15, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.7, "anisotropy": 0.0, "procedural": "gradient-smoke"}, "palette": ["#694E40", "#7D5439", "#DA9969", "#9C6A47", "#DDD7D2"], "paletteHueRisk": [], "gradientAxis": "horizontal", "stats": {"meanLum": 115.2, "meanSaturation": 0.572, "gradientStrength": 0.599, "mottle": 0.081, "streakRatio": 1.23, "hueSpread": 0.013, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "head", "regionId": "skin-face", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "bbox": {"x": 405, "y": 155, "width": 245, "height": 190}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0296}, "observations": ["chromatic base-colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "head", "regionId": "skin-face", "materialId": "skin.human.code-only", "family": "skin", "subtype": "human-code-only", "finish": "natural", "aliases": [], "confidence": 0.86, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["hair"] = createSculptMaterial(
    "hair",
    {"id": "hair", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#2A1810", "color": "#2A1810", "albedo": {"dominant": "#2A1810", "secondary": ["#56311D"]}, "colorVariation": {"palette": ["#171310", "#13100d"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.38, "variation": 0.1, "map": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-01-hair-crown/hair_roughness.png"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "hair-directional-highlight", "kind": "gloss", "description": "Directional low-roughness response along clump tangents.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "referenceMaterialId": "hair.human.code-only", "materialFamily": "hair", "materialSubtype": "human-code-only", "materialFinish": "strand-directional", "materialReference": {"registry": "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json", "profileId": "hair.human.code-only", "method": "explicit-material-id", "confidence": 1.0, "sourceRefs": ["three.mesh-physical", "pbrt.hair"], "requiredMaps": [], "optionalMaps": [], "validationViews": ["neutral-studio", "grazing", "reference-beauty"]}, "anisotropy": {"base": 0.8, "variation": 0.0}, "sheen": {"base": 0.6, "variation": 0.0}, "sheenRoughness": {"base": 0.3, "variation": 0.0}, "ior": {"base": 1.55, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/01-hair-crown.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-01-hair-crown/hair_albedo.png", "url": "/references/cartoon-courier/materials/hair_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-01-hair-crown/hair_roughness.png", "url": "/references/cartoon-courier/materials/hair_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-01-hair-crown/hair_height.png", "url": "/references/cartoon-courier/materials/hair_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-01-hair-crown/hair_normal.png", "url": "/references/cartoon-courier/materials/hair_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-01-hair-crown/hair_ao.png", "url": "/references/cartoon-courier/materials/hair_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 335, "sourceHeight": 205, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 310, "height": 205}, "mask": {"backgroundColor": "#E6E1DC", "backgroundNoise": 5.831, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.6322}, "mapStats": {"valueRange": 0.7172, "heightP90Gradient": 0.06816, "roughnessBase": 0.712, "roughnessVariation": 0.122, "normalStrength": 0.236, "blurRadius": 10}, "palette": ["#2E1B11", "#493022", "#140904", "#784F35", "#E8B388"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "candy-coat", "recipe": {"metalness": 0.35, "roughness": 0.18, "clearcoat": 0.6, "clearcoatRoughness": 0.15, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.7, "anisotropy": 0.0, "procedural": "gradient-smoke"}, "palette": ["#E3DED9", "#877870", "#524238", "#654B39", "#8B654C"], "paletteHueRisk": [], "gradientAxis": "vertical", "stats": {"meanLum": 110.4, "meanSaturation": 0.437, "gradientStrength": 0.677, "mottle": 0.073, "streakRatio": 1.25, "hueSpread": 0.003, "specularFraction": 0.009}}, "materialEvidence": {"componentId": "hair", "regionId": "hair-crown", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/01-hair-crown.png", "bbox": {"x": 350, "y": 28, "width": 335, "height": 205}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0437}, "observations": ["chromatic base-colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "hair", "regionId": "hair-crown", "materialId": "hair.human.code-only", "family": "hair", "subtype": "human-code-only", "finish": "strand-directional", "aliases": [], "confidence": 0.86, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["shirt"] = createSculptMaterial(
    "shirt",
    {"id": "shirt", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#E0D3B5", "color": "#E0D3B5", "albedo": {"dominant": "#E0D3B5", "secondary": ["#BFAE8F"]}, "colorVariation": {"palette": ["#20202a", "#1a1a22"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.9, "variation": 0.12, "map": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-03-shirt-cream/shirt_roughness.png"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "referenceMaterialId": "fabric.woven-matte.code-only", "materialFamily": "fabric", "materialSubtype": "woven-code-only", "materialFinish": "matte", "materialReference": {"registry": "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json", "profileId": "fabric.woven-matte.code-only", "method": "explicit-material-id", "confidence": 1.0, "sourceRefs": ["three.mesh-physical", "khronos.sheen"], "requiredMaps": [], "optionalMaps": [], "validationViews": ["albedo-unlit", "neutral-studio", "grazing", "reference-beauty"]}, "sheen": {"base": 0.7, "variation": 0.0}, "sheenRoughness": {"base": 0.85, "variation": 0.0}, "ior": {"base": 1.5, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/03-shirt-cream.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-03-shirt-cream/shirt_albedo.png", "url": "/references/cartoon-courier/materials/shirt_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-03-shirt-cream/shirt_roughness.png", "url": "/references/cartoon-courier/materials/shirt_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-03-shirt-cream/shirt_height.png", "url": "/references/cartoon-courier/materials/shirt_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-03-shirt-cream/shirt_normal.png", "url": "/references/cartoon-courier/materials/shirt_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-03-shirt-cream/shirt_ao.png", "url": "/references/cartoon-courier/materials/shirt_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 110, "sourceHeight": 160, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 110, "height": 160}, "mask": {"backgroundColor": "#7D5F3C", "backgroundNoise": 80.623, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9866}, "mapStats": {"valueRange": 0.6563, "heightP90Gradient": 0.07132, "roughnessBase": 0.724, "roughnessVariation": 0.129, "normalStrength": 0.24, "blurRadius": 10}, "palette": ["#4C3320", "#E5C8A6", "#4E5C4E", "#8D6740", "#C4A37E"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "candy-coat", "recipe": {"metalness": 0.35, "roughness": 0.18, "clearcoat": 0.6, "clearcoatRoughness": 0.15, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.7, "anisotropy": 0.0, "procedural": "gradient-smoke"}, "palette": ["#A58566", "#B09172", "#B99B7E", "#64573C", "#4E594A"], "paletteHueRisk": [], "gradientAxis": "horizontal", "stats": {"meanLum": 121.7, "meanSaturation": 0.412, "gradientStrength": 0.369, "mottle": 0.058, "streakRatio": 1.09, "hueSpread": 0.11, "specularFraction": 0.0}}, "materialEvidence": {"componentId": "shirt-shell", "regionId": "shirt-cream", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/03-shirt-cream.png", "bbox": {"x": 445, "y": 505, "width": 110, "height": 160}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0112}, "observations": ["chromatic base-colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "shirt-shell", "regionId": "shirt-cream", "materialId": "fabric.woven-matte.code-only", "family": "fabric", "subtype": "woven-code-only", "finish": "matte", "aliases": [], "confidence": 0.829, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["pants"] = createSculptMaterial(
    "pants",
    {"id": "pants", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#362F2A", "color": "#362F2A", "albedo": {"dominant": "#362F2A", "secondary": ["#52453B"]}, "colorVariation": {"palette": ["#2b2d33", "#23252a"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.9, "variation": 0.1, "map": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-11-pants-charcoal/pants_roughness.png"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "referenceMaterialId": "fabric.woven-matte.code-only", "materialFamily": "fabric", "materialSubtype": "woven-code-only", "materialFinish": "matte", "materialReference": {"registry": "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json", "profileId": "fabric.woven-matte.code-only", "method": "explicit-material-id", "confidence": 1.0, "sourceRefs": ["three.mesh-physical", "khronos.sheen"], "requiredMaps": [], "optionalMaps": [], "validationViews": ["albedo-unlit", "neutral-studio", "grazing", "reference-beauty"]}, "sheen": {"base": 0.7, "variation": 0.0}, "sheenRoughness": {"base": 0.85, "variation": 0.0}, "ior": {"base": 1.5, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/11-pants-charcoal.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-11-pants-charcoal/pants_albedo.png", "url": "/references/cartoon-courier/materials/pants_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-11-pants-charcoal/pants_roughness.png", "url": "/references/cartoon-courier/materials/pants_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-11-pants-charcoal/pants_height.png", "url": "/references/cartoon-courier/materials/pants_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-11-pants-charcoal/pants_normal.png", "url": "/references/cartoon-courier/materials/pants_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-11-pants-charcoal/pants_ao.png", "url": "/references/cartoon-courier/materials/pants_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 225, "sourceHeight": 285, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 225, "height": 285}, "mask": {"backgroundColor": "#38251A", "backgroundNoise": 70.434, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9964}, "mapStats": {"valueRange": 0.8303, "heightP90Gradient": 0.04056, "roughnessBase": 0.699, "roughnessVariation": 0.051, "normalStrength": 0.204, "blurRadius": 10}, "palette": ["#403026", "#302219", "#4F3C31", "#19110A", "#E9E4E0"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "candy-coat", "recipe": {"metalness": 0.35, "roughness": 0.18, "clearcoat": 0.6, "clearcoatRoughness": 0.15, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.7, "anisotropy": 0.0, "procedural": "gradient-smoke"}, "palette": ["#2B1D14", "#392B22", "#A19994", "#3F2E23", "#5C4E45"], "paletteHueRisk": [], "gradientAxis": "horizontal", "stats": {"meanLum": 68.8, "meanSaturation": 0.4, "gradientStrength": 0.551, "mottle": 0.041, "streakRatio": 1.37, "hueSpread": 0.002, "specularFraction": 0.007}}, "materialEvidence": {"componentId": "thigh-l", "regionId": "pants-charcoal", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/11-pants-charcoal.png", "bbox": {"x": 390, "y": 770, "width": 225, "height": 285}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0408}, "observations": ["chromatic base-colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "thigh-l", "regionId": "pants-charcoal", "materialId": "fabric.woven-matte.code-only", "family": "fabric", "subtype": "woven-code-only", "finish": "matte", "aliases": [], "confidence": 0.829, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["shoes"] = createSculptMaterial(
    "shoes",
    {"id": "shoes", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#966330", "color": "#966330", "albedo": {"dominant": "#966330", "secondary": ["#5D371C"]}, "colorVariation": {"palette": ["#171512", "#13110f"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.62, "variation": 0.08, "map": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-12-shoe-leather/shoes_roughness.png"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "referenceMaterialId": "leather.matte", "materialFamily": "leather", "materialSubtype": "natural-or-synthetic", "materialFinish": "matte-worn", "materialReference": {"registry": "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json", "profileId": "leather.matte", "method": "explicit-material-id", "confidence": 1.0, "sourceRefs": ["three.mesh-physical", "three.mesh-standard", "adobe.pbr-guide-2", "mit.material-recognition"], "requiredMaps": ["map", "roughnessMap", "normalMap"], "optionalMaps": ["aoMap", "clearcoatMap"], "validationViews": ["albedo-unlit", "neutral-studio", "grazing", "reference-beauty"]}, "clearcoat": {"base": 0.08, "variation": 0.0}, "clearcoatRoughness": {"base": 0.45, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/12-shoe-leather.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-12-shoe-leather/shoes_albedo.png", "url": "/references/cartoon-courier/materials/shoes_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-12-shoe-leather/shoes_roughness.png", "url": "/references/cartoon-courier/materials/shoes_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-12-shoe-leather/shoes_height.png", "url": "/references/cartoon-courier/materials/shoes_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-12-shoe-leather/shoes_normal.png", "url": "/references/cartoon-courier/materials/shoes_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-12-shoe-leather/shoes_ao.png", "url": "/references/cartoon-courier/materials/shoes_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 205, "sourceHeight": 215, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 205, "height": 215}, "mask": {"backgroundColor": "#D5CDC8", "backgroundNoise": 29.58, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.6876}, "mapStats": {"valueRange": 0.3226, "heightP90Gradient": 0.12856, "roughnessBase": 0.73, "roughnessVariation": 0.203, "normalStrength": 0.307, "blurRadius": 10}, "palette": ["#4B2F1C", "#663E21", "#81512B", "#9C6A40", "#28160A"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#B19C8C", "#99877C", "#83644F", "#6E4626", "#9C9490"], "paletteHueRisk": [], "gradientAxis": "vertical", "stats": {"meanLum": 113.3, "meanSaturation": 0.455, "gradientStrength": 0.405, "mottle": 0.038, "streakRatio": 0.78, "hueSpread": 0.001, "specularFraction": 0.001}}, "materialEvidence": {"componentId": "foot-l", "regionId": "shoe-leather", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/12-shoe-leather.png", "bbox": {"x": 265, "y": 1215, "width": 205, "height": 215}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.028}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "foot-l", "regionId": "shoe-leather", "materialId": "leather.matte", "family": "leather", "subtype": "natural-or-synthetic", "finish": "matte-worn", "aliases": [], "confidence": 0.86, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["eye"] = createSculptMaterial(
    "eye",
    {"id": "eye", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#F2EBDB", "color": "#F2EBDB", "albedo": {"dominant": "#F2EBDB", "secondary": ["#B16714"]}, "colorVariation": {"palette": ["#f2eee4", "#c6c3bb"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.28, "variation": 0.03, "map": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-09-eye-gloss/eye_roughness.png"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "referenceMaterialId": "plastic.glossy", "materialFamily": "plastic", "materialSubtype": "generic-polymer", "materialFinish": "glossy", "materialReference": {"registry": "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json", "profileId": "plastic.glossy", "method": "explicit-material-id", "confidence": 1.0, "sourceRefs": ["three.mesh-physical", "three.mesh-standard", "adobe.pbr-guide-1", "google.filament-pbr", "mit.material-recognition"], "requiredMaps": ["map", "roughnessMap"], "optionalMaps": ["normalMap", "clearcoatMap"], "validationViews": ["neutral-studio", "grazing", "environment-reflection", "reference-beauty"]}, "clearcoat": {"base": 0.2, "variation": 0.0}, "clearcoatRoughness": {"base": 0.18, "variation": 0.0}, "ior": {"base": 1.5, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/09-eye-gloss.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-09-eye-gloss/eye_albedo.png", "url": "/references/cartoon-courier/materials/eye_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-09-eye-gloss/eye_roughness.png", "url": "/references/cartoon-courier/materials/eye_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-09-eye-gloss/eye_height.png", "url": "/references/cartoon-courier/materials/eye_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-09-eye-gloss/eye_normal.png", "url": "/references/cartoon-courier/materials/eye_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-09-eye-gloss/eye_ao.png", "url": "/references/cartoon-courier/materials/eye_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 62, "sourceHeight": 72, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 62, "height": 72}, "mask": {"backgroundColor": "#DE8051", "backgroundNoise": 65.498, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9693}, "mapStats": {"valueRange": 0.7095, "heightP90Gradient": 0.05804, "roughnessBase": 0.695, "roughnessVariation": 0.09, "normalStrength": 0.224, "blurRadius": 10}, "palette": ["#E79D6A", "#8D4F22", "#1E0D05", "#C07642", "#E6BFA2"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#603C24", "#A96636", "#7B563C", "#CC956C", "#E28F5F"], "paletteHueRisk": [], "gradientAxis": "vertical", "stats": {"meanLum": 127.1, "meanSaturation": 0.618, "gradientStrength": 0.439, "mottle": 0.035, "streakRatio": 0.83, "hueSpread": 0.006, "specularFraction": 0.005}}, "materialEvidence": {"componentId": "eye-l", "regionId": "eye-gloss", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/09-eye-gloss.png", "bbox": {"x": 455, "y": 215, "width": 62, "height": 72}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0028}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "eye-l", "regionId": "eye-gloss", "materialId": "plastic.glossy", "family": "plastic", "subtype": "generic-polymer", "finish": "glossy", "aliases": [], "confidence": 0.829, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["lips"] = createSculptMaterial(
    "lips",
    {"id": "lips", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#9B4D3B", "color": "#9B4D3B", "albedo": {"dominant": "#9B4D3B", "secondary": ["#DE896F"]}, "colorVariation": {"palette": ["#c98070", "#a5695c"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.55, "variation": 0.05, "map": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-10-lip-crease/lips_roughness.png"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "referenceMaterialId": "skin.human.code-only", "materialFamily": "skin", "materialSubtype": "human-code-only", "materialFinish": "natural", "materialReference": {"registry": "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json", "profileId": "skin.human.code-only", "method": "explicit-material-id", "confidence": 1.0, "sourceRefs": ["three.mesh-physical", "nvidia.faceworks"], "requiredMaps": [], "optionalMaps": [], "validationViews": ["albedo-unlit", "neutral-studio", "grazing", "reference-beauty"]}, "clearcoat": {"base": 0.18, "variation": 0.0}, "clearcoatRoughness": {"base": 0.38, "variation": 0.0}, "ior": {"base": 1.4, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/10-lip-crease.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-10-lip-crease/lips_albedo.png", "url": "/references/cartoon-courier/materials/lips_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-10-lip-crease/lips_roughness.png", "url": "/references/cartoon-courier/materials/lips_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-10-lip-crease/lips_height.png", "url": "/references/cartoon-courier/materials/lips_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-10-lip-crease/lips_normal.png", "url": "/references/cartoon-courier/materials/lips_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-10-lip-crease/lips_ao.png", "url": "/references/cartoon-courier/materials/lips_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 115, "sourceHeight": 35, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 115, "height": 35}, "mask": {"backgroundColor": "#C3814E", "backgroundNoise": 78.403, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9975}, "mapStats": {"valueRange": 0.6889, "heightP90Gradient": 0.02718, "roughnessBase": 0.692, "roughnessVariation": 0.05, "normalStrength": 0.188, "blurRadius": 10}, "palette": ["#CD8853", "#F1B481", "#E3A06A", "#A66031", "#140B05"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#B5723F", "#C7844F", "#E8A471", "#E4A774", "#6F543F"], "paletteHueRisk": [], "gradientAxis": "horizontal", "stats": {"meanLum": 151.8, "meanSaturation": 0.576, "gradientStrength": 0.428, "mottle": 0.027, "streakRatio": 1.79, "hueSpread": 0.004, "specularFraction": 0.001}}, "materialEvidence": {"componentId": "mouth", "regionId": "lip-crease", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/10-lip-crease.png", "bbox": {"x": 470, "y": 300, "width": 115, "height": 35}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0026}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "mouth", "regionId": "lip-crease", "materialId": "skin.human.code-only", "family": "skin", "subtype": "human-code-only", "finish": "natural", "aliases": [], "confidence": 0.829, "source": "vision"}, "alternatives": []}},
    options
  );
  materialMap["jacket"] = createSculptMaterial(
    "jacket",
    {"id": "jacket", "baseColor": "#375853", "referenceMaterialId": "fabric.woven-matte.code-only", "materialFamily": "fabric", "materialSubtype": "woven-code-only", "materialFinish": "matte", "materialReference": {"registry": "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json", "profileId": "fabric.woven-matte.code-only", "method": "explicit-material-id", "confidence": 1.0, "sourceRefs": ["three.mesh-physical", "khronos.sheen"], "requiredMaps": [], "optionalMaps": [], "validationViews": ["albedo-unlit", "neutral-studio", "grazing", "reference-beauty"]}, "metalness": {"base": 0.0, "variation": 0.0}, "roughness": {"base": 0.9, "variation": 0.0, "map": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-02-jacket-teal/jacket_roughness.png"}, "sheen": {"base": 0.7, "variation": 0.0}, "sheenRoughness": {"base": 0.85, "variation": 0.0}, "ior": {"base": 1.5, "variation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "colorSpace": "SRGBColorSpace for albedo; NoColorSpace for scalar/normal maps", "mapBindings": []}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/02-jacket-teal.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.839, "estimatedFidelity": 0.839, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-02-jacket-teal/jacket_albedo.png", "url": "/references/cartoon-courier/materials/jacket_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-02-jacket-teal/jacket_roughness.png", "url": "/references/cartoon-courier/materials/jacket_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-02-jacket-teal/jacket_height.png", "url": "/references/cartoon-courier/materials/jacket_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-02-jacket-teal/jacket_normal.png", "url": "/references/cartoon-courier/materials/jacket_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-02-jacket-teal/jacket_ao.png", "url": "/references/cartoon-courier/materials/jacket_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 105, "sourceHeight": 215, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 105, "height": 215}, "mask": {"backgroundColor": "#475B52", "backgroundNoise": 134.967, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.827}, "mapStats": {"valueRange": 0.322, "heightP90Gradient": 0.06485, "roughnessBase": 0.737, "roughnessVariation": 0.121, "normalStrength": 0.232, "blurRadius": 10}, "palette": ["#4A5F55", "#576D62", "#354136", "#1D1C14", "#9E4A20"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#2E382F", "#3E4B41", "#51594C", "#70776C", "#BFC0BB"], "paletteHueRisk": [], "gradientAxis": "horizontal", "stats": {"meanLum": 101.5, "meanSaturation": 0.265, "gradientStrength": 0.551, "mottle": 0.031, "streakRatio": 0.84, "hueSpread": 0.466, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "jacket-shell", "regionId": "jacket-teal", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/02-jacket-teal.png", "bbox": {"x": 600, "y": 395, "width": 105, "height": 215}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0144}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "jacket-shell", "regionId": "jacket-teal", "materialId": "fabric.woven-matte.code-only", "family": "fabric", "subtype": "woven-code-only", "finish": "matte", "aliases": [], "confidence": 0.839, "source": "vision"}, "alternatives": []}, "ambientOcclusion": {"cavityStrength": 0.24, "contactShadowBias": 0.3, "notes": "Independent AO response concentrated at seams and attachments."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.18, "role": "broad color variation"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.08, "role": "folds, grain and edge wear"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.025, "role": "grazing highlight breakup"}], "color": "#375853", "albedo": {"dominant": "#375853", "secondary": ["#53756C"]}},
    options
  );
  materialMap["scarf"] = createSculptMaterial(
    "scarf",
    {"id": "scarf", "baseColor": "#9F421D", "referenceMaterialId": "fabric.woven-matte.code-only", "materialFamily": "fabric", "materialSubtype": "woven-code-only", "materialFinish": "matte", "materialReference": {"registry": "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json", "profileId": "fabric.woven-matte.code-only", "method": "explicit-material-id", "confidence": 1.0, "sourceRefs": ["three.mesh-physical", "khronos.sheen"], "requiredMaps": [], "optionalMaps": [], "validationViews": ["albedo-unlit", "neutral-studio", "grazing", "reference-beauty"]}, "metalness": {"base": 0.0, "variation": 0.0}, "roughness": {"base": 0.9, "variation": 0.0, "map": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-04-scarf-orange/scarf_roughness.png"}, "sheen": {"base": 0.7, "variation": 0.0}, "sheenRoughness": {"base": 0.85, "variation": 0.0}, "ior": {"base": 1.5, "variation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "colorSpace": "SRGBColorSpace for albedo; NoColorSpace for scalar/normal maps", "mapBindings": []}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/04-scarf-orange.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.816, "estimatedFidelity": 0.816, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-04-scarf-orange/scarf_albedo.png", "url": "/references/cartoon-courier/materials/scarf_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-04-scarf-orange/scarf_roughness.png", "url": "/references/cartoon-courier/materials/scarf_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-04-scarf-orange/scarf_height.png", "url": "/references/cartoon-courier/materials/scarf_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-04-scarf-orange/scarf_normal.png", "url": "/references/cartoon-courier/materials/scarf_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-04-scarf-orange/scarf_ao.png", "url": "/references/cartoon-courier/materials/scarf_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 180, "sourceHeight": 125, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 180, "height": 125}, "mask": {"backgroundColor": "#98584F", "backgroundNoise": 163.052, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9824}, "mapStats": {"valueRange": 0.4266, "heightP90Gradient": 0.08533, "roughnessBase": 0.733, "roughnessVariation": 0.139, "normalStrength": 0.256, "blurRadius": 10}, "palette": ["#833B14", "#B56130", "#3F392B", "#52665A", "#2A0F05"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "candy-coat", "recipe": {"metalness": 0.35, "roughness": 0.18, "clearcoat": 0.6, "clearcoatRoughness": 0.15, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.7, "anisotropy": 0.0, "procedural": "gradient-smoke"}, "palette": ["#662A0D", "#95451A", "#774A2C", "#49483A", "#6E6151"], "paletteHueRisk": [], "gradientAxis": "horizontal", "stats": {"meanLum": 77.0, "meanSaturation": 0.629, "gradientStrength": 0.198, "mottle": 0.051, "streakRatio": 1.21, "hueSpread": 0.159, "specularFraction": 0.0}}, "materialEvidence": {"componentId": "scarf-wrap", "regionId": "scarf-orange", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/04-scarf-orange.png", "bbox": {"x": 450, "y": 356, "width": 180, "height": 125}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0143}, "observations": ["chromatic base-colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "scarf-wrap", "regionId": "scarf-orange", "materialId": "fabric.woven-matte.code-only", "family": "fabric", "subtype": "woven-code-only", "finish": "matte", "aliases": [], "confidence": 0.816, "source": "vision"}, "alternatives": []}, "ambientOcclusion": {"cavityStrength": 0.24, "contactShadowBias": 0.3, "notes": "Independent AO response concentrated at seams and attachments."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.18, "role": "broad color variation"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.08, "role": "folds, grain and edge wear"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.025, "role": "grazing highlight breakup"}], "color": "#9F421D", "albedo": {"dominant": "#9F421D", "secondary": ["#C55B2A"]}},
    options
  );
  materialMap["leather-dark"] = createSculptMaterial(
    "leather-dark",
    {"id": "leather-dark", "baseColor": "#492B1B", "referenceMaterialId": "leather.matte", "materialFamily": "leather", "materialSubtype": "natural-or-synthetic", "materialFinish": "matte-worn", "materialReference": {"registry": "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json", "profileId": "leather.matte", "method": "explicit-material-id", "confidence": 1.0, "sourceRefs": ["three.mesh-physical", "three.mesh-standard", "adobe.pbr-guide-2", "mit.material-recognition"], "requiredMaps": ["map", "roughnessMap", "normalMap"], "optionalMaps": ["aoMap", "clearcoatMap"], "validationViews": ["albedo-unlit", "neutral-studio", "grazing", "reference-beauty"]}, "metalness": {"base": 0.0, "variation": 0.0}, "roughness": {"base": 0.62, "variation": 0.0, "map": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-05-leather-dark/leather-dark_roughness.png"}, "clearcoat": {"base": 0.08, "variation": 0.0}, "clearcoatRoughness": {"base": 0.45, "variation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "colorSpace": "SRGBColorSpace for albedo; NoColorSpace for scalar/normal maps", "mapBindings": ["map", "roughnessMap", "normalMap"]}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/05-leather-dark.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.858, "estimatedFidelity": 0.858, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-05-leather-dark/leather-dark_albedo.png", "url": "/references/cartoon-courier/materials/leather-dark_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-05-leather-dark/leather-dark_roughness.png", "url": "/references/cartoon-courier/materials/leather-dark_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-05-leather-dark/leather-dark_height.png", "url": "/references/cartoon-courier/materials/leather-dark_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-05-leather-dark/leather-dark_normal.png", "url": "/references/cartoon-courier/materials/leather-dark_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-05-leather-dark/leather-dark_ao.png", "url": "/references/cartoon-courier/materials/leather-dark_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 160, "sourceHeight": 80, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 150, "height": 80}, "mask": {"backgroundColor": "#ECE7E3", "backgroundNoise": 293.636, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.8548}, "mapStats": {"valueRange": 0.3996, "heightP90Gradient": 0.11301, "roughnessBase": 0.744, "roughnessVariation": 0.182, "normalStrength": 0.289, "blurRadius": 10}, "palette": ["#513727", "#3C2515", "#785130", "#170C04", "#B69165"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "candy-coat", "recipe": {"metalness": 0.35, "roughness": 0.18, "clearcoat": 0.6, "clearcoatRoughness": 0.15, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.7, "anisotropy": 0.0, "procedural": "gradient-smoke"}, "palette": ["#4C321D", "#523928", "#683F22", "#3A2518", "#D9D0CA"], "paletteHueRisk": [], "gradientAxis": "horizontal", "stats": {"meanLum": 72.1, "meanSaturation": 0.557, "gradientStrength": 0.67, "mottle": 0.059, "streakRatio": 1.43, "hueSpread": 0.004, "specularFraction": 0.006}}, "materialEvidence": {"componentId": "belt", "regionId": "leather-dark", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/05-leather-dark.png", "bbox": {"x": 450, "y": 670, "width": 160, "height": 80}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0081}, "observations": ["chromatic base-colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "belt", "regionId": "leather-dark", "materialId": "leather.matte", "family": "leather", "subtype": "natural-or-synthetic", "finish": "matte-worn", "aliases": [], "confidence": 0.858, "source": "vision"}, "alternatives": []}, "ambientOcclusion": {"cavityStrength": 0.24, "contactShadowBias": 0.3, "notes": "Independent AO response concentrated at seams and attachments."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.18, "role": "broad color variation"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.08, "role": "folds, grain and edge wear"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.025, "role": "grazing highlight breakup"}], "localOverrides": [{"id": "leather-edge-wear", "kind": "scratch", "description": "Sparse lighter wear on exposed leather rims.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "color": "#492B1B", "albedo": {"dominant": "#492B1B", "secondary": ["#704628"]}},
    options
  );
  materialMap["leather-tan"] = createSculptMaterial(
    "leather-tan",
    {"id": "leather-tan", "baseColor": "#97632F", "referenceMaterialId": "leather.matte", "materialFamily": "leather", "materialSubtype": "natural-or-synthetic", "materialFinish": "matte-worn", "materialReference": {"registry": "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json", "profileId": "leather.matte", "method": "explicit-material-id", "confidence": 1.0, "sourceRefs": ["three.mesh-physical", "three.mesh-standard", "adobe.pbr-guide-2", "mit.material-recognition"], "requiredMaps": ["map", "roughnessMap", "normalMap"], "optionalMaps": ["aoMap", "clearcoatMap"], "validationViews": ["albedo-unlit", "neutral-studio", "grazing", "reference-beauty"]}, "metalness": {"base": 0.0, "variation": 0.0}, "roughness": {"base": 0.62, "variation": 0.0, "map": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-06-leather-tan/leather-tan_roughness.png"}, "clearcoat": {"base": 0.08, "variation": 0.0}, "clearcoatRoughness": {"base": 0.45, "variation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "colorSpace": "SRGBColorSpace for albedo; NoColorSpace for scalar/normal maps", "mapBindings": ["map", "roughnessMap", "normalMap"]}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/06-leather-tan.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-06-leather-tan/leather-tan_albedo.png", "url": "/references/cartoon-courier/materials/leather-tan_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-06-leather-tan/leather-tan_roughness.png", "url": "/references/cartoon-courier/materials/leather-tan_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-06-leather-tan/leather-tan_height.png", "url": "/references/cartoon-courier/materials/leather-tan_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-06-leather-tan/leather-tan_normal.png", "url": "/references/cartoon-courier/materials/leather-tan_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-06-leather-tan/leather-tan_ao.png", "url": "/references/cartoon-courier/materials/leather-tan_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 205, "sourceHeight": 215, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 205, "height": 215}, "mask": {"backgroundColor": "#D5CDC8", "backgroundNoise": 29.58, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.6876}, "mapStats": {"valueRange": 0.3226, "heightP90Gradient": 0.12856, "roughnessBase": 0.73, "roughnessVariation": 0.203, "normalStrength": 0.307, "blurRadius": 10}, "palette": ["#4B2F1C", "#663E21", "#81512B", "#9C6A40", "#28160A"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "painted-metal", "recipe": {"metalness": 0.0, "roughness": 0.5, "clearcoat": 1.0, "clearcoatRoughness": 0.05, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 1.0, "anisotropy": 0.0, "procedural": "flat-clearcoat"}, "palette": ["#B19C8C", "#99877C", "#83644F", "#6E4626", "#9C9490"], "paletteHueRisk": [], "gradientAxis": "vertical", "stats": {"meanLum": 113.3, "meanSaturation": 0.455, "gradientStrength": 0.405, "mottle": 0.038, "streakRatio": 0.78, "hueSpread": 0.001, "specularFraction": 0.001}}, "materialEvidence": {"componentId": "boot-l", "regionId": "leather-tan", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/06-leather-tan.png", "bbox": {"x": 265, "y": 1215, "width": 205, "height": 215}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.028}, "observations": ["chromatic base-colour response", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "boot-l", "regionId": "leather-tan", "materialId": "leather.matte", "family": "leather", "subtype": "natural-or-synthetic", "finish": "matte-worn", "aliases": [], "confidence": 0.86, "source": "vision"}, "alternatives": []}, "ambientOcclusion": {"cavityStrength": 0.24, "contactShadowBias": 0.3, "notes": "Independent AO response concentrated at seams and attachments."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.18, "role": "broad color variation"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.08, "role": "folds, grain and edge wear"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.025, "role": "grazing highlight breakup"}], "localOverrides": [{"id": "leather-edge-wear", "kind": "scratch", "description": "Sparse lighter wear on exposed leather rims.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "color": "#97632F", "albedo": {"dominant": "#97632F", "secondary": ["#BC8441"]}},
    options
  );
  materialMap["brass"] = createSculptMaterial(
    "brass",
    {"id": "brass", "baseColor": "#AE772B", "referenceMaterialId": "metal.brass", "materialFamily": "metal", "materialSubtype": "brass-bronze", "materialFinish": "polished-or-aged", "materialReference": {"registry": "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json", "profileId": "metal.brass", "method": "explicit-material-id", "confidence": 1.0, "sourceRefs": ["three.mesh-standard", "gltf.2", "khronos.gltf-pbr", "adobe.pbr-guide-2", "google.filament-pbr"], "requiredMaps": ["map", "roughnessMap"], "optionalMaps": ["normalMap", "aoMap", "metalnessMap"], "validationViews": ["albedo-unlit", "environment-reflection", "grazing", "reference-beauty"]}, "metalness": {"base": 1.0, "variation": 0.0}, "roughness": {"base": 0.3, "variation": 0.0, "map": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-07-brass-buckle/brass_roughness.png"}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "colorSpace": "SRGBColorSpace for albedo; NoColorSpace for scalar/normal maps", "mapBindings": ["map", "roughnessMap"]}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/07-brass-buckle.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.809, "estimatedFidelity": 0.809, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-07-brass-buckle/brass_albedo.png", "url": "/references/cartoon-courier/materials/brass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-07-brass-buckle/brass_roughness.png", "url": "/references/cartoon-courier/materials/brass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-07-brass-buckle/brass_height.png", "url": "/references/cartoon-courier/materials/brass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-07-brass-buckle/brass_normal.png", "url": "/references/cartoon-courier/materials/brass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-07-brass-buckle/brass_ao.png", "url": "/references/cartoon-courier/materials/brass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 72, "sourceHeight": 58, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 72, "height": 58}, "mask": {"backgroundColor": "#5E4125", "backgroundNoise": 54.378, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9988}, "mapStats": {"valueRange": 0.401, "heightP90Gradient": 0.08832, "roughnessBase": 0.741, "roughnessVariation": 0.151, "normalStrength": 0.26, "blurRadius": 10}, "palette": ["#583925", "#83562F", "#3E2515", "#160A03", "#CCA56F"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "candy-coat", "recipe": {"metalness": 0.35, "roughness": 0.18, "clearcoat": 0.6, "clearcoatRoughness": 0.15, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.7, "anisotropy": 0.0, "procedural": "gradient-smoke"}, "palette": ["#553924", "#916F43", "#4C3221", "#533624", "#6D4223"], "paletteHueRisk": [], "gradientAxis": "horizontal", "stats": {"meanLum": 64.1, "meanSaturation": 0.637, "gradientStrength": 0.421, "mottle": 0.044, "streakRatio": 1.22, "hueSpread": 0.004, "specularFraction": 0.001}}, "materialEvidence": {"componentId": "belt-buckle", "regionId": "brass-buckle", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/07-brass-buckle.png", "bbox": {"x": 458, "y": 681, "width": 72, "height": 58}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0027}, "observations": ["chromatic base-colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "belt-buckle", "regionId": "brass-buckle", "materialId": "metal.brass", "family": "metal", "subtype": "brass-bronze", "finish": "polished-or-aged", "aliases": [], "confidence": 0.809, "source": "vision"}, "alternatives": []}, "needsEnvironment": true, "ambientOcclusion": {"cavityStrength": 0.24, "contactShadowBias": 0.3, "notes": "Independent AO response concentrated at seams and attachments."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.18, "role": "broad color variation"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.08, "role": "folds, grain and edge wear"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.025, "role": "grazing highlight breakup"}], "color": "#AE772B", "albedo": {"dominant": "#AE772B", "secondary": ["#DEA94D"]}},
    options
  );
  materialMap["rubber"] = createSculptMaterial(
    "rubber",
    {"id": "rubber", "baseColor": "#281F19", "referenceMaterialId": "rubber.matte", "materialFamily": "rubber", "materialSubtype": "generic-elastomer", "materialFinish": "matte", "materialReference": {"registry": "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json", "profileId": "rubber.matte", "method": "explicit-material-id", "confidence": 1.0, "sourceRefs": ["three.mesh-standard", "adobe.pbr-guide-1", "google.filament-pbr", "mit.material-recognition"], "requiredMaps": ["map", "roughnessMap", "normalMap"], "optionalMaps": ["aoMap"], "validationViews": ["albedo-unlit", "neutral-studio", "grazing", "reference-beauty"]}, "metalness": {"base": 0.0, "variation": 0.0}, "roughness": {"base": 0.88, "variation": 0.0, "map": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-08-rubber-sole/rubber_roughness.png"}, "ior": {"base": 1.48, "variation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "colorSpace": "SRGBColorSpace for albedo; NoColorSpace for scalar/normal maps", "mapBindings": ["map", "roughnessMap", "normalMap"]}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/08-rubber-sole.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-08-rubber-sole/rubber_albedo.png", "url": "/references/cartoon-courier/materials/rubber_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-08-rubber-sole/rubber_roughness.png", "url": "/references/cartoon-courier/materials/rubber_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-08-rubber-sole/rubber_height.png", "url": "/references/cartoon-courier/materials/rubber_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-08-rubber-sole/rubber_normal.png", "url": "/references/cartoon-courier/materials/rubber_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-08-rubber-sole/rubber_ao.png", "url": "/references/cartoon-courier/materials/rubber_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 245, "sourceHeight": 62, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 245, "height": 46}, "mask": {"backgroundColor": "#D7D0CB", "backgroundNoise": 39.912, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.462}, "mapStats": {"valueRange": 0.3669, "heightP90Gradient": 0.08708, "roughnessBase": 0.71, "roughnessVariation": 0.156, "normalStrength": 0.258, "blurRadius": 10}, "palette": ["#503A2B", "#3E2B1E", "#744F33", "#19110B", "#887B71"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "candy-coat", "recipe": {"metalness": 0.35, "roughness": 0.18, "clearcoat": 0.6, "clearcoatRoughness": 0.15, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.7, "anisotropy": 0.0, "procedural": "gradient-smoke"}, "palette": ["#5B3D25", "#594537", "#7C6D62", "#80746C", "#CDC4C0"], "paletteHueRisk": [], "gradientAxis": "vertical", "stats": {"meanLum": 107.6, "meanSaturation": 0.333, "gradientStrength": 0.534, "mottle": 0.046, "streakRatio": 1.76, "hueSpread": 0.002, "specularFraction": 0.0}}, "materialEvidence": {"componentId": "sole-l", "regionId": "rubber-sole", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/08-rubber-sole.png", "bbox": {"x": 250, "y": 1385, "width": 245, "height": 62}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0097}, "observations": ["chromatic base-colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "sole-l", "regionId": "rubber-sole", "materialId": "rubber.matte", "family": "rubber", "subtype": "generic-elastomer", "finish": "matte", "aliases": [], "confidence": 0.86, "source": "vision"}, "alternatives": []}, "ambientOcclusion": {"cavityStrength": 0.24, "contactShadowBias": 0.3, "notes": "Independent AO response concentrated at seams and attachments."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.18, "role": "broad color variation"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.08, "role": "folds, grain and edge wear"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.025, "role": "grazing highlight breakup"}], "color": "#281F19", "albedo": {"dominant": "#281F19", "secondary": ["#433125"]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Character (root)__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Character (root)", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Character (root) is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0.0, 0.0, 0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "root", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Character (root)";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Character (root)", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Character (root) is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0.0, 0.0, 0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "root", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_pelvis_1 = makeAttachmentEndpoint(null);
  const node_pelvis_1 = new THREE.Group();
  node_pelvis_1.name = "Pelvis__pivot";
  node_pelvis_1.scale.set(1, 1, 1);
  if (endpoint_pelvis_1) {
    node_pelvis_1.position.copy(endpoint_pelvis_1.start);
    node_pelvis_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pelvis_1.position.set(0.0, -0.20300000000000004, 0.0);
    node_pelvis_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_pelvis_1.userData.sculptComponent = {"id": "pelvis", "name": "Pelvis", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Pelvis is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.25004, "height": 0.15791999999999998, "depth": 0.1974, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.20300000000000004, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.25004, 0.15791999999999998, 0.1974]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pelvis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "pelvis", "dominantAlbedo": "rgba(67, 50, 40, 1.0)", "secondaryAlbedo": "rgba(34, 24, 17, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.302, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/11-pants-charcoal.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.631}}};
  node_pelvis_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pelvis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}};
  (nodes["root"] ?? root).add(node_pelvis_1);
  nodes["pelvis"] = node_pelvis_1;
  const mesh_pelvis_1Geometry = endpoint_pelvis_1
    ? new THREE.CylinderGeometry(endpoint_pelvis_1.endRadius, endpoint_pelvis_1.baseRadius, endpoint_pelvis_1.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_pelvis_1) {
    mesh_pelvis_1Geometry.scale(0.25004, 0.15791999999999998, 0.1974);
  }
  const mesh_pelvis_1 = new THREE.SkinnedMesh(
    mesh_pelvis_1Geometry,
    materialMap["pants"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pelvis_1.name = "Pelvis";
  if (endpoint_pelvis_1) {
    mesh_pelvis_1.position.copy(endpoint_pelvis_1.midpoint);
    mesh_pelvis_1.quaternion.copy(endpoint_pelvis_1.quaternion);
  }
  mesh_pelvis_1.castShadow = options.castShadow ?? true;
  mesh_pelvis_1.receiveShadow = options.receiveShadow ?? true;
  mesh_pelvis_1.userData.sculptComponent = {"id": "pelvis", "name": "Pelvis", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Pelvis is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.25004, "height": 0.15791999999999998, "depth": 0.1974, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.20300000000000004, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.25004, 0.15791999999999998, 0.1974]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pelvis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "pelvis", "dominantAlbedo": "rgba(67, 50, 40, 1.0)", "secondaryAlbedo": "rgba(34, 24, 17, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.302, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/11-pants-charcoal.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.631}}};
  node_pelvis_1.add(mesh_pelvis_1);
  meshes["pelvis"] = mesh_pelvis_1;
  colliders["pelvis"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["pelvis"] ??= [];
  destructionGroups["pelvis"].push(node_pelvis_1);

  const attachment_abdomen_2 = {"parentSocket": "pelvis-waist", "localStart": [0.0, 0.028, 0.0], "localEnd": [0.0, 0.30436, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.10528, "endRadius": 0.12757, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_abdomen_2 = makeAttachmentEndpoint(attachment_abdomen_2);
  const node_abdomen_2 = new THREE.Group();
  node_abdomen_2.name = "Abdomen__pivot";
  node_abdomen_2.scale.set(1, 1, 1);
  if (endpoint_abdomen_2) {
    node_abdomen_2.position.copy(endpoint_abdomen_2.start);
    node_abdomen_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_abdomen_2.position.set(0.0, 0.027999999999999997, 0.0);
    node_abdomen_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_abdomen_2.userData.sculptComponent = {"id": "abdomen", "name": "Abdomen", "level": "macro", "role": "shell", "importance": 0.95, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Abdomen is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "pelvis", "attachment": {"parentSocket": "pelvis-waist", "localStart": [0.0, 0.028, 0.0], "localEnd": [0.0, 0.30436, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.10528, "endRadius": 0.12757, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.23688, "height": 0.27636000000000005, "depth": 0.21056, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, 0.027999999999999997, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.23688, 0.27636000000000005, 0.21056]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "abdomen", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "shirt", "materialLayers": ["shirt"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "abdomen", "dominantAlbedo": "rgba(78, 67, 50, 1.0)", "secondaryAlbedo": "rgba(224, 194, 159, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.247, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/03-shirt-cream.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.49}}};
  node_abdomen_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "abdomen", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}};
  (nodes["pelvis"] ?? root).add(node_abdomen_2);
  nodes["abdomen"] = node_abdomen_2;
  const mesh_abdomen_2Geometry = endpoint_abdomen_2
    ? new THREE.CylinderGeometry(endpoint_abdomen_2.endRadius, endpoint_abdomen_2.baseRadius, endpoint_abdomen_2.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_abdomen_2) {
    mesh_abdomen_2Geometry.scale(0.23688, 0.27636000000000005, 0.21056);
  }
  const mesh_abdomen_2 = new THREE.SkinnedMesh(
    mesh_abdomen_2Geometry,
    materialMap["shirt"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_abdomen_2.name = "Abdomen";
  if (endpoint_abdomen_2) {
    mesh_abdomen_2.position.copy(endpoint_abdomen_2.midpoint);
    mesh_abdomen_2.quaternion.copy(endpoint_abdomen_2.quaternion);
  }
  mesh_abdomen_2.castShadow = options.castShadow ?? true;
  mesh_abdomen_2.receiveShadow = options.receiveShadow ?? true;
  mesh_abdomen_2.userData.sculptComponent = {"id": "abdomen", "name": "Abdomen", "level": "macro", "role": "shell", "importance": 0.95, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Abdomen is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "pelvis", "attachment": {"parentSocket": "pelvis-waist", "localStart": [0.0, 0.028, 0.0], "localEnd": [0.0, 0.30436, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.10528, "endRadius": 0.12757, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.23688, "height": 0.27636000000000005, "depth": 0.21056, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, 0.027999999999999997, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.23688, 0.27636000000000005, 0.21056]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "abdomen", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "shirt", "materialLayers": ["shirt"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "abdomen", "dominantAlbedo": "rgba(78, 67, 50, 1.0)", "secondaryAlbedo": "rgba(224, 194, 159, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.247, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/03-shirt-cream.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.49}}};
  node_abdomen_2.add(mesh_abdomen_2);
  meshes["abdomen"] = mesh_abdomen_2;
  colliders["abdomen"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["abdomen"] ??= [];
  destructionGroups["abdomen"].push(node_abdomen_2);

  const attachment_chest_3 = {"parentSocket": "abdomen-chest", "localStart": [0.0, 0.27636, 0.0028], "localEnd": [0.0, 0.658, 0.0056], "contactType": "rigid-weld", "baseRadius": 0.14258, "endRadius": 0.09755, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_chest_3 = makeAttachmentEndpoint(attachment_chest_3);
  const node_chest_3 = new THREE.Group();
  node_chest_3.name = "Chest__pivot";
  node_chest_3.scale.set(1, 1, 1);
  if (endpoint_chest_3) {
    node_chest_3.position.copy(endpoint_chest_3.start);
    node_chest_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chest_3.position.set(0.0, 0.27636000000000005, 0.0028000000000000004);
    node_chest_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_chest_3.userData.sculptComponent = {"id": "chest", "name": "Chest", "level": "macro", "role": "shell", "importance": 1.0, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Chest is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "abdomen", "attachment": {"parentSocket": "abdomen-chest", "localStart": [0.0, 0.27636, 0.0028], "localEnd": [0.0, 0.658, 0.0056], "contactType": "rigid-weld", "baseRadius": 0.14258, "endRadius": 0.09755, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.35644000000000003, "height": 0.3816400000000001, "depth": 0.22371999999999997, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, 0.27636000000000005, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.35644000000000003, 0.3816400000000001, 0.22371999999999997]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "shirt", "materialLayers": ["shirt"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "chest", "dominantAlbedo": "rgba(78, 67, 50, 1.0)", "secondaryAlbedo": "rgba(224, 194, 159, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.247, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/03-shirt-cream.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.49}}};
  node_chest_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}};
  (nodes["abdomen"] ?? root).add(node_chest_3);
  nodes["chest"] = node_chest_3;
  const mesh_chest_3Geometry = endpoint_chest_3
    ? new THREE.CylinderGeometry(endpoint_chest_3.endRadius, endpoint_chest_3.baseRadius, endpoint_chest_3.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_chest_3) {
    mesh_chest_3Geometry.scale(0.35644000000000003, 0.3816400000000001, 0.22371999999999997);
  }
  const mesh_chest_3 = new THREE.SkinnedMesh(
    mesh_chest_3Geometry,
    materialMap["shirt"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_3.name = "Chest";
  if (endpoint_chest_3) {
    mesh_chest_3.position.copy(endpoint_chest_3.midpoint);
    mesh_chest_3.quaternion.copy(endpoint_chest_3.quaternion);
  }
  mesh_chest_3.castShadow = options.castShadow ?? true;
  mesh_chest_3.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_3.userData.sculptComponent = {"id": "chest", "name": "Chest", "level": "macro", "role": "shell", "importance": 1.0, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Chest is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "abdomen", "attachment": {"parentSocket": "abdomen-chest", "localStart": [0.0, 0.27636, 0.0028], "localEnd": [0.0, 0.658, 0.0056], "contactType": "rigid-weld", "baseRadius": 0.14258, "endRadius": 0.09755, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.35644000000000003, "height": 0.3816400000000001, "depth": 0.22371999999999997, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, 0.27636000000000005, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.35644000000000003, 0.3816400000000001, 0.22371999999999997]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "shirt", "materialLayers": ["shirt"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "chest", "dominantAlbedo": "rgba(78, 67, 50, 1.0)", "secondaryAlbedo": "rgba(224, 194, 159, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.247, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/03-shirt-cream.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.49}}};
  node_chest_3.add(mesh_chest_3);
  meshes["chest"] = mesh_chest_3;
  colliders["chest"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest"] ??= [];
  destructionGroups["chest"].push(node_chest_3);

  const attachment_neck_4 = {"parentSocket": "chest-neck-base", "localStart": [0.0, 0.35924, 0.0028], "localEnd": [0.0, 0.45164, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.0728, "endRadius": 0.056, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_neck_4 = makeAttachmentEndpoint(attachment_neck_4);
  const node_neck_4 = new THREE.Group();
  node_neck_4.name = "Neck__pivot";
  node_neck_4.scale.set(1, 1, 1);
  if (endpoint_neck_4) {
    node_neck_4.position.copy(endpoint_neck_4.start);
    node_neck_4.rotation.set(0.0, 0.03490658503988659, 0.0);
  } else {
    node_neck_4.position.set(0.0, 0.3592400000000001, 0.0028000000000000004);
    node_neck_4.rotation.set(0.0, 0.03490658503988659, 0.0);
  }
  node_neck_4.userData.sculptComponent = {"id": "neck", "name": "Neck", "level": "meso", "role": "support", "importance": 0.6, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Neck is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "chest", "attachment": {"parentSocket": "chest-neck-base", "localStart": [0.0, 0.35924, 0.0028], "localEnd": [0.0, 0.45164, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.0728, "endRadius": 0.056, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.15400000000000003, "height": 0.09240000000000004, "depth": 0.15400000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, 0.3592400000000001, 0.0028000000000000004], "rotation": [0.0, 0.03490658503988659, 0.0], "scale": [0.15400000000000003, 0.09240000000000004, 0.15400000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "neck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "neck", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_neck_4.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "neck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["chest"] ?? root).add(node_neck_4);
  nodes["neck"] = node_neck_4;
  const mesh_neck_4Geometry = endpoint_neck_4
    ? new THREE.CylinderGeometry(endpoint_neck_4.endRadius, endpoint_neck_4.baseRadius, endpoint_neck_4.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_neck_4) {
    mesh_neck_4Geometry.scale(0.15400000000000003, 0.09240000000000004, 0.15400000000000003);
  }
  const mesh_neck_4 = new THREE.SkinnedMesh(
    mesh_neck_4Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_neck_4.name = "Neck";
  if (endpoint_neck_4) {
    mesh_neck_4.position.copy(endpoint_neck_4.midpoint);
    mesh_neck_4.quaternion.copy(endpoint_neck_4.quaternion);
  }
  mesh_neck_4.castShadow = options.castShadow ?? true;
  mesh_neck_4.receiveShadow = options.receiveShadow ?? true;
  mesh_neck_4.userData.sculptComponent = {"id": "neck", "name": "Neck", "level": "meso", "role": "support", "importance": 0.6, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Neck is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "chest", "attachment": {"parentSocket": "chest-neck-base", "localStart": [0.0, 0.35924, 0.0028], "localEnd": [0.0, 0.45164, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.0728, "endRadius": 0.056, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.15400000000000003, "height": 0.09240000000000004, "depth": 0.15400000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, 0.3592400000000001, 0.0028000000000000004], "rotation": [0.0, 0.03490658503988659, 0.0], "scale": [0.15400000000000003, 0.09240000000000004, 0.15400000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "neck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "neck", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_neck_4.add(mesh_neck_4);
  meshes["neck"] = mesh_neck_4;
  colliders["neck"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["neck"] ??= [];
  destructionGroups["neck"].push(node_neck_4);

  const endpoint_head_5 = makeAttachmentEndpoint(null);
  const node_head_5 = new THREE.Group();
  node_head_5.name = "Head__pivot";
  node_head_5.scale.set(1, 1, 1);
  if (endpoint_head_5) {
    node_head_5.position.copy(endpoint_head_5.start);
    node_head_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_head_5.position.set(0.0, 0.2380000000000001, 0.0);
    node_head_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_head_5.userData.sculptComponent = {"id": "head", "name": "Head", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Head is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "neck", "attachment": null, "dimensions": {"width": 0.25760000000000005, "height": 0.31360000000000005, "depth": 0.27440000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, 0.2380000000000001, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.25760000000000005, 0.31360000000000005, 0.27440000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "skin"}, "materialRegions": [{"regionId": "skin-face", "materialId": "skin", "profileId": "skin.human.code-only", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "bbox": {"x": 405, "y": 155, "width": 245, "height": 190}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0296}}, {"regionId": "skin-face", "materialId": "skin", "profileId": "skin.human.code-only", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "bbox": {"x": 405, "y": 155, "width": 245, "height": 190}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0296}}], "colorMaterialRecipe": {"componentId": "head", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_head_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["neck"] ?? root).add(node_head_5);
  nodes["head"] = node_head_5;
  const mesh_head_5Geometry = endpoint_head_5
    ? new THREE.CylinderGeometry(endpoint_head_5.endRadius, endpoint_head_5.baseRadius, endpoint_head_5.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_head_5) {
    mesh_head_5Geometry.scale(0.25760000000000005, 0.31360000000000005, 0.27440000000000003);
  }
  const mesh_head_5 = new THREE.SkinnedMesh(
    mesh_head_5Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_head_5.name = "Head";
  if (endpoint_head_5) {
    mesh_head_5.position.copy(endpoint_head_5.midpoint);
    mesh_head_5.quaternion.copy(endpoint_head_5.quaternion);
  }
  mesh_head_5.castShadow = options.castShadow ?? true;
  mesh_head_5.receiveShadow = options.receiveShadow ?? true;
  mesh_head_5.userData.sculptComponent = {"id": "head", "name": "Head", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Head is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "neck", "attachment": null, "dimensions": {"width": 0.25760000000000005, "height": 0.31360000000000005, "depth": 0.27440000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, 0.2380000000000001, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.25760000000000005, 0.31360000000000005, 0.27440000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "skin"}, "materialRegions": [{"regionId": "skin-face", "materialId": "skin", "profileId": "skin.human.code-only", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "bbox": {"x": 405, "y": 155, "width": 245, "height": 190}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0296}}, {"regionId": "skin-face", "materialId": "skin", "profileId": "skin.human.code-only", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "bbox": {"x": 405, "y": 155, "width": 245, "height": 190}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0296}}], "colorMaterialRecipe": {"componentId": "head", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_head_5.add(mesh_head_5);
  meshes["head"] = mesh_head_5;
  colliders["head"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_head_5);

  const endpoint_hair_6 = makeAttachmentEndpoint(null);
  const node_hair_6 = new THREE.Group();
  node_hair_6.name = "Hair__pivot";
  node_hair_6.scale.set(1, 1, 1);
  if (endpoint_hair_6) {
    node_hair_6.position.copy(endpoint_hair_6.start);
    node_hair_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_6.position.set(0.0, 0.084, -0.005600000000000001);
    node_hair_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_6.userData.sculptComponent = {"id": "hair", "name": "Hair", "level": "meso", "role": "hair", "importance": 0.8, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Hair is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.28, "height": 0.21840000000000004, "depth": 0.2856, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.084, -0.005600000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [0.28, 0.21840000000000004, 0.2856]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["short, neutral stylized hairstyle", {"id": "hair-clumps", "kind": "contour", "description": "Asymmetric overlapping swept clumps with embedded roots and tapered tips.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "hair"}, "materialRegions": [{"regionId": "hair-crown", "materialId": "hair", "profileId": "hair.human.code-only", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/01-hair-crown.png", "bbox": {"x": 350, "y": 28, "width": 335, "height": 205}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0437}}, {"regionId": "hair-crown", "materialId": "hair", "profileId": "hair.human.code-only", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/01-hair-crown.png", "bbox": {"x": 350, "y": 28, "width": 335, "height": 205}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0437}}], "colorMaterialRecipe": {"componentId": "hair", "dominantAlbedo": "rgba(80, 54, 40, 1.0)", "secondaryAlbedo": "rgba(36, 22, 14, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.135, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/01-hair-crown.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.537}}, "standProud": {"againstComponentId": "head", "clearance": 0.012, "maxPush": 0.08}};
  node_hair_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_6);
  nodes["hair"] = node_hair_6;
  const mesh_hair_6Geometry = endpoint_hair_6
    ? new THREE.CylinderGeometry(endpoint_hair_6.endRadius, endpoint_hair_6.baseRadius, endpoint_hair_6.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_hair_6) {
    mesh_hair_6Geometry.scale(0.28, 0.21840000000000004, 0.2856);
  }
  const mesh_hair_6 = new THREE.Mesh(
    mesh_hair_6Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_6.name = "Hair";
  if (endpoint_hair_6) {
    mesh_hair_6.position.copy(endpoint_hair_6.midpoint);
    mesh_hair_6.quaternion.copy(endpoint_hair_6.quaternion);
  }
  mesh_hair_6.castShadow = options.castShadow ?? true;
  mesh_hair_6.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_6.userData.sculptComponent = {"id": "hair", "name": "Hair", "level": "meso", "role": "hair", "importance": 0.8, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Hair is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.28, "height": 0.21840000000000004, "depth": 0.2856, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.084, -0.005600000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [0.28, 0.21840000000000004, 0.2856]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["short, neutral stylized hairstyle", {"id": "hair-clumps", "kind": "contour", "description": "Asymmetric overlapping swept clumps with embedded roots and tapered tips.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "hair"}, "materialRegions": [{"regionId": "hair-crown", "materialId": "hair", "profileId": "hair.human.code-only", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/01-hair-crown.png", "bbox": {"x": 350, "y": 28, "width": 335, "height": 205}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0437}}, {"regionId": "hair-crown", "materialId": "hair", "profileId": "hair.human.code-only", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/01-hair-crown.png", "bbox": {"x": 350, "y": 28, "width": 335, "height": 205}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0437}}], "colorMaterialRecipe": {"componentId": "hair", "dominantAlbedo": "rgba(80, 54, 40, 1.0)", "secondaryAlbedo": "rgba(36, 22, 14, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.135, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/01-hair-crown.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.537}}, "standProud": {"againstComponentId": "head", "clearance": 0.012, "maxPush": 0.08}};
  node_hair_6.add(mesh_hair_6);
  meshes["hair"] = mesh_hair_6;
  colliders["hair"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair"] ??= [];
  destructionGroups["hair"].push(node_hair_6);

  const endpoint_brow_l_7 = makeAttachmentEndpoint(null);
  const node_brow_l_7 = new THREE.Group();
  node_brow_l_7.name = "Eyebrow L__pivot";
  node_brow_l_7.scale.set(1, 1, 1);
  if (endpoint_brow_l_7) {
    node_brow_l_7.position.copy(endpoint_brow_l_7.start);
    node_brow_l_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_brow_l_7.position.set(0.05600000000000001, 0.033600000000000005, 0.12880000000000003);
    node_brow_l_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_brow_l_7.userData.sculptComponent = {"id": "brow-l", "name": "Eyebrow L", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Eyebrow L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.06160000000000001, "height": 0.011200000000000002, "depth": 0.016800000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.05600000000000001, 0.033600000000000005, 0.12880000000000003], "rotation": [0.0, 0.0, 0.0], "scale": [0.06160000000000001, 0.011200000000000002, 0.016800000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "brow-l", "dominantAlbedo": "rgba(80, 54, 40, 1.0)", "secondaryAlbedo": "rgba(36, 22, 14, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.135, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/01-hair-crown.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.537}}};
  node_brow_l_7.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_brow_l_7);
  nodes["brow-l"] = node_brow_l_7;
  const mesh_brow_l_7Geometry = endpoint_brow_l_7
    ? new THREE.CylinderGeometry(endpoint_brow_l_7.endRadius, endpoint_brow_l_7.baseRadius, endpoint_brow_l_7.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_brow_l_7) {
    mesh_brow_l_7Geometry.scale(0.06160000000000001, 0.011200000000000002, 0.016800000000000002);
  }
  const mesh_brow_l_7 = new THREE.Mesh(
    mesh_brow_l_7Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brow_l_7.name = "Eyebrow L";
  if (endpoint_brow_l_7) {
    mesh_brow_l_7.position.copy(endpoint_brow_l_7.midpoint);
    mesh_brow_l_7.quaternion.copy(endpoint_brow_l_7.quaternion);
  }
  mesh_brow_l_7.castShadow = options.castShadow ?? true;
  mesh_brow_l_7.receiveShadow = options.receiveShadow ?? true;
  mesh_brow_l_7.userData.sculptComponent = {"id": "brow-l", "name": "Eyebrow L", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Eyebrow L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.06160000000000001, "height": 0.011200000000000002, "depth": 0.016800000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.05600000000000001, 0.033600000000000005, 0.12880000000000003], "rotation": [0.0, 0.0, 0.0], "scale": [0.06160000000000001, 0.011200000000000002, 0.016800000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "brow-l", "dominantAlbedo": "rgba(80, 54, 40, 1.0)", "secondaryAlbedo": "rgba(36, 22, 14, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.135, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/01-hair-crown.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.537}}};
  node_brow_l_7.add(mesh_brow_l_7);
  meshes["brow-l"] = mesh_brow_l_7;
  colliders["brow-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["brow-l"] ??= [];
  destructionGroups["brow-l"].push(node_brow_l_7);

  const endpoint_brow_r_8 = makeAttachmentEndpoint(null);
  const node_brow_r_8 = new THREE.Group();
  node_brow_r_8.name = "Eyebrow R__pivot";
  node_brow_r_8.scale.set(1, 1, 1);
  if (endpoint_brow_r_8) {
    node_brow_r_8.position.copy(endpoint_brow_r_8.start);
    node_brow_r_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_brow_r_8.position.set(-0.05600000000000001, 0.033600000000000005, 0.12880000000000003);
    node_brow_r_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_brow_r_8.userData.sculptComponent = {"id": "brow-r", "name": "Eyebrow R", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Eyebrow R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.06160000000000001, "height": 0.011200000000000002, "depth": 0.016800000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.05600000000000001, 0.033600000000000005, 0.12880000000000003], "rotation": [0.0, 0.0, 0.0], "scale": [0.06160000000000001, 0.011200000000000002, 0.016800000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "brow-r", "dominantAlbedo": "rgba(80, 54, 40, 1.0)", "secondaryAlbedo": "rgba(36, 22, 14, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.135, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/01-hair-crown.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.537}}};
  node_brow_r_8.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_brow_r_8);
  nodes["brow-r"] = node_brow_r_8;
  const mesh_brow_r_8Geometry = endpoint_brow_r_8
    ? new THREE.CylinderGeometry(endpoint_brow_r_8.endRadius, endpoint_brow_r_8.baseRadius, endpoint_brow_r_8.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_brow_r_8) {
    mesh_brow_r_8Geometry.scale(0.06160000000000001, 0.011200000000000002, 0.016800000000000002);
  }
  const mesh_brow_r_8 = new THREE.Mesh(
    mesh_brow_r_8Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brow_r_8.name = "Eyebrow R";
  if (endpoint_brow_r_8) {
    mesh_brow_r_8.position.copy(endpoint_brow_r_8.midpoint);
    mesh_brow_r_8.quaternion.copy(endpoint_brow_r_8.quaternion);
  }
  mesh_brow_r_8.castShadow = options.castShadow ?? true;
  mesh_brow_r_8.receiveShadow = options.receiveShadow ?? true;
  mesh_brow_r_8.userData.sculptComponent = {"id": "brow-r", "name": "Eyebrow R", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Eyebrow R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.06160000000000001, "height": 0.011200000000000002, "depth": 0.016800000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.05600000000000001, 0.033600000000000005, 0.12880000000000003], "rotation": [0.0, 0.0, 0.0], "scale": [0.06160000000000001, 0.011200000000000002, 0.016800000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "brow-r", "dominantAlbedo": "rgba(80, 54, 40, 1.0)", "secondaryAlbedo": "rgba(36, 22, 14, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.135, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/01-hair-crown.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.537}}};
  node_brow_r_8.add(mesh_brow_r_8);
  meshes["brow-r"] = mesh_brow_r_8;
  colliders["brow-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["brow-r"] ??= [];
  destructionGroups["brow-r"].push(node_brow_r_8);

  const endpoint_ear_l_9 = makeAttachmentEndpoint(null);
  const node_ear_l_9 = new THREE.Group();
  node_ear_l_9.name = "Ear L__pivot";
  node_ear_l_9.scale.set(1, 1, 1);
  if (endpoint_ear_l_9) {
    node_ear_l_9.position.copy(endpoint_ear_l_9.start);
    node_ear_l_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear_l_9.position.set(0.12040000000000001, 0.005600000000000001, -0.005600000000000001);
    node_ear_l_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear_l_9.userData.sculptComponent = {"id": "ear-l", "name": "Ear L", "level": "micro", "role": "detail", "importance": 0.45, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Ear L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.0252, "height": 0.0728, "depth": 0.04760000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.12040000000000001, 0.005600000000000001, -0.005600000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [0.0252, 0.0728, 0.04760000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["outer helix reads as a flattened shell against the skull, not a disc"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "ear-l", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_ear_l_9.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["head"] ?? root).add(node_ear_l_9);
  nodes["ear-l"] = node_ear_l_9;
  const mesh_ear_l_9Geometry = endpoint_ear_l_9
    ? new THREE.CylinderGeometry(endpoint_ear_l_9.endRadius, endpoint_ear_l_9.baseRadius, endpoint_ear_l_9.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_ear_l_9) {
    mesh_ear_l_9Geometry.scale(0.0252, 0.0728, 0.04760000000000001);
  }
  const mesh_ear_l_9 = new THREE.Mesh(
    mesh_ear_l_9Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_l_9.name = "Ear L";
  if (endpoint_ear_l_9) {
    mesh_ear_l_9.position.copy(endpoint_ear_l_9.midpoint);
    mesh_ear_l_9.quaternion.copy(endpoint_ear_l_9.quaternion);
  }
  mesh_ear_l_9.castShadow = options.castShadow ?? true;
  mesh_ear_l_9.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_l_9.userData.sculptComponent = {"id": "ear-l", "name": "Ear L", "level": "micro", "role": "detail", "importance": 0.45, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Ear L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.0252, "height": 0.0728, "depth": 0.04760000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.12040000000000001, 0.005600000000000001, -0.005600000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [0.0252, 0.0728, 0.04760000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["outer helix reads as a flattened shell against the skull, not a disc"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "ear-l", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_ear_l_9.add(mesh_ear_l_9);
  meshes["ear-l"] = mesh_ear_l_9;
  colliders["ear-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["ear-l"] ??= [];
  destructionGroups["ear-l"].push(node_ear_l_9);

  const endpoint_ear_r_10 = makeAttachmentEndpoint(null);
  const node_ear_r_10 = new THREE.Group();
  node_ear_r_10.name = "Ear R__pivot";
  node_ear_r_10.scale.set(1, 1, 1);
  if (endpoint_ear_r_10) {
    node_ear_r_10.position.copy(endpoint_ear_r_10.start);
    node_ear_r_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear_r_10.position.set(-0.12040000000000001, 0.005600000000000001, -0.005600000000000001);
    node_ear_r_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear_r_10.userData.sculptComponent = {"id": "ear-r", "name": "Ear R", "level": "micro", "role": "detail", "importance": 0.45, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Ear R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.0252, "height": 0.0728, "depth": 0.04760000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.12040000000000001, 0.005600000000000001, -0.005600000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [0.0252, 0.0728, 0.04760000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["outer helix reads as a flattened shell against the skull, not a disc"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "ear-r", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_ear_r_10.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["head"] ?? root).add(node_ear_r_10);
  nodes["ear-r"] = node_ear_r_10;
  const mesh_ear_r_10Geometry = endpoint_ear_r_10
    ? new THREE.CylinderGeometry(endpoint_ear_r_10.endRadius, endpoint_ear_r_10.baseRadius, endpoint_ear_r_10.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_ear_r_10) {
    mesh_ear_r_10Geometry.scale(0.0252, 0.0728, 0.04760000000000001);
  }
  const mesh_ear_r_10 = new THREE.Mesh(
    mesh_ear_r_10Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_r_10.name = "Ear R";
  if (endpoint_ear_r_10) {
    mesh_ear_r_10.position.copy(endpoint_ear_r_10.midpoint);
    mesh_ear_r_10.quaternion.copy(endpoint_ear_r_10.quaternion);
  }
  mesh_ear_r_10.castShadow = options.castShadow ?? true;
  mesh_ear_r_10.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_r_10.userData.sculptComponent = {"id": "ear-r", "name": "Ear R", "level": "micro", "role": "detail", "importance": 0.45, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Ear R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.0252, "height": 0.0728, "depth": 0.04760000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.12040000000000001, 0.005600000000000001, -0.005600000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [0.0252, 0.0728, 0.04760000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["outer helix reads as a flattened shell against the skull, not a disc"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "ear-r", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_ear_r_10.add(mesh_ear_r_10);
  meshes["ear-r"] = mesh_ear_r_10;
  colliders["ear-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["ear-r"] ??= [];
  destructionGroups["ear-r"].push(node_ear_r_10);

  const endpoint_nose_11 = makeAttachmentEndpoint(null);
  const node_nose_11 = new THREE.Group();
  node_nose_11.name = "Nose__pivot";
  node_nose_11.scale.set(1, 1, 1);
  if (endpoint_nose_11) {
    node_nose_11.position.copy(endpoint_nose_11.start);
    node_nose_11.rotation.set(0.024434609527920613, 0.0, 0.0);
  } else {
    node_nose_11.position.set(0.0, -0.011200000000000002, 0.14);
    node_nose_11.rotation.set(0.024434609527920613, 0.0, 0.0);
  }
  node_nose_11.userData.sculptComponent = {"id": "nose", "name": "Nose", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Nose is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.039200000000000006, "height": 0.07840000000000001, "depth": 0.0504, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.011200000000000002, 0.14], "rotation": [0.024434609527920613, 0.0, 0.0], "scale": [0.039200000000000006, 0.07840000000000001, 0.0504]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nose", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "nose", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_nose_11.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nose", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["head"] ?? root).add(node_nose_11);
  nodes["nose"] = node_nose_11;
  const mesh_nose_11Geometry = endpoint_nose_11
    ? new THREE.CylinderGeometry(endpoint_nose_11.endRadius, endpoint_nose_11.baseRadius, endpoint_nose_11.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_nose_11) {
    mesh_nose_11Geometry.scale(0.039200000000000006, 0.07840000000000001, 0.0504);
  }
  const mesh_nose_11 = new THREE.Mesh(
    mesh_nose_11Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nose_11.name = "Nose";
  if (endpoint_nose_11) {
    mesh_nose_11.position.copy(endpoint_nose_11.midpoint);
    mesh_nose_11.quaternion.copy(endpoint_nose_11.quaternion);
  }
  mesh_nose_11.castShadow = options.castShadow ?? true;
  mesh_nose_11.receiveShadow = options.receiveShadow ?? true;
  mesh_nose_11.userData.sculptComponent = {"id": "nose", "name": "Nose", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Nose is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.039200000000000006, "height": 0.07840000000000001, "depth": 0.0504, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.011200000000000002, 0.14], "rotation": [0.024434609527920613, 0.0, 0.0], "scale": [0.039200000000000006, 0.07840000000000001, 0.0504]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nose", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "nose", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_nose_11.add(mesh_nose_11);
  meshes["nose"] = mesh_nose_11;
  colliders["nose"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["nose"] ??= [];
  destructionGroups["nose"].push(node_nose_11);

  const endpoint_mouth_12 = makeAttachmentEndpoint(null);
  const node_mouth_12 = new THREE.Group();
  node_mouth_12.name = "Mouth__pivot";
  node_mouth_12.scale.set(1, 1, 1);
  if (endpoint_mouth_12) {
    node_mouth_12.position.copy(endpoint_mouth_12.start);
    node_mouth_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mouth_12.position.set(0.0, -0.09520000000000002, 0.12880000000000003);
    node_mouth_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_mouth_12.userData.sculptComponent = {"id": "mouth", "name": "Mouth", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Mouth is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.06720000000000001, "height": 0.011200000000000002, "depth": 0.014000000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.09520000000000002, 0.12880000000000003], "rotation": [0.0, 0.0, 0.0], "scale": [0.06720000000000001, 0.011200000000000002, 0.014000000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mouth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "lips"}}, "material": "lips", "materialLayers": ["lips"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "lips"}, "materialRegions": [{"regionId": "lip-crease", "materialId": "lips", "profileId": "skin.human.code-only", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/10-lip-crease.png", "bbox": {"x": 470, "y": 300, "width": 115, "height": 35}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0026}}, {"regionId": "lip-crease", "materialId": "lips", "profileId": "skin.human.code-only", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/10-lip-crease.png", "bbox": {"x": 470, "y": 300, "width": 115, "height": 35}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0026}}], "colorMaterialRecipe": {"componentId": "mouth", "dominantAlbedo": "rgba(234, 170, 118, 1.0)", "secondaryAlbedo": "rgba(194, 124, 73, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.124, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/10-lip-crease.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.482}}};
  node_mouth_12.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mouth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "lips"}};
  (nodes["head"] ?? root).add(node_mouth_12);
  nodes["mouth"] = node_mouth_12;
  const mesh_mouth_12Geometry = endpoint_mouth_12
    ? new THREE.CylinderGeometry(endpoint_mouth_12.endRadius, endpoint_mouth_12.baseRadius, endpoint_mouth_12.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_mouth_12) {
    mesh_mouth_12Geometry.scale(0.06720000000000001, 0.011200000000000002, 0.014000000000000002);
  }
  const mesh_mouth_12 = new THREE.Mesh(
    mesh_mouth_12Geometry,
    materialMap["lips"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mouth_12.name = "Mouth";
  if (endpoint_mouth_12) {
    mesh_mouth_12.position.copy(endpoint_mouth_12.midpoint);
    mesh_mouth_12.quaternion.copy(endpoint_mouth_12.quaternion);
  }
  mesh_mouth_12.castShadow = options.castShadow ?? true;
  mesh_mouth_12.receiveShadow = options.receiveShadow ?? true;
  mesh_mouth_12.userData.sculptComponent = {"id": "mouth", "name": "Mouth", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Mouth is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.06720000000000001, "height": 0.011200000000000002, "depth": 0.014000000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.09520000000000002, 0.12880000000000003], "rotation": [0.0, 0.0, 0.0], "scale": [0.06720000000000001, 0.011200000000000002, 0.014000000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mouth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "lips"}}, "material": "lips", "materialLayers": ["lips"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "lips"}, "materialRegions": [{"regionId": "lip-crease", "materialId": "lips", "profileId": "skin.human.code-only", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/10-lip-crease.png", "bbox": {"x": 470, "y": 300, "width": 115, "height": 35}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0026}}, {"regionId": "lip-crease", "materialId": "lips", "profileId": "skin.human.code-only", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/10-lip-crease.png", "bbox": {"x": 470, "y": 300, "width": 115, "height": 35}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0026}}], "colorMaterialRecipe": {"componentId": "mouth", "dominantAlbedo": "rgba(234, 170, 118, 1.0)", "secondaryAlbedo": "rgba(194, 124, 73, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.124, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/10-lip-crease.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.482}}};
  node_mouth_12.add(mesh_mouth_12);
  meshes["mouth"] = mesh_mouth_12;
  colliders["mouth"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["mouth"] ??= [];
  destructionGroups["mouth"].push(node_mouth_12);

  const endpoint_eye_l_13 = makeAttachmentEndpoint(null);
  const node_eye_l_13 = new THREE.Group();
  node_eye_l_13.name = "Eye L__pivot";
  node_eye_l_13.scale.set(1, 1, 1);
  if (endpoint_eye_l_13) {
    node_eye_l_13.position.copy(endpoint_eye_l_13.start);
    node_eye_l_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_l_13.position.set(0.053200000000000004, 0.008400000000000001, 0.11200000000000002);
    node_eye_l_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_l_13.userData.sculptComponent = {"id": "eye-l", "name": "Eye L", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Eye L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.030800000000000004, "height": 0.030800000000000004, "depth": 0.030800000000000004, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.053200000000000004, 0.008400000000000001, 0.11200000000000002], "rotation": [0.0, 0.0, 0.0], "scale": [0.030800000000000004, 0.030800000000000004, 0.030800000000000004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye", "materialLayers": ["eye"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "face-eyes", "kind": "gloss", "description": "Amber iris, dark pupil and paired catchlights.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "eye"}, "materialRegions": [{"regionId": "eye-gloss", "materialId": "eye", "profileId": "plastic.glossy", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/09-eye-gloss.png", "bbox": {"x": 455, "y": 215, "width": 62, "height": 72}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0028}}, {"regionId": "eye-gloss", "materialId": "eye", "profileId": "plastic.glossy", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/09-eye-gloss.png", "bbox": {"x": 455, "y": 215, "width": 62, "height": 72}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0028}}], "colorMaterialRecipe": {"componentId": "eye-l", "dominantAlbedo": "rgba(227, 160, 111, 1.0)", "secondaryAlbedo": "rgba(152, 86, 40, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.6, "roughnessEstimate": 0.136, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/09-eye-gloss.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.475}}};
  node_eye_l_13.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}};
  (nodes["head"] ?? root).add(node_eye_l_13);
  nodes["eye-l"] = node_eye_l_13;
  const mesh_eye_l_13Geometry = endpoint_eye_l_13
    ? new THREE.CylinderGeometry(endpoint_eye_l_13.endRadius, endpoint_eye_l_13.baseRadius, endpoint_eye_l_13.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_eye_l_13) {
    mesh_eye_l_13Geometry.scale(0.030800000000000004, 0.030800000000000004, 0.030800000000000004);
  }
  const mesh_eye_l_13 = new THREE.Mesh(
    mesh_eye_l_13Geometry,
    materialMap["eye"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_l_13.name = "Eye L";
  if (endpoint_eye_l_13) {
    mesh_eye_l_13.position.copy(endpoint_eye_l_13.midpoint);
    mesh_eye_l_13.quaternion.copy(endpoint_eye_l_13.quaternion);
  }
  mesh_eye_l_13.castShadow = options.castShadow ?? true;
  mesh_eye_l_13.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_l_13.userData.sculptComponent = {"id": "eye-l", "name": "Eye L", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Eye L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.030800000000000004, "height": 0.030800000000000004, "depth": 0.030800000000000004, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.053200000000000004, 0.008400000000000001, 0.11200000000000002], "rotation": [0.0, 0.0, 0.0], "scale": [0.030800000000000004, 0.030800000000000004, 0.030800000000000004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye", "materialLayers": ["eye"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "face-eyes", "kind": "gloss", "description": "Amber iris, dark pupil and paired catchlights.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "eye"}, "materialRegions": [{"regionId": "eye-gloss", "materialId": "eye", "profileId": "plastic.glossy", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/09-eye-gloss.png", "bbox": {"x": 455, "y": 215, "width": 62, "height": 72}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0028}}, {"regionId": "eye-gloss", "materialId": "eye", "profileId": "plastic.glossy", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/09-eye-gloss.png", "bbox": {"x": 455, "y": 215, "width": 62, "height": 72}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0028}}], "colorMaterialRecipe": {"componentId": "eye-l", "dominantAlbedo": "rgba(227, 160, 111, 1.0)", "secondaryAlbedo": "rgba(152, 86, 40, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.6, "roughnessEstimate": 0.136, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/09-eye-gloss.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.475}}};
  node_eye_l_13.add(mesh_eye_l_13);
  meshes["eye-l"] = mesh_eye_l_13;
  colliders["eye-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-l"] ??= [];
  destructionGroups["eye-l"].push(node_eye_l_13);

  const endpoint_eye_cavity_l_14 = makeAttachmentEndpoint(null);
  const node_eye_cavity_l_14 = new THREE.Group();
  node_eye_cavity_l_14.name = "Eye cavity L__pivot";
  node_eye_cavity_l_14.scale.set(1, 1, 1);
  if (endpoint_eye_cavity_l_14) {
    node_eye_cavity_l_14.position.copy(endpoint_eye_cavity_l_14.start);
    node_eye_cavity_l_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_cavity_l_14.position.set(0.053200000000000004, 0.008400000000000001, 0.12040000000000001);
    node_eye_cavity_l_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_cavity_l_14.userData.sculptComponent = {"id": "eye-cavity-l", "name": "Eye cavity L", "level": "micro", "role": "cavity", "importance": 0.4, "confidence": 0.8, "primitive": "sphere", "topologyClass": "implicit", "topologyRationale": "The eye reads as a recessed concave cavity carved out of the head volume with a boolean subtraction (US-004), not a flat decal or shaded patch.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "shell", "type": "sphere", "center": [0.0, 0.0, 0.0], "radius": 0.0252}, {"id": "carve", "type": "sphere", "center": [0.0, 0.0, 0.0154], "radius": 0.021}], "operations": [{"id": "socket", "type": "subtract", "left": "shell", "right": "carve"}], "bounds": {"min": [-0.0455, -0.0455, -0.0455], "max": [0.0455, 0.0455, 0.0455]}, "resolution": 24}}, "parent": "head", "attachment": null, "dimensions": {"width": 0.0504, "height": 0.0504, "depth": 0.0504, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.053200000000000004, 0.008400000000000001, 0.12040000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-cavity-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "eye-cavity-l", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_eye_cavity_l_14.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-cavity-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["head"] ?? root).add(node_eye_cavity_l_14);
  nodes["eye-cavity-l"] = node_eye_cavity_l_14;
  const mesh_eye_cavity_l_14Geometry = polygonizeSdf({"primitives": [{"id": "shell", "type": "sphere", "center": [0.0, 0.0, 0.0], "radius": 0.0252}, {"id": "carve", "type": "sphere", "center": [0.0, 0.0, 0.0154], "radius": 0.021}], "operations": [{"id": "socket", "type": "subtract", "left": "shell", "right": "carve"}], "bounds": {"min": [-0.0455, -0.0455, -0.0455], "max": [0.0455, 0.0455, 0.0455]}, "resolution": 24});
  if (!endpoint_eye_cavity_l_14) {
    mesh_eye_cavity_l_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_eye_cavity_l_14 = new THREE.Mesh(
    mesh_eye_cavity_l_14Geometry,
    createSculptMaterial("skin", {"id": "skin", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#DE9B6C", "color": "#DE9B6C", "albedo": {"dominant": "#DE9B6C", "secondary": ["#F4B689"]}, "colorVariation": {"palette": ["#e8b98f", "#be9875"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.55, "variation": 0.08, "map": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_roughness.png"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "skin-blush", "kind": "stain", "description": "Localized cheek and nose warmth with soft falloff.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "referenceMaterialId": "skin.human.code-only", "materialFamily": "skin", "materialSubtype": "human-code-only", "materialFinish": "natural", "materialReference": {"registry": "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json", "profileId": "skin.human.code-only", "method": "explicit-material-id", "confidence": 1.0, "sourceRefs": ["three.mesh-physical", "nvidia.faceworks"], "requiredMaps": [], "optionalMaps": [], "validationViews": ["albedo-unlit", "neutral-studio", "grazing", "reference-beauty"]}, "clearcoat": {"base": 0.18, "variation": 0.0}, "clearcoatRoughness": {"base": 0.38, "variation": 0.0}, "ior": {"base": 1.4, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_albedo.png", "url": "/references/cartoon-courier/materials/skin_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_roughness.png", "url": "/references/cartoon-courier/materials/skin_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_height.png", "url": "/references/cartoon-courier/materials/skin_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_normal.png", "url": "/references/cartoon-courier/materials/skin_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_ao.png", "url": "/references/cartoon-courier/materials/skin_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 245, "sourceHeight": 190, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 245, "height": 190}, "mask": {"backgroundColor": "#EAE4E0", "backgroundNoise": 306.659, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.8661}, "mapStats": {"valueRange": 0.7393, "heightP90Gradient": 0.08073, "roughnessBase": 0.71, "roughnessVariation": 0.143, "normalStrength": 0.251, "blurRadius": 10}, "palette": ["#1B0E06", "#F1B07F", "#D48B58", "#462816", "#9A582C"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "candy-coat", "recipe": {"metalness": 0.35, "roughness": 0.18, "clearcoat": 0.6, "clearcoatRoughness": 0.15, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.7, "anisotropy": 0.0, "procedural": "gradient-smoke"}, "palette": ["#694E40", "#7D5439", "#DA9969", "#9C6A47", "#DDD7D2"], "paletteHueRisk": [], "gradientAxis": "horizontal", "stats": {"meanLum": 115.2, "meanSaturation": 0.572, "gradientStrength": 0.599, "mottle": 0.081, "streakRatio": 1.23, "hueSpread": 0.013, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "head", "regionId": "skin-face", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "bbox": {"x": 405, "y": 155, "width": 245, "height": 190}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0296}, "observations": ["chromatic base-colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "head", "regionId": "skin-face", "materialId": "skin.human.code-only", "family": "skin", "subtype": "human-code-only", "finish": "natural", "aliases": [], "confidence": 0.86, "source": "vision"}, "alternatives": []}}, options, true)
  );
  mesh_eye_cavity_l_14.name = "Eye cavity L";
  if (endpoint_eye_cavity_l_14) {
    mesh_eye_cavity_l_14.position.copy(endpoint_eye_cavity_l_14.midpoint);
    mesh_eye_cavity_l_14.quaternion.copy(endpoint_eye_cavity_l_14.quaternion);
  }
  mesh_eye_cavity_l_14.castShadow = options.castShadow ?? true;
  mesh_eye_cavity_l_14.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_cavity_l_14.userData.sculptComponent = {"id": "eye-cavity-l", "name": "Eye cavity L", "level": "micro", "role": "cavity", "importance": 0.4, "confidence": 0.8, "primitive": "sphere", "topologyClass": "implicit", "topologyRationale": "The eye reads as a recessed concave cavity carved out of the head volume with a boolean subtraction (US-004), not a flat decal or shaded patch.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "shell", "type": "sphere", "center": [0.0, 0.0, 0.0], "radius": 0.0252}, {"id": "carve", "type": "sphere", "center": [0.0, 0.0, 0.0154], "radius": 0.021}], "operations": [{"id": "socket", "type": "subtract", "left": "shell", "right": "carve"}], "bounds": {"min": [-0.0455, -0.0455, -0.0455], "max": [0.0455, 0.0455, 0.0455]}, "resolution": 24}}, "parent": "head", "attachment": null, "dimensions": {"width": 0.0504, "height": 0.0504, "depth": 0.0504, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.053200000000000004, 0.008400000000000001, 0.12040000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-cavity-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "eye-cavity-l", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_eye_cavity_l_14.add(mesh_eye_cavity_l_14);
  meshes["eye-cavity-l"] = mesh_eye_cavity_l_14;
  colliders["eye-cavity-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-cavity-l"] ??= [];
  destructionGroups["eye-cavity-l"].push(node_eye_cavity_l_14);

  const endpoint_eye_r_15 = makeAttachmentEndpoint(null);
  const node_eye_r_15 = new THREE.Group();
  node_eye_r_15.name = "Eye R__pivot";
  node_eye_r_15.scale.set(1, 1, 1);
  if (endpoint_eye_r_15) {
    node_eye_r_15.position.copy(endpoint_eye_r_15.start);
    node_eye_r_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_r_15.position.set(-0.053200000000000004, 0.008400000000000001, 0.11200000000000002);
    node_eye_r_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_r_15.userData.sculptComponent = {"id": "eye-r", "name": "Eye R", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Eye R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.030800000000000004, "height": 0.030800000000000004, "depth": 0.030800000000000004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.053200000000000004, 0.008400000000000001, 0.11200000000000002], "rotation": [0.0, 0.0, 0.0], "scale": [0.030800000000000004, 0.030800000000000004, 0.030800000000000004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye", "materialLayers": ["eye"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "eye-r", "dominantAlbedo": "rgba(227, 160, 111, 1.0)", "secondaryAlbedo": "rgba(152, 86, 40, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.6, "roughnessEstimate": 0.136, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/09-eye-gloss.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.475}}};
  node_eye_r_15.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}};
  (nodes["head"] ?? root).add(node_eye_r_15);
  nodes["eye-r"] = node_eye_r_15;
  const mesh_eye_r_15Geometry = endpoint_eye_r_15
    ? new THREE.CylinderGeometry(endpoint_eye_r_15.endRadius, endpoint_eye_r_15.baseRadius, endpoint_eye_r_15.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_eye_r_15) {
    mesh_eye_r_15Geometry.scale(0.030800000000000004, 0.030800000000000004, 0.030800000000000004);
  }
  const mesh_eye_r_15 = new THREE.Mesh(
    mesh_eye_r_15Geometry,
    materialMap["eye"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_r_15.name = "Eye R";
  if (endpoint_eye_r_15) {
    mesh_eye_r_15.position.copy(endpoint_eye_r_15.midpoint);
    mesh_eye_r_15.quaternion.copy(endpoint_eye_r_15.quaternion);
  }
  mesh_eye_r_15.castShadow = options.castShadow ?? true;
  mesh_eye_r_15.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_r_15.userData.sculptComponent = {"id": "eye-r", "name": "Eye R", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Eye R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.030800000000000004, "height": 0.030800000000000004, "depth": 0.030800000000000004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.053200000000000004, 0.008400000000000001, 0.11200000000000002], "rotation": [0.0, 0.0, 0.0], "scale": [0.030800000000000004, 0.030800000000000004, 0.030800000000000004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye", "materialLayers": ["eye"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "eye-r", "dominantAlbedo": "rgba(227, 160, 111, 1.0)", "secondaryAlbedo": "rgba(152, 86, 40, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.6, "roughnessEstimate": 0.136, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/09-eye-gloss.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.475}}};
  node_eye_r_15.add(mesh_eye_r_15);
  meshes["eye-r"] = mesh_eye_r_15;
  colliders["eye-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-r"] ??= [];
  destructionGroups["eye-r"].push(node_eye_r_15);

  const endpoint_eye_cavity_r_16 = makeAttachmentEndpoint(null);
  const node_eye_cavity_r_16 = new THREE.Group();
  node_eye_cavity_r_16.name = "Eye cavity R__pivot";
  node_eye_cavity_r_16.scale.set(1, 1, 1);
  if (endpoint_eye_cavity_r_16) {
    node_eye_cavity_r_16.position.copy(endpoint_eye_cavity_r_16.start);
    node_eye_cavity_r_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_cavity_r_16.position.set(-0.053200000000000004, 0.008400000000000001, 0.12040000000000001);
    node_eye_cavity_r_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_cavity_r_16.userData.sculptComponent = {"id": "eye-cavity-r", "name": "Eye cavity R", "level": "micro", "role": "cavity", "importance": 0.4, "confidence": 0.8, "primitive": "sphere", "topologyClass": "implicit", "topologyRationale": "The eye reads as a recessed concave cavity carved out of the head volume with a boolean subtraction (US-004), not a flat decal or shaded patch.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "shell", "type": "sphere", "center": [0.0, 0.0, 0.0], "radius": 0.0252}, {"id": "carve", "type": "sphere", "center": [0.0, 0.0, 0.0154], "radius": 0.021}], "operations": [{"id": "socket", "type": "subtract", "left": "shell", "right": "carve"}], "bounds": {"min": [-0.0455, -0.0455, -0.0455], "max": [0.0455, 0.0455, 0.0455]}, "resolution": 24}}, "parent": "head", "attachment": null, "dimensions": {"width": 0.0504, "height": 0.0504, "depth": 0.0504, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.053200000000000004, 0.008400000000000001, 0.12040000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-cavity-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "eye-cavity-r", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_eye_cavity_r_16.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-cavity-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["head"] ?? root).add(node_eye_cavity_r_16);
  nodes["eye-cavity-r"] = node_eye_cavity_r_16;
  const mesh_eye_cavity_r_16Geometry = polygonizeSdf({"primitives": [{"id": "shell", "type": "sphere", "center": [0.0, 0.0, 0.0], "radius": 0.0252}, {"id": "carve", "type": "sphere", "center": [0.0, 0.0, 0.0154], "radius": 0.021}], "operations": [{"id": "socket", "type": "subtract", "left": "shell", "right": "carve"}], "bounds": {"min": [-0.0455, -0.0455, -0.0455], "max": [0.0455, 0.0455, 0.0455]}, "resolution": 24});
  if (!endpoint_eye_cavity_r_16) {
    mesh_eye_cavity_r_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_eye_cavity_r_16 = new THREE.Mesh(
    mesh_eye_cavity_r_16Geometry,
    createSculptMaterial("skin", {"id": "skin", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#DE9B6C", "color": "#DE9B6C", "albedo": {"dominant": "#DE9B6C", "secondary": ["#F4B689"]}, "colorVariation": {"palette": ["#e8b98f", "#be9875"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.55, "variation": 0.08, "map": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_roughness.png"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "skin-blush", "kind": "stain", "description": "Localized cheek and nose warmth with soft falloff.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "referenceMaterialId": "skin.human.code-only", "materialFamily": "skin", "materialSubtype": "human-code-only", "materialFinish": "natural", "materialReference": {"registry": "/Users/nicco/Desktop/img2threejs/docs/materials/material-reference.json", "profileId": "skin.human.code-only", "method": "explicit-material-id", "confidence": 1.0, "sourceRefs": ["three.mesh-physical", "nvidia.faceworks"], "requiredMaps": [], "optionalMaps": [], "validationViews": ["albedo-unlit", "neutral-studio", "grazing", "reference-beauty"]}, "clearcoat": {"base": 0.18, "variation": 0.0}, "clearcoatRoughness": {"base": 0.38, "variation": 0.0}, "ior": {"base": 1.4, "variation": 0.0}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_albedo.png", "url": "/references/cartoon-courier/materials/skin_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_roughness.png", "url": "/references/cartoon-courier/materials/skin_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_height.png", "url": "/references/cartoon-courier/materials/skin_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_normal.png", "url": "/references/cartoon-courier/materials/skin_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/pbr-00-skin-face/skin_ao.png", "url": "/references/cartoon-courier/materials/skin_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 245, "sourceHeight": 190, "mapSize": 512, "cropBBoxPixels": {"x": 0, "y": 0, "width": 245, "height": 190}, "mask": {"backgroundColor": "#EAE4E0", "backgroundNoise": 306.659, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.8661}, "mapStats": {"valueRange": 0.7393, "heightP90Gradient": 0.08073, "roughnessBase": 0.71, "roughnessVariation": 0.143, "normalStrength": 0.251, "blurRadius": 10}, "palette": ["#1B0E06", "#F1B07F", "#D48B58", "#462816", "#9A582C"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "textureAnalysis": {"finishClass": "candy-coat", "recipe": {"metalness": 0.35, "roughness": 0.18, "clearcoat": 0.6, "clearcoatRoughness": 0.15, "transmission": 0.0, "ior": 1.5, "envMapIntensity": 0.7, "anisotropy": 0.0, "procedural": "gradient-smoke"}, "palette": ["#694E40", "#7D5439", "#DA9969", "#9C6A47", "#DDD7D2"], "paletteHueRisk": [], "gradientAxis": "horizontal", "stats": {"meanLum": 115.2, "meanSaturation": 0.572, "gradientStrength": 0.599, "mottle": 0.081, "streakRatio": 1.23, "hueSpread": 0.013, "specularFraction": 0.01}}, "materialEvidence": {"componentId": "head", "regionId": "skin-face", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "bbox": {"x": 405, "y": 155, "width": 245, "height": 190}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0296}, "observations": ["chromatic base-colour response", "visible meso/micro variation", "strong image-space gradient; verify it is material pattern, not lighting", "single-image PBR inference requires controlled render validation"], "hypothesis": {"componentId": "head", "regionId": "skin-face", "materialId": "skin.human.code-only", "family": "skin", "subtype": "human-code-only", "finish": "natural", "aliases": [], "confidence": 0.86, "source": "vision"}, "alternatives": []}}, options, true)
  );
  mesh_eye_cavity_r_16.name = "Eye cavity R";
  if (endpoint_eye_cavity_r_16) {
    mesh_eye_cavity_r_16.position.copy(endpoint_eye_cavity_r_16.midpoint);
    mesh_eye_cavity_r_16.quaternion.copy(endpoint_eye_cavity_r_16.quaternion);
  }
  mesh_eye_cavity_r_16.castShadow = options.castShadow ?? true;
  mesh_eye_cavity_r_16.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_cavity_r_16.userData.sculptComponent = {"id": "eye-cavity-r", "name": "Eye cavity R", "level": "micro", "role": "cavity", "importance": 0.4, "confidence": 0.8, "primitive": "sphere", "topologyClass": "implicit", "topologyRationale": "The eye reads as a recessed concave cavity carved out of the head volume with a boolean subtraction (US-004), not a flat decal or shaded patch.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "shell", "type": "sphere", "center": [0.0, 0.0, 0.0], "radius": 0.0252}, {"id": "carve", "type": "sphere", "center": [0.0, 0.0, 0.0154], "radius": 0.021}], "operations": [{"id": "socket", "type": "subtract", "left": "shell", "right": "carve"}], "bounds": {"min": [-0.0455, -0.0455, -0.0455], "max": [0.0455, 0.0455, 0.0455]}, "resolution": 24}}, "parent": "head", "attachment": null, "dimensions": {"width": 0.0504, "height": 0.0504, "depth": 0.0504, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.053200000000000004, 0.008400000000000001, 0.12040000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-cavity-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "eye-cavity-r", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_eye_cavity_r_16.add(mesh_eye_cavity_r_16);
  meshes["eye-cavity-r"] = mesh_eye_cavity_r_16;
  colliders["eye-cavity-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-cavity-r"] ??= [];
  destructionGroups["eye-cavity-r"].push(node_eye_cavity_r_16);

  const attachment_clavicle_l_17 = {"parentSocket": "chest-clavicle-l", "localStart": [0.03002, 0.36484, 0.0056], "localEnd": [0.1876, 0.35924, 0.0112], "contactType": "rigid-weld", "baseRadius": 0.0308, "endRadius": 0.0476, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_clavicle_l_17 = makeAttachmentEndpoint(attachment_clavicle_l_17);
  const node_clavicle_l_17 = new THREE.Group();
  node_clavicle_l_17.name = "Clavicle L__pivot";
  node_clavicle_l_17.scale.set(1, 1, 1);
  if (endpoint_clavicle_l_17) {
    node_clavicle_l_17.position.copy(endpoint_clavicle_l_17.start);
    node_clavicle_l_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_clavicle_l_17.position.set(0.030016000000000004, 0.3648400000000001, 0.005600000000000001);
    node_clavicle_l_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_clavicle_l_17.userData.sculptComponent = {"id": "clavicle-l", "name": "Clavicle L", "level": "meso", "role": "support", "importance": 0.6, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Clavicle L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "chest", "attachment": {"parentSocket": "chest-clavicle-l", "localStart": [0.03002, 0.36484, 0.0056], "localEnd": [0.1876, 0.35924, 0.0112], "contactType": "rigid-weld", "baseRadius": 0.0308, "endRadius": 0.0476, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.157584, "height": 0.09520000000000002, "depth": 0.09520000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.030016000000000004, 0.3648400000000001, 0.005600000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [0.157584, 0.09520000000000002, 0.09520000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "clavicle-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "clavicle-l", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_clavicle_l_17.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "clavicle-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["chest"] ?? root).add(node_clavicle_l_17);
  nodes["clavicle-l"] = node_clavicle_l_17;
  const mesh_clavicle_l_17Geometry = endpoint_clavicle_l_17
    ? new THREE.CylinderGeometry(endpoint_clavicle_l_17.endRadius, endpoint_clavicle_l_17.baseRadius, endpoint_clavicle_l_17.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_clavicle_l_17) {
    mesh_clavicle_l_17Geometry.scale(0.157584, 0.09520000000000002, 0.09520000000000002);
  }
  const mesh_clavicle_l_17 = new THREE.SkinnedMesh(
    mesh_clavicle_l_17Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clavicle_l_17.name = "Clavicle L";
  if (endpoint_clavicle_l_17) {
    mesh_clavicle_l_17.position.copy(endpoint_clavicle_l_17.midpoint);
    mesh_clavicle_l_17.quaternion.copy(endpoint_clavicle_l_17.quaternion);
  }
  mesh_clavicle_l_17.castShadow = options.castShadow ?? true;
  mesh_clavicle_l_17.receiveShadow = options.receiveShadow ?? true;
  mesh_clavicle_l_17.userData.sculptComponent = {"id": "clavicle-l", "name": "Clavicle L", "level": "meso", "role": "support", "importance": 0.6, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Clavicle L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "chest", "attachment": {"parentSocket": "chest-clavicle-l", "localStart": [0.03002, 0.36484, 0.0056], "localEnd": [0.1876, 0.35924, 0.0112], "contactType": "rigid-weld", "baseRadius": 0.0308, "endRadius": 0.0476, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.157584, "height": 0.09520000000000002, "depth": 0.09520000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.030016000000000004, 0.3648400000000001, 0.005600000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [0.157584, 0.09520000000000002, 0.09520000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "clavicle-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "clavicle-l", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_clavicle_l_17.add(mesh_clavicle_l_17);
  meshes["clavicle-l"] = mesh_clavicle_l_17;
  colliders["clavicle-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["clavicle-l"] ??= [];
  destructionGroups["clavicle-l"].push(node_clavicle_l_17);

  const attachment_upper_arm_l_18 = {"parentSocket": "clavicle-shoulder-l", "localStart": [0.15758, -0.0056, 0.0056], "localEnd": [0.22589, -0.34255, 0.0056], "contactType": "socket-joint", "baseRadius": 0.0448, "endRadius": 0.0364, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_upper_arm_l_18 = makeAttachmentEndpoint(attachment_upper_arm_l_18);
  const node_upper_arm_l_18 = new THREE.Group();
  node_upper_arm_l_18.name = "Upper arm L__pivot";
  node_upper_arm_l_18.scale.set(1, 1, 1);
  if (endpoint_upper_arm_l_18) {
    node_upper_arm_l_18.position.copy(endpoint_upper_arm_l_18.start);
    node_upper_arm_l_18.rotation.set(0.06981317007977318, 0.0, -0.12217304763960307);
  } else {
    node_upper_arm_l_18.position.set(0.157584, -0.005599999999999994, 0.005600000000000001);
    node_upper_arm_l_18.rotation.set(0.06981317007977318, 0.0, -0.12217304763960307);
  }
  node_upper_arm_l_18.userData.sculptComponent = {"id": "upper-arm-l", "name": "Upper arm L", "level": "meso", "role": "arm", "importance": 0.7, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Upper arm L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "clavicle-l", "attachment": {"parentSocket": "clavicle-shoulder-l", "localStart": [0.15758, -0.0056, 0.0056], "localEnd": [0.22589, -0.34255, 0.0056], "contactType": "socket-joint", "baseRadius": 0.0448, "endRadius": 0.0364, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.08960000000000001, "height": 0.3438050000000001, "depth": 0.08960000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.157584, -0.005599999999999994, 0.005600000000000001], "rotation": [0.06981317007977318, 0.0, -0.12217304763960307], "scale": [0.08960000000000001, 0.3438050000000001, 0.08960000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "shirt", "materialLayers": ["shirt"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "upper-arm-l", "dominantAlbedo": "rgba(78, 67, 50, 1.0)", "secondaryAlbedo": "rgba(224, 194, 159, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.247, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/03-shirt-cream.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.49}}};
  node_upper_arm_l_18.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}};
  (nodes["clavicle-l"] ?? root).add(node_upper_arm_l_18);
  nodes["upper-arm-l"] = node_upper_arm_l_18;
  const mesh_upper_arm_l_18Geometry = endpoint_upper_arm_l_18
    ? new THREE.CylinderGeometry(endpoint_upper_arm_l_18.endRadius, endpoint_upper_arm_l_18.baseRadius, endpoint_upper_arm_l_18.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_upper_arm_l_18) {
    mesh_upper_arm_l_18Geometry.scale(0.08960000000000001, 0.3438050000000001, 0.08960000000000001);
  }
  const mesh_upper_arm_l_18 = new THREE.SkinnedMesh(
    mesh_upper_arm_l_18Geometry,
    materialMap["shirt"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_l_18.name = "Upper arm L";
  if (endpoint_upper_arm_l_18) {
    mesh_upper_arm_l_18.position.copy(endpoint_upper_arm_l_18.midpoint);
    mesh_upper_arm_l_18.quaternion.copy(endpoint_upper_arm_l_18.quaternion);
  }
  mesh_upper_arm_l_18.castShadow = options.castShadow ?? true;
  mesh_upper_arm_l_18.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_l_18.userData.sculptComponent = {"id": "upper-arm-l", "name": "Upper arm L", "level": "meso", "role": "arm", "importance": 0.7, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Upper arm L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "clavicle-l", "attachment": {"parentSocket": "clavicle-shoulder-l", "localStart": [0.15758, -0.0056, 0.0056], "localEnd": [0.22589, -0.34255, 0.0056], "contactType": "socket-joint", "baseRadius": 0.0448, "endRadius": 0.0364, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.08960000000000001, "height": 0.3438050000000001, "depth": 0.08960000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.157584, -0.005599999999999994, 0.005600000000000001], "rotation": [0.06981317007977318, 0.0, -0.12217304763960307], "scale": [0.08960000000000001, 0.3438050000000001, 0.08960000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "shirt", "materialLayers": ["shirt"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "upper-arm-l", "dominantAlbedo": "rgba(78, 67, 50, 1.0)", "secondaryAlbedo": "rgba(224, 194, 159, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.247, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/03-shirt-cream.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.49}}};
  node_upper_arm_l_18.add(mesh_upper_arm_l_18);
  meshes["upper-arm-l"] = mesh_upper_arm_l_18;
  colliders["upper-arm-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["upper-arm-l"] ??= [];
  destructionGroups["upper-arm-l"].push(node_upper_arm_l_18);

  const attachment_forearm_l_19 = {"parentSocket": "upper-arm-elbow-l", "localStart": [0.0683, -0.33695, 0.0], "localEnd": [0.10198, -0.61622, 0.0], "contactType": "hinge-joint", "baseRadius": 0.0336, "endRadius": 0.0252, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_forearm_l_19 = makeAttachmentEndpoint(attachment_forearm_l_19);
  const node_forearm_l_19 = new THREE.Group();
  node_forearm_l_19.name = "Forearm L__pivot";
  node_forearm_l_19.scale.set(1, 1, 1);
  if (endpoint_forearm_l_19) {
    node_forearm_l_19.position.copy(endpoint_forearm_l_19.start);
    node_forearm_l_19.rotation.set(0.13962634015954636, 0.0, 0.03490658503988659);
  } else {
    node_forearm_l_19.position.set(0.06830350927399606, -0.33695178979470813, 0.0);
    node_forearm_l_19.rotation.set(0.13962634015954636, 0.0, 0.03490658503988659);
  }
  node_forearm_l_19.userData.sculptComponent = {"id": "forearm-l", "name": "Forearm L", "level": "meso", "role": "arm", "importance": 0.65, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Forearm L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "upper-arm-l", "attachment": {"parentSocket": "upper-arm-elbow-l", "localStart": [0.0683, -0.33695, 0.0], "localEnd": [0.10198, -0.61622, 0.0], "contactType": "hinge-joint", "baseRadius": 0.0336, "endRadius": 0.0252, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0728, "height": 0.2812950000000001, "depth": 0.0728, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.06830350927399606, -0.33695178979470813, 0.0], "rotation": [0.13962634015954636, 0.0, 0.03490658503988659], "scale": [0.0728, 0.2812950000000001, 0.0728]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "forearm-l", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_forearm_l_19.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["upper-arm-l"] ?? root).add(node_forearm_l_19);
  nodes["forearm-l"] = node_forearm_l_19;
  const mesh_forearm_l_19Geometry = endpoint_forearm_l_19
    ? new THREE.CylinderGeometry(endpoint_forearm_l_19.endRadius, endpoint_forearm_l_19.baseRadius, endpoint_forearm_l_19.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_forearm_l_19) {
    mesh_forearm_l_19Geometry.scale(0.0728, 0.2812950000000001, 0.0728);
  }
  const mesh_forearm_l_19 = new THREE.SkinnedMesh(
    mesh_forearm_l_19Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_l_19.name = "Forearm L";
  if (endpoint_forearm_l_19) {
    mesh_forearm_l_19.position.copy(endpoint_forearm_l_19.midpoint);
    mesh_forearm_l_19.quaternion.copy(endpoint_forearm_l_19.quaternion);
  }
  mesh_forearm_l_19.castShadow = options.castShadow ?? true;
  mesh_forearm_l_19.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_l_19.userData.sculptComponent = {"id": "forearm-l", "name": "Forearm L", "level": "meso", "role": "arm", "importance": 0.65, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Forearm L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "upper-arm-l", "attachment": {"parentSocket": "upper-arm-elbow-l", "localStart": [0.0683, -0.33695, 0.0], "localEnd": [0.10198, -0.61622, 0.0], "contactType": "hinge-joint", "baseRadius": 0.0336, "endRadius": 0.0252, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0728, "height": 0.2812950000000001, "depth": 0.0728, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.06830350927399606, -0.33695178979470813, 0.0], "rotation": [0.13962634015954636, 0.0, 0.03490658503988659], "scale": [0.0728, 0.2812950000000001, 0.0728]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "forearm-l", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_forearm_l_19.add(mesh_forearm_l_19);
  meshes["forearm-l"] = mesh_forearm_l_19;
  colliders["forearm-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["forearm-l"] ??= [];
  destructionGroups["forearm-l"].push(node_forearm_l_19);

  const endpoint_hand_l_20 = makeAttachmentEndpoint(null);
  const node_hand_l_20 = new THREE.Group();
  node_hand_l_20.name = "Hand L__pivot";
  node_hand_l_20.scale.set(1, 1, 1);
  if (endpoint_hand_l_20) {
    node_hand_l_20.position.copy(endpoint_hand_l_20.start);
    node_hand_l_20.rotation.set(0.03490658503988659, 0.0, 0.06981317007977318);
  } else {
    node_hand_l_20.position.set(0.039037552235880124, -0.32374993210876657, 0.0);
    node_hand_l_20.rotation.set(0.03490658503988659, 0.0, 0.06981317007977318);
  }
  node_hand_l_20.userData.sculptComponent = {"id": "hand-l", "name": "Hand L", "level": "meso", "role": "hand", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Hand L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "forearm-l", "attachment": null, "dimensions": {"width": 0.06160000000000001, "height": 0.08960000000000001, "depth": 0.0364, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.039037552235880124, -0.32374993210876657, 0.0], "rotation": [0.03490658503988659, 0.0, 0.06981317007977318], "scale": [0.06160000000000001, 0.08960000000000001, 0.0364]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "hand-l", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_hand_l_20.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["forearm-l"] ?? root).add(node_hand_l_20);
  nodes["hand-l"] = node_hand_l_20;
  const mesh_hand_l_20Geometry = endpoint_hand_l_20
    ? new THREE.CylinderGeometry(endpoint_hand_l_20.endRadius, endpoint_hand_l_20.baseRadius, endpoint_hand_l_20.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_hand_l_20) {
    mesh_hand_l_20Geometry.scale(0.06160000000000001, 0.08960000000000001, 0.0364);
  }
  const mesh_hand_l_20 = new THREE.SkinnedMesh(
    mesh_hand_l_20Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_l_20.name = "Hand L";
  if (endpoint_hand_l_20) {
    mesh_hand_l_20.position.copy(endpoint_hand_l_20.midpoint);
    mesh_hand_l_20.quaternion.copy(endpoint_hand_l_20.quaternion);
  }
  mesh_hand_l_20.castShadow = options.castShadow ?? true;
  mesh_hand_l_20.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_l_20.userData.sculptComponent = {"id": "hand-l", "name": "Hand L", "level": "meso", "role": "hand", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Hand L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "forearm-l", "attachment": null, "dimensions": {"width": 0.06160000000000001, "height": 0.08960000000000001, "depth": 0.0364, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.039037552235880124, -0.32374993210876657, 0.0], "rotation": [0.03490658503988659, 0.0, 0.06981317007977318], "scale": [0.06160000000000001, 0.08960000000000001, 0.0364]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "hand-l", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_hand_l_20.add(mesh_hand_l_20);
  meshes["hand-l"] = mesh_hand_l_20;
  colliders["hand-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-l"] ??= [];
  destructionGroups["hand-l"].push(node_hand_l_20);

  const attachment_thumb_l_1_21 = {"parentSocket": "hand-l-thumb-1", "localStart": [-0.028, -0.00538, 0.0056], "localEnd": [-0.04312, -0.0184, 0.0119], "contactType": "rigid-weld", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_l_1_21 = makeAttachmentEndpoint(attachment_thumb_l_1_21);
  const node_thumb_l_1_21 = new THREE.Group();
  node_thumb_l_1_21.name = "Thumb L phalanx 1__pivot";
  node_thumb_l_1_21.scale.set(1, 1, 1);
  if (endpoint_thumb_l_1_21) {
    node_thumb_l_1_21.position.copy(endpoint_thumb_l_1_21.start);
    node_thumb_l_1_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_l_1_21.position.set(-0.028000000000000025, -0.005375999999999992, 0.005600000000000001);
    node_thumb_l_1_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_l_1_21.userData.sculptComponent = {"id": "thumb-l-1", "name": "Thumb L phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thumb L phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "hand-l-thumb-1", "localStart": [-0.028, -0.00538, 0.0056], "localEnd": [-0.04312, -0.0184, 0.0119], "contactType": "rigid-weld", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.017920000000000002, "height": 0.021, "depth": 0.017920000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.028000000000000025, -0.005375999999999992, 0.005600000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [0.017920000000000002, 0.021, 0.017920000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "thumb-l-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_thumb_l_1_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-l"] ?? root).add(node_thumb_l_1_21);
  nodes["thumb-l-1"] = node_thumb_l_1_21;
  const mesh_thumb_l_1_21Geometry = endpoint_thumb_l_1_21
    ? new THREE.CylinderGeometry(endpoint_thumb_l_1_21.endRadius, endpoint_thumb_l_1_21.baseRadius, endpoint_thumb_l_1_21.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_thumb_l_1_21) {
    mesh_thumb_l_1_21Geometry.scale(0.017920000000000002, 0.021, 0.017920000000000002);
  }
  const mesh_thumb_l_1_21 = new THREE.SkinnedMesh(
    mesh_thumb_l_1_21Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_l_1_21.name = "Thumb L phalanx 1";
  if (endpoint_thumb_l_1_21) {
    mesh_thumb_l_1_21.position.copy(endpoint_thumb_l_1_21.midpoint);
    mesh_thumb_l_1_21.quaternion.copy(endpoint_thumb_l_1_21.quaternion);
  }
  mesh_thumb_l_1_21.castShadow = options.castShadow ?? true;
  mesh_thumb_l_1_21.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_l_1_21.userData.sculptComponent = {"id": "thumb-l-1", "name": "Thumb L phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thumb L phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "hand-l-thumb-1", "localStart": [-0.028, -0.00538, 0.0056], "localEnd": [-0.04312, -0.0184, 0.0119], "contactType": "rigid-weld", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.017920000000000002, "height": 0.021, "depth": 0.017920000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.028000000000000025, -0.005375999999999992, 0.005600000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [0.017920000000000002, 0.021, 0.017920000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "thumb-l-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_thumb_l_1_21.add(mesh_thumb_l_1_21);
  meshes["thumb-l-1"] = mesh_thumb_l_1_21;
  colliders["thumb-l-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["thumb-l-1"] ??= [];
  destructionGroups["thumb-l-1"].push(node_thumb_l_1_21);

  const attachment_thumb_l_2_22 = {"parentSocket": "thumb-l-1-thumb-2", "localStart": [-0.01512, -0.01302, 0.0063], "localEnd": [-0.02621, -0.02257, 0.01092], "contactType": "hinge-joint", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_l_2_22 = makeAttachmentEndpoint(attachment_thumb_l_2_22);
  const node_thumb_l_2_22 = new THREE.Group();
  node_thumb_l_2_22.name = "Thumb L phalanx 2__pivot";
  node_thumb_l_2_22.scale.set(1, 1, 1);
  if (endpoint_thumb_l_2_22) {
    node_thumb_l_2_22.position.copy(endpoint_thumb_l_2_22.start);
    node_thumb_l_2_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_l_2_22.position.set(-0.015120000000000022, -0.013020000000000004, 0.0063);
    node_thumb_l_2_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_l_2_22.userData.sculptComponent = {"id": "thumb-l-2", "name": "Thumb L phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thumb L phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thumb-l-1", "attachment": {"parentSocket": "thumb-l-1-thumb-2", "localStart": [-0.01512, -0.01302, 0.0063], "localEnd": [-0.02621, -0.02257, 0.01092], "contactType": "hinge-joint", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.017920000000000002, "height": 0.015400000000000002, "depth": 0.017920000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.015120000000000022, -0.013020000000000004, 0.0063], "rotation": [0.0, 0.0, 0.0], "scale": [0.017920000000000002, 0.015400000000000002, 0.017920000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "thumb-l-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_thumb_l_2_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["thumb-l-1"] ?? root).add(node_thumb_l_2_22);
  nodes["thumb-l-2"] = node_thumb_l_2_22;
  const mesh_thumb_l_2_22Geometry = endpoint_thumb_l_2_22
    ? new THREE.CylinderGeometry(endpoint_thumb_l_2_22.endRadius, endpoint_thumb_l_2_22.baseRadius, endpoint_thumb_l_2_22.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_thumb_l_2_22) {
    mesh_thumb_l_2_22Geometry.scale(0.017920000000000002, 0.015400000000000002, 0.017920000000000002);
  }
  const mesh_thumb_l_2_22 = new THREE.SkinnedMesh(
    mesh_thumb_l_2_22Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_l_2_22.name = "Thumb L phalanx 2";
  if (endpoint_thumb_l_2_22) {
    mesh_thumb_l_2_22.position.copy(endpoint_thumb_l_2_22.midpoint);
    mesh_thumb_l_2_22.quaternion.copy(endpoint_thumb_l_2_22.quaternion);
  }
  mesh_thumb_l_2_22.castShadow = options.castShadow ?? true;
  mesh_thumb_l_2_22.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_l_2_22.userData.sculptComponent = {"id": "thumb-l-2", "name": "Thumb L phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thumb L phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thumb-l-1", "attachment": {"parentSocket": "thumb-l-1-thumb-2", "localStart": [-0.01512, -0.01302, 0.0063], "localEnd": [-0.02621, -0.02257, 0.01092], "contactType": "hinge-joint", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.017920000000000002, "height": 0.015400000000000002, "depth": 0.017920000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.015120000000000022, -0.013020000000000004, 0.0063], "rotation": [0.0, 0.0, 0.0], "scale": [0.017920000000000002, 0.015400000000000002, 0.017920000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "thumb-l-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_thumb_l_2_22.add(mesh_thumb_l_2_22);
  meshes["thumb-l-2"] = mesh_thumb_l_2_22;
  colliders["thumb-l-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["thumb-l-2"] ??= [];
  destructionGroups["thumb-l-2"].push(node_thumb_l_2_22);

  const attachment_thumb_l_3_23 = {"parentSocket": "thumb-l-2-thumb-3", "localStart": [-0.01109, -0.00955, 0.00462], "localEnd": [-0.01915, -0.01649, 0.00798], "contactType": "hinge-joint", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_l_3_23 = makeAttachmentEndpoint(attachment_thumb_l_3_23);
  const node_thumb_l_3_23 = new THREE.Group();
  node_thumb_l_3_23.name = "Thumb L phalanx 3__pivot";
  node_thumb_l_3_23.scale.set(1, 1, 1);
  if (endpoint_thumb_l_3_23) {
    node_thumb_l_3_23.position.copy(endpoint_thumb_l_3_23.start);
    node_thumb_l_3_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_l_3_23.position.set(-0.011087999999999987, -0.009548000000000001, 0.004620000000000003);
    node_thumb_l_3_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_l_3_23.userData.sculptComponent = {"id": "thumb-l-3", "name": "Thumb L phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thumb L phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thumb-l-2", "attachment": {"parentSocket": "thumb-l-2-thumb-3", "localStart": [-0.01109, -0.00955, 0.00462], "localEnd": [-0.01915, -0.01649, 0.00798], "contactType": "hinge-joint", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.017920000000000002, "height": 0.011200000000000002, "depth": 0.017920000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.011087999999999987, -0.009548000000000001, 0.004620000000000003], "rotation": [0.0, 0.0, 0.0], "scale": [0.017920000000000002, 0.011200000000000002, 0.017920000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "thumb-l-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_thumb_l_3_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["thumb-l-2"] ?? root).add(node_thumb_l_3_23);
  nodes["thumb-l-3"] = node_thumb_l_3_23;
  const mesh_thumb_l_3_23Geometry = endpoint_thumb_l_3_23
    ? new THREE.CylinderGeometry(endpoint_thumb_l_3_23.endRadius, endpoint_thumb_l_3_23.baseRadius, endpoint_thumb_l_3_23.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_thumb_l_3_23) {
    mesh_thumb_l_3_23Geometry.scale(0.017920000000000002, 0.011200000000000002, 0.017920000000000002);
  }
  const mesh_thumb_l_3_23 = new THREE.SkinnedMesh(
    mesh_thumb_l_3_23Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_l_3_23.name = "Thumb L phalanx 3";
  if (endpoint_thumb_l_3_23) {
    mesh_thumb_l_3_23.position.copy(endpoint_thumb_l_3_23.midpoint);
    mesh_thumb_l_3_23.quaternion.copy(endpoint_thumb_l_3_23.quaternion);
  }
  mesh_thumb_l_3_23.castShadow = options.castShadow ?? true;
  mesh_thumb_l_3_23.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_l_3_23.userData.sculptComponent = {"id": "thumb-l-3", "name": "Thumb L phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thumb L phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thumb-l-2", "attachment": {"parentSocket": "thumb-l-2-thumb-3", "localStart": [-0.01109, -0.00955, 0.00462], "localEnd": [-0.01915, -0.01649, 0.00798], "contactType": "hinge-joint", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.017920000000000002, "height": 0.011200000000000002, "depth": 0.017920000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.011087999999999987, -0.009548000000000001, 0.004620000000000003], "rotation": [0.0, 0.0, 0.0], "scale": [0.017920000000000002, 0.011200000000000002, 0.017920000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "thumb-l-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_thumb_l_3_23.add(mesh_thumb_l_3_23);
  meshes["thumb-l-3"] = mesh_thumb_l_3_23;
  colliders["thumb-l-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["thumb-l-3"] ??= [];
  destructionGroups["thumb-l-3"].push(node_thumb_l_3_23);

  const attachment_index_l_1_24 = {"parentSocket": "hand-l-index-1", "localStart": [-0.021, -0.03763, 0.0028], "localEnd": [-0.01748, -0.06682, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_l_1_24 = makeAttachmentEndpoint(attachment_index_l_1_24);
  const node_index_l_1_24 = new THREE.Group();
  node_index_l_1_24.name = "Index L phalanx 1__pivot";
  node_index_l_1_24.scale.set(1, 1, 1);
  if (endpoint_index_l_1_24) {
    node_index_l_1_24.position.copy(endpoint_index_l_1_24.start);
    node_index_l_1_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_l_1_24.position.set(-0.02100000000000002, -0.037632, 0.0028000000000000004);
    node_index_l_1_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_l_1_24.userData.sculptComponent = {"id": "index-l-1", "name": "Index L phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Index L phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "hand-l-index-1", "localStart": [-0.021, -0.03763, 0.0028], "localEnd": [-0.01748, -0.06682, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015680000000000003, "height": 0.029400000000000003, "depth": 0.015680000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.02100000000000002, -0.037632, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.015680000000000003, 0.029400000000000003, 0.015680000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "index-l-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_index_l_1_24.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-l"] ?? root).add(node_index_l_1_24);
  nodes["index-l-1"] = node_index_l_1_24;
  const mesh_index_l_1_24Geometry = endpoint_index_l_1_24
    ? new THREE.CylinderGeometry(endpoint_index_l_1_24.endRadius, endpoint_index_l_1_24.baseRadius, endpoint_index_l_1_24.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_index_l_1_24) {
    mesh_index_l_1_24Geometry.scale(0.015680000000000003, 0.029400000000000003, 0.015680000000000003);
  }
  const mesh_index_l_1_24 = new THREE.SkinnedMesh(
    mesh_index_l_1_24Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_l_1_24.name = "Index L phalanx 1";
  if (endpoint_index_l_1_24) {
    mesh_index_l_1_24.position.copy(endpoint_index_l_1_24.midpoint);
    mesh_index_l_1_24.quaternion.copy(endpoint_index_l_1_24.quaternion);
  }
  mesh_index_l_1_24.castShadow = options.castShadow ?? true;
  mesh_index_l_1_24.receiveShadow = options.receiveShadow ?? true;
  mesh_index_l_1_24.userData.sculptComponent = {"id": "index-l-1", "name": "Index L phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Index L phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "hand-l-index-1", "localStart": [-0.021, -0.03763, 0.0028], "localEnd": [-0.01748, -0.06682, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015680000000000003, "height": 0.029400000000000003, "depth": 0.015680000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.02100000000000002, -0.037632, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.015680000000000003, 0.029400000000000003, 0.015680000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "index-l-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_index_l_1_24.add(mesh_index_l_1_24);
  meshes["index-l-1"] = mesh_index_l_1_24;
  colliders["index-l-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["index-l-1"] ??= [];
  destructionGroups["index-l-1"].push(node_index_l_1_24);

  const attachment_index_l_2_25 = {"parentSocket": "index-l-1-index-2", "localStart": [0.00352, -0.02919, 0.0], "localEnd": [0.00593, -0.0492, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_l_2_25 = makeAttachmentEndpoint(attachment_index_l_2_25);
  const node_index_l_2_25 = new THREE.Group();
  node_index_l_2_25.name = "Index L phalanx 2__pivot";
  node_index_l_2_25.scale.set(1, 1, 1);
  if (endpoint_index_l_2_25) {
    node_index_l_2_25.position.copy(endpoint_index_l_2_25.start);
    node_index_l_2_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_l_2_25.position.set(0.0035195388942942385, -0.029188573894103648, 0.0);
    node_index_l_2_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_l_2_25.userData.sculptComponent = {"id": "index-l-2", "name": "Index L phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Index L phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "index-l-1", "attachment": {"parentSocket": "index-l-1-index-2", "localStart": [0.00352, -0.02919, 0.0], "localEnd": [0.00593, -0.0492, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015680000000000003, "height": 0.02016, "depth": 0.015680000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0035195388942942385, -0.029188573894103648, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.015680000000000003, 0.02016, 0.015680000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "index-l-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_index_l_2_25.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["index-l-1"] ?? root).add(node_index_l_2_25);
  nodes["index-l-2"] = node_index_l_2_25;
  const mesh_index_l_2_25Geometry = endpoint_index_l_2_25
    ? new THREE.CylinderGeometry(endpoint_index_l_2_25.endRadius, endpoint_index_l_2_25.baseRadius, endpoint_index_l_2_25.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_index_l_2_25) {
    mesh_index_l_2_25Geometry.scale(0.015680000000000003, 0.02016, 0.015680000000000003);
  }
  const mesh_index_l_2_25 = new THREE.SkinnedMesh(
    mesh_index_l_2_25Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_l_2_25.name = "Index L phalanx 2";
  if (endpoint_index_l_2_25) {
    mesh_index_l_2_25.position.copy(endpoint_index_l_2_25.midpoint);
    mesh_index_l_2_25.quaternion.copy(endpoint_index_l_2_25.quaternion);
  }
  mesh_index_l_2_25.castShadow = options.castShadow ?? true;
  mesh_index_l_2_25.receiveShadow = options.receiveShadow ?? true;
  mesh_index_l_2_25.userData.sculptComponent = {"id": "index-l-2", "name": "Index L phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Index L phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "index-l-1", "attachment": {"parentSocket": "index-l-1-index-2", "localStart": [0.00352, -0.02919, 0.0], "localEnd": [0.00593, -0.0492, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015680000000000003, "height": 0.02016, "depth": 0.015680000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0035195388942942385, -0.029188573894103648, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.015680000000000003, 0.02016, 0.015680000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "index-l-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_index_l_2_25.add(mesh_index_l_2_25);
  meshes["index-l-2"] = mesh_index_l_2_25;
  colliders["index-l-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["index-l-2"] ??= [];
  destructionGroups["index-l-2"].push(node_index_l_2_25);

  const attachment_index_l_3_26 = {"parentSocket": "index-l-2-index-3", "localStart": [0.00241, -0.02002, 0.0], "localEnd": [0.00402, -0.03336, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_l_3_26 = makeAttachmentEndpoint(attachment_index_l_3_26);
  const node_index_l_3_26 = new THREE.Group();
  node_index_l_3_26.name = "Index L phalanx 3__pivot";
  node_index_l_3_26.scale.set(1, 1, 1);
  if (endpoint_index_l_3_26) {
    node_index_l_3_26.position.copy(endpoint_index_l_3_26.start);
    node_index_l_3_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_l_3_26.position.set(0.0024133980989446413, -0.02001502209881395, 0.0);
    node_index_l_3_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_l_3_26.userData.sculptComponent = {"id": "index-l-3", "name": "Index L phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Index L phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "index-l-2", "attachment": {"parentSocket": "index-l-2-index-3", "localStart": [0.00241, -0.02002, 0.0], "localEnd": [0.00402, -0.03336, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015680000000000003, "height": 0.013440000000000002, "depth": 0.015680000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0024133980989446413, -0.02001502209881395, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.015680000000000003, 0.013440000000000002, 0.015680000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "index-l-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_index_l_3_26.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["index-l-2"] ?? root).add(node_index_l_3_26);
  nodes["index-l-3"] = node_index_l_3_26;
  const mesh_index_l_3_26Geometry = endpoint_index_l_3_26
    ? new THREE.CylinderGeometry(endpoint_index_l_3_26.endRadius, endpoint_index_l_3_26.baseRadius, endpoint_index_l_3_26.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_index_l_3_26) {
    mesh_index_l_3_26Geometry.scale(0.015680000000000003, 0.013440000000000002, 0.015680000000000003);
  }
  const mesh_index_l_3_26 = new THREE.SkinnedMesh(
    mesh_index_l_3_26Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_l_3_26.name = "Index L phalanx 3";
  if (endpoint_index_l_3_26) {
    mesh_index_l_3_26.position.copy(endpoint_index_l_3_26.midpoint);
    mesh_index_l_3_26.quaternion.copy(endpoint_index_l_3_26.quaternion);
  }
  mesh_index_l_3_26.castShadow = options.castShadow ?? true;
  mesh_index_l_3_26.receiveShadow = options.receiveShadow ?? true;
  mesh_index_l_3_26.userData.sculptComponent = {"id": "index-l-3", "name": "Index L phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Index L phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "index-l-2", "attachment": {"parentSocket": "index-l-2-index-3", "localStart": [0.00241, -0.02002, 0.0], "localEnd": [0.00402, -0.03336, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015680000000000003, "height": 0.013440000000000002, "depth": 0.015680000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0024133980989446413, -0.02001502209881395, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.015680000000000003, 0.013440000000000002, 0.015680000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "index-l-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_index_l_3_26.add(mesh_index_l_3_26);
  meshes["index-l-3"] = mesh_index_l_3_26;
  colliders["index-l-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["index-l-3"] ??= [];
  destructionGroups["index-l-3"].push(node_index_l_3_26);

  const attachment_middle_l_1_27 = {"parentSocket": "hand-l-middle-1", "localStart": [-0.007, -0.03763, 0.0028], "localEnd": [-0.00315, -0.0696, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_l_1_27 = makeAttachmentEndpoint(attachment_middle_l_1_27);
  const node_middle_l_1_27 = new THREE.Group();
  node_middle_l_1_27.name = "Middle L phalanx 1__pivot";
  node_middle_l_1_27.scale.set(1, 1, 1);
  if (endpoint_middle_l_1_27) {
    node_middle_l_1_27.position.copy(endpoint_middle_l_1_27.start);
    node_middle_l_1_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_l_1_27.position.set(-0.007000000000000006, -0.037632, 0.0028000000000000004);
    node_middle_l_1_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_l_1_27.userData.sculptComponent = {"id": "middle-l-1", "name": "Middle L phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Middle L phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "hand-l-middle-1", "localStart": [-0.007, -0.03763, 0.0028], "localEnd": [-0.00315, -0.0696, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.01624, "height": 0.032200000000000006, "depth": 0.01624, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.007000000000000006, -0.037632, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.01624, 0.032200000000000006, 0.01624]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "middle-l-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_middle_l_1_27.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-l"] ?? root).add(node_middle_l_1_27);
  nodes["middle-l-1"] = node_middle_l_1_27;
  const mesh_middle_l_1_27Geometry = endpoint_middle_l_1_27
    ? new THREE.CylinderGeometry(endpoint_middle_l_1_27.endRadius, endpoint_middle_l_1_27.baseRadius, endpoint_middle_l_1_27.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_middle_l_1_27) {
    mesh_middle_l_1_27Geometry.scale(0.01624, 0.032200000000000006, 0.01624);
  }
  const mesh_middle_l_1_27 = new THREE.SkinnedMesh(
    mesh_middle_l_1_27Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_l_1_27.name = "Middle L phalanx 1";
  if (endpoint_middle_l_1_27) {
    mesh_middle_l_1_27.position.copy(endpoint_middle_l_1_27.midpoint);
    mesh_middle_l_1_27.quaternion.copy(endpoint_middle_l_1_27.quaternion);
  }
  mesh_middle_l_1_27.castShadow = options.castShadow ?? true;
  mesh_middle_l_1_27.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_l_1_27.userData.sculptComponent = {"id": "middle-l-1", "name": "Middle L phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Middle L phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "hand-l-middle-1", "localStart": [-0.007, -0.03763, 0.0028], "localEnd": [-0.00315, -0.0696, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.01624, "height": 0.032200000000000006, "depth": 0.01624, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.007000000000000006, -0.037632, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.01624, 0.032200000000000006, 0.01624]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "middle-l-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_middle_l_1_27.add(mesh_middle_l_1_27);
  meshes["middle-l-1"] = mesh_middle_l_1_27;
  colliders["middle-l-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["middle-l-1"] ??= [];
  destructionGroups["middle-l-1"].push(node_middle_l_1_27);

  const attachment_middle_l_2_28 = {"parentSocket": "middle-l-1-middle-2", "localStart": [0.00385, -0.03197, 0.0], "localEnd": [0.00654, -0.05421, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_l_2_28 = makeAttachmentEndpoint(attachment_middle_l_2_28);
  const node_middle_l_2_28 = new THREE.Group();
  node_middle_l_2_28.name = "Middle L phalanx 2__pivot";
  node_middle_l_2_28.scale.set(1, 1, 1);
  if (endpoint_middle_l_2_28) {
    node_middle_l_2_28.position.copy(endpoint_middle_l_2_28.start);
    node_middle_l_2_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_l_2_28.position.set(0.003854733074703187, -0.03196843807449448, 0.0);
    node_middle_l_2_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_l_2_28.userData.sculptComponent = {"id": "middle-l-2", "name": "Middle L phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Middle L phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "middle-l-1", "attachment": {"parentSocket": "middle-l-1-middle-2", "localStart": [0.00385, -0.03197, 0.0], "localEnd": [0.00654, -0.05421, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.01624, "height": 0.022400000000000003, "depth": 0.01624, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.003854733074703187, -0.03196843807449448, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.01624, 0.022400000000000003, 0.01624]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "middle-l-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_middle_l_2_28.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["middle-l-1"] ?? root).add(node_middle_l_2_28);
  nodes["middle-l-2"] = node_middle_l_2_28;
  const mesh_middle_l_2_28Geometry = endpoint_middle_l_2_28
    ? new THREE.CylinderGeometry(endpoint_middle_l_2_28.endRadius, endpoint_middle_l_2_28.baseRadius, endpoint_middle_l_2_28.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_middle_l_2_28) {
    mesh_middle_l_2_28Geometry.scale(0.01624, 0.022400000000000003, 0.01624);
  }
  const mesh_middle_l_2_28 = new THREE.SkinnedMesh(
    mesh_middle_l_2_28Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_l_2_28.name = "Middle L phalanx 2";
  if (endpoint_middle_l_2_28) {
    mesh_middle_l_2_28.position.copy(endpoint_middle_l_2_28.midpoint);
    mesh_middle_l_2_28.quaternion.copy(endpoint_middle_l_2_28.quaternion);
  }
  mesh_middle_l_2_28.castShadow = options.castShadow ?? true;
  mesh_middle_l_2_28.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_l_2_28.userData.sculptComponent = {"id": "middle-l-2", "name": "Middle L phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Middle L phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "middle-l-1", "attachment": {"parentSocket": "middle-l-1-middle-2", "localStart": [0.00385, -0.03197, 0.0], "localEnd": [0.00654, -0.05421, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.01624, "height": 0.022400000000000003, "depth": 0.01624, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.003854733074703187, -0.03196843807449448, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.01624, 0.022400000000000003, 0.01624]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "middle-l-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_middle_l_2_28.add(mesh_middle_l_2_28);
  meshes["middle-l-2"] = mesh_middle_l_2_28;
  colliders["middle-l-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["middle-l-2"] ??= [];
  destructionGroups["middle-l-2"].push(node_middle_l_2_28);

  const attachment_middle_l_3_29 = {"parentSocket": "middle-l-2-middle-3", "localStart": [0.00268, -0.02224, 0.0], "localEnd": [0.00436, -0.03614, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_l_3_29 = makeAttachmentEndpoint(attachment_middle_l_3_29);
  const node_middle_l_3_29 = new THREE.Group();
  node_middle_l_3_29.name = "Middle L phalanx 3__pivot";
  node_middle_l_3_29.scale.set(1, 1, 1);
  if (endpoint_middle_l_3_29) {
    node_middle_l_3_29.position.copy(endpoint_middle_l_3_29.start);
    node_middle_l_3_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_l_3_29.position.set(0.0026815534432718113, -0.022238913443126618, 0.0);
    node_middle_l_3_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_l_3_29.userData.sculptComponent = {"id": "middle-l-3", "name": "Middle L phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Middle L phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "middle-l-2", "attachment": {"parentSocket": "middle-l-2-middle-3", "localStart": [0.00268, -0.02224, 0.0], "localEnd": [0.00436, -0.03614, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.01624, "height": 0.014000000000000002, "depth": 0.01624, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0026815534432718113, -0.022238913443126618, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.01624, 0.014000000000000002, 0.01624]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "middle-l-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_middle_l_3_29.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["middle-l-2"] ?? root).add(node_middle_l_3_29);
  nodes["middle-l-3"] = node_middle_l_3_29;
  const mesh_middle_l_3_29Geometry = endpoint_middle_l_3_29
    ? new THREE.CylinderGeometry(endpoint_middle_l_3_29.endRadius, endpoint_middle_l_3_29.baseRadius, endpoint_middle_l_3_29.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_middle_l_3_29) {
    mesh_middle_l_3_29Geometry.scale(0.01624, 0.014000000000000002, 0.01624);
  }
  const mesh_middle_l_3_29 = new THREE.SkinnedMesh(
    mesh_middle_l_3_29Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_l_3_29.name = "Middle L phalanx 3";
  if (endpoint_middle_l_3_29) {
    mesh_middle_l_3_29.position.copy(endpoint_middle_l_3_29.midpoint);
    mesh_middle_l_3_29.quaternion.copy(endpoint_middle_l_3_29.quaternion);
  }
  mesh_middle_l_3_29.castShadow = options.castShadow ?? true;
  mesh_middle_l_3_29.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_l_3_29.userData.sculptComponent = {"id": "middle-l-3", "name": "Middle L phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Middle L phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "middle-l-2", "attachment": {"parentSocket": "middle-l-2-middle-3", "localStart": [0.00268, -0.02224, 0.0], "localEnd": [0.00436, -0.03614, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.01624, "height": 0.014000000000000002, "depth": 0.01624, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0026815534432718113, -0.022238913443126618, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.01624, 0.014000000000000002, 0.01624]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "middle-l-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_middle_l_3_29.add(mesh_middle_l_3_29);
  meshes["middle-l-3"] = mesh_middle_l_3_29;
  colliders["middle-l-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["middle-l-3"] ??= [];
  destructionGroups["middle-l-3"].push(node_middle_l_3_29);

  const attachment_ring_l_1_30 = {"parentSocket": "hand-l-ring-1", "localStart": [0.007, -0.03763, 0.0028], "localEnd": [0.01052, -0.06682, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_l_1_30 = makeAttachmentEndpoint(attachment_ring_l_1_30);
  const node_ring_l_1_30 = new THREE.Group();
  node_ring_l_1_30.name = "Ring L phalanx 1__pivot";
  node_ring_l_1_30.scale.set(1, 1, 1);
  if (endpoint_ring_l_1_30) {
    node_ring_l_1_30.position.copy(endpoint_ring_l_1_30.start);
    node_ring_l_1_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_l_1_30.position.set(0.007000000000000006, -0.037632, 0.0028000000000000004);
    node_ring_l_1_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_l_1_30.userData.sculptComponent = {"id": "ring-l-1", "name": "Ring L phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Ring L phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "hand-l-ring-1", "localStart": [0.007, -0.03763, 0.0028], "localEnd": [0.01052, -0.06682, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015120000000000001, "height": 0.029400000000000003, "depth": 0.015120000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.007000000000000006, -0.037632, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.015120000000000001, 0.029400000000000003, 0.015120000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "ring-l-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_ring_l_1_30.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-l"] ?? root).add(node_ring_l_1_30);
  nodes["ring-l-1"] = node_ring_l_1_30;
  const mesh_ring_l_1_30Geometry = endpoint_ring_l_1_30
    ? new THREE.CylinderGeometry(endpoint_ring_l_1_30.endRadius, endpoint_ring_l_1_30.baseRadius, endpoint_ring_l_1_30.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_ring_l_1_30) {
    mesh_ring_l_1_30Geometry.scale(0.015120000000000001, 0.029400000000000003, 0.015120000000000001);
  }
  const mesh_ring_l_1_30 = new THREE.SkinnedMesh(
    mesh_ring_l_1_30Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_l_1_30.name = "Ring L phalanx 1";
  if (endpoint_ring_l_1_30) {
    mesh_ring_l_1_30.position.copy(endpoint_ring_l_1_30.midpoint);
    mesh_ring_l_1_30.quaternion.copy(endpoint_ring_l_1_30.quaternion);
  }
  mesh_ring_l_1_30.castShadow = options.castShadow ?? true;
  mesh_ring_l_1_30.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_l_1_30.userData.sculptComponent = {"id": "ring-l-1", "name": "Ring L phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Ring L phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "hand-l-ring-1", "localStart": [0.007, -0.03763, 0.0028], "localEnd": [0.01052, -0.06682, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015120000000000001, "height": 0.029400000000000003, "depth": 0.015120000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.007000000000000006, -0.037632, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.015120000000000001, 0.029400000000000003, 0.015120000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "ring-l-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_ring_l_1_30.add(mesh_ring_l_1_30);
  meshes["ring-l-1"] = mesh_ring_l_1_30;
  colliders["ring-l-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["ring-l-1"] ??= [];
  destructionGroups["ring-l-1"].push(node_ring_l_1_30);

  const attachment_ring_l_2_31 = {"parentSocket": "ring-l-1-ring-2", "localStart": [0.00352, -0.02919, 0.0], "localEnd": [0.00593, -0.0492, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_l_2_31 = makeAttachmentEndpoint(attachment_ring_l_2_31);
  const node_ring_l_2_31 = new THREE.Group();
  node_ring_l_2_31.name = "Ring L phalanx 2__pivot";
  node_ring_l_2_31.scale.set(1, 1, 1);
  if (endpoint_ring_l_2_31) {
    node_ring_l_2_31.position.copy(endpoint_ring_l_2_31.start);
    node_ring_l_2_31.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_l_2_31.position.set(0.0035195388942942385, -0.029188573894103648, 0.0);
    node_ring_l_2_31.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_l_2_31.userData.sculptComponent = {"id": "ring-l-2", "name": "Ring L phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Ring L phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "ring-l-1", "attachment": {"parentSocket": "ring-l-1-ring-2", "localStart": [0.00352, -0.02919, 0.0], "localEnd": [0.00593, -0.0492, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015120000000000001, "height": 0.02016, "depth": 0.015120000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0035195388942942385, -0.029188573894103648, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.015120000000000001, 0.02016, 0.015120000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "ring-l-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_ring_l_2_31.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["ring-l-1"] ?? root).add(node_ring_l_2_31);
  nodes["ring-l-2"] = node_ring_l_2_31;
  const mesh_ring_l_2_31Geometry = endpoint_ring_l_2_31
    ? new THREE.CylinderGeometry(endpoint_ring_l_2_31.endRadius, endpoint_ring_l_2_31.baseRadius, endpoint_ring_l_2_31.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_ring_l_2_31) {
    mesh_ring_l_2_31Geometry.scale(0.015120000000000001, 0.02016, 0.015120000000000001);
  }
  const mesh_ring_l_2_31 = new THREE.SkinnedMesh(
    mesh_ring_l_2_31Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_l_2_31.name = "Ring L phalanx 2";
  if (endpoint_ring_l_2_31) {
    mesh_ring_l_2_31.position.copy(endpoint_ring_l_2_31.midpoint);
    mesh_ring_l_2_31.quaternion.copy(endpoint_ring_l_2_31.quaternion);
  }
  mesh_ring_l_2_31.castShadow = options.castShadow ?? true;
  mesh_ring_l_2_31.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_l_2_31.userData.sculptComponent = {"id": "ring-l-2", "name": "Ring L phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Ring L phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "ring-l-1", "attachment": {"parentSocket": "ring-l-1-ring-2", "localStart": [0.00352, -0.02919, 0.0], "localEnd": [0.00593, -0.0492, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015120000000000001, "height": 0.02016, "depth": 0.015120000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0035195388942942385, -0.029188573894103648, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.015120000000000001, 0.02016, 0.015120000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "ring-l-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_ring_l_2_31.add(mesh_ring_l_2_31);
  meshes["ring-l-2"] = mesh_ring_l_2_31;
  colliders["ring-l-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["ring-l-2"] ??= [];
  destructionGroups["ring-l-2"].push(node_ring_l_2_31);

  const attachment_ring_l_3_32 = {"parentSocket": "ring-l-2-ring-3", "localStart": [0.00241, -0.02002, 0.0], "localEnd": [0.00396, -0.0328, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_l_3_32 = makeAttachmentEndpoint(attachment_ring_l_3_32);
  const node_ring_l_3_32 = new THREE.Group();
  node_ring_l_3_32.name = "Ring L phalanx 3__pivot";
  node_ring_l_3_32.scale.set(1, 1, 1);
  if (endpoint_ring_l_3_32) {
    node_ring_l_3_32.position.copy(endpoint_ring_l_3_32.start);
    node_ring_l_3_32.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_l_3_32.position.set(0.0024133980989446413, -0.02001502209881395, 0.0);
    node_ring_l_3_32.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_l_3_32.userData.sculptComponent = {"id": "ring-l-3", "name": "Ring L phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Ring L phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "ring-l-2", "attachment": {"parentSocket": "ring-l-2-ring-3", "localStart": [0.00241, -0.02002, 0.0], "localEnd": [0.00396, -0.0328, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015120000000000001, "height": 0.01288, "depth": 0.015120000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0024133980989446413, -0.02001502209881395, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.015120000000000001, 0.01288, 0.015120000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "ring-l-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_ring_l_3_32.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["ring-l-2"] ?? root).add(node_ring_l_3_32);
  nodes["ring-l-3"] = node_ring_l_3_32;
  const mesh_ring_l_3_32Geometry = endpoint_ring_l_3_32
    ? new THREE.CylinderGeometry(endpoint_ring_l_3_32.endRadius, endpoint_ring_l_3_32.baseRadius, endpoint_ring_l_3_32.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_ring_l_3_32) {
    mesh_ring_l_3_32Geometry.scale(0.015120000000000001, 0.01288, 0.015120000000000001);
  }
  const mesh_ring_l_3_32 = new THREE.SkinnedMesh(
    mesh_ring_l_3_32Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_l_3_32.name = "Ring L phalanx 3";
  if (endpoint_ring_l_3_32) {
    mesh_ring_l_3_32.position.copy(endpoint_ring_l_3_32.midpoint);
    mesh_ring_l_3_32.quaternion.copy(endpoint_ring_l_3_32.quaternion);
  }
  mesh_ring_l_3_32.castShadow = options.castShadow ?? true;
  mesh_ring_l_3_32.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_l_3_32.userData.sculptComponent = {"id": "ring-l-3", "name": "Ring L phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Ring L phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "ring-l-2", "attachment": {"parentSocket": "ring-l-2-ring-3", "localStart": [0.00241, -0.02002, 0.0], "localEnd": [0.00396, -0.0328, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015120000000000001, "height": 0.01288, "depth": 0.015120000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0024133980989446413, -0.02001502209881395, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.015120000000000001, 0.01288, 0.015120000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "ring-l-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_ring_l_3_32.add(mesh_ring_l_3_32);
  meshes["ring-l-3"] = mesh_ring_l_3_32;
  colliders["ring-l-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["ring-l-3"] ??= [];
  destructionGroups["ring-l-3"].push(node_ring_l_3_32);

  const attachment_little_l_1_33 = {"parentSocket": "hand-l-little-1", "localStart": [0.0196, -0.03763, 0.0028], "localEnd": [0.02228, -0.05987, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_l_1_33 = makeAttachmentEndpoint(attachment_little_l_1_33);
  const node_little_l_1_33 = new THREE.Group();
  node_little_l_1_33.name = "Little L phalanx 1__pivot";
  node_little_l_1_33.scale.set(1, 1, 1);
  if (endpoint_little_l_1_33) {
    node_little_l_1_33.position.copy(endpoint_little_l_1_33.start);
    node_little_l_1_33.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_l_1_33.position.set(0.019600000000000006, -0.037632, 0.0028000000000000004);
    node_little_l_1_33.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_l_1_33.userData.sculptComponent = {"id": "little-l-1", "name": "Little L phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Little L phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "hand-l-little-1", "localStart": [0.0196, -0.03763, 0.0028], "localEnd": [0.02228, -0.05987, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.013440000000000002, "height": 0.022400000000000003, "depth": 0.013440000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.019600000000000006, -0.037632, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.013440000000000002, 0.022400000000000003, 0.013440000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "little-l-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_little_l_1_33.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-l"] ?? root).add(node_little_l_1_33);
  nodes["little-l-1"] = node_little_l_1_33;
  const mesh_little_l_1_33Geometry = endpoint_little_l_1_33
    ? new THREE.CylinderGeometry(endpoint_little_l_1_33.endRadius, endpoint_little_l_1_33.baseRadius, endpoint_little_l_1_33.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_little_l_1_33) {
    mesh_little_l_1_33Geometry.scale(0.013440000000000002, 0.022400000000000003, 0.013440000000000002);
  }
  const mesh_little_l_1_33 = new THREE.SkinnedMesh(
    mesh_little_l_1_33Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_l_1_33.name = "Little L phalanx 1";
  if (endpoint_little_l_1_33) {
    mesh_little_l_1_33.position.copy(endpoint_little_l_1_33.midpoint);
    mesh_little_l_1_33.quaternion.copy(endpoint_little_l_1_33.quaternion);
  }
  mesh_little_l_1_33.castShadow = options.castShadow ?? true;
  mesh_little_l_1_33.receiveShadow = options.receiveShadow ?? true;
  mesh_little_l_1_33.userData.sculptComponent = {"id": "little-l-1", "name": "Little L phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Little L phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "hand-l-little-1", "localStart": [0.0196, -0.03763, 0.0028], "localEnd": [0.02228, -0.05987, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.013440000000000002, "height": 0.022400000000000003, "depth": 0.013440000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.019600000000000006, -0.037632, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.013440000000000002, 0.022400000000000003, 0.013440000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-l-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "little-l-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_little_l_1_33.add(mesh_little_l_1_33);
  meshes["little-l-1"] = mesh_little_l_1_33;
  colliders["little-l-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["little-l-1"] ??= [];
  destructionGroups["little-l-1"].push(node_little_l_1_33);

  const attachment_little_l_2_34 = {"parentSocket": "little-l-1-little-2", "localStart": [0.00268, -0.02224, 0.0], "localEnd": [0.00463, -0.03836, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_l_2_34 = makeAttachmentEndpoint(attachment_little_l_2_34);
  const node_little_l_2_34 = new THREE.Group();
  node_little_l_2_34.name = "Little L phalanx 2__pivot";
  node_little_l_2_34.scale.set(1, 1, 1);
  if (endpoint_little_l_2_34) {
    node_little_l_2_34.position.copy(endpoint_little_l_2_34.start);
    node_little_l_2_34.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_l_2_34.position.set(0.0026815534432718113, -0.02223891344312659, 0.0);
    node_little_l_2_34.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_l_2_34.userData.sculptComponent = {"id": "little-l-2", "name": "Little L phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Little L phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "little-l-1", "attachment": {"parentSocket": "little-l-1-little-2", "localStart": [0.00268, -0.02224, 0.0], "localEnd": [0.00463, -0.03836, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.013440000000000002, "height": 0.01624, "depth": 0.013440000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0026815534432718113, -0.02223891344312659, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.013440000000000002, 0.01624, 0.013440000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "little-l-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_little_l_2_34.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["little-l-1"] ?? root).add(node_little_l_2_34);
  nodes["little-l-2"] = node_little_l_2_34;
  const mesh_little_l_2_34Geometry = endpoint_little_l_2_34
    ? new THREE.CylinderGeometry(endpoint_little_l_2_34.endRadius, endpoint_little_l_2_34.baseRadius, endpoint_little_l_2_34.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_little_l_2_34) {
    mesh_little_l_2_34Geometry.scale(0.013440000000000002, 0.01624, 0.013440000000000002);
  }
  const mesh_little_l_2_34 = new THREE.SkinnedMesh(
    mesh_little_l_2_34Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_l_2_34.name = "Little L phalanx 2";
  if (endpoint_little_l_2_34) {
    mesh_little_l_2_34.position.copy(endpoint_little_l_2_34.midpoint);
    mesh_little_l_2_34.quaternion.copy(endpoint_little_l_2_34.quaternion);
  }
  mesh_little_l_2_34.castShadow = options.castShadow ?? true;
  mesh_little_l_2_34.receiveShadow = options.receiveShadow ?? true;
  mesh_little_l_2_34.userData.sculptComponent = {"id": "little-l-2", "name": "Little L phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Little L phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "little-l-1", "attachment": {"parentSocket": "little-l-1-little-2", "localStart": [0.00268, -0.02224, 0.0], "localEnd": [0.00463, -0.03836, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.013440000000000002, "height": 0.01624, "depth": 0.013440000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0026815534432718113, -0.02223891344312659, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.013440000000000002, 0.01624, 0.013440000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-l-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "little-l-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_little_l_2_34.add(mesh_little_l_2_34);
  meshes["little-l-2"] = mesh_little_l_2_34;
  colliders["little-l-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["little-l-2"] ??= [];
  destructionGroups["little-l-2"].push(node_little_l_2_34);

  const attachment_little_l_3_35 = {"parentSocket": "little-l-2-little-3", "localStart": [0.00194, -0.01612, 0.0], "localEnd": [0.00322, -0.02669, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_l_3_35 = makeAttachmentEndpoint(attachment_little_l_3_35);
  const node_little_l_3_35 = new THREE.Group();
  node_little_l_3_35.name = "Little L phalanx 3__pivot";
  node_little_l_3_35.scale.set(1, 1, 1);
  if (endpoint_little_l_3_35) {
    node_little_l_3_35.position.copy(endpoint_little_l_3_35.start);
    node_little_l_3_35.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_l_3_35.position.set(0.0019441262463720244, -0.016123212246266783, 0.0);
    node_little_l_3_35.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_l_3_35.userData.sculptComponent = {"id": "little-l-3", "name": "Little L phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Little L phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "little-l-2", "attachment": {"parentSocket": "little-l-2-little-3", "localStart": [0.00194, -0.01612, 0.0], "localEnd": [0.00322, -0.02669, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.013440000000000002, "height": 0.01064, "depth": 0.013440000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0019441262463720244, -0.016123212246266783, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.013440000000000002, 0.01064, 0.013440000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "little-l-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_little_l_3_35.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["little-l-2"] ?? root).add(node_little_l_3_35);
  nodes["little-l-3"] = node_little_l_3_35;
  const mesh_little_l_3_35Geometry = endpoint_little_l_3_35
    ? new THREE.CylinderGeometry(endpoint_little_l_3_35.endRadius, endpoint_little_l_3_35.baseRadius, endpoint_little_l_3_35.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_little_l_3_35) {
    mesh_little_l_3_35Geometry.scale(0.013440000000000002, 0.01064, 0.013440000000000002);
  }
  const mesh_little_l_3_35 = new THREE.SkinnedMesh(
    mesh_little_l_3_35Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_l_3_35.name = "Little L phalanx 3";
  if (endpoint_little_l_3_35) {
    mesh_little_l_3_35.position.copy(endpoint_little_l_3_35.midpoint);
    mesh_little_l_3_35.quaternion.copy(endpoint_little_l_3_35.quaternion);
  }
  mesh_little_l_3_35.castShadow = options.castShadow ?? true;
  mesh_little_l_3_35.receiveShadow = options.receiveShadow ?? true;
  mesh_little_l_3_35.userData.sculptComponent = {"id": "little-l-3", "name": "Little L phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Little L phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "little-l-2", "attachment": {"parentSocket": "little-l-2-little-3", "localStart": [0.00194, -0.01612, 0.0], "localEnd": [0.00322, -0.02669, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.013440000000000002, "height": 0.01064, "depth": 0.013440000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0019441262463720244, -0.016123212246266783, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.013440000000000002, 0.01064, 0.013440000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-l-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "little-l-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_little_l_3_35.add(mesh_little_l_3_35);
  meshes["little-l-3"] = mesh_little_l_3_35;
  colliders["little-l-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["little-l-3"] ??= [];
  destructionGroups["little-l-3"].push(node_little_l_3_35);

  const attachment_clavicle_r_36 = {"parentSocket": "chest-clavicle-r", "localStart": [-0.03002, 0.36484, 0.0056], "localEnd": [-0.1876, 0.35924, 0.0112], "contactType": "rigid-weld", "baseRadius": 0.0308, "endRadius": 0.0476, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_clavicle_r_36 = makeAttachmentEndpoint(attachment_clavicle_r_36);
  const node_clavicle_r_36 = new THREE.Group();
  node_clavicle_r_36.name = "Clavicle R__pivot";
  node_clavicle_r_36.scale.set(1, 1, 1);
  if (endpoint_clavicle_r_36) {
    node_clavicle_r_36.position.copy(endpoint_clavicle_r_36.start);
    node_clavicle_r_36.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_clavicle_r_36.position.set(-0.030016000000000004, 0.3648400000000001, 0.005600000000000001);
    node_clavicle_r_36.rotation.set(0.0, 0.0, 0.0);
  }
  node_clavicle_r_36.userData.sculptComponent = {"id": "clavicle-r", "name": "Clavicle R", "level": "meso", "role": "support", "importance": 0.6, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Clavicle R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "chest", "attachment": {"parentSocket": "chest-clavicle-r", "localStart": [-0.03002, 0.36484, 0.0056], "localEnd": [-0.1876, 0.35924, 0.0112], "contactType": "rigid-weld", "baseRadius": 0.0308, "endRadius": 0.0476, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.157584, "height": 0.09520000000000002, "depth": 0.09520000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.030016000000000004, 0.3648400000000001, 0.005600000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [0.157584, 0.09520000000000002, 0.09520000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "clavicle-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "clavicle-r", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_clavicle_r_36.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "clavicle-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["chest"] ?? root).add(node_clavicle_r_36);
  nodes["clavicle-r"] = node_clavicle_r_36;
  const mesh_clavicle_r_36Geometry = endpoint_clavicle_r_36
    ? new THREE.CylinderGeometry(endpoint_clavicle_r_36.endRadius, endpoint_clavicle_r_36.baseRadius, endpoint_clavicle_r_36.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_clavicle_r_36) {
    mesh_clavicle_r_36Geometry.scale(0.157584, 0.09520000000000002, 0.09520000000000002);
  }
  const mesh_clavicle_r_36 = new THREE.SkinnedMesh(
    mesh_clavicle_r_36Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_clavicle_r_36.name = "Clavicle R";
  if (endpoint_clavicle_r_36) {
    mesh_clavicle_r_36.position.copy(endpoint_clavicle_r_36.midpoint);
    mesh_clavicle_r_36.quaternion.copy(endpoint_clavicle_r_36.quaternion);
  }
  mesh_clavicle_r_36.castShadow = options.castShadow ?? true;
  mesh_clavicle_r_36.receiveShadow = options.receiveShadow ?? true;
  mesh_clavicle_r_36.userData.sculptComponent = {"id": "clavicle-r", "name": "Clavicle R", "level": "meso", "role": "support", "importance": 0.6, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Clavicle R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "chest", "attachment": {"parentSocket": "chest-clavicle-r", "localStart": [-0.03002, 0.36484, 0.0056], "localEnd": [-0.1876, 0.35924, 0.0112], "contactType": "rigid-weld", "baseRadius": 0.0308, "endRadius": 0.0476, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.157584, "height": 0.09520000000000002, "depth": 0.09520000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.030016000000000004, 0.3648400000000001, 0.005600000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [0.157584, 0.09520000000000002, 0.09520000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "clavicle-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "clavicle-r", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_clavicle_r_36.add(mesh_clavicle_r_36);
  meshes["clavicle-r"] = mesh_clavicle_r_36;
  colliders["clavicle-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["clavicle-r"] ??= [];
  destructionGroups["clavicle-r"].push(node_clavicle_r_36);

  const attachment_upper_arm_r_37 = {"parentSocket": "clavicle-shoulder-r", "localStart": [-0.15758, -0.0056, 0.0056], "localEnd": [-0.22589, -0.34255, 0.0056], "contactType": "socket-joint", "baseRadius": 0.0448, "endRadius": 0.0364, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_upper_arm_r_37 = makeAttachmentEndpoint(attachment_upper_arm_r_37);
  const node_upper_arm_r_37 = new THREE.Group();
  node_upper_arm_r_37.name = "Upper arm R__pivot";
  node_upper_arm_r_37.scale.set(1, 1, 1);
  if (endpoint_upper_arm_r_37) {
    node_upper_arm_r_37.position.copy(endpoint_upper_arm_r_37.start);
    node_upper_arm_r_37.rotation.set(0.05235987755982989, 0.0, 0.10471975511965978);
  } else {
    node_upper_arm_r_37.position.set(-0.157584, -0.005599999999999994, 0.005600000000000001);
    node_upper_arm_r_37.rotation.set(0.05235987755982989, 0.0, 0.10471975511965978);
  }
  node_upper_arm_r_37.userData.sculptComponent = {"id": "upper-arm-r", "name": "Upper arm R", "level": "meso", "role": "arm", "importance": 0.7, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Upper arm R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "clavicle-r", "attachment": {"parentSocket": "clavicle-shoulder-r", "localStart": [-0.15758, -0.0056, 0.0056], "localEnd": [-0.22589, -0.34255, 0.0056], "contactType": "socket-joint", "baseRadius": 0.0448, "endRadius": 0.0364, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.08960000000000001, "height": 0.3438050000000001, "depth": 0.08960000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.157584, -0.005599999999999994, 0.005600000000000001], "rotation": [0.05235987755982989, 0.0, 0.10471975511965978], "scale": [0.08960000000000001, 0.3438050000000001, 0.08960000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "shirt", "materialLayers": ["shirt"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "upper-arm-r", "dominantAlbedo": "rgba(78, 67, 50, 1.0)", "secondaryAlbedo": "rgba(224, 194, 159, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.247, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/03-shirt-cream.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.49}}};
  node_upper_arm_r_37.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}};
  (nodes["clavicle-r"] ?? root).add(node_upper_arm_r_37);
  nodes["upper-arm-r"] = node_upper_arm_r_37;
  const mesh_upper_arm_r_37Geometry = endpoint_upper_arm_r_37
    ? new THREE.CylinderGeometry(endpoint_upper_arm_r_37.endRadius, endpoint_upper_arm_r_37.baseRadius, endpoint_upper_arm_r_37.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_upper_arm_r_37) {
    mesh_upper_arm_r_37Geometry.scale(0.08960000000000001, 0.3438050000000001, 0.08960000000000001);
  }
  const mesh_upper_arm_r_37 = new THREE.SkinnedMesh(
    mesh_upper_arm_r_37Geometry,
    materialMap["shirt"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_r_37.name = "Upper arm R";
  if (endpoint_upper_arm_r_37) {
    mesh_upper_arm_r_37.position.copy(endpoint_upper_arm_r_37.midpoint);
    mesh_upper_arm_r_37.quaternion.copy(endpoint_upper_arm_r_37.quaternion);
  }
  mesh_upper_arm_r_37.castShadow = options.castShadow ?? true;
  mesh_upper_arm_r_37.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_r_37.userData.sculptComponent = {"id": "upper-arm-r", "name": "Upper arm R", "level": "meso", "role": "arm", "importance": 0.7, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Upper arm R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "clavicle-r", "attachment": {"parentSocket": "clavicle-shoulder-r", "localStart": [-0.15758, -0.0056, 0.0056], "localEnd": [-0.22589, -0.34255, 0.0056], "contactType": "socket-joint", "baseRadius": 0.0448, "endRadius": 0.0364, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.08960000000000001, "height": 0.3438050000000001, "depth": 0.08960000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.157584, -0.005599999999999994, 0.005600000000000001], "rotation": [0.05235987755982989, 0.0, 0.10471975511965978], "scale": [0.08960000000000001, 0.3438050000000001, 0.08960000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "shirt", "materialLayers": ["shirt"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "upper-arm-r", "dominantAlbedo": "rgba(78, 67, 50, 1.0)", "secondaryAlbedo": "rgba(224, 194, 159, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.247, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/03-shirt-cream.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.49}}};
  node_upper_arm_r_37.add(mesh_upper_arm_r_37);
  meshes["upper-arm-r"] = mesh_upper_arm_r_37;
  colliders["upper-arm-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["upper-arm-r"] ??= [];
  destructionGroups["upper-arm-r"].push(node_upper_arm_r_37);

  const attachment_forearm_r_38 = {"parentSocket": "upper-arm-elbow-r", "localStart": [-0.0683, -0.33695, 0.0], "localEnd": [-0.10198, -0.61622, 0.0], "contactType": "hinge-joint", "baseRadius": 0.0336, "endRadius": 0.0252, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_forearm_r_38 = makeAttachmentEndpoint(attachment_forearm_r_38);
  const node_forearm_r_38 = new THREE.Group();
  node_forearm_r_38.name = "Forearm R__pivot";
  node_forearm_r_38.scale.set(1, 1, 1);
  if (endpoint_forearm_r_38) {
    node_forearm_r_38.position.copy(endpoint_forearm_r_38.start);
    node_forearm_r_38.rotation.set(0.12217304763960307, 0.0, -0.03490658503988659);
  } else {
    node_forearm_r_38.position.set(-0.06830350927399606, -0.33695178979470813, 0.0);
    node_forearm_r_38.rotation.set(0.12217304763960307, 0.0, -0.03490658503988659);
  }
  node_forearm_r_38.userData.sculptComponent = {"id": "forearm-r", "name": "Forearm R", "level": "meso", "role": "arm", "importance": 0.65, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Forearm R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "upper-arm-r", "attachment": {"parentSocket": "upper-arm-elbow-r", "localStart": [-0.0683, -0.33695, 0.0], "localEnd": [-0.10198, -0.61622, 0.0], "contactType": "hinge-joint", "baseRadius": 0.0336, "endRadius": 0.0252, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0728, "height": 0.2812950000000001, "depth": 0.0728, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.06830350927399606, -0.33695178979470813, 0.0], "rotation": [0.12217304763960307, 0.0, -0.03490658503988659], "scale": [0.0728, 0.2812950000000001, 0.0728]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "forearm-r", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_forearm_r_38.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["upper-arm-r"] ?? root).add(node_forearm_r_38);
  nodes["forearm-r"] = node_forearm_r_38;
  const mesh_forearm_r_38Geometry = endpoint_forearm_r_38
    ? new THREE.CylinderGeometry(endpoint_forearm_r_38.endRadius, endpoint_forearm_r_38.baseRadius, endpoint_forearm_r_38.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_forearm_r_38) {
    mesh_forearm_r_38Geometry.scale(0.0728, 0.2812950000000001, 0.0728);
  }
  const mesh_forearm_r_38 = new THREE.SkinnedMesh(
    mesh_forearm_r_38Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_r_38.name = "Forearm R";
  if (endpoint_forearm_r_38) {
    mesh_forearm_r_38.position.copy(endpoint_forearm_r_38.midpoint);
    mesh_forearm_r_38.quaternion.copy(endpoint_forearm_r_38.quaternion);
  }
  mesh_forearm_r_38.castShadow = options.castShadow ?? true;
  mesh_forearm_r_38.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_r_38.userData.sculptComponent = {"id": "forearm-r", "name": "Forearm R", "level": "meso", "role": "arm", "importance": 0.65, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Forearm R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "upper-arm-r", "attachment": {"parentSocket": "upper-arm-elbow-r", "localStart": [-0.0683, -0.33695, 0.0], "localEnd": [-0.10198, -0.61622, 0.0], "contactType": "hinge-joint", "baseRadius": 0.0336, "endRadius": 0.0252, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0728, "height": 0.2812950000000001, "depth": 0.0728, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.06830350927399606, -0.33695178979470813, 0.0], "rotation": [0.12217304763960307, 0.0, -0.03490658503988659], "scale": [0.0728, 0.2812950000000001, 0.0728]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "forearm-r", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_forearm_r_38.add(mesh_forearm_r_38);
  meshes["forearm-r"] = mesh_forearm_r_38;
  colliders["forearm-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["forearm-r"] ??= [];
  destructionGroups["forearm-r"].push(node_forearm_r_38);

  const endpoint_hand_r_39 = makeAttachmentEndpoint(null);
  const node_hand_r_39 = new THREE.Group();
  node_hand_r_39.name = "Hand R__pivot";
  node_hand_r_39.scale.set(1, 1, 1);
  if (endpoint_hand_r_39) {
    node_hand_r_39.position.copy(endpoint_hand_r_39.start);
    node_hand_r_39.rotation.set(0.03490658503988659, 0.0, -0.06981317007977318);
  } else {
    node_hand_r_39.position.set(-0.039037552235880124, -0.32374993210876657, 0.0);
    node_hand_r_39.rotation.set(0.03490658503988659, 0.0, -0.06981317007977318);
  }
  node_hand_r_39.userData.sculptComponent = {"id": "hand-r", "name": "Hand R", "level": "meso", "role": "hand", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Hand R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "forearm-r", "attachment": null, "dimensions": {"width": 0.06160000000000001, "height": 0.08960000000000001, "depth": 0.0364, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.039037552235880124, -0.32374993210876657, 0.0], "rotation": [0.03490658503988659, 0.0, -0.06981317007977318], "scale": [0.06160000000000001, 0.08960000000000001, 0.0364]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "hand-r", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_hand_r_39.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["forearm-r"] ?? root).add(node_hand_r_39);
  nodes["hand-r"] = node_hand_r_39;
  const mesh_hand_r_39Geometry = endpoint_hand_r_39
    ? new THREE.CylinderGeometry(endpoint_hand_r_39.endRadius, endpoint_hand_r_39.baseRadius, endpoint_hand_r_39.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_hand_r_39) {
    mesh_hand_r_39Geometry.scale(0.06160000000000001, 0.08960000000000001, 0.0364);
  }
  const mesh_hand_r_39 = new THREE.SkinnedMesh(
    mesh_hand_r_39Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_r_39.name = "Hand R";
  if (endpoint_hand_r_39) {
    mesh_hand_r_39.position.copy(endpoint_hand_r_39.midpoint);
    mesh_hand_r_39.quaternion.copy(endpoint_hand_r_39.quaternion);
  }
  mesh_hand_r_39.castShadow = options.castShadow ?? true;
  mesh_hand_r_39.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_r_39.userData.sculptComponent = {"id": "hand-r", "name": "Hand R", "level": "meso", "role": "hand", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Hand R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "forearm-r", "attachment": null, "dimensions": {"width": 0.06160000000000001, "height": 0.08960000000000001, "depth": 0.0364, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.039037552235880124, -0.32374993210876657, 0.0], "rotation": [0.03490658503988659, 0.0, -0.06981317007977318], "scale": [0.06160000000000001, 0.08960000000000001, 0.0364]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "hand-r", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_hand_r_39.add(mesh_hand_r_39);
  meshes["hand-r"] = mesh_hand_r_39;
  colliders["hand-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-r"] ??= [];
  destructionGroups["hand-r"].push(node_hand_r_39);

  const attachment_thumb_r_1_40 = {"parentSocket": "hand-r-thumb-1", "localStart": [0.028, -0.00538, 0.0056], "localEnd": [0.04312, -0.0184, 0.0119], "contactType": "rigid-weld", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_r_1_40 = makeAttachmentEndpoint(attachment_thumb_r_1_40);
  const node_thumb_r_1_40 = new THREE.Group();
  node_thumb_r_1_40.name = "Thumb R phalanx 1__pivot";
  node_thumb_r_1_40.scale.set(1, 1, 1);
  if (endpoint_thumb_r_1_40) {
    node_thumb_r_1_40.position.copy(endpoint_thumb_r_1_40.start);
    node_thumb_r_1_40.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_r_1_40.position.set(0.028000000000000025, -0.005375999999999992, 0.005600000000000001);
    node_thumb_r_1_40.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_r_1_40.userData.sculptComponent = {"id": "thumb-r-1", "name": "Thumb R phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thumb R phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "hand-r-thumb-1", "localStart": [0.028, -0.00538, 0.0056], "localEnd": [0.04312, -0.0184, 0.0119], "contactType": "rigid-weld", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.017920000000000002, "height": 0.021, "depth": 0.017920000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.028000000000000025, -0.005375999999999992, 0.005600000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [0.017920000000000002, 0.021, 0.017920000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "thumb-r-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_thumb_r_1_40.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-r"] ?? root).add(node_thumb_r_1_40);
  nodes["thumb-r-1"] = node_thumb_r_1_40;
  const mesh_thumb_r_1_40Geometry = endpoint_thumb_r_1_40
    ? new THREE.CylinderGeometry(endpoint_thumb_r_1_40.endRadius, endpoint_thumb_r_1_40.baseRadius, endpoint_thumb_r_1_40.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_thumb_r_1_40) {
    mesh_thumb_r_1_40Geometry.scale(0.017920000000000002, 0.021, 0.017920000000000002);
  }
  const mesh_thumb_r_1_40 = new THREE.SkinnedMesh(
    mesh_thumb_r_1_40Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_r_1_40.name = "Thumb R phalanx 1";
  if (endpoint_thumb_r_1_40) {
    mesh_thumb_r_1_40.position.copy(endpoint_thumb_r_1_40.midpoint);
    mesh_thumb_r_1_40.quaternion.copy(endpoint_thumb_r_1_40.quaternion);
  }
  mesh_thumb_r_1_40.castShadow = options.castShadow ?? true;
  mesh_thumb_r_1_40.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_r_1_40.userData.sculptComponent = {"id": "thumb-r-1", "name": "Thumb R phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thumb R phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "hand-r-thumb-1", "localStart": [0.028, -0.00538, 0.0056], "localEnd": [0.04312, -0.0184, 0.0119], "contactType": "rigid-weld", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.017920000000000002, "height": 0.021, "depth": 0.017920000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.028000000000000025, -0.005375999999999992, 0.005600000000000001], "rotation": [0.0, 0.0, 0.0], "scale": [0.017920000000000002, 0.021, 0.017920000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "thumb-r-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_thumb_r_1_40.add(mesh_thumb_r_1_40);
  meshes["thumb-r-1"] = mesh_thumb_r_1_40;
  colliders["thumb-r-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["thumb-r-1"] ??= [];
  destructionGroups["thumb-r-1"].push(node_thumb_r_1_40);

  const attachment_thumb_r_2_41 = {"parentSocket": "thumb-r-1-thumb-2", "localStart": [0.01512, -0.01302, 0.0063], "localEnd": [0.02621, -0.02257, 0.01092], "contactType": "hinge-joint", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_r_2_41 = makeAttachmentEndpoint(attachment_thumb_r_2_41);
  const node_thumb_r_2_41 = new THREE.Group();
  node_thumb_r_2_41.name = "Thumb R phalanx 2__pivot";
  node_thumb_r_2_41.scale.set(1, 1, 1);
  if (endpoint_thumb_r_2_41) {
    node_thumb_r_2_41.position.copy(endpoint_thumb_r_2_41.start);
    node_thumb_r_2_41.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_r_2_41.position.set(0.015120000000000022, -0.013020000000000004, 0.0063);
    node_thumb_r_2_41.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_r_2_41.userData.sculptComponent = {"id": "thumb-r-2", "name": "Thumb R phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thumb R phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thumb-r-1", "attachment": {"parentSocket": "thumb-r-1-thumb-2", "localStart": [0.01512, -0.01302, 0.0063], "localEnd": [0.02621, -0.02257, 0.01092], "contactType": "hinge-joint", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.017920000000000002, "height": 0.015400000000000002, "depth": 0.017920000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.015120000000000022, -0.013020000000000004, 0.0063], "rotation": [0.0, 0.0, 0.0], "scale": [0.017920000000000002, 0.015400000000000002, 0.017920000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "thumb-r-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_thumb_r_2_41.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["thumb-r-1"] ?? root).add(node_thumb_r_2_41);
  nodes["thumb-r-2"] = node_thumb_r_2_41;
  const mesh_thumb_r_2_41Geometry = endpoint_thumb_r_2_41
    ? new THREE.CylinderGeometry(endpoint_thumb_r_2_41.endRadius, endpoint_thumb_r_2_41.baseRadius, endpoint_thumb_r_2_41.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_thumb_r_2_41) {
    mesh_thumb_r_2_41Geometry.scale(0.017920000000000002, 0.015400000000000002, 0.017920000000000002);
  }
  const mesh_thumb_r_2_41 = new THREE.SkinnedMesh(
    mesh_thumb_r_2_41Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_r_2_41.name = "Thumb R phalanx 2";
  if (endpoint_thumb_r_2_41) {
    mesh_thumb_r_2_41.position.copy(endpoint_thumb_r_2_41.midpoint);
    mesh_thumb_r_2_41.quaternion.copy(endpoint_thumb_r_2_41.quaternion);
  }
  mesh_thumb_r_2_41.castShadow = options.castShadow ?? true;
  mesh_thumb_r_2_41.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_r_2_41.userData.sculptComponent = {"id": "thumb-r-2", "name": "Thumb R phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thumb R phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thumb-r-1", "attachment": {"parentSocket": "thumb-r-1-thumb-2", "localStart": [0.01512, -0.01302, 0.0063], "localEnd": [0.02621, -0.02257, 0.01092], "contactType": "hinge-joint", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.017920000000000002, "height": 0.015400000000000002, "depth": 0.017920000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.015120000000000022, -0.013020000000000004, 0.0063], "rotation": [0.0, 0.0, 0.0], "scale": [0.017920000000000002, 0.015400000000000002, 0.017920000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "thumb-r-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_thumb_r_2_41.add(mesh_thumb_r_2_41);
  meshes["thumb-r-2"] = mesh_thumb_r_2_41;
  colliders["thumb-r-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["thumb-r-2"] ??= [];
  destructionGroups["thumb-r-2"].push(node_thumb_r_2_41);

  const attachment_thumb_r_3_42 = {"parentSocket": "thumb-r-2-thumb-3", "localStart": [0.01109, -0.00955, 0.00462], "localEnd": [0.01915, -0.01649, 0.00798], "contactType": "hinge-joint", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thumb_r_3_42 = makeAttachmentEndpoint(attachment_thumb_r_3_42);
  const node_thumb_r_3_42 = new THREE.Group();
  node_thumb_r_3_42.name = "Thumb R phalanx 3__pivot";
  node_thumb_r_3_42.scale.set(1, 1, 1);
  if (endpoint_thumb_r_3_42) {
    node_thumb_r_3_42.position.copy(endpoint_thumb_r_3_42.start);
    node_thumb_r_3_42.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_thumb_r_3_42.position.set(0.011087999999999987, -0.009548000000000001, 0.004620000000000003);
    node_thumb_r_3_42.rotation.set(0.0, 0.0, 0.0);
  }
  node_thumb_r_3_42.userData.sculptComponent = {"id": "thumb-r-3", "name": "Thumb R phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thumb R phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thumb-r-2", "attachment": {"parentSocket": "thumb-r-2-thumb-3", "localStart": [0.01109, -0.00955, 0.00462], "localEnd": [0.01915, -0.01649, 0.00798], "contactType": "hinge-joint", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.017920000000000002, "height": 0.011200000000000002, "depth": 0.017920000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.011087999999999987, -0.009548000000000001, 0.004620000000000003], "rotation": [0.0, 0.0, 0.0], "scale": [0.017920000000000002, 0.011200000000000002, 0.017920000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "thumb-r-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_thumb_r_3_42.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["thumb-r-2"] ?? root).add(node_thumb_r_3_42);
  nodes["thumb-r-3"] = node_thumb_r_3_42;
  const mesh_thumb_r_3_42Geometry = endpoint_thumb_r_3_42
    ? new THREE.CylinderGeometry(endpoint_thumb_r_3_42.endRadius, endpoint_thumb_r_3_42.baseRadius, endpoint_thumb_r_3_42.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_thumb_r_3_42) {
    mesh_thumb_r_3_42Geometry.scale(0.017920000000000002, 0.011200000000000002, 0.017920000000000002);
  }
  const mesh_thumb_r_3_42 = new THREE.SkinnedMesh(
    mesh_thumb_r_3_42Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thumb_r_3_42.name = "Thumb R phalanx 3";
  if (endpoint_thumb_r_3_42) {
    mesh_thumb_r_3_42.position.copy(endpoint_thumb_r_3_42.midpoint);
    mesh_thumb_r_3_42.quaternion.copy(endpoint_thumb_r_3_42.quaternion);
  }
  mesh_thumb_r_3_42.castShadow = options.castShadow ?? true;
  mesh_thumb_r_3_42.receiveShadow = options.receiveShadow ?? true;
  mesh_thumb_r_3_42.userData.sculptComponent = {"id": "thumb-r-3", "name": "Thumb R phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thumb R phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thumb-r-2", "attachment": {"parentSocket": "thumb-r-2-thumb-3", "localStart": [0.01109, -0.00955, 0.00462], "localEnd": [0.01915, -0.01649, 0.00798], "contactType": "hinge-joint", "baseRadius": 0.00896, "endRadius": 0.00735, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.017920000000000002, "height": 0.011200000000000002, "depth": 0.017920000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.011087999999999987, -0.009548000000000001, 0.004620000000000003], "rotation": [0.0, 0.0, 0.0], "scale": [0.017920000000000002, 0.011200000000000002, 0.017920000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thumb-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "thumb-r-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_thumb_r_3_42.add(mesh_thumb_r_3_42);
  meshes["thumb-r-3"] = mesh_thumb_r_3_42;
  colliders["thumb-r-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["thumb-r-3"] ??= [];
  destructionGroups["thumb-r-3"].push(node_thumb_r_3_42);

  const attachment_index_r_1_43 = {"parentSocket": "hand-r-index-1", "localStart": [0.021, -0.03763, 0.0028], "localEnd": [0.01748, -0.06682, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_r_1_43 = makeAttachmentEndpoint(attachment_index_r_1_43);
  const node_index_r_1_43 = new THREE.Group();
  node_index_r_1_43.name = "Index R phalanx 1__pivot";
  node_index_r_1_43.scale.set(1, 1, 1);
  if (endpoint_index_r_1_43) {
    node_index_r_1_43.position.copy(endpoint_index_r_1_43.start);
    node_index_r_1_43.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_r_1_43.position.set(0.02100000000000002, -0.037632, 0.0028000000000000004);
    node_index_r_1_43.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_r_1_43.userData.sculptComponent = {"id": "index-r-1", "name": "Index R phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Index R phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "hand-r-index-1", "localStart": [0.021, -0.03763, 0.0028], "localEnd": [0.01748, -0.06682, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015680000000000003, "height": 0.029400000000000003, "depth": 0.015680000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.02100000000000002, -0.037632, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.015680000000000003, 0.029400000000000003, 0.015680000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "index-r-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_index_r_1_43.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-r"] ?? root).add(node_index_r_1_43);
  nodes["index-r-1"] = node_index_r_1_43;
  const mesh_index_r_1_43Geometry = endpoint_index_r_1_43
    ? new THREE.CylinderGeometry(endpoint_index_r_1_43.endRadius, endpoint_index_r_1_43.baseRadius, endpoint_index_r_1_43.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_index_r_1_43) {
    mesh_index_r_1_43Geometry.scale(0.015680000000000003, 0.029400000000000003, 0.015680000000000003);
  }
  const mesh_index_r_1_43 = new THREE.SkinnedMesh(
    mesh_index_r_1_43Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_r_1_43.name = "Index R phalanx 1";
  if (endpoint_index_r_1_43) {
    mesh_index_r_1_43.position.copy(endpoint_index_r_1_43.midpoint);
    mesh_index_r_1_43.quaternion.copy(endpoint_index_r_1_43.quaternion);
  }
  mesh_index_r_1_43.castShadow = options.castShadow ?? true;
  mesh_index_r_1_43.receiveShadow = options.receiveShadow ?? true;
  mesh_index_r_1_43.userData.sculptComponent = {"id": "index-r-1", "name": "Index R phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Index R phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "hand-r-index-1", "localStart": [0.021, -0.03763, 0.0028], "localEnd": [0.01748, -0.06682, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015680000000000003, "height": 0.029400000000000003, "depth": 0.015680000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.02100000000000002, -0.037632, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.015680000000000003, 0.029400000000000003, 0.015680000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "index-r-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_index_r_1_43.add(mesh_index_r_1_43);
  meshes["index-r-1"] = mesh_index_r_1_43;
  colliders["index-r-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["index-r-1"] ??= [];
  destructionGroups["index-r-1"].push(node_index_r_1_43);

  const attachment_index_r_2_44 = {"parentSocket": "index-r-1-index-2", "localStart": [-0.00352, -0.02919, 0.0], "localEnd": [-0.00593, -0.0492, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_r_2_44 = makeAttachmentEndpoint(attachment_index_r_2_44);
  const node_index_r_2_44 = new THREE.Group();
  node_index_r_2_44.name = "Index R phalanx 2__pivot";
  node_index_r_2_44.scale.set(1, 1, 1);
  if (endpoint_index_r_2_44) {
    node_index_r_2_44.position.copy(endpoint_index_r_2_44.start);
    node_index_r_2_44.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_r_2_44.position.set(-0.0035195388942942385, -0.029188573894103648, 0.0);
    node_index_r_2_44.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_r_2_44.userData.sculptComponent = {"id": "index-r-2", "name": "Index R phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Index R phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "index-r-1", "attachment": {"parentSocket": "index-r-1-index-2", "localStart": [-0.00352, -0.02919, 0.0], "localEnd": [-0.00593, -0.0492, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015680000000000003, "height": 0.02016, "depth": 0.015680000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0035195388942942385, -0.029188573894103648, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.015680000000000003, 0.02016, 0.015680000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "index-r-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_index_r_2_44.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["index-r-1"] ?? root).add(node_index_r_2_44);
  nodes["index-r-2"] = node_index_r_2_44;
  const mesh_index_r_2_44Geometry = endpoint_index_r_2_44
    ? new THREE.CylinderGeometry(endpoint_index_r_2_44.endRadius, endpoint_index_r_2_44.baseRadius, endpoint_index_r_2_44.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_index_r_2_44) {
    mesh_index_r_2_44Geometry.scale(0.015680000000000003, 0.02016, 0.015680000000000003);
  }
  const mesh_index_r_2_44 = new THREE.SkinnedMesh(
    mesh_index_r_2_44Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_r_2_44.name = "Index R phalanx 2";
  if (endpoint_index_r_2_44) {
    mesh_index_r_2_44.position.copy(endpoint_index_r_2_44.midpoint);
    mesh_index_r_2_44.quaternion.copy(endpoint_index_r_2_44.quaternion);
  }
  mesh_index_r_2_44.castShadow = options.castShadow ?? true;
  mesh_index_r_2_44.receiveShadow = options.receiveShadow ?? true;
  mesh_index_r_2_44.userData.sculptComponent = {"id": "index-r-2", "name": "Index R phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Index R phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "index-r-1", "attachment": {"parentSocket": "index-r-1-index-2", "localStart": [-0.00352, -0.02919, 0.0], "localEnd": [-0.00593, -0.0492, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015680000000000003, "height": 0.02016, "depth": 0.015680000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0035195388942942385, -0.029188573894103648, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.015680000000000003, 0.02016, 0.015680000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "index-r-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_index_r_2_44.add(mesh_index_r_2_44);
  meshes["index-r-2"] = mesh_index_r_2_44;
  colliders["index-r-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["index-r-2"] ??= [];
  destructionGroups["index-r-2"].push(node_index_r_2_44);

  const attachment_index_r_3_45 = {"parentSocket": "index-r-2-index-3", "localStart": [-0.00241, -0.02002, 0.0], "localEnd": [-0.00402, -0.03336, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_index_r_3_45 = makeAttachmentEndpoint(attachment_index_r_3_45);
  const node_index_r_3_45 = new THREE.Group();
  node_index_r_3_45.name = "Index R phalanx 3__pivot";
  node_index_r_3_45.scale.set(1, 1, 1);
  if (endpoint_index_r_3_45) {
    node_index_r_3_45.position.copy(endpoint_index_r_3_45.start);
    node_index_r_3_45.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_index_r_3_45.position.set(-0.0024133980989446413, -0.02001502209881395, 0.0);
    node_index_r_3_45.rotation.set(0.0, 0.0, 0.0);
  }
  node_index_r_3_45.userData.sculptComponent = {"id": "index-r-3", "name": "Index R phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Index R phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "index-r-2", "attachment": {"parentSocket": "index-r-2-index-3", "localStart": [-0.00241, -0.02002, 0.0], "localEnd": [-0.00402, -0.03336, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015680000000000003, "height": 0.013440000000000002, "depth": 0.015680000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0024133980989446413, -0.02001502209881395, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.015680000000000003, 0.013440000000000002, 0.015680000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "index-r-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_index_r_3_45.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["index-r-2"] ?? root).add(node_index_r_3_45);
  nodes["index-r-3"] = node_index_r_3_45;
  const mesh_index_r_3_45Geometry = endpoint_index_r_3_45
    ? new THREE.CylinderGeometry(endpoint_index_r_3_45.endRadius, endpoint_index_r_3_45.baseRadius, endpoint_index_r_3_45.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_index_r_3_45) {
    mesh_index_r_3_45Geometry.scale(0.015680000000000003, 0.013440000000000002, 0.015680000000000003);
  }
  const mesh_index_r_3_45 = new THREE.SkinnedMesh(
    mesh_index_r_3_45Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_index_r_3_45.name = "Index R phalanx 3";
  if (endpoint_index_r_3_45) {
    mesh_index_r_3_45.position.copy(endpoint_index_r_3_45.midpoint);
    mesh_index_r_3_45.quaternion.copy(endpoint_index_r_3_45.quaternion);
  }
  mesh_index_r_3_45.castShadow = options.castShadow ?? true;
  mesh_index_r_3_45.receiveShadow = options.receiveShadow ?? true;
  mesh_index_r_3_45.userData.sculptComponent = {"id": "index-r-3", "name": "Index R phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Index R phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "index-r-2", "attachment": {"parentSocket": "index-r-2-index-3", "localStart": [-0.00241, -0.02002, 0.0], "localEnd": [-0.00402, -0.03336, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00784, "endRadius": 0.00643, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015680000000000003, "height": 0.013440000000000002, "depth": 0.015680000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0024133980989446413, -0.02001502209881395, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.015680000000000003, 0.013440000000000002, 0.015680000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "index-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "index-r-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_index_r_3_45.add(mesh_index_r_3_45);
  meshes["index-r-3"] = mesh_index_r_3_45;
  colliders["index-r-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["index-r-3"] ??= [];
  destructionGroups["index-r-3"].push(node_index_r_3_45);

  const attachment_middle_r_1_46 = {"parentSocket": "hand-r-middle-1", "localStart": [0.007, -0.03763, 0.0028], "localEnd": [0.00315, -0.0696, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_r_1_46 = makeAttachmentEndpoint(attachment_middle_r_1_46);
  const node_middle_r_1_46 = new THREE.Group();
  node_middle_r_1_46.name = "Middle R phalanx 1__pivot";
  node_middle_r_1_46.scale.set(1, 1, 1);
  if (endpoint_middle_r_1_46) {
    node_middle_r_1_46.position.copy(endpoint_middle_r_1_46.start);
    node_middle_r_1_46.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_r_1_46.position.set(0.007000000000000006, -0.037632, 0.0028000000000000004);
    node_middle_r_1_46.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_r_1_46.userData.sculptComponent = {"id": "middle-r-1", "name": "Middle R phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Middle R phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "hand-r-middle-1", "localStart": [0.007, -0.03763, 0.0028], "localEnd": [0.00315, -0.0696, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.01624, "height": 0.032200000000000006, "depth": 0.01624, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.007000000000000006, -0.037632, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.01624, 0.032200000000000006, 0.01624]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "middle-r-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_middle_r_1_46.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-r"] ?? root).add(node_middle_r_1_46);
  nodes["middle-r-1"] = node_middle_r_1_46;
  const mesh_middle_r_1_46Geometry = endpoint_middle_r_1_46
    ? new THREE.CylinderGeometry(endpoint_middle_r_1_46.endRadius, endpoint_middle_r_1_46.baseRadius, endpoint_middle_r_1_46.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_middle_r_1_46) {
    mesh_middle_r_1_46Geometry.scale(0.01624, 0.032200000000000006, 0.01624);
  }
  const mesh_middle_r_1_46 = new THREE.SkinnedMesh(
    mesh_middle_r_1_46Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_r_1_46.name = "Middle R phalanx 1";
  if (endpoint_middle_r_1_46) {
    mesh_middle_r_1_46.position.copy(endpoint_middle_r_1_46.midpoint);
    mesh_middle_r_1_46.quaternion.copy(endpoint_middle_r_1_46.quaternion);
  }
  mesh_middle_r_1_46.castShadow = options.castShadow ?? true;
  mesh_middle_r_1_46.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_r_1_46.userData.sculptComponent = {"id": "middle-r-1", "name": "Middle R phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Middle R phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "hand-r-middle-1", "localStart": [0.007, -0.03763, 0.0028], "localEnd": [0.00315, -0.0696, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.01624, "height": 0.032200000000000006, "depth": 0.01624, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.007000000000000006, -0.037632, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.01624, 0.032200000000000006, 0.01624]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "middle-r-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_middle_r_1_46.add(mesh_middle_r_1_46);
  meshes["middle-r-1"] = mesh_middle_r_1_46;
  colliders["middle-r-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["middle-r-1"] ??= [];
  destructionGroups["middle-r-1"].push(node_middle_r_1_46);

  const attachment_middle_r_2_47 = {"parentSocket": "middle-r-1-middle-2", "localStart": [-0.00385, -0.03197, 0.0], "localEnd": [-0.00654, -0.05421, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_r_2_47 = makeAttachmentEndpoint(attachment_middle_r_2_47);
  const node_middle_r_2_47 = new THREE.Group();
  node_middle_r_2_47.name = "Middle R phalanx 2__pivot";
  node_middle_r_2_47.scale.set(1, 1, 1);
  if (endpoint_middle_r_2_47) {
    node_middle_r_2_47.position.copy(endpoint_middle_r_2_47.start);
    node_middle_r_2_47.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_r_2_47.position.set(-0.003854733074703187, -0.03196843807449448, 0.0);
    node_middle_r_2_47.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_r_2_47.userData.sculptComponent = {"id": "middle-r-2", "name": "Middle R phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Middle R phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "middle-r-1", "attachment": {"parentSocket": "middle-r-1-middle-2", "localStart": [-0.00385, -0.03197, 0.0], "localEnd": [-0.00654, -0.05421, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.01624, "height": 0.022400000000000003, "depth": 0.01624, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.003854733074703187, -0.03196843807449448, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.01624, 0.022400000000000003, 0.01624]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "middle-r-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_middle_r_2_47.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["middle-r-1"] ?? root).add(node_middle_r_2_47);
  nodes["middle-r-2"] = node_middle_r_2_47;
  const mesh_middle_r_2_47Geometry = endpoint_middle_r_2_47
    ? new THREE.CylinderGeometry(endpoint_middle_r_2_47.endRadius, endpoint_middle_r_2_47.baseRadius, endpoint_middle_r_2_47.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_middle_r_2_47) {
    mesh_middle_r_2_47Geometry.scale(0.01624, 0.022400000000000003, 0.01624);
  }
  const mesh_middle_r_2_47 = new THREE.SkinnedMesh(
    mesh_middle_r_2_47Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_r_2_47.name = "Middle R phalanx 2";
  if (endpoint_middle_r_2_47) {
    mesh_middle_r_2_47.position.copy(endpoint_middle_r_2_47.midpoint);
    mesh_middle_r_2_47.quaternion.copy(endpoint_middle_r_2_47.quaternion);
  }
  mesh_middle_r_2_47.castShadow = options.castShadow ?? true;
  mesh_middle_r_2_47.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_r_2_47.userData.sculptComponent = {"id": "middle-r-2", "name": "Middle R phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Middle R phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "middle-r-1", "attachment": {"parentSocket": "middle-r-1-middle-2", "localStart": [-0.00385, -0.03197, 0.0], "localEnd": [-0.00654, -0.05421, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.01624, "height": 0.022400000000000003, "depth": 0.01624, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.003854733074703187, -0.03196843807449448, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.01624, 0.022400000000000003, 0.01624]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "middle-r-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_middle_r_2_47.add(mesh_middle_r_2_47);
  meshes["middle-r-2"] = mesh_middle_r_2_47;
  colliders["middle-r-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["middle-r-2"] ??= [];
  destructionGroups["middle-r-2"].push(node_middle_r_2_47);

  const attachment_middle_r_3_48 = {"parentSocket": "middle-r-2-middle-3", "localStart": [-0.00268, -0.02224, 0.0], "localEnd": [-0.00436, -0.03614, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_middle_r_3_48 = makeAttachmentEndpoint(attachment_middle_r_3_48);
  const node_middle_r_3_48 = new THREE.Group();
  node_middle_r_3_48.name = "Middle R phalanx 3__pivot";
  node_middle_r_3_48.scale.set(1, 1, 1);
  if (endpoint_middle_r_3_48) {
    node_middle_r_3_48.position.copy(endpoint_middle_r_3_48.start);
    node_middle_r_3_48.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_r_3_48.position.set(-0.0026815534432718113, -0.022238913443126618, 0.0);
    node_middle_r_3_48.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_r_3_48.userData.sculptComponent = {"id": "middle-r-3", "name": "Middle R phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Middle R phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "middle-r-2", "attachment": {"parentSocket": "middle-r-2-middle-3", "localStart": [-0.00268, -0.02224, 0.0], "localEnd": [-0.00436, -0.03614, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.01624, "height": 0.014000000000000002, "depth": 0.01624, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0026815534432718113, -0.022238913443126618, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.01624, 0.014000000000000002, 0.01624]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "middle-r-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_middle_r_3_48.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["middle-r-2"] ?? root).add(node_middle_r_3_48);
  nodes["middle-r-3"] = node_middle_r_3_48;
  const mesh_middle_r_3_48Geometry = endpoint_middle_r_3_48
    ? new THREE.CylinderGeometry(endpoint_middle_r_3_48.endRadius, endpoint_middle_r_3_48.baseRadius, endpoint_middle_r_3_48.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_middle_r_3_48) {
    mesh_middle_r_3_48Geometry.scale(0.01624, 0.014000000000000002, 0.01624);
  }
  const mesh_middle_r_3_48 = new THREE.SkinnedMesh(
    mesh_middle_r_3_48Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_r_3_48.name = "Middle R phalanx 3";
  if (endpoint_middle_r_3_48) {
    mesh_middle_r_3_48.position.copy(endpoint_middle_r_3_48.midpoint);
    mesh_middle_r_3_48.quaternion.copy(endpoint_middle_r_3_48.quaternion);
  }
  mesh_middle_r_3_48.castShadow = options.castShadow ?? true;
  mesh_middle_r_3_48.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_r_3_48.userData.sculptComponent = {"id": "middle-r-3", "name": "Middle R phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Middle R phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "middle-r-2", "attachment": {"parentSocket": "middle-r-2-middle-3", "localStart": [-0.00268, -0.02224, 0.0], "localEnd": [-0.00436, -0.03614, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00812, "endRadius": 0.00666, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.01624, "height": 0.014000000000000002, "depth": 0.01624, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0026815534432718113, -0.022238913443126618, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.01624, 0.014000000000000002, 0.01624]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "middle-r-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_middle_r_3_48.add(mesh_middle_r_3_48);
  meshes["middle-r-3"] = mesh_middle_r_3_48;
  colliders["middle-r-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["middle-r-3"] ??= [];
  destructionGroups["middle-r-3"].push(node_middle_r_3_48);

  const attachment_ring_r_1_49 = {"parentSocket": "hand-r-ring-1", "localStart": [-0.007, -0.03763, 0.0028], "localEnd": [-0.01052, -0.06682, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_r_1_49 = makeAttachmentEndpoint(attachment_ring_r_1_49);
  const node_ring_r_1_49 = new THREE.Group();
  node_ring_r_1_49.name = "Ring R phalanx 1__pivot";
  node_ring_r_1_49.scale.set(1, 1, 1);
  if (endpoint_ring_r_1_49) {
    node_ring_r_1_49.position.copy(endpoint_ring_r_1_49.start);
    node_ring_r_1_49.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_r_1_49.position.set(-0.007000000000000006, -0.037632, 0.0028000000000000004);
    node_ring_r_1_49.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_r_1_49.userData.sculptComponent = {"id": "ring-r-1", "name": "Ring R phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Ring R phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "hand-r-ring-1", "localStart": [-0.007, -0.03763, 0.0028], "localEnd": [-0.01052, -0.06682, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015120000000000001, "height": 0.029400000000000003, "depth": 0.015120000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.007000000000000006, -0.037632, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.015120000000000001, 0.029400000000000003, 0.015120000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "ring-r-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_ring_r_1_49.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-r"] ?? root).add(node_ring_r_1_49);
  nodes["ring-r-1"] = node_ring_r_1_49;
  const mesh_ring_r_1_49Geometry = endpoint_ring_r_1_49
    ? new THREE.CylinderGeometry(endpoint_ring_r_1_49.endRadius, endpoint_ring_r_1_49.baseRadius, endpoint_ring_r_1_49.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_ring_r_1_49) {
    mesh_ring_r_1_49Geometry.scale(0.015120000000000001, 0.029400000000000003, 0.015120000000000001);
  }
  const mesh_ring_r_1_49 = new THREE.SkinnedMesh(
    mesh_ring_r_1_49Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_r_1_49.name = "Ring R phalanx 1";
  if (endpoint_ring_r_1_49) {
    mesh_ring_r_1_49.position.copy(endpoint_ring_r_1_49.midpoint);
    mesh_ring_r_1_49.quaternion.copy(endpoint_ring_r_1_49.quaternion);
  }
  mesh_ring_r_1_49.castShadow = options.castShadow ?? true;
  mesh_ring_r_1_49.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_r_1_49.userData.sculptComponent = {"id": "ring-r-1", "name": "Ring R phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Ring R phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "hand-r-ring-1", "localStart": [-0.007, -0.03763, 0.0028], "localEnd": [-0.01052, -0.06682, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015120000000000001, "height": 0.029400000000000003, "depth": 0.015120000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.007000000000000006, -0.037632, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.015120000000000001, 0.029400000000000003, 0.015120000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "ring-r-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_ring_r_1_49.add(mesh_ring_r_1_49);
  meshes["ring-r-1"] = mesh_ring_r_1_49;
  colliders["ring-r-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["ring-r-1"] ??= [];
  destructionGroups["ring-r-1"].push(node_ring_r_1_49);

  const attachment_ring_r_2_50 = {"parentSocket": "ring-r-1-ring-2", "localStart": [-0.00352, -0.02919, 0.0], "localEnd": [-0.00593, -0.0492, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_r_2_50 = makeAttachmentEndpoint(attachment_ring_r_2_50);
  const node_ring_r_2_50 = new THREE.Group();
  node_ring_r_2_50.name = "Ring R phalanx 2__pivot";
  node_ring_r_2_50.scale.set(1, 1, 1);
  if (endpoint_ring_r_2_50) {
    node_ring_r_2_50.position.copy(endpoint_ring_r_2_50.start);
    node_ring_r_2_50.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_r_2_50.position.set(-0.0035195388942942385, -0.029188573894103648, 0.0);
    node_ring_r_2_50.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_r_2_50.userData.sculptComponent = {"id": "ring-r-2", "name": "Ring R phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Ring R phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "ring-r-1", "attachment": {"parentSocket": "ring-r-1-ring-2", "localStart": [-0.00352, -0.02919, 0.0], "localEnd": [-0.00593, -0.0492, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015120000000000001, "height": 0.02016, "depth": 0.015120000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0035195388942942385, -0.029188573894103648, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.015120000000000001, 0.02016, 0.015120000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "ring-r-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_ring_r_2_50.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["ring-r-1"] ?? root).add(node_ring_r_2_50);
  nodes["ring-r-2"] = node_ring_r_2_50;
  const mesh_ring_r_2_50Geometry = endpoint_ring_r_2_50
    ? new THREE.CylinderGeometry(endpoint_ring_r_2_50.endRadius, endpoint_ring_r_2_50.baseRadius, endpoint_ring_r_2_50.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_ring_r_2_50) {
    mesh_ring_r_2_50Geometry.scale(0.015120000000000001, 0.02016, 0.015120000000000001);
  }
  const mesh_ring_r_2_50 = new THREE.SkinnedMesh(
    mesh_ring_r_2_50Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_r_2_50.name = "Ring R phalanx 2";
  if (endpoint_ring_r_2_50) {
    mesh_ring_r_2_50.position.copy(endpoint_ring_r_2_50.midpoint);
    mesh_ring_r_2_50.quaternion.copy(endpoint_ring_r_2_50.quaternion);
  }
  mesh_ring_r_2_50.castShadow = options.castShadow ?? true;
  mesh_ring_r_2_50.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_r_2_50.userData.sculptComponent = {"id": "ring-r-2", "name": "Ring R phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Ring R phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "ring-r-1", "attachment": {"parentSocket": "ring-r-1-ring-2", "localStart": [-0.00352, -0.02919, 0.0], "localEnd": [-0.00593, -0.0492, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015120000000000001, "height": 0.02016, "depth": 0.015120000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0035195388942942385, -0.029188573894103648, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.015120000000000001, 0.02016, 0.015120000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "ring-r-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_ring_r_2_50.add(mesh_ring_r_2_50);
  meshes["ring-r-2"] = mesh_ring_r_2_50;
  colliders["ring-r-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["ring-r-2"] ??= [];
  destructionGroups["ring-r-2"].push(node_ring_r_2_50);

  const attachment_ring_r_3_51 = {"parentSocket": "ring-r-2-ring-3", "localStart": [-0.00241, -0.02002, 0.0], "localEnd": [-0.00396, -0.0328, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_ring_r_3_51 = makeAttachmentEndpoint(attachment_ring_r_3_51);
  const node_ring_r_3_51 = new THREE.Group();
  node_ring_r_3_51.name = "Ring R phalanx 3__pivot";
  node_ring_r_3_51.scale.set(1, 1, 1);
  if (endpoint_ring_r_3_51) {
    node_ring_r_3_51.position.copy(endpoint_ring_r_3_51.start);
    node_ring_r_3_51.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ring_r_3_51.position.set(-0.0024133980989446413, -0.02001502209881395, 0.0);
    node_ring_r_3_51.rotation.set(0.0, 0.0, 0.0);
  }
  node_ring_r_3_51.userData.sculptComponent = {"id": "ring-r-3", "name": "Ring R phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Ring R phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "ring-r-2", "attachment": {"parentSocket": "ring-r-2-ring-3", "localStart": [-0.00241, -0.02002, 0.0], "localEnd": [-0.00396, -0.0328, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015120000000000001, "height": 0.01288, "depth": 0.015120000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0024133980989446413, -0.02001502209881395, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.015120000000000001, 0.01288, 0.015120000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "ring-r-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_ring_r_3_51.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["ring-r-2"] ?? root).add(node_ring_r_3_51);
  nodes["ring-r-3"] = node_ring_r_3_51;
  const mesh_ring_r_3_51Geometry = endpoint_ring_r_3_51
    ? new THREE.CylinderGeometry(endpoint_ring_r_3_51.endRadius, endpoint_ring_r_3_51.baseRadius, endpoint_ring_r_3_51.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_ring_r_3_51) {
    mesh_ring_r_3_51Geometry.scale(0.015120000000000001, 0.01288, 0.015120000000000001);
  }
  const mesh_ring_r_3_51 = new THREE.SkinnedMesh(
    mesh_ring_r_3_51Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ring_r_3_51.name = "Ring R phalanx 3";
  if (endpoint_ring_r_3_51) {
    mesh_ring_r_3_51.position.copy(endpoint_ring_r_3_51.midpoint);
    mesh_ring_r_3_51.quaternion.copy(endpoint_ring_r_3_51.quaternion);
  }
  mesh_ring_r_3_51.castShadow = options.castShadow ?? true;
  mesh_ring_r_3_51.receiveShadow = options.receiveShadow ?? true;
  mesh_ring_r_3_51.userData.sculptComponent = {"id": "ring-r-3", "name": "Ring R phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Ring R phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "ring-r-2", "attachment": {"parentSocket": "ring-r-2-ring-3", "localStart": [-0.00241, -0.02002, 0.0], "localEnd": [-0.00396, -0.0328, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00756, "endRadius": 0.0062, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.015120000000000001, "height": 0.01288, "depth": 0.015120000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0024133980989446413, -0.02001502209881395, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.015120000000000001, 0.01288, 0.015120000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ring-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "ring-r-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_ring_r_3_51.add(mesh_ring_r_3_51);
  meshes["ring-r-3"] = mesh_ring_r_3_51;
  colliders["ring-r-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["ring-r-3"] ??= [];
  destructionGroups["ring-r-3"].push(node_ring_r_3_51);

  const attachment_little_r_1_52 = {"parentSocket": "hand-r-little-1", "localStart": [-0.0196, -0.03763, 0.0028], "localEnd": [-0.02228, -0.05987, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_r_1_52 = makeAttachmentEndpoint(attachment_little_r_1_52);
  const node_little_r_1_52 = new THREE.Group();
  node_little_r_1_52.name = "Little R phalanx 1__pivot";
  node_little_r_1_52.scale.set(1, 1, 1);
  if (endpoint_little_r_1_52) {
    node_little_r_1_52.position.copy(endpoint_little_r_1_52.start);
    node_little_r_1_52.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_r_1_52.position.set(-0.019600000000000006, -0.037632, 0.0028000000000000004);
    node_little_r_1_52.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_r_1_52.userData.sculptComponent = {"id": "little-r-1", "name": "Little R phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Little R phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "hand-r-little-1", "localStart": [-0.0196, -0.03763, 0.0028], "localEnd": [-0.02228, -0.05987, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.013440000000000002, "height": 0.022400000000000003, "depth": 0.013440000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.019600000000000006, -0.037632, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.013440000000000002, 0.022400000000000003, 0.013440000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "little-r-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_little_r_1_52.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-r"] ?? root).add(node_little_r_1_52);
  nodes["little-r-1"] = node_little_r_1_52;
  const mesh_little_r_1_52Geometry = endpoint_little_r_1_52
    ? new THREE.CylinderGeometry(endpoint_little_r_1_52.endRadius, endpoint_little_r_1_52.baseRadius, endpoint_little_r_1_52.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_little_r_1_52) {
    mesh_little_r_1_52Geometry.scale(0.013440000000000002, 0.022400000000000003, 0.013440000000000002);
  }
  const mesh_little_r_1_52 = new THREE.SkinnedMesh(
    mesh_little_r_1_52Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_r_1_52.name = "Little R phalanx 1";
  if (endpoint_little_r_1_52) {
    mesh_little_r_1_52.position.copy(endpoint_little_r_1_52.midpoint);
    mesh_little_r_1_52.quaternion.copy(endpoint_little_r_1_52.quaternion);
  }
  mesh_little_r_1_52.castShadow = options.castShadow ?? true;
  mesh_little_r_1_52.receiveShadow = options.receiveShadow ?? true;
  mesh_little_r_1_52.userData.sculptComponent = {"id": "little-r-1", "name": "Little R phalanx 1", "level": "micro", "role": "finger", "importance": 0.3, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Little R phalanx 1 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "hand-r-little-1", "localStart": [-0.0196, -0.03763, 0.0028], "localEnd": [-0.02228, -0.05987, 0.0028], "contactType": "rigid-weld", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.013440000000000002, "height": 0.022400000000000003, "depth": 0.013440000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.019600000000000006, -0.037632, 0.0028000000000000004], "rotation": [0.0, 0.0, 0.0], "scale": [0.013440000000000002, 0.022400000000000003, 0.013440000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-r-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "little-r-1", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_little_r_1_52.add(mesh_little_r_1_52);
  meshes["little-r-1"] = mesh_little_r_1_52;
  colliders["little-r-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["little-r-1"] ??= [];
  destructionGroups["little-r-1"].push(node_little_r_1_52);

  const attachment_little_r_2_53 = {"parentSocket": "little-r-1-little-2", "localStart": [-0.00268, -0.02224, 0.0], "localEnd": [-0.00463, -0.03836, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_r_2_53 = makeAttachmentEndpoint(attachment_little_r_2_53);
  const node_little_r_2_53 = new THREE.Group();
  node_little_r_2_53.name = "Little R phalanx 2__pivot";
  node_little_r_2_53.scale.set(1, 1, 1);
  if (endpoint_little_r_2_53) {
    node_little_r_2_53.position.copy(endpoint_little_r_2_53.start);
    node_little_r_2_53.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_r_2_53.position.set(-0.0026815534432718113, -0.02223891344312659, 0.0);
    node_little_r_2_53.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_r_2_53.userData.sculptComponent = {"id": "little-r-2", "name": "Little R phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Little R phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "little-r-1", "attachment": {"parentSocket": "little-r-1-little-2", "localStart": [-0.00268, -0.02224, 0.0], "localEnd": [-0.00463, -0.03836, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.013440000000000002, "height": 0.01624, "depth": 0.013440000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0026815534432718113, -0.02223891344312659, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.013440000000000002, 0.01624, 0.013440000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "little-r-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_little_r_2_53.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["little-r-1"] ?? root).add(node_little_r_2_53);
  nodes["little-r-2"] = node_little_r_2_53;
  const mesh_little_r_2_53Geometry = endpoint_little_r_2_53
    ? new THREE.CylinderGeometry(endpoint_little_r_2_53.endRadius, endpoint_little_r_2_53.baseRadius, endpoint_little_r_2_53.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_little_r_2_53) {
    mesh_little_r_2_53Geometry.scale(0.013440000000000002, 0.01624, 0.013440000000000002);
  }
  const mesh_little_r_2_53 = new THREE.SkinnedMesh(
    mesh_little_r_2_53Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_r_2_53.name = "Little R phalanx 2";
  if (endpoint_little_r_2_53) {
    mesh_little_r_2_53.position.copy(endpoint_little_r_2_53.midpoint);
    mesh_little_r_2_53.quaternion.copy(endpoint_little_r_2_53.quaternion);
  }
  mesh_little_r_2_53.castShadow = options.castShadow ?? true;
  mesh_little_r_2_53.receiveShadow = options.receiveShadow ?? true;
  mesh_little_r_2_53.userData.sculptComponent = {"id": "little-r-2", "name": "Little R phalanx 2", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Little R phalanx 2 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "little-r-1", "attachment": {"parentSocket": "little-r-1-little-2", "localStart": [-0.00268, -0.02224, 0.0], "localEnd": [-0.00463, -0.03836, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.013440000000000002, "height": 0.01624, "depth": 0.013440000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0026815534432718113, -0.02223891344312659, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.013440000000000002, 0.01624, 0.013440000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-r-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "little-r-2", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_little_r_2_53.add(mesh_little_r_2_53);
  meshes["little-r-2"] = mesh_little_r_2_53;
  colliders["little-r-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["little-r-2"] ??= [];
  destructionGroups["little-r-2"].push(node_little_r_2_53);

  const attachment_little_r_3_54 = {"parentSocket": "little-r-2-little-3", "localStart": [-0.00194, -0.01612, 0.0], "localEnd": [-0.00322, -0.02669, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_little_r_3_54 = makeAttachmentEndpoint(attachment_little_r_3_54);
  const node_little_r_3_54 = new THREE.Group();
  node_little_r_3_54.name = "Little R phalanx 3__pivot";
  node_little_r_3_54.scale.set(1, 1, 1);
  if (endpoint_little_r_3_54) {
    node_little_r_3_54.position.copy(endpoint_little_r_3_54.start);
    node_little_r_3_54.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_little_r_3_54.position.set(-0.0019441262463720244, -0.016123212246266783, 0.0);
    node_little_r_3_54.rotation.set(0.0, 0.0, 0.0);
  }
  node_little_r_3_54.userData.sculptComponent = {"id": "little-r-3", "name": "Little R phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Little R phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "little-r-2", "attachment": {"parentSocket": "little-r-2-little-3", "localStart": [-0.00194, -0.01612, 0.0], "localEnd": [-0.00322, -0.02669, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.013440000000000002, "height": 0.01064, "depth": 0.013440000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0019441262463720244, -0.016123212246266783, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.013440000000000002, 0.01064, 0.013440000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "little-r-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_little_r_3_54.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["little-r-2"] ?? root).add(node_little_r_3_54);
  nodes["little-r-3"] = node_little_r_3_54;
  const mesh_little_r_3_54Geometry = endpoint_little_r_3_54
    ? new THREE.CylinderGeometry(endpoint_little_r_3_54.endRadius, endpoint_little_r_3_54.baseRadius, endpoint_little_r_3_54.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_little_r_3_54) {
    mesh_little_r_3_54Geometry.scale(0.013440000000000002, 0.01064, 0.013440000000000002);
  }
  const mesh_little_r_3_54 = new THREE.SkinnedMesh(
    mesh_little_r_3_54Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_little_r_3_54.name = "Little R phalanx 3";
  if (endpoint_little_r_3_54) {
    mesh_little_r_3_54.position.copy(endpoint_little_r_3_54.midpoint);
    mesh_little_r_3_54.quaternion.copy(endpoint_little_r_3_54.quaternion);
  }
  mesh_little_r_3_54.castShadow = options.castShadow ?? true;
  mesh_little_r_3_54.receiveShadow = options.receiveShadow ?? true;
  mesh_little_r_3_54.userData.sculptComponent = {"id": "little-r-3", "name": "Little R phalanx 3", "level": "micro", "role": "finger", "importance": 0.2, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Little R phalanx 3 is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "little-r-2", "attachment": {"parentSocket": "little-r-2-little-3", "localStart": [-0.00194, -0.01612, 0.0], "localEnd": [-0.00322, -0.02669, 0.0], "contactType": "hinge-joint", "baseRadius": 0.00672, "endRadius": 0.00551, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.013440000000000002, "height": 0.01064, "depth": 0.013440000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0019441262463720244, -0.016123212246266783, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.013440000000000002, 0.01064, 0.013440000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "little-r-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "little-r-3", "dominantAlbedo": "rgba(40, 24, 15, 1.0)", "secondaryAlbedo": "rgba(229, 164, 113, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.6, "roughnessEstimate": 0.152, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/00-skin-face.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.59}}};
  node_little_r_3_54.add(mesh_little_r_3_54);
  meshes["little-r-3"] = mesh_little_r_3_54;
  colliders["little-r-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["little-r-3"] ??= [];
  destructionGroups["little-r-3"].push(node_little_r_3_54);

  const attachment_thigh_l_55 = {"parentSocket": "pelvis-hip-l", "localStart": [0.07896, -0.06496, 0.0056], "localEnd": [0.07896, -0.44338, 0.0056], "contactType": "socket-joint", "baseRadius": 0.056, "endRadius": 0.0448, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thigh_l_55 = makeAttachmentEndpoint(attachment_thigh_l_55);
  const node_thigh_l_55 = new THREE.Group();
  node_thigh_l_55.name = "Thigh L__pivot";
  node_thigh_l_55.scale.set(1, 1, 1);
  if (endpoint_thigh_l_55) {
    node_thigh_l_55.position.copy(endpoint_thigh_l_55.start);
    node_thigh_l_55.rotation.set(0.03490658503988659, 0.0, 0.05235987755982989);
  } else {
    node_thigh_l_55.position.set(0.07895999999999999, -0.06495999999999999, 0.005600000000000001);
    node_thigh_l_55.rotation.set(0.03490658503988659, 0.0, 0.05235987755982989);
  }
  node_thigh_l_55.userData.sculptComponent = {"id": "thigh-l", "name": "Thigh L", "level": "meso", "role": "leg", "importance": 0.75, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thigh L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "pelvis", "attachment": {"parentSocket": "pelvis-hip-l", "localStart": [0.07896, -0.06496, 0.0056], "localEnd": [0.07896, -0.44338, 0.0056], "contactType": "socket-joint", "baseRadius": 0.056, "endRadius": 0.0448, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.10640000000000001, "height": 0.37842, "depth": 0.10640000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.07895999999999999, -0.06495999999999999, 0.005600000000000001], "rotation": [0.03490658503988659, 0.0, 0.05235987755982989], "scale": [0.10640000000000001, 0.37842, 0.10640000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pants-seams", "kind": "seam", "description": "Front seam and curved hip-pocket seam.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "pants"}, "materialRegions": [{"regionId": "pants-charcoal", "materialId": "pants", "profileId": "fabric.woven-matte.code-only", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/11-pants-charcoal.png", "bbox": {"x": 390, "y": 770, "width": 225, "height": 285}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0408}}], "colorMaterialRecipe": {"componentId": "thigh-l", "dominantAlbedo": "rgba(67, 50, 40, 1.0)", "secondaryAlbedo": "rgba(34, 24, 17, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.302, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/11-pants-charcoal.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.631}}};
  node_thigh_l_55.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}};
  (nodes["pelvis"] ?? root).add(node_thigh_l_55);
  nodes["thigh-l"] = node_thigh_l_55;
  const mesh_thigh_l_55Geometry = endpoint_thigh_l_55
    ? new THREE.CylinderGeometry(endpoint_thigh_l_55.endRadius, endpoint_thigh_l_55.baseRadius, endpoint_thigh_l_55.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_thigh_l_55) {
    mesh_thigh_l_55Geometry.scale(0.10640000000000001, 0.37842, 0.10640000000000001);
  }
  const mesh_thigh_l_55 = new THREE.SkinnedMesh(
    mesh_thigh_l_55Geometry,
    materialMap["pants"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_l_55.name = "Thigh L";
  if (endpoint_thigh_l_55) {
    mesh_thigh_l_55.position.copy(endpoint_thigh_l_55.midpoint);
    mesh_thigh_l_55.quaternion.copy(endpoint_thigh_l_55.quaternion);
  }
  mesh_thigh_l_55.castShadow = options.castShadow ?? true;
  mesh_thigh_l_55.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_l_55.userData.sculptComponent = {"id": "thigh-l", "name": "Thigh L", "level": "meso", "role": "leg", "importance": 0.75, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thigh L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "pelvis", "attachment": {"parentSocket": "pelvis-hip-l", "localStart": [0.07896, -0.06496, 0.0056], "localEnd": [0.07896, -0.44338, 0.0056], "contactType": "socket-joint", "baseRadius": 0.056, "endRadius": 0.0448, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.10640000000000001, "height": 0.37842, "depth": 0.10640000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.07895999999999999, -0.06495999999999999, 0.005600000000000001], "rotation": [0.03490658503988659, 0.0, 0.05235987755982989], "scale": [0.10640000000000001, 0.37842, 0.10640000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pants-seams", "kind": "seam", "description": "Front seam and curved hip-pocket seam.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "pants"}, "materialRegions": [{"regionId": "pants-charcoal", "materialId": "pants", "profileId": "fabric.woven-matte.code-only", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/11-pants-charcoal.png", "bbox": {"x": 390, "y": 770, "width": 225, "height": 285}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.0408}}], "colorMaterialRecipe": {"componentId": "thigh-l", "dominantAlbedo": "rgba(67, 50, 40, 1.0)", "secondaryAlbedo": "rgba(34, 24, 17, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.302, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/11-pants-charcoal.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.631}}};
  node_thigh_l_55.add(mesh_thigh_l_55);
  meshes["thigh-l"] = mesh_thigh_l_55;
  colliders["thigh-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["thigh-l"] ??= [];
  destructionGroups["thigh-l"].push(node_thigh_l_55);

  const attachment_shin_l_56 = {"parentSocket": "thigh-knee-l", "localStart": [0.0, -0.37842, 0.0], "localEnd": [0.0, -0.714, -0.0056], "contactType": "hinge-joint", "baseRadius": 0.0392, "endRadius": 0.028, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_shin_l_56 = makeAttachmentEndpoint(attachment_shin_l_56);
  const node_shin_l_56 = new THREE.Group();
  node_shin_l_56.name = "Shin L__pivot";
  node_shin_l_56.scale.set(1, 1, 1);
  if (endpoint_shin_l_56) {
    node_shin_l_56.position.copy(endpoint_shin_l_56.start);
    node_shin_l_56.rotation.set(0.06981317007977318, 0.0, 0.0);
  } else {
    node_shin_l_56.position.set(0.0, -0.3784199999999999, 0.0);
    node_shin_l_56.rotation.set(0.06981317007977318, 0.0, 0.0);
  }
  node_shin_l_56.userData.sculptComponent = {"id": "shin-l", "name": "Shin L", "level": "meso", "role": "leg", "importance": 0.7, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Shin L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thigh-l", "attachment": {"parentSocket": "thigh-knee-l", "localStart": [0.0, -0.37842, 0.0], "localEnd": [0.0, -0.714, -0.0056], "contactType": "hinge-joint", "baseRadius": 0.0392, "endRadius": 0.028, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.07840000000000001, "height": 0.33558, "depth": 0.07840000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.3784199999999999, 0.0], "rotation": [0.06981317007977318, 0.0, 0.0], "scale": [0.07840000000000001, 0.33558, 0.07840000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "shin-l", "dominantAlbedo": "rgba(67, 50, 40, 1.0)", "secondaryAlbedo": "rgba(34, 24, 17, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.302, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/11-pants-charcoal.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.631}}};
  node_shin_l_56.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}};
  (nodes["thigh-l"] ?? root).add(node_shin_l_56);
  nodes["shin-l"] = node_shin_l_56;
  const mesh_shin_l_56Geometry = endpoint_shin_l_56
    ? new THREE.CylinderGeometry(endpoint_shin_l_56.endRadius, endpoint_shin_l_56.baseRadius, endpoint_shin_l_56.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_shin_l_56) {
    mesh_shin_l_56Geometry.scale(0.07840000000000001, 0.33558, 0.07840000000000001);
  }
  const mesh_shin_l_56 = new THREE.SkinnedMesh(
    mesh_shin_l_56Geometry,
    materialMap["pants"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_l_56.name = "Shin L";
  if (endpoint_shin_l_56) {
    mesh_shin_l_56.position.copy(endpoint_shin_l_56.midpoint);
    mesh_shin_l_56.quaternion.copy(endpoint_shin_l_56.quaternion);
  }
  mesh_shin_l_56.castShadow = options.castShadow ?? true;
  mesh_shin_l_56.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_l_56.userData.sculptComponent = {"id": "shin-l", "name": "Shin L", "level": "meso", "role": "leg", "importance": 0.7, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Shin L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thigh-l", "attachment": {"parentSocket": "thigh-knee-l", "localStart": [0.0, -0.37842, 0.0], "localEnd": [0.0, -0.714, -0.0056], "contactType": "hinge-joint", "baseRadius": 0.0392, "endRadius": 0.028, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.07840000000000001, "height": 0.33558, "depth": 0.07840000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.3784199999999999, 0.0], "rotation": [0.06981317007977318, 0.0, 0.0], "scale": [0.07840000000000001, 0.33558, 0.07840000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "shin-l", "dominantAlbedo": "rgba(67, 50, 40, 1.0)", "secondaryAlbedo": "rgba(34, 24, 17, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.302, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/11-pants-charcoal.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.631}}};
  node_shin_l_56.add(mesh_shin_l_56);
  meshes["shin-l"] = mesh_shin_l_56;
  colliders["shin-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["shin-l"] ??= [];
  destructionGroups["shin-l"].push(node_shin_l_56);

  const endpoint_foot_l_57 = makeAttachmentEndpoint(null);
  const node_foot_l_57 = new THREE.Group();
  node_foot_l_57.name = "Foot L__pivot";
  node_foot_l_57.scale.set(1, 1, 1);
  if (endpoint_foot_l_57) {
    node_foot_l_57.position.copy(endpoint_foot_l_57.start);
    node_foot_l_57.rotation.set(0.0, 0.0, -0.03490658503988659);
  } else {
    node_foot_l_57.position.set(0.0, -0.34958, 0.039200000000000006);
    node_foot_l_57.rotation.set(0.0, 0.0, -0.03490658503988659);
  }
  node_foot_l_57.userData.sculptComponent = {"id": "foot-l", "name": "Foot L", "level": "meso", "role": "foot", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Foot L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "shin-l", "attachment": null, "dimensions": {"width": 0.06720000000000001, "height": 0.044800000000000006, "depth": 0.12320000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.34958, 0.039200000000000006], "rotation": [0.0, 0.0, -0.03490658503988659], "scale": [0.06720000000000001, 0.044800000000000006, 0.12320000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}}, "material": "shoes", "materialLayers": ["shoes"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "shoes"}, "materialRegions": [{"regionId": "shoe-leather", "materialId": "shoes", "profileId": "leather.matte", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/12-shoe-leather.png", "bbox": {"x": 265, "y": 1215, "width": 205, "height": 215}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.028}}], "colorMaterialRecipe": {"componentId": "foot-l", "dominantAlbedo": "rgba(106, 64, 33, 1.0)", "secondaryAlbedo": "rgba(68, 39, 20, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "roughnessEstimate": 0.12, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/12-shoe-leather.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.478}}};
  node_foot_l_57.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}};
  (nodes["shin-l"] ?? root).add(node_foot_l_57);
  nodes["foot-l"] = node_foot_l_57;
  const mesh_foot_l_57Geometry = endpoint_foot_l_57
    ? new THREE.CylinderGeometry(endpoint_foot_l_57.endRadius, endpoint_foot_l_57.baseRadius, endpoint_foot_l_57.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_foot_l_57) {
    mesh_foot_l_57Geometry.scale(0.06720000000000001, 0.044800000000000006, 0.12320000000000002);
  }
  const mesh_foot_l_57 = new THREE.SkinnedMesh(
    mesh_foot_l_57Geometry,
    materialMap["shoes"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_l_57.name = "Foot L";
  if (endpoint_foot_l_57) {
    mesh_foot_l_57.position.copy(endpoint_foot_l_57.midpoint);
    mesh_foot_l_57.quaternion.copy(endpoint_foot_l_57.quaternion);
  }
  mesh_foot_l_57.castShadow = options.castShadow ?? true;
  mesh_foot_l_57.receiveShadow = options.receiveShadow ?? true;
  mesh_foot_l_57.userData.sculptComponent = {"id": "foot-l", "name": "Foot L", "level": "meso", "role": "foot", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Foot L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "shin-l", "attachment": null, "dimensions": {"width": 0.06720000000000001, "height": 0.044800000000000006, "depth": 0.12320000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.34958, 0.039200000000000006], "rotation": [0.0, 0.0, -0.03490658503988659], "scale": [0.06720000000000001, 0.044800000000000006, 0.12320000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}}, "material": "shoes", "materialLayers": ["shoes"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "uvContract": {"status": "unwrapped", "strategy": "generated procedural coordinates", "materialId": "shoes"}, "materialRegions": [{"regionId": "shoe-leather", "materialId": "shoes", "profileId": "leather.matte", "crop": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/12-shoe-leather.png", "bbox": {"x": 265, "y": 1215, "width": 205, "height": 215}, "sourceWidth": 1024, "sourceHeight": 1536, "loaderWarnings": [], "coverage": 0.028}}], "colorMaterialRecipe": {"componentId": "foot-l", "dominantAlbedo": "rgba(106, 64, 33, 1.0)", "secondaryAlbedo": "rgba(68, 39, 20, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "roughnessEstimate": 0.12, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/12-shoe-leather.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.478}}};
  node_foot_l_57.add(mesh_foot_l_57);
  meshes["foot-l"] = mesh_foot_l_57;
  colliders["foot-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["foot-l"] ??= [];
  destructionGroups["foot-l"].push(node_foot_l_57);

  const attachment_thigh_r_58 = {"parentSocket": "pelvis-hip-r", "localStart": [-0.07896, -0.06496, 0.0056], "localEnd": [-0.07896, -0.44338, 0.0056], "contactType": "socket-joint", "baseRadius": 0.056, "endRadius": 0.0448, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thigh_r_58 = makeAttachmentEndpoint(attachment_thigh_r_58);
  const node_thigh_r_58 = new THREE.Group();
  node_thigh_r_58.name = "Thigh R__pivot";
  node_thigh_r_58.scale.set(1, 1, 1);
  if (endpoint_thigh_r_58) {
    node_thigh_r_58.position.copy(endpoint_thigh_r_58.start);
    node_thigh_r_58.rotation.set(-0.03490658503988659, 0.0, -0.05235987755982989);
  } else {
    node_thigh_r_58.position.set(-0.07895999999999999, -0.06495999999999999, 0.005600000000000001);
    node_thigh_r_58.rotation.set(-0.03490658503988659, 0.0, -0.05235987755982989);
  }
  node_thigh_r_58.userData.sculptComponent = {"id": "thigh-r", "name": "Thigh R", "level": "meso", "role": "leg", "importance": 0.75, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thigh R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "pelvis", "attachment": {"parentSocket": "pelvis-hip-r", "localStart": [-0.07896, -0.06496, 0.0056], "localEnd": [-0.07896, -0.44338, 0.0056], "contactType": "socket-joint", "baseRadius": 0.056, "endRadius": 0.0448, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.10640000000000001, "height": 0.37842, "depth": 0.10640000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.07895999999999999, -0.06495999999999999, 0.005600000000000001], "rotation": [-0.03490658503988659, 0.0, -0.05235987755982989], "scale": [0.10640000000000001, 0.37842, 0.10640000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "thigh-r", "dominantAlbedo": "rgba(67, 50, 40, 1.0)", "secondaryAlbedo": "rgba(34, 24, 17, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.302, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/11-pants-charcoal.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.631}}};
  node_thigh_r_58.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}};
  (nodes["pelvis"] ?? root).add(node_thigh_r_58);
  nodes["thigh-r"] = node_thigh_r_58;
  const mesh_thigh_r_58Geometry = endpoint_thigh_r_58
    ? new THREE.CylinderGeometry(endpoint_thigh_r_58.endRadius, endpoint_thigh_r_58.baseRadius, endpoint_thigh_r_58.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_thigh_r_58) {
    mesh_thigh_r_58Geometry.scale(0.10640000000000001, 0.37842, 0.10640000000000001);
  }
  const mesh_thigh_r_58 = new THREE.SkinnedMesh(
    mesh_thigh_r_58Geometry,
    materialMap["pants"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_r_58.name = "Thigh R";
  if (endpoint_thigh_r_58) {
    mesh_thigh_r_58.position.copy(endpoint_thigh_r_58.midpoint);
    mesh_thigh_r_58.quaternion.copy(endpoint_thigh_r_58.quaternion);
  }
  mesh_thigh_r_58.castShadow = options.castShadow ?? true;
  mesh_thigh_r_58.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_r_58.userData.sculptComponent = {"id": "thigh-r", "name": "Thigh R", "level": "meso", "role": "leg", "importance": 0.75, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thigh R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "pelvis", "attachment": {"parentSocket": "pelvis-hip-r", "localStart": [-0.07896, -0.06496, 0.0056], "localEnd": [-0.07896, -0.44338, 0.0056], "contactType": "socket-joint", "baseRadius": 0.056, "endRadius": 0.0448, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.10640000000000001, "height": 0.37842, "depth": 0.10640000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.07895999999999999, -0.06495999999999999, 0.005600000000000001], "rotation": [-0.03490658503988659, 0.0, -0.05235987755982989], "scale": [0.10640000000000001, 0.37842, 0.10640000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "thigh-r", "dominantAlbedo": "rgba(67, 50, 40, 1.0)", "secondaryAlbedo": "rgba(34, 24, 17, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.302, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/11-pants-charcoal.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.631}}};
  node_thigh_r_58.add(mesh_thigh_r_58);
  meshes["thigh-r"] = mesh_thigh_r_58;
  colliders["thigh-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["thigh-r"] ??= [];
  destructionGroups["thigh-r"].push(node_thigh_r_58);

  const attachment_shin_r_59 = {"parentSocket": "thigh-knee-r", "localStart": [0.0, -0.37842, 0.0], "localEnd": [0.0, -0.714, -0.0056], "contactType": "hinge-joint", "baseRadius": 0.0392, "endRadius": 0.028, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_shin_r_59 = makeAttachmentEndpoint(attachment_shin_r_59);
  const node_shin_r_59 = new THREE.Group();
  node_shin_r_59.name = "Shin R__pivot";
  node_shin_r_59.scale.set(1, 1, 1);
  if (endpoint_shin_r_59) {
    node_shin_r_59.position.copy(endpoint_shin_r_59.start);
    node_shin_r_59.rotation.set(0.05235987755982989, 0.0, 0.0);
  } else {
    node_shin_r_59.position.set(0.0, -0.3784199999999999, 0.0);
    node_shin_r_59.rotation.set(0.05235987755982989, 0.0, 0.0);
  }
  node_shin_r_59.userData.sculptComponent = {"id": "shin-r", "name": "Shin R", "level": "meso", "role": "leg", "importance": 0.7, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Shin R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thigh-r", "attachment": {"parentSocket": "thigh-knee-r", "localStart": [0.0, -0.37842, 0.0], "localEnd": [0.0, -0.714, -0.0056], "contactType": "hinge-joint", "baseRadius": 0.0392, "endRadius": 0.028, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.07840000000000001, "height": 0.33558, "depth": 0.07840000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.3784199999999999, 0.0], "rotation": [0.05235987755982989, 0.0, 0.0], "scale": [0.07840000000000001, 0.33558, 0.07840000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "shin-r", "dominantAlbedo": "rgba(67, 50, 40, 1.0)", "secondaryAlbedo": "rgba(34, 24, 17, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.302, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/11-pants-charcoal.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.631}}};
  node_shin_r_59.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}};
  (nodes["thigh-r"] ?? root).add(node_shin_r_59);
  nodes["shin-r"] = node_shin_r_59;
  const mesh_shin_r_59Geometry = endpoint_shin_r_59
    ? new THREE.CylinderGeometry(endpoint_shin_r_59.endRadius, endpoint_shin_r_59.baseRadius, endpoint_shin_r_59.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_shin_r_59) {
    mesh_shin_r_59Geometry.scale(0.07840000000000001, 0.33558, 0.07840000000000001);
  }
  const mesh_shin_r_59 = new THREE.SkinnedMesh(
    mesh_shin_r_59Geometry,
    materialMap["pants"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_r_59.name = "Shin R";
  if (endpoint_shin_r_59) {
    mesh_shin_r_59.position.copy(endpoint_shin_r_59.midpoint);
    mesh_shin_r_59.quaternion.copy(endpoint_shin_r_59.quaternion);
  }
  mesh_shin_r_59.castShadow = options.castShadow ?? true;
  mesh_shin_r_59.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_r_59.userData.sculptComponent = {"id": "shin-r", "name": "Shin R", "level": "meso", "role": "leg", "importance": 0.7, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Shin R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thigh-r", "attachment": {"parentSocket": "thigh-knee-r", "localStart": [0.0, -0.37842, 0.0], "localEnd": [0.0, -0.714, -0.0056], "contactType": "hinge-joint", "baseRadius": 0.0392, "endRadius": 0.028, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.07840000000000001, "height": 0.33558, "depth": 0.07840000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.3784199999999999, 0.0], "rotation": [0.05235987755982989, 0.0, 0.0], "scale": [0.07840000000000001, 0.33558, 0.07840000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "shin-r", "dominantAlbedo": "rgba(67, 50, 40, 1.0)", "secondaryAlbedo": "rgba(34, 24, 17, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.6, "roughnessEstimate": 0.302, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/11-pants-charcoal.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.631}}};
  node_shin_r_59.add(mesh_shin_r_59);
  meshes["shin-r"] = mesh_shin_r_59;
  colliders["shin-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["shin-r"] ??= [];
  destructionGroups["shin-r"].push(node_shin_r_59);

  const endpoint_foot_r_60 = makeAttachmentEndpoint(null);
  const node_foot_r_60 = new THREE.Group();
  node_foot_r_60.name = "Foot R__pivot";
  node_foot_r_60.scale.set(1, 1, 1);
  if (endpoint_foot_r_60) {
    node_foot_r_60.position.copy(endpoint_foot_r_60.start);
    node_foot_r_60.rotation.set(0.0, 0.0, 0.03490658503988659);
  } else {
    node_foot_r_60.position.set(0.0, -0.34958, 0.039200000000000006);
    node_foot_r_60.rotation.set(0.0, 0.0, 0.03490658503988659);
  }
  node_foot_r_60.userData.sculptComponent = {"id": "foot-r", "name": "Foot R", "level": "meso", "role": "foot", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Foot R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "shin-r", "attachment": null, "dimensions": {"width": 0.06720000000000001, "height": 0.044800000000000006, "depth": 0.12320000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.34958, 0.039200000000000006], "rotation": [0.0, 0.0, 0.03490658503988659], "scale": [0.06720000000000001, 0.044800000000000006, 0.12320000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}}, "material": "shoes", "materialLayers": ["shoes"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "foot-r", "dominantAlbedo": "rgba(106, 64, 33, 1.0)", "secondaryAlbedo": "rgba(68, 39, 20, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "roughnessEstimate": 0.12, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/12-shoe-leather.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.478}}};
  node_foot_r_60.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}};
  (nodes["shin-r"] ?? root).add(node_foot_r_60);
  nodes["foot-r"] = node_foot_r_60;
  const mesh_foot_r_60Geometry = endpoint_foot_r_60
    ? new THREE.CylinderGeometry(endpoint_foot_r_60.endRadius, endpoint_foot_r_60.baseRadius, endpoint_foot_r_60.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_foot_r_60) {
    mesh_foot_r_60Geometry.scale(0.06720000000000001, 0.044800000000000006, 0.12320000000000002);
  }
  const mesh_foot_r_60 = new THREE.SkinnedMesh(
    mesh_foot_r_60Geometry,
    materialMap["shoes"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_r_60.name = "Foot R";
  if (endpoint_foot_r_60) {
    mesh_foot_r_60.position.copy(endpoint_foot_r_60.midpoint);
    mesh_foot_r_60.quaternion.copy(endpoint_foot_r_60.quaternion);
  }
  mesh_foot_r_60.castShadow = options.castShadow ?? true;
  mesh_foot_r_60.receiveShadow = options.receiveShadow ?? true;
  mesh_foot_r_60.userData.sculptComponent = {"id": "foot-r", "name": "Foot R", "level": "meso", "role": "foot", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Foot R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "shin-r", "attachment": null, "dimensions": {"width": 0.06720000000000001, "height": 0.044800000000000006, "depth": 0.12320000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.34958, 0.039200000000000006], "rotation": [0.0, 0.0, 0.03490658503988659], "scale": [0.06720000000000001, 0.044800000000000006, 0.12320000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}}, "material": "shoes", "materialLayers": ["shoes"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"componentId": "foot-r", "dominantAlbedo": "rgba(106, 64, 33, 1.0)", "secondaryAlbedo": "rgba(68, 39, 20, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "roughnessEstimate": 0.12, "metalnessEstimate": 0.0, "highlightEvidence": "sharp, tight specular hotspot — supports low roughness/high specularity", "sourceCropPath": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/materials/evidence/12-shoe-leather.png", "labClusterMeta": {"clusterCount": 3, "dominantClusterSharePct": 0.478}}};
  node_foot_r_60.add(mesh_foot_r_60);
  meshes["foot-r"] = mesh_foot_r_60;
  colliders["foot-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["foot-r"] ??= [];
  destructionGroups["foot-r"].push(node_foot_r_60);

  const attachment_shirt_shell_61 = {"parentSocket": "chest-surface", "localStart": [0, 0, 0.006], "localEnd": [0, 0.04, 0.006], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_shirt_shell_61 = makeAttachmentEndpoint(attachment_shirt_shell_61);
  const node_shirt_shell_61 = new THREE.Group();
  node_shirt_shell_61.name = "Cream shirt shell__pivot";
  node_shirt_shell_61.scale.set(1, 1, 1);
  if (endpoint_shirt_shell_61) {
    node_shirt_shell_61.position.copy(endpoint_shirt_shell_61.start);
    node_shirt_shell_61.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shirt_shell_61.position.set(0.0, 0.0, 0.006);
    node_shirt_shell_61.rotation.set(0.0, 0.0, 0.0);
  }
  node_shirt_shell_61.userData.sculptComponent = {"id": "shirt-shell", "name": "Cream shirt shell", "level": "meso", "role": "shell", "importance": 0.88, "confidence": 0.82, "primitive": "capsule", "topologyClass": "conforming-shell", "topologyRationale": "Cream shirt shell is a distinct conforming shell observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "layered-shell", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "chest", "attachment": {"parentSocket": "chest-surface", "localStart": [0, 0, 0.006], "localEnd": [0, 0.04, 0.006], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.34, "height": 0.36, "depth": 0.22, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0, 0.006], "rotation": [0.0, 0.0, 0.0], "scale": [0.34, 0.36, 0.22]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shirt-shell", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "shirt", "materialLayers": ["shirt"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(224, 211, 181, 1.0)", "secondaryAlbedo": "rgba(191, 174, 143, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.88, "evidenceRef": "reference/cartoon-courier.png"}};
  node_shirt_shell_61.userData.actionProfile = {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shirt-shell", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}};
  (nodes["chest"] ?? root).add(node_shirt_shell_61);
  nodes["shirt-shell"] = node_shirt_shell_61;
  const mesh_shirt_shell_61Geometry = endpoint_shirt_shell_61
    ? new THREE.CylinderGeometry(endpoint_shirt_shell_61.endRadius, endpoint_shirt_shell_61.baseRadius, endpoint_shirt_shell_61.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_shirt_shell_61) {
    mesh_shirt_shell_61Geometry.scale(0.34, 0.36, 0.22);
  }
  const mesh_shirt_shell_61 = new THREE.Mesh(
    mesh_shirt_shell_61Geometry,
    materialMap["shirt"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shirt_shell_61.name = "Cream shirt shell";
  if (endpoint_shirt_shell_61) {
    mesh_shirt_shell_61.position.copy(endpoint_shirt_shell_61.midpoint);
    mesh_shirt_shell_61.quaternion.copy(endpoint_shirt_shell_61.quaternion);
  }
  mesh_shirt_shell_61.castShadow = options.castShadow ?? true;
  mesh_shirt_shell_61.receiveShadow = options.receiveShadow ?? true;
  mesh_shirt_shell_61.userData.sculptComponent = {"id": "shirt-shell", "name": "Cream shirt shell", "level": "meso", "role": "shell", "importance": 0.88, "confidence": 0.82, "primitive": "capsule", "topologyClass": "conforming-shell", "topologyRationale": "Cream shirt shell is a distinct conforming shell observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "layered-shell", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "chest", "attachment": {"parentSocket": "chest-surface", "localStart": [0, 0, 0.006], "localEnd": [0, 0.04, 0.006], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.34, "height": 0.36, "depth": 0.22, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0, 0.006], "rotation": [0.0, 0.0, 0.0], "scale": [0.34, 0.36, 0.22]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shirt-shell", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "shirt", "materialLayers": ["shirt"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(224, 211, 181, 1.0)", "secondaryAlbedo": "rgba(191, 174, 143, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.88, "evidenceRef": "reference/cartoon-courier.png"}};
  node_shirt_shell_61.add(mesh_shirt_shell_61);
  meshes["shirt-shell"] = mesh_shirt_shell_61;
  colliders["shirt-shell"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["shirt-shell"] ??= [];
  destructionGroups["shirt-shell"].push(node_shirt_shell_61);

  const attachment_jacket_shell_62 = {"parentSocket": "chest-surface", "localStart": [0, 0.01, 0.018], "localEnd": [0, 0.05, 0.018], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_jacket_shell_62 = makeAttachmentEndpoint(attachment_jacket_shell_62);
  const node_jacket_shell_62 = new THREE.Group();
  node_jacket_shell_62.name = "Cropped teal jacket shell__pivot";
  node_jacket_shell_62.scale.set(1, 1, 1);
  if (endpoint_jacket_shell_62) {
    node_jacket_shell_62.position.copy(endpoint_jacket_shell_62.start);
    node_jacket_shell_62.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_jacket_shell_62.position.set(0.0, 0.01, 0.018);
    node_jacket_shell_62.rotation.set(0.0, 0.0, 0.0);
  }
  node_jacket_shell_62.userData.sculptComponent = {"id": "jacket-shell", "name": "Cropped teal jacket shell", "level": "macro", "role": "shell", "importance": 0.88, "confidence": 0.82, "primitive": "capsule", "topologyClass": "conforming-shell", "topologyRationale": "Cropped teal jacket shell is a distinct conforming shell observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "layered-shell", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "chest", "attachment": {"parentSocket": "chest-surface", "localStart": [0, 0.01, 0.018], "localEnd": [0, 0.05, 0.018], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.39, "height": 0.34, "depth": 0.25, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0.01, 0.018], "rotation": [0.0, 0.0, 0.0], "scale": [0.39, 0.34, 0.25]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "jacket-shell", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "jacket"}}, "material": "jacket", "materialLayers": ["jacket"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "jacket-piping", "kind": "ridge", "description": "Raised ochre piping along collar, opening and cropped hem.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(55, 88, 83, 1.0)", "secondaryAlbedo": "rgba(83, 117, 108, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.91, "evidenceRef": "reference/cartoon-courier.png"}};
  node_jacket_shell_62.userData.actionProfile = {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "jacket-shell", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "jacket"}};
  (nodes["chest"] ?? root).add(node_jacket_shell_62);
  nodes["jacket-shell"] = node_jacket_shell_62;
  const mesh_jacket_shell_62Geometry = endpoint_jacket_shell_62
    ? new THREE.CylinderGeometry(endpoint_jacket_shell_62.endRadius, endpoint_jacket_shell_62.baseRadius, endpoint_jacket_shell_62.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_jacket_shell_62) {
    mesh_jacket_shell_62Geometry.scale(0.39, 0.34, 0.25);
  }
  const mesh_jacket_shell_62 = new THREE.Mesh(
    mesh_jacket_shell_62Geometry,
    materialMap["jacket"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_jacket_shell_62.name = "Cropped teal jacket shell";
  if (endpoint_jacket_shell_62) {
    mesh_jacket_shell_62.position.copy(endpoint_jacket_shell_62.midpoint);
    mesh_jacket_shell_62.quaternion.copy(endpoint_jacket_shell_62.quaternion);
  }
  mesh_jacket_shell_62.castShadow = options.castShadow ?? true;
  mesh_jacket_shell_62.receiveShadow = options.receiveShadow ?? true;
  mesh_jacket_shell_62.userData.sculptComponent = {"id": "jacket-shell", "name": "Cropped teal jacket shell", "level": "macro", "role": "shell", "importance": 0.88, "confidence": 0.82, "primitive": "capsule", "topologyClass": "conforming-shell", "topologyRationale": "Cropped teal jacket shell is a distinct conforming shell observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "layered-shell", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "chest", "attachment": {"parentSocket": "chest-surface", "localStart": [0, 0.01, 0.018], "localEnd": [0, 0.05, 0.018], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.39, "height": 0.34, "depth": 0.25, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0.01, 0.018], "rotation": [0.0, 0.0, 0.0], "scale": [0.39, 0.34, 0.25]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "jacket-shell", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "jacket"}}, "material": "jacket", "materialLayers": ["jacket"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "jacket-piping", "kind": "ridge", "description": "Raised ochre piping along collar, opening and cropped hem.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(55, 88, 83, 1.0)", "secondaryAlbedo": "rgba(83, 117, 108, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.91, "evidenceRef": "reference/cartoon-courier.png"}};
  node_jacket_shell_62.add(mesh_jacket_shell_62);
  meshes["jacket-shell"] = mesh_jacket_shell_62;
  colliders["jacket-shell"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["jacket-shell"] ??= [];
  destructionGroups["jacket-shell"].push(node_jacket_shell_62);

  const endpoint_scarf_wrap_63 = makeAttachmentEndpoint(null);
  const node_scarf_wrap_63 = new THREE.Group();
  node_scarf_wrap_63.name = "Burnt orange scarf wrap__pivot";
  node_scarf_wrap_63.scale.set(1, 1, 1);
  if (endpoint_scarf_wrap_63) {
    node_scarf_wrap_63.position.copy(endpoint_scarf_wrap_63.start);
    node_scarf_wrap_63.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_scarf_wrap_63.position.set(0.0, 0.01, 0.02);
    node_scarf_wrap_63.rotation.set(0.0, 0.0, 0.0);
  }
  node_scarf_wrap_63.userData.sculptComponent = {"id": "scarf-wrap", "name": "Burnt orange scarf wrap", "level": "meso", "role": "cloth", "importance": 0.88, "confidence": 0.82, "primitive": "torus", "topologyClass": "conforming-shell", "topologyRationale": "Burnt orange scarf wrap is a distinct conforming shell observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "layered-shell", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "neck", "attachment": {"parentSocket": "neck-surface", "localStart": [0, 0.01, 0.02], "localEnd": [0, 0.05, 0.02], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.12, "depth": 0.22, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0.01, 0.02], "rotation": [0.0, 0.0, 0.0], "scale": [0.25, 0.12, 0.22]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "scarf-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scarf"}}, "material": "scarf", "materialLayers": ["scarf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "scarf-folds", "kind": "ridge", "description": "Two broad neck folds and a short lateral tail.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(159, 66, 29, 1.0)", "secondaryAlbedo": "rgba(197, 91, 42, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9, "evidenceRef": "reference/cartoon-courier.png"}};
  node_scarf_wrap_63.userData.actionProfile = {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "scarf-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scarf"}};
  (nodes["neck"] ?? root).add(node_scarf_wrap_63);
  nodes["scarf-wrap"] = node_scarf_wrap_63;
  const mesh_scarf_wrap_63Geometry = endpoint_scarf_wrap_63
    ? new THREE.CylinderGeometry(endpoint_scarf_wrap_63.endRadius, endpoint_scarf_wrap_63.baseRadius, endpoint_scarf_wrap_63.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.08, 24, 96);
  if (!endpoint_scarf_wrap_63) {
    mesh_scarf_wrap_63Geometry.scale(0.25, 0.12, 0.22);
  }
  const mesh_scarf_wrap_63 = new THREE.Mesh(
    mesh_scarf_wrap_63Geometry,
    materialMap["scarf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_scarf_wrap_63.name = "Burnt orange scarf wrap";
  if (endpoint_scarf_wrap_63) {
    mesh_scarf_wrap_63.position.copy(endpoint_scarf_wrap_63.midpoint);
    mesh_scarf_wrap_63.quaternion.copy(endpoint_scarf_wrap_63.quaternion);
  }
  mesh_scarf_wrap_63.castShadow = options.castShadow ?? true;
  mesh_scarf_wrap_63.receiveShadow = options.receiveShadow ?? true;
  mesh_scarf_wrap_63.userData.sculptComponent = {"id": "scarf-wrap", "name": "Burnt orange scarf wrap", "level": "meso", "role": "cloth", "importance": 0.88, "confidence": 0.82, "primitive": "torus", "topologyClass": "conforming-shell", "topologyRationale": "Burnt orange scarf wrap is a distinct conforming shell observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "layered-shell", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "neck", "attachment": {"parentSocket": "neck-surface", "localStart": [0, 0.01, 0.02], "localEnd": [0, 0.05, 0.02], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.12, "depth": 0.22, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0.01, 0.02], "rotation": [0.0, 0.0, 0.0], "scale": [0.25, 0.12, 0.22]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "scarf-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scarf"}}, "material": "scarf", "materialLayers": ["scarf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "scarf-folds", "kind": "ridge", "description": "Two broad neck folds and a short lateral tail.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(159, 66, 29, 1.0)", "secondaryAlbedo": "rgba(197, 91, 42, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.9, "evidenceRef": "reference/cartoon-courier.png"}};
  node_scarf_wrap_63.add(mesh_scarf_wrap_63);
  meshes["scarf-wrap"] = mesh_scarf_wrap_63;
  colliders["scarf-wrap"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["scarf-wrap"] ??= [];
  destructionGroups["scarf-wrap"].push(node_scarf_wrap_63);

  const endpoint_belt_64 = makeAttachmentEndpoint(null);
  const node_belt_64 = new THREE.Group();
  node_belt_64.name = "Dark leather belt__pivot";
  node_belt_64.scale.set(1, 1, 1);
  if (endpoint_belt_64) {
    node_belt_64.position.copy(endpoint_belt_64.start);
    node_belt_64.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_belt_64.position.set(0.0, 0.08, 0.035);
    node_belt_64.rotation.set(0.0, 0.0, 0.0);
  }
  node_belt_64.userData.sculptComponent = {"id": "belt", "name": "Dark leather belt", "level": "meso", "role": "support", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Dark leather belt is a distinct assembled volume observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "assembled-solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "pelvis", "attachment": {"parentSocket": "pelvis-surface", "localStart": [0, 0.08, 0.035], "localEnd": [0, 0.12, 0.035], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.31, "height": 0.075, "depth": 0.22, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0.08, 0.035], "rotation": [0.0, 0.0, 0.0], "scale": [0.31, 0.075, 0.22]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "belt", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}}, "material": "leather-dark", "materialLayers": ["leather-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 43, 27, 1.0)", "secondaryAlbedo": "rgba(112, 70, 40, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.78, "evidenceRef": "reference/cartoon-courier.png"}};
  node_belt_64.userData.actionProfile = {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "belt", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}};
  (nodes["pelvis"] ?? root).add(node_belt_64);
  nodes["belt"] = node_belt_64;
  const mesh_belt_64Geometry = endpoint_belt_64
    ? new THREE.CylinderGeometry(endpoint_belt_64.endRadius, endpoint_belt_64.baseRadius, endpoint_belt_64.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_belt_64) {
    mesh_belt_64Geometry.scale(0.31, 0.075, 0.22);
  }
  const mesh_belt_64 = new THREE.Mesh(
    mesh_belt_64Geometry,
    materialMap["leather-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_belt_64.name = "Dark leather belt";
  if (endpoint_belt_64) {
    mesh_belt_64.position.copy(endpoint_belt_64.midpoint);
    mesh_belt_64.quaternion.copy(endpoint_belt_64.quaternion);
  }
  mesh_belt_64.castShadow = options.castShadow ?? true;
  mesh_belt_64.receiveShadow = options.receiveShadow ?? true;
  mesh_belt_64.userData.sculptComponent = {"id": "belt", "name": "Dark leather belt", "level": "meso", "role": "support", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Dark leather belt is a distinct assembled volume observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "assembled-solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "pelvis", "attachment": {"parentSocket": "pelvis-surface", "localStart": [0, 0.08, 0.035], "localEnd": [0, 0.12, 0.035], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.31, "height": 0.075, "depth": 0.22, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0.08, 0.035], "rotation": [0.0, 0.0, 0.0], "scale": [0.31, 0.075, 0.22]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "belt", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}}, "material": "leather-dark", "materialLayers": ["leather-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 43, 27, 1.0)", "secondaryAlbedo": "rgba(112, 70, 40, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.78, "evidenceRef": "reference/cartoon-courier.png"}};
  node_belt_64.add(mesh_belt_64);
  meshes["belt"] = mesh_belt_64;
  colliders["belt"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["belt"] ??= [];
  destructionGroups["belt"].push(node_belt_64);

  const endpoint_belt_buckle_65 = makeAttachmentEndpoint(null);
  const node_belt_buckle_65 = new THREE.Group();
  node_belt_buckle_65.name = "Brass belt buckle__pivot";
  node_belt_buckle_65.scale.set(1, 1, 1);
  if (endpoint_belt_buckle_65) {
    node_belt_buckle_65.position.copy(endpoint_belt_buckle_65.start);
    node_belt_buckle_65.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_belt_buckle_65.position.set(0.0, 0.0, 0.13);
    node_belt_buckle_65.rotation.set(0.0, 0.0, 0.0);
  }
  node_belt_buckle_65.userData.sculptComponent = {"id": "belt-buckle", "name": "Brass belt buckle", "level": "micro", "role": "detail", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Brass belt buckle is a distinct assembled volume observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "assembled-solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "belt", "attachment": {"parentSocket": "belt-surface", "localStart": [0, 0, 0.13], "localEnd": [0, 0.04, 0.13], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1, "height": 0.075, "depth": 0.025, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0, 0.13], "rotation": [0.0, 0.0, 0.0], "scale": [0.1, 0.075, 0.025]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "belt-buckle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "brass"}}, "material": "brass", "materialLayers": ["brass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "belt-buckle", "kind": "bevel", "description": "Beveled brass frame with central prong.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(174, 119, 43, 1.0)", "secondaryAlbedo": "rgba(222, 169, 77, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.92, "evidenceRef": "reference/cartoon-courier.png"}};
  node_belt_buckle_65.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "belt-buckle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "brass"}};
  (nodes["belt"] ?? root).add(node_belt_buckle_65);
  nodes["belt-buckle"] = node_belt_buckle_65;
  const mesh_belt_buckle_65Geometry = endpoint_belt_buckle_65
    ? new THREE.CylinderGeometry(endpoint_belt_buckle_65.endRadius, endpoint_belt_buckle_65.baseRadius, endpoint_belt_buckle_65.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_belt_buckle_65) {
    mesh_belt_buckle_65Geometry.scale(0.1, 0.075, 0.025);
  }
  const mesh_belt_buckle_65 = new THREE.Mesh(
    mesh_belt_buckle_65Geometry,
    materialMap["brass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_belt_buckle_65.name = "Brass belt buckle";
  if (endpoint_belt_buckle_65) {
    mesh_belt_buckle_65.position.copy(endpoint_belt_buckle_65.midpoint);
    mesh_belt_buckle_65.quaternion.copy(endpoint_belt_buckle_65.quaternion);
  }
  mesh_belt_buckle_65.castShadow = options.castShadow ?? true;
  mesh_belt_buckle_65.receiveShadow = options.receiveShadow ?? true;
  mesh_belt_buckle_65.userData.sculptComponent = {"id": "belt-buckle", "name": "Brass belt buckle", "level": "micro", "role": "detail", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Brass belt buckle is a distinct assembled volume observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "assembled-solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "belt", "attachment": {"parentSocket": "belt-surface", "localStart": [0, 0, 0.13], "localEnd": [0, 0.04, 0.13], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1, "height": 0.075, "depth": 0.025, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0, 0.13], "rotation": [0.0, 0.0, 0.0], "scale": [0.1, 0.075, 0.025]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "belt-buckle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "brass"}}, "material": "brass", "materialLayers": ["brass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "belt-buckle", "kind": "bevel", "description": "Beveled brass frame with central prong.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(174, 119, 43, 1.0)", "secondaryAlbedo": "rgba(222, 169, 77, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.92, "evidenceRef": "reference/cartoon-courier.png"}};
  node_belt_buckle_65.add(mesh_belt_buckle_65);
  meshes["belt-buckle"] = mesh_belt_buckle_65;
  colliders["belt-buckle"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["belt-buckle"] ??= [];
  destructionGroups["belt-buckle"].push(node_belt_buckle_65);

  const endpoint_shirt_toggles_66 = makeAttachmentEndpoint(null);
  const node_shirt_toggles_66 = new THREE.Group();
  node_shirt_toggles_66.name = "Three shirt toggles__pivot";
  node_shirt_toggles_66.scale.set(1, 1, 1);
  if (endpoint_shirt_toggles_66) {
    node_shirt_toggles_66.position.copy(endpoint_shirt_toggles_66.start);
    node_shirt_toggles_66.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shirt_toggles_66.position.set(0.0, 0.05, 0.12);
    node_shirt_toggles_66.rotation.set(0.0, 0.0, 0.0);
  }
  node_shirt_toggles_66.userData.sculptComponent = {"id": "shirt-toggles", "name": "Three shirt toggles", "level": "micro", "role": "detail", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Three shirt toggles is a distinct assembled volume observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "assembled-solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "shirt-shell", "attachment": {"parentSocket": "shirt-shell-surface", "localStart": [0, 0.05, 0.12], "localEnd": [0, 0.09, 0.12], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.035, "height": 0.08, "depth": 0.02, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0.05, 0.12], "rotation": [0.0, 0.0, 0.0], "scale": [0.035, 0.08, 0.02]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shirt-toggles", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}}, "material": "leather-dark", "materialLayers": ["leather-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "shirt-toggles", "kind": "fastener", "description": "Three vertically repeated brown toggles.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 43, 27, 1.0)", "secondaryAlbedo": "rgba(112, 70, 40, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.78, "evidenceRef": "reference/cartoon-courier.png"}};
  node_shirt_toggles_66.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shirt-toggles", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}};
  (nodes["shirt-shell"] ?? root).add(node_shirt_toggles_66);
  nodes["shirt-toggles"] = node_shirt_toggles_66;
  const mesh_shirt_toggles_66Geometry = endpoint_shirt_toggles_66
    ? new THREE.CylinderGeometry(endpoint_shirt_toggles_66.endRadius, endpoint_shirt_toggles_66.baseRadius, endpoint_shirt_toggles_66.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_shirt_toggles_66) {
    mesh_shirt_toggles_66Geometry.scale(0.035, 0.08, 0.02);
  }
  const mesh_shirt_toggles_66 = new THREE.Mesh(
    mesh_shirt_toggles_66Geometry,
    materialMap["leather-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shirt_toggles_66.name = "Three shirt toggles";
  if (endpoint_shirt_toggles_66) {
    mesh_shirt_toggles_66.position.copy(endpoint_shirt_toggles_66.midpoint);
    mesh_shirt_toggles_66.quaternion.copy(endpoint_shirt_toggles_66.quaternion);
  }
  mesh_shirt_toggles_66.castShadow = options.castShadow ?? true;
  mesh_shirt_toggles_66.receiveShadow = options.receiveShadow ?? true;
  mesh_shirt_toggles_66.userData.sculptComponent = {"id": "shirt-toggles", "name": "Three shirt toggles", "level": "micro", "role": "detail", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Three shirt toggles is a distinct assembled volume observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "assembled-solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "shirt-shell", "attachment": {"parentSocket": "shirt-shell-surface", "localStart": [0, 0.05, 0.12], "localEnd": [0, 0.09, 0.12], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.035, "height": 0.08, "depth": 0.02, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0.05, 0.12], "rotation": [0.0, 0.0, 0.0], "scale": [0.035, 0.08, 0.02]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shirt-toggles", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}}, "material": "leather-dark", "materialLayers": ["leather-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "shirt-toggles", "kind": "fastener", "description": "Three vertically repeated brown toggles.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 43, 27, 1.0)", "secondaryAlbedo": "rgba(112, 70, 40, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.78, "evidenceRef": "reference/cartoon-courier.png"}};
  node_shirt_toggles_66.add(mesh_shirt_toggles_66);
  meshes["shirt-toggles"] = mesh_shirt_toggles_66;
  colliders["shirt-toggles"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["shirt-toggles"] ??= [];
  destructionGroups["shirt-toggles"].push(node_shirt_toggles_66);

  const endpoint_crossbody_strap_67 = makeAttachmentEndpoint(null);
  const node_crossbody_strap_67 = new THREE.Group();
  node_crossbody_strap_67.name = "Cross-body leather strap__pivot";
  node_crossbody_strap_67.scale.set(1, 1, 1);
  if (endpoint_crossbody_strap_67) {
    node_crossbody_strap_67.position.copy(endpoint_crossbody_strap_67.start);
    node_crossbody_strap_67.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_crossbody_strap_67.position.set(-0.02, 0.0, 0.14);
    node_crossbody_strap_67.rotation.set(0.0, 0.0, 0.0);
  }
  node_crossbody_strap_67.userData.sculptComponent = {"id": "crossbody-strap", "name": "Cross-body leather strap", "level": "meso", "role": "cloth", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "conforming-shell", "topologyRationale": "Cross-body leather strap is a distinct conforming shell observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "layered-shell", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "chest", "attachment": {"parentSocket": "chest-surface", "localStart": [-0.02, 0, 0.14], "localEnd": [-0.02, 0.04, 0.14], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.055, "height": 0.55, "depth": 0.018, "units": "relative", "confidence": 0.82}, "transform": {"position": [-0.02, 0, 0.14], "rotation": [0.0, 0.0, 0.0], "scale": [0.055, 0.55, 0.018]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "crossbody-strap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}}, "material": "leather-dark", "materialLayers": ["leather-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 43, 27, 1.0)", "secondaryAlbedo": "rgba(112, 70, 40, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.78, "evidenceRef": "reference/cartoon-courier.png"}};
  node_crossbody_strap_67.userData.actionProfile = {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "crossbody-strap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}};
  (nodes["chest"] ?? root).add(node_crossbody_strap_67);
  nodes["crossbody-strap"] = node_crossbody_strap_67;
  const mesh_crossbody_strap_67Geometry = endpoint_crossbody_strap_67
    ? new THREE.CylinderGeometry(endpoint_crossbody_strap_67.endRadius, endpoint_crossbody_strap_67.baseRadius, endpoint_crossbody_strap_67.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_crossbody_strap_67) {
    mesh_crossbody_strap_67Geometry.scale(0.055, 0.55, 0.018);
  }
  const mesh_crossbody_strap_67 = new THREE.Mesh(
    mesh_crossbody_strap_67Geometry,
    materialMap["leather-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_crossbody_strap_67.name = "Cross-body leather strap";
  if (endpoint_crossbody_strap_67) {
    mesh_crossbody_strap_67.position.copy(endpoint_crossbody_strap_67.midpoint);
    mesh_crossbody_strap_67.quaternion.copy(endpoint_crossbody_strap_67.quaternion);
  }
  mesh_crossbody_strap_67.castShadow = options.castShadow ?? true;
  mesh_crossbody_strap_67.receiveShadow = options.receiveShadow ?? true;
  mesh_crossbody_strap_67.userData.sculptComponent = {"id": "crossbody-strap", "name": "Cross-body leather strap", "level": "meso", "role": "cloth", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "conforming-shell", "topologyRationale": "Cross-body leather strap is a distinct conforming shell observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "layered-shell", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "chest", "attachment": {"parentSocket": "chest-surface", "localStart": [-0.02, 0, 0.14], "localEnd": [-0.02, 0.04, 0.14], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.055, "height": 0.55, "depth": 0.018, "units": "relative", "confidence": 0.82}, "transform": {"position": [-0.02, 0, 0.14], "rotation": [0.0, 0.0, 0.0], "scale": [0.055, 0.55, 0.018]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "crossbody-strap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}}, "material": "leather-dark", "materialLayers": ["leather-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 43, 27, 1.0)", "secondaryAlbedo": "rgba(112, 70, 40, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.78, "evidenceRef": "reference/cartoon-courier.png"}};
  node_crossbody_strap_67.add(mesh_crossbody_strap_67);
  meshes["crossbody-strap"] = mesh_crossbody_strap_67;
  colliders["crossbody-strap"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["crossbody-strap"] ??= [];
  destructionGroups["crossbody-strap"].push(node_crossbody_strap_67);

  const endpoint_satchel_68 = makeAttachmentEndpoint(null);
  const node_satchel_68 = new THREE.Group();
  node_satchel_68.name = "Side satchel__pivot";
  node_satchel_68.scale.set(1, 1, 1);
  if (endpoint_satchel_68) {
    node_satchel_68.position.copy(endpoint_satchel_68.start);
    node_satchel_68.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_satchel_68.position.set(-0.24, -0.03, 0.04);
    node_satchel_68.rotation.set(0.0, 0.0, 0.0);
  }
  node_satchel_68.userData.sculptComponent = {"id": "satchel", "name": "Side satchel", "level": "meso", "role": "support", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Side satchel is a distinct assembled volume observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "assembled-solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "pelvis", "attachment": {"parentSocket": "pelvis-surface", "localStart": [-0.24, -0.03, 0.04], "localEnd": [-0.24, 0.010000000000000002, 0.04], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.18, "height": 0.24, "depth": 0.1, "units": "relative", "confidence": 0.82}, "transform": {"position": [-0.24, -0.03, 0.04], "rotation": [0.0, 0.0, 0.0], "scale": [0.18, 0.24, 0.1]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "satchel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}}, "material": "leather-dark", "materialLayers": ["leather-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "satchel-stitches", "kind": "stitch", "description": "Repeated warm thread around flap and attachment tabs.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 43, 27, 1.0)", "secondaryAlbedo": "rgba(112, 70, 40, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.78, "evidenceRef": "reference/cartoon-courier.png"}};
  node_satchel_68.userData.actionProfile = {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "satchel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}};
  (nodes["pelvis"] ?? root).add(node_satchel_68);
  nodes["satchel"] = node_satchel_68;
  const mesh_satchel_68Geometry = endpoint_satchel_68
    ? new THREE.CylinderGeometry(endpoint_satchel_68.endRadius, endpoint_satchel_68.baseRadius, endpoint_satchel_68.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_satchel_68) {
    mesh_satchel_68Geometry.scale(0.18, 0.24, 0.1);
  }
  const mesh_satchel_68 = new THREE.Mesh(
    mesh_satchel_68Geometry,
    materialMap["leather-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_satchel_68.name = "Side satchel";
  if (endpoint_satchel_68) {
    mesh_satchel_68.position.copy(endpoint_satchel_68.midpoint);
    mesh_satchel_68.quaternion.copy(endpoint_satchel_68.quaternion);
  }
  mesh_satchel_68.castShadow = options.castShadow ?? true;
  mesh_satchel_68.receiveShadow = options.receiveShadow ?? true;
  mesh_satchel_68.userData.sculptComponent = {"id": "satchel", "name": "Side satchel", "level": "meso", "role": "support", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Side satchel is a distinct assembled volume observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "assembled-solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "pelvis", "attachment": {"parentSocket": "pelvis-surface", "localStart": [-0.24, -0.03, 0.04], "localEnd": [-0.24, 0.010000000000000002, 0.04], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.18, "height": 0.24, "depth": 0.1, "units": "relative", "confidence": 0.82}, "transform": {"position": [-0.24, -0.03, 0.04], "rotation": [0.0, 0.0, 0.0], "scale": [0.18, 0.24, 0.1]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "satchel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}}, "material": "leather-dark", "materialLayers": ["leather-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "satchel-stitches", "kind": "stitch", "description": "Repeated warm thread around flap and attachment tabs.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 43, 27, 1.0)", "secondaryAlbedo": "rgba(112, 70, 40, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.78, "evidenceRef": "reference/cartoon-courier.png"}};
  node_satchel_68.add(mesh_satchel_68);
  meshes["satchel"] = mesh_satchel_68;
  colliders["satchel"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["satchel"] ??= [];
  destructionGroups["satchel"].push(node_satchel_68);

  const endpoint_cargo_pocket_69 = makeAttachmentEndpoint(null);
  const node_cargo_pocket_69 = new THREE.Group();
  node_cargo_pocket_69.name = "Left thigh cargo pocket__pivot";
  node_cargo_pocket_69.scale.set(1, 1, 1);
  if (endpoint_cargo_pocket_69) {
    node_cargo_pocket_69.position.copy(endpoint_cargo_pocket_69.start);
    node_cargo_pocket_69.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cargo_pocket_69.position.set(0.055, -0.02, 0.07);
    node_cargo_pocket_69.rotation.set(0.0, 0.0, 0.0);
  }
  node_cargo_pocket_69.userData.sculptComponent = {"id": "cargo-pocket", "name": "Left thigh cargo pocket", "level": "micro", "role": "detail", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Left thigh cargo pocket is a distinct assembled volume observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "assembled-solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thigh-l", "attachment": {"parentSocket": "thigh-l-surface", "localStart": [0.055, -0.02, 0.07], "localEnd": [0.055, 0.02, 0.07], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1, "height": 0.16, "depth": 0.025, "units": "relative", "confidence": 0.82}, "transform": {"position": [0.055, -0.02, 0.07], "rotation": [0.0, 0.0, 0.0], "scale": [0.1, 0.16, 0.025]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cargo-pocket", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cargo-pocket", "kind": "bevel", "description": "Raised pocket shell with rounded flap.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(54, 47, 42, 1.0)", "secondaryAlbedo": "rgba(82, 69, 59, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.89, "evidenceRef": "reference/cartoon-courier.png"}};
  node_cargo_pocket_69.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cargo-pocket", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}};
  (nodes["thigh-l"] ?? root).add(node_cargo_pocket_69);
  nodes["cargo-pocket"] = node_cargo_pocket_69;
  const mesh_cargo_pocket_69Geometry = endpoint_cargo_pocket_69
    ? new THREE.CylinderGeometry(endpoint_cargo_pocket_69.endRadius, endpoint_cargo_pocket_69.baseRadius, endpoint_cargo_pocket_69.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_cargo_pocket_69) {
    mesh_cargo_pocket_69Geometry.scale(0.1, 0.16, 0.025);
  }
  const mesh_cargo_pocket_69 = new THREE.Mesh(
    mesh_cargo_pocket_69Geometry,
    materialMap["pants"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cargo_pocket_69.name = "Left thigh cargo pocket";
  if (endpoint_cargo_pocket_69) {
    mesh_cargo_pocket_69.position.copy(endpoint_cargo_pocket_69.midpoint);
    mesh_cargo_pocket_69.quaternion.copy(endpoint_cargo_pocket_69.quaternion);
  }
  mesh_cargo_pocket_69.castShadow = options.castShadow ?? true;
  mesh_cargo_pocket_69.receiveShadow = options.receiveShadow ?? true;
  mesh_cargo_pocket_69.userData.sculptComponent = {"id": "cargo-pocket", "name": "Left thigh cargo pocket", "level": "micro", "role": "detail", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Left thigh cargo pocket is a distinct assembled volume observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "assembled-solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thigh-l", "attachment": {"parentSocket": "thigh-l-surface", "localStart": [0.055, -0.02, 0.07], "localEnd": [0.055, 0.02, 0.07], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1, "height": 0.16, "depth": 0.025, "units": "relative", "confidence": 0.82}, "transform": {"position": [0.055, -0.02, 0.07], "rotation": [0.0, 0.0, 0.0], "scale": [0.1, 0.16, 0.025]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cargo-pocket", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cargo-pocket", "kind": "bevel", "description": "Raised pocket shell with rounded flap.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(54, 47, 42, 1.0)", "secondaryAlbedo": "rgba(82, 69, 59, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.89, "evidenceRef": "reference/cartoon-courier.png"}};
  node_cargo_pocket_69.add(mesh_cargo_pocket_69);
  meshes["cargo-pocket"] = mesh_cargo_pocket_69;
  colliders["cargo-pocket"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["cargo-pocket"] ??= [];
  destructionGroups["cargo-pocket"].push(node_cargo_pocket_69);

  const endpoint_glove_l_70 = makeAttachmentEndpoint(null);
  const node_glove_l_70 = new THREE.Group();
  node_glove_l_70.name = "Left fingerless glove__pivot";
  node_glove_l_70.scale.set(1, 1, 1);
  if (endpoint_glove_l_70) {
    node_glove_l_70.position.copy(endpoint_glove_l_70.start);
    node_glove_l_70.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_glove_l_70.position.set(0.0, 0.0, 0.0);
    node_glove_l_70.rotation.set(0.0, 0.0, 0.0);
  }
  node_glove_l_70.userData.sculptComponent = {"id": "glove-l", "name": "Left fingerless glove", "level": "meso", "role": "shell", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "conforming-shell", "topologyRationale": "Left fingerless glove is a distinct conforming shell observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "layered-shell", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "hand-l-surface", "localStart": [0, 0, 0], "localEnd": [0, 0.04, 0], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.075, "height": 0.09, "depth": 0.05, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0, 0], "rotation": [0.0, 0.0, 0.0], "scale": [0.075, 0.09, 0.05]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "glove-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}}, "material": "leather-dark", "materialLayers": ["leather-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "fingerless-gloves", "kind": "seam", "description": "Exposed fingertips and layered wrist cuff.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 43, 27, 1.0)", "secondaryAlbedo": "rgba(112, 70, 40, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.78, "evidenceRef": "reference/cartoon-courier.png"}};
  node_glove_l_70.userData.actionProfile = {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "glove-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}};
  (nodes["hand-l"] ?? root).add(node_glove_l_70);
  nodes["glove-l"] = node_glove_l_70;
  const mesh_glove_l_70Geometry = endpoint_glove_l_70
    ? new THREE.CylinderGeometry(endpoint_glove_l_70.endRadius, endpoint_glove_l_70.baseRadius, endpoint_glove_l_70.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_glove_l_70) {
    mesh_glove_l_70Geometry.scale(0.075, 0.09, 0.05);
  }
  const mesh_glove_l_70 = new THREE.Mesh(
    mesh_glove_l_70Geometry,
    materialMap["leather-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_glove_l_70.name = "Left fingerless glove";
  if (endpoint_glove_l_70) {
    mesh_glove_l_70.position.copy(endpoint_glove_l_70.midpoint);
    mesh_glove_l_70.quaternion.copy(endpoint_glove_l_70.quaternion);
  }
  mesh_glove_l_70.castShadow = options.castShadow ?? true;
  mesh_glove_l_70.receiveShadow = options.receiveShadow ?? true;
  mesh_glove_l_70.userData.sculptComponent = {"id": "glove-l", "name": "Left fingerless glove", "level": "meso", "role": "shell", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "conforming-shell", "topologyRationale": "Left fingerless glove is a distinct conforming shell observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "layered-shell", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-l", "attachment": {"parentSocket": "hand-l-surface", "localStart": [0, 0, 0], "localEnd": [0, 0.04, 0], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.075, "height": 0.09, "depth": 0.05, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0, 0], "rotation": [0.0, 0.0, 0.0], "scale": [0.075, 0.09, 0.05]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "glove-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}}, "material": "leather-dark", "materialLayers": ["leather-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "fingerless-gloves", "kind": "seam", "description": "Exposed fingertips and layered wrist cuff.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 43, 27, 1.0)", "secondaryAlbedo": "rgba(112, 70, 40, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.78, "evidenceRef": "reference/cartoon-courier.png"}};
  node_glove_l_70.add(mesh_glove_l_70);
  meshes["glove-l"] = mesh_glove_l_70;
  colliders["glove-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["glove-l"] ??= [];
  destructionGroups["glove-l"].push(node_glove_l_70);

  const endpoint_glove_r_71 = makeAttachmentEndpoint(null);
  const node_glove_r_71 = new THREE.Group();
  node_glove_r_71.name = "Right fingerless glove__pivot";
  node_glove_r_71.scale.set(1, 1, 1);
  if (endpoint_glove_r_71) {
    node_glove_r_71.position.copy(endpoint_glove_r_71.start);
    node_glove_r_71.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_glove_r_71.position.set(0.0, 0.0, 0.0);
    node_glove_r_71.rotation.set(0.0, 0.0, 0.0);
  }
  node_glove_r_71.userData.sculptComponent = {"id": "glove-r", "name": "Right fingerless glove", "level": "meso", "role": "shell", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "conforming-shell", "topologyRationale": "Right fingerless glove is a distinct conforming shell observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "layered-shell", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "hand-r-surface", "localStart": [0, 0, 0], "localEnd": [0, 0.04, 0], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.075, "height": 0.09, "depth": 0.05, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0, 0], "rotation": [0.0, 0.0, 0.0], "scale": [0.075, 0.09, 0.05]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "glove-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}}, "material": "leather-dark", "materialLayers": ["leather-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 43, 27, 1.0)", "secondaryAlbedo": "rgba(112, 70, 40, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.78, "evidenceRef": "reference/cartoon-courier.png"}};
  node_glove_r_71.userData.actionProfile = {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "glove-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}};
  (nodes["hand-r"] ?? root).add(node_glove_r_71);
  nodes["glove-r"] = node_glove_r_71;
  const mesh_glove_r_71Geometry = endpoint_glove_r_71
    ? new THREE.CylinderGeometry(endpoint_glove_r_71.endRadius, endpoint_glove_r_71.baseRadius, endpoint_glove_r_71.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_glove_r_71) {
    mesh_glove_r_71Geometry.scale(0.075, 0.09, 0.05);
  }
  const mesh_glove_r_71 = new THREE.Mesh(
    mesh_glove_r_71Geometry,
    materialMap["leather-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_glove_r_71.name = "Right fingerless glove";
  if (endpoint_glove_r_71) {
    mesh_glove_r_71.position.copy(endpoint_glove_r_71.midpoint);
    mesh_glove_r_71.quaternion.copy(endpoint_glove_r_71.quaternion);
  }
  mesh_glove_r_71.castShadow = options.castShadow ?? true;
  mesh_glove_r_71.receiveShadow = options.receiveShadow ?? true;
  mesh_glove_r_71.userData.sculptComponent = {"id": "glove-r", "name": "Right fingerless glove", "level": "meso", "role": "shell", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "conforming-shell", "topologyRationale": "Right fingerless glove is a distinct conforming shell observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "layered-shell", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-r", "attachment": {"parentSocket": "hand-r-surface", "localStart": [0, 0, 0], "localEnd": [0, 0.04, 0], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.075, "height": 0.09, "depth": 0.05, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0, 0], "rotation": [0.0, 0.0, 0.0], "scale": [0.075, 0.09, 0.05]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "glove-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-dark"}}, "material": "leather-dark", "materialLayers": ["leather-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 43, 27, 1.0)", "secondaryAlbedo": "rgba(112, 70, 40, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.78, "evidenceRef": "reference/cartoon-courier.png"}};
  node_glove_r_71.add(mesh_glove_r_71);
  meshes["glove-r"] = mesh_glove_r_71;
  colliders["glove-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["glove-r"] ??= [];
  destructionGroups["glove-r"].push(node_glove_r_71);

  const endpoint_boot_l_72 = makeAttachmentEndpoint(null);
  const node_boot_l_72 = new THREE.Group();
  node_boot_l_72.name = "Left layered boot__pivot";
  node_boot_l_72.scale.set(1, 1, 1);
  if (endpoint_boot_l_72) {
    node_boot_l_72.position.copy(endpoint_boot_l_72.start);
    node_boot_l_72.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_boot_l_72.position.set(0.0, 0.08, 0.01);
    node_boot_l_72.rotation.set(0.0, 0.0, 0.0);
  }
  node_boot_l_72.userData.sculptComponent = {"id": "boot-l", "name": "Left layered boot", "level": "macro", "role": "shell", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "conforming-shell", "topologyRationale": "Left layered boot is a distinct conforming shell observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "layered-shell", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "foot-l", "attachment": {"parentSocket": "foot-l-surface", "localStart": [0, 0.08, 0.01], "localEnd": [0, 0.12, 0.01], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.16, "height": 0.28, "depth": 0.24, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0.08, 0.01], "rotation": [0.0, 0.0, 0.0], "scale": [0.16, 0.28, 0.24]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-tan"}}, "material": "leather-tan", "materialLayers": ["leather-tan"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "boot-layering", "kind": "ridge", "description": "Toe shell, shin guard, cuff and raised straps.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(151, 99, 47, 1.0)", "secondaryAlbedo": "rgba(188, 132, 65, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.8, "evidenceRef": "reference/cartoon-courier.png"}};
  node_boot_l_72.userData.actionProfile = {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-tan"}};
  (nodes["foot-l"] ?? root).add(node_boot_l_72);
  nodes["boot-l"] = node_boot_l_72;
  const mesh_boot_l_72Geometry = endpoint_boot_l_72
    ? new THREE.CylinderGeometry(endpoint_boot_l_72.endRadius, endpoint_boot_l_72.baseRadius, endpoint_boot_l_72.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_boot_l_72) {
    mesh_boot_l_72Geometry.scale(0.16, 0.28, 0.24);
  }
  const mesh_boot_l_72 = new THREE.Mesh(
    mesh_boot_l_72Geometry,
    materialMap["leather-tan"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boot_l_72.name = "Left layered boot";
  if (endpoint_boot_l_72) {
    mesh_boot_l_72.position.copy(endpoint_boot_l_72.midpoint);
    mesh_boot_l_72.quaternion.copy(endpoint_boot_l_72.quaternion);
  }
  mesh_boot_l_72.castShadow = options.castShadow ?? true;
  mesh_boot_l_72.receiveShadow = options.receiveShadow ?? true;
  mesh_boot_l_72.userData.sculptComponent = {"id": "boot-l", "name": "Left layered boot", "level": "macro", "role": "shell", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "conforming-shell", "topologyRationale": "Left layered boot is a distinct conforming shell observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "layered-shell", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "foot-l", "attachment": {"parentSocket": "foot-l-surface", "localStart": [0, 0.08, 0.01], "localEnd": [0, 0.12, 0.01], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.16, "height": 0.28, "depth": 0.24, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0.08, 0.01], "rotation": [0.0, 0.0, 0.0], "scale": [0.16, 0.28, 0.24]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-tan"}}, "material": "leather-tan", "materialLayers": ["leather-tan"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "boot-layering", "kind": "ridge", "description": "Toe shell, shin guard, cuff and raised straps.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(151, 99, 47, 1.0)", "secondaryAlbedo": "rgba(188, 132, 65, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.8, "evidenceRef": "reference/cartoon-courier.png"}};
  node_boot_l_72.add(mesh_boot_l_72);
  meshes["boot-l"] = mesh_boot_l_72;
  colliders["boot-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["boot-l"] ??= [];
  destructionGroups["boot-l"].push(node_boot_l_72);

  const endpoint_boot_r_73 = makeAttachmentEndpoint(null);
  const node_boot_r_73 = new THREE.Group();
  node_boot_r_73.name = "Right layered boot__pivot";
  node_boot_r_73.scale.set(1, 1, 1);
  if (endpoint_boot_r_73) {
    node_boot_r_73.position.copy(endpoint_boot_r_73.start);
    node_boot_r_73.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_boot_r_73.position.set(0.0, 0.08, 0.01);
    node_boot_r_73.rotation.set(0.0, 0.0, 0.0);
  }
  node_boot_r_73.userData.sculptComponent = {"id": "boot-r", "name": "Right layered boot", "level": "macro", "role": "shell", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "conforming-shell", "topologyRationale": "Right layered boot is a distinct conforming shell observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "layered-shell", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "foot-r", "attachment": {"parentSocket": "foot-r-surface", "localStart": [0, 0.08, 0.01], "localEnd": [0, 0.12, 0.01], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.16, "height": 0.28, "depth": 0.24, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0.08, 0.01], "rotation": [0.0, 0.0, 0.0], "scale": [0.16, 0.28, 0.24]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boot-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-tan"}}, "material": "leather-tan", "materialLayers": ["leather-tan"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "boot-straps", "kind": "fastener", "description": "Repeated leather straps with brass buckles.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(151, 99, 47, 1.0)", "secondaryAlbedo": "rgba(188, 132, 65, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.8, "evidenceRef": "reference/cartoon-courier.png"}};
  node_boot_r_73.userData.actionProfile = {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boot-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-tan"}};
  (nodes["foot-r"] ?? root).add(node_boot_r_73);
  nodes["boot-r"] = node_boot_r_73;
  const mesh_boot_r_73Geometry = endpoint_boot_r_73
    ? new THREE.CylinderGeometry(endpoint_boot_r_73.endRadius, endpoint_boot_r_73.baseRadius, endpoint_boot_r_73.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_boot_r_73) {
    mesh_boot_r_73Geometry.scale(0.16, 0.28, 0.24);
  }
  const mesh_boot_r_73 = new THREE.Mesh(
    mesh_boot_r_73Geometry,
    materialMap["leather-tan"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boot_r_73.name = "Right layered boot";
  if (endpoint_boot_r_73) {
    mesh_boot_r_73.position.copy(endpoint_boot_r_73.midpoint);
    mesh_boot_r_73.quaternion.copy(endpoint_boot_r_73.quaternion);
  }
  mesh_boot_r_73.castShadow = options.castShadow ?? true;
  mesh_boot_r_73.receiveShadow = options.receiveShadow ?? true;
  mesh_boot_r_73.userData.sculptComponent = {"id": "boot-r", "name": "Right layered boot", "level": "macro", "role": "shell", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "conforming-shell", "topologyRationale": "Right layered boot is a distinct conforming shell observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "layered-shell", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "foot-r", "attachment": {"parentSocket": "foot-r-surface", "localStart": [0, 0.08, 0.01], "localEnd": [0, 0.12, 0.01], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.16, "height": 0.28, "depth": 0.24, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, 0.08, 0.01], "rotation": [0.0, 0.0, 0.0], "scale": [0.16, 0.28, 0.24]}, "actionProfile": {"animationRole": "secondary", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boot-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "leather-tan"}}, "material": "leather-tan", "materialLayers": ["leather-tan"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "boot-straps", "kind": "fastener", "description": "Repeated leather straps with brass buckles.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(151, 99, 47, 1.0)", "secondaryAlbedo": "rgba(188, 132, 65, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.8, "evidenceRef": "reference/cartoon-courier.png"}};
  node_boot_r_73.add(mesh_boot_r_73);
  meshes["boot-r"] = mesh_boot_r_73;
  colliders["boot-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["boot-r"] ??= [];
  destructionGroups["boot-r"].push(node_boot_r_73);

  const endpoint_sole_l_74 = makeAttachmentEndpoint(null);
  const node_sole_l_74 = new THREE.Group();
  node_sole_l_74.name = "Left lugged sole__pivot";
  node_sole_l_74.scale.set(1, 1, 1);
  if (endpoint_sole_l_74) {
    node_sole_l_74.position.copy(endpoint_sole_l_74.start);
    node_sole_l_74.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sole_l_74.position.set(0.0, -0.13, 0.025);
    node_sole_l_74.rotation.set(0.0, 0.0, 0.0);
  }
  node_sole_l_74.userData.sculptComponent = {"id": "sole-l", "name": "Left lugged sole", "level": "micro", "role": "detail", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Left lugged sole is a distinct assembled volume observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "assembled-solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "boot-l", "attachment": {"parentSocket": "boot-l-surface", "localStart": [0, -0.13, 0.025], "localEnd": [0, -0.09, 0.025], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.18, "height": 0.055, "depth": 0.27, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, -0.13, 0.025], "rotation": [0.0, 0.0, 0.0], "scale": [0.18, 0.055, 0.27]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sole-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rubber"}}, "material": "rubber", "materialLayers": ["rubber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "sole-lugs", "kind": "groove", "description": "Regular rectangular tread notches in the silhouette.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(40, 31, 25, 1.0)", "secondaryAlbedo": "rgba(67, 49, 37, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9, "evidenceRef": "reference/cartoon-courier.png"}};
  node_sole_l_74.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sole-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rubber"}};
  (nodes["boot-l"] ?? root).add(node_sole_l_74);
  nodes["sole-l"] = node_sole_l_74;
  const mesh_sole_l_74Geometry = endpoint_sole_l_74
    ? new THREE.CylinderGeometry(endpoint_sole_l_74.endRadius, endpoint_sole_l_74.baseRadius, endpoint_sole_l_74.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_sole_l_74) {
    mesh_sole_l_74Geometry.scale(0.18, 0.055, 0.27);
  }
  const mesh_sole_l_74 = new THREE.Mesh(
    mesh_sole_l_74Geometry,
    materialMap["rubber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sole_l_74.name = "Left lugged sole";
  if (endpoint_sole_l_74) {
    mesh_sole_l_74.position.copy(endpoint_sole_l_74.midpoint);
    mesh_sole_l_74.quaternion.copy(endpoint_sole_l_74.quaternion);
  }
  mesh_sole_l_74.castShadow = options.castShadow ?? true;
  mesh_sole_l_74.receiveShadow = options.receiveShadow ?? true;
  mesh_sole_l_74.userData.sculptComponent = {"id": "sole-l", "name": "Left lugged sole", "level": "micro", "role": "detail", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Left lugged sole is a distinct assembled volume observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "assembled-solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "boot-l", "attachment": {"parentSocket": "boot-l-surface", "localStart": [0, -0.13, 0.025], "localEnd": [0, -0.09, 0.025], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.18, "height": 0.055, "depth": 0.27, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, -0.13, 0.025], "rotation": [0.0, 0.0, 0.0], "scale": [0.18, 0.055, 0.27]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sole-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rubber"}}, "material": "rubber", "materialLayers": ["rubber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "sole-lugs", "kind": "groove", "description": "Regular rectangular tread notches in the silhouette.", "evidenceRefs": ["reference/cartoon-courier.png"], "confidence": 0.9}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(40, 31, 25, 1.0)", "secondaryAlbedo": "rgba(67, 49, 37, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9, "evidenceRef": "reference/cartoon-courier.png"}};
  node_sole_l_74.add(mesh_sole_l_74);
  meshes["sole-l"] = mesh_sole_l_74;
  colliders["sole-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["sole-l"] ??= [];
  destructionGroups["sole-l"].push(node_sole_l_74);

  const endpoint_sole_r_75 = makeAttachmentEndpoint(null);
  const node_sole_r_75 = new THREE.Group();
  node_sole_r_75.name = "Right lugged sole__pivot";
  node_sole_r_75.scale.set(1, 1, 1);
  if (endpoint_sole_r_75) {
    node_sole_r_75.position.copy(endpoint_sole_r_75.start);
    node_sole_r_75.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sole_r_75.position.set(0.0, -0.13, 0.025);
    node_sole_r_75.rotation.set(0.0, 0.0, 0.0);
  }
  node_sole_r_75.userData.sculptComponent = {"id": "sole-r", "name": "Right lugged sole", "level": "micro", "role": "detail", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Right lugged sole is a distinct assembled volume observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "assembled-solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "boot-r", "attachment": {"parentSocket": "boot-r-surface", "localStart": [0, -0.13, 0.025], "localEnd": [0, -0.09, 0.025], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.18, "height": 0.055, "depth": 0.27, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, -0.13, 0.025], "rotation": [0.0, 0.0, 0.0], "scale": [0.18, 0.055, 0.27]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sole-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rubber"}}, "material": "rubber", "materialLayers": ["rubber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(40, 31, 25, 1.0)", "secondaryAlbedo": "rgba(67, 49, 37, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9, "evidenceRef": "reference/cartoon-courier.png"}};
  node_sole_r_75.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sole-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rubber"}};
  (nodes["boot-r"] ?? root).add(node_sole_r_75);
  nodes["sole-r"] = node_sole_r_75;
  const mesh_sole_r_75Geometry = endpoint_sole_r_75
    ? new THREE.CylinderGeometry(endpoint_sole_r_75.endRadius, endpoint_sole_r_75.baseRadius, endpoint_sole_r_75.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_sole_r_75) {
    mesh_sole_r_75Geometry.scale(0.18, 0.055, 0.27);
  }
  const mesh_sole_r_75 = new THREE.Mesh(
    mesh_sole_r_75Geometry,
    materialMap["rubber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sole_r_75.name = "Right lugged sole";
  if (endpoint_sole_r_75) {
    mesh_sole_r_75.position.copy(endpoint_sole_r_75.midpoint);
    mesh_sole_r_75.quaternion.copy(endpoint_sole_r_75.quaternion);
  }
  mesh_sole_r_75.castShadow = options.castShadow ?? true;
  mesh_sole_r_75.receiveShadow = options.receiveShadow ?? true;
  mesh_sole_r_75.userData.sculptComponent = {"id": "sole-r", "name": "Right lugged sole", "level": "micro", "role": "detail", "importance": 0.88, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Right lugged sole is a distinct assembled volume observed in the reference and separated for rigging, selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "assembled-solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "boot-r", "attachment": {"parentSocket": "boot-r-surface", "localStart": [0, -0.13, 0.025], "localEnd": [0, -0.09, 0.025], "contactType": "overlap", "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.18, "height": 0.055, "depth": 0.27, "units": "relative", "confidence": 0.82}, "transform": {"position": [0, -0.13, 0.025], "rotation": [0.0, 0.0, 0.0], "scale": [0.18, 0.055, 0.27]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sole-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rubber"}}, "material": "rubber", "materialLayers": ["rubber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(40, 31, 25, 1.0)", "secondaryAlbedo": "rgba(67, 49, 37, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9, "evidenceRef": "reference/cartoon-courier.png"}};
  node_sole_r_75.add(mesh_sole_r_75);
  meshes["sole-r"] = mesh_sole_r_75;
  colliders["sole-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["sole-r"] ??= [];
  destructionGroups["sole-r"].push(node_sole_r_75);

  // standProud: hold these components outside the surfaces they cover.
  if (meshes["hair"] && nodes["head"]) {
    applyStandProud(
      meshes["hair"].geometry,
      meshes["hair"],
      nodes["head"],
      {"rings": [[-0.15680000000000002, 2.5760000000000007e-05, 2.7440000000000005e-05, 0.0], [-0.13066677120000003, 0.07119677600000002, 0.07584004400000001, 0.0], [-0.10453322880000002, 0.09600185280000002, 0.10226284320000001, 0.0], [-0.07840000000000001, 0.11154414880000002, 0.11881876720000001, 0.0], [-0.05226677120000001, 0.12143392800000002, 0.12935353200000002, 0.0], [-0.026133228800000005, 0.12699860320000003, 0.13528112080000002, 0.0], [0.0, 0.12880000000000003, 0.13720000000000002, 0.0], [0.026133228800000005, 0.12699860320000003, 0.13528112080000002, 0.0], [0.05226677120000001, 0.12143392800000002, 0.12935353200000002, 0.0], [0.07840000000000001, 0.11154414880000002, 0.11881876720000001, 0.0], [0.10453322880000002, 0.09600185280000002, 0.10226284320000001, 0.0], [0.13066677120000003, 0.07119677600000002, 0.07584004400000001, 0.0], [0.15680000000000002, 2.5760000000000007e-05, 2.7440000000000005e-05, 0.0]]},
      0.012,
      0.08,
    );
  }

  // PLAN_1.5 WS-C slice 1: bone hierarchy from spec.rig. Model-space joints are
  // converted to parent-local offsets here. Nothing is bound yet (rig.bound === false).
  const bones: Record<string, THREE.Bone> = {};
  const boneOrder: string[] = [];
  const bone_pelvis = new THREE.Bone();
  bone_pelvis.name = "pelvis";
  bone_pelvis.position.set(0.0, -0.203, 0.0);
  root.add(bone_pelvis);
  bones["pelvis"] = bone_pelvis;
  boneOrder.push("pelvis");
  const bone_abdomen = new THREE.Bone();
  bone_abdomen.name = "abdomen";
  bone_abdomen.position.set(0.0, 0.028000000000000025, 0.0);
  bone_pelvis.add(bone_abdomen);
  bones["abdomen"] = bone_abdomen;
  boneOrder.push("abdomen");
  const bone_chest = new THREE.Bone();
  bone_chest.name = "chest";
  bone_chest.position.set(0.0, 0.27636, 0.0028);
  bone_abdomen.add(bone_chest);
  bones["chest"] = bone_chest;
  boneOrder.push("chest");
  const bone_clavicle_l = new THREE.Bone();
  bone_clavicle_l.name = "clavicle-l";
  bone_clavicle_l.position.set(0.03002, 0.36484, 0.005599999999999999);
  bone_chest.add(bone_clavicle_l);
  bones["clavicle-l"] = bone_clavicle_l;
  boneOrder.push("clavicle-l");
  const bone_clavicle_r = new THREE.Bone();
  bone_clavicle_r.name = "clavicle-r";
  bone_clavicle_r.position.set(-0.03002, 0.36484, 0.005599999999999999);
  bone_chest.add(bone_clavicle_r);
  bones["clavicle-r"] = bone_clavicle_r;
  boneOrder.push("clavicle-r");
  const bone_thigh_l = new THREE.Bone();
  bone_thigh_l.name = "thigh-l";
  bone_thigh_l.position.set(0.07896, -0.06495999999999996, 0.0056);
  bone_pelvis.add(bone_thigh_l);
  bones["thigh-l"] = bone_thigh_l;
  boneOrder.push("thigh-l");
  const bone_shin_l = new THREE.Bone();
  bone_shin_l.name = "shin-l";
  bone_shin_l.position.set(0.0, -0.37842, 0.0);
  bone_thigh_l.add(bone_shin_l);
  bones["shin-l"] = bone_shin_l;
  boneOrder.push("shin-l");
  const bone_foot_l = new THREE.Bone();
  bone_foot_l.name = "foot-l";
  bone_foot_l.position.set(0.0, -0.34958, 0.0392);
  bone_shin_l.add(bone_foot_l);
  bones["foot-l"] = bone_foot_l;
  boneOrder.push("foot-l");
  const bone_thigh_r = new THREE.Bone();
  bone_thigh_r.name = "thigh-r";
  bone_thigh_r.position.set(-0.07896, -0.06495999999999996, 0.0056);
  bone_pelvis.add(bone_thigh_r);
  bones["thigh-r"] = bone_thigh_r;
  boneOrder.push("thigh-r");
  const bone_shin_r = new THREE.Bone();
  bone_shin_r.name = "shin-r";
  bone_shin_r.position.set(0.0, -0.37842, 0.0);
  bone_thigh_r.add(bone_shin_r);
  bones["shin-r"] = bone_shin_r;
  boneOrder.push("shin-r");
  const bone_foot_r = new THREE.Bone();
  bone_foot_r.name = "foot-r";
  bone_foot_r.position.set(0.0, -0.34958, 0.0392);
  bone_shin_r.add(bone_foot_r);
  bones["foot-r"] = bone_foot_r;
  boneOrder.push("foot-r");
  const bone_upper_arm_l = new THREE.Bone();
  bone_upper_arm_l.name = "upper-arm-l";
  bone_upper_arm_l.position.set(0.15758, -0.005599999999999994, 0.005600000000000001);
  bone_clavicle_l.add(bone_upper_arm_l);
  bones["upper-arm-l"] = bone_upper_arm_l;
  boneOrder.push("upper-arm-l");
  const bone_forearm_l = new THREE.Bone();
  bone_forearm_l.name = "forearm-l";
  bone_forearm_l.position.set(0.06830000000000003, -0.33695, 0.0);
  bone_upper_arm_l.add(bone_forearm_l);
  bones["forearm-l"] = bone_forearm_l;
  boneOrder.push("forearm-l");
  const bone_upper_arm_r = new THREE.Bone();
  bone_upper_arm_r.name = "upper-arm-r";
  bone_upper_arm_r.position.set(-0.15758, -0.005599999999999994, 0.005600000000000001);
  bone_clavicle_r.add(bone_upper_arm_r);
  bones["upper-arm-r"] = bone_upper_arm_r;
  boneOrder.push("upper-arm-r");
  const bone_forearm_r = new THREE.Bone();
  bone_forearm_r.name = "forearm-r";
  bone_forearm_r.position.set(-0.06830000000000003, -0.33695, 0.0);
  bone_upper_arm_r.add(bone_forearm_r);
  bones["forearm-r"] = bone_forearm_r;
  boneOrder.push("forearm-r");
  const bone_hand_l = new THREE.Bone();
  bone_hand_l.name = "hand-l";
  bone_hand_l.position.set(0.039039999999999964, -0.32375, 0.0);
  bone_forearm_l.add(bone_hand_l);
  bones["hand-l"] = bone_hand_l;
  boneOrder.push("hand-l");
  const bone_hand_r = new THREE.Bone();
  bone_hand_r.name = "hand-r";
  bone_hand_r.position.set(-0.039039999999999964, -0.32375, 0.0);
  bone_forearm_r.add(bone_hand_r);
  bones["hand-r"] = bone_hand_r;
  boneOrder.push("hand-r");
  const bone_neck = new THREE.Bone();
  bone_neck.name = "neck";
  bone_neck.position.set(0.0, 0.35924, 0.0028);
  bone_chest.add(bone_neck);
  bones["neck"] = bone_neck;
  boneOrder.push("neck");
  const bone_head = new THREE.Bone();
  bone_head.name = "head";
  bone_head.position.set(0.0, 0.238, 0.0);
  bone_neck.add(bone_head);
  bones["head"] = bone_head;
  boneOrder.push("head");
  const bone_index_l_1 = new THREE.Bone();
  bone_index_l_1.name = "index-l-1";
  bone_index_l_1.position.set(-0.020999999999999963, -0.03763, 0.0027999999999999987);
  bone_hand_l.add(bone_index_l_1);
  bones["index-l-1"] = bone_index_l_1;
  boneOrder.push("index-l-1");
  const bone_index_l_2 = new THREE.Bone();
  bone_index_l_2.name = "index-l-2";
  bone_index_l_2.position.set(0.0035199999999999676, -0.029189999999999994, 0.0);
  bone_index_l_1.add(bone_index_l_2);
  bones["index-l-2"] = bone_index_l_2;
  boneOrder.push("index-l-2");
  const bone_index_l_3 = new THREE.Bone();
  bone_index_l_3.name = "index-l-3";
  bone_index_l_3.position.set(0.0024100000000000232, -0.020019999999999982, 0.0);
  bone_index_l_2.add(bone_index_l_3);
  bones["index-l-3"] = bone_index_l_3;
  boneOrder.push("index-l-3");
  const bone_index_r_1 = new THREE.Bone();
  bone_index_r_1.name = "index-r-1";
  bone_index_r_1.position.set(0.020999999999999963, -0.03763, 0.0027999999999999987);
  bone_hand_r.add(bone_index_r_1);
  bones["index-r-1"] = bone_index_r_1;
  boneOrder.push("index-r-1");
  const bone_index_r_2 = new THREE.Bone();
  bone_index_r_2.name = "index-r-2";
  bone_index_r_2.position.set(-0.0035199999999999676, -0.029189999999999994, 0.0);
  bone_index_r_1.add(bone_index_r_2);
  bones["index-r-2"] = bone_index_r_2;
  boneOrder.push("index-r-2");
  const bone_index_r_3 = new THREE.Bone();
  bone_index_r_3.name = "index-r-3";
  bone_index_r_3.position.set(-0.0024100000000000232, -0.020019999999999982, 0.0);
  bone_index_r_2.add(bone_index_r_3);
  bones["index-r-3"] = bone_index_r_3;
  boneOrder.push("index-r-3");
  const bone_little_l_1 = new THREE.Bone();
  bone_little_l_1.name = "little-l-1";
  bone_little_l_1.position.set(0.019600000000000006, -0.03763, 0.0027999999999999987);
  bone_hand_l.add(bone_little_l_1);
  bones["little-l-1"] = bone_little_l_1;
  boneOrder.push("little-l-1");
  const bone_little_l_2 = new THREE.Bone();
  bone_little_l_2.name = "little-l-2";
  bone_little_l_2.position.set(0.0026800000000000157, -0.022239999999999982, 0.0);
  bone_little_l_1.add(bone_little_l_2);
  bones["little-l-2"] = bone_little_l_2;
  boneOrder.push("little-l-2");
  const bone_little_l_3 = new THREE.Bone();
  bone_little_l_3.name = "little-l-3";
  bone_little_l_3.position.set(0.0019500000000000073, -0.016130000000000033, 0.0);
  bone_little_l_2.add(bone_little_l_3);
  bones["little-l-3"] = bone_little_l_3;
  boneOrder.push("little-l-3");
  const bone_little_r_1 = new THREE.Bone();
  bone_little_r_1.name = "little-r-1";
  bone_little_r_1.position.set(-0.019600000000000006, -0.03763, 0.0027999999999999987);
  bone_hand_r.add(bone_little_r_1);
  bones["little-r-1"] = bone_little_r_1;
  boneOrder.push("little-r-1");
  const bone_little_r_2 = new THREE.Bone();
  bone_little_r_2.name = "little-r-2";
  bone_little_r_2.position.set(-0.0026800000000000157, -0.022239999999999982, 0.0);
  bone_little_r_1.add(bone_little_r_2);
  bones["little-r-2"] = bone_little_r_2;
  boneOrder.push("little-r-2");
  const bone_little_r_3 = new THREE.Bone();
  bone_little_r_3.name = "little-r-3";
  bone_little_r_3.position.set(-0.0019500000000000073, -0.016130000000000033, 0.0);
  bone_little_r_2.add(bone_little_r_3);
  bones["little-r-3"] = bone_little_r_3;
  boneOrder.push("little-r-3");
  const bone_middle_l_1 = new THREE.Bone();
  bone_middle_l_1.name = "middle-l-1";
  bone_middle_l_1.position.set(-0.007000000000000006, -0.03763, 0.0027999999999999987);
  bone_hand_l.add(bone_middle_l_1);
  bones["middle-l-1"] = bone_middle_l_1;
  boneOrder.push("middle-l-1");
  const bone_middle_l_2 = new THREE.Bone();
  bone_middle_l_2.name = "middle-l-2";
  bone_middle_l_2.position.set(0.00386000000000003, -0.03197, 0.0);
  bone_middle_l_1.add(bone_middle_l_2);
  bones["middle-l-2"] = bone_middle_l_2;
  boneOrder.push("middle-l-2");
  const bone_middle_l_3 = new THREE.Bone();
  bone_middle_l_3.name = "middle-l-3";
  bone_middle_l_3.position.set(0.0026800000000000157, -0.022239999999999982, 0.0);
  bone_middle_l_2.add(bone_middle_l_3);
  bones["middle-l-3"] = bone_middle_l_3;
  boneOrder.push("middle-l-3");
  const bone_middle_r_1 = new THREE.Bone();
  bone_middle_r_1.name = "middle-r-1";
  bone_middle_r_1.position.set(0.007000000000000006, -0.03763, 0.0027999999999999987);
  bone_hand_r.add(bone_middle_r_1);
  bones["middle-r-1"] = bone_middle_r_1;
  boneOrder.push("middle-r-1");
  const bone_middle_r_2 = new THREE.Bone();
  bone_middle_r_2.name = "middle-r-2";
  bone_middle_r_2.position.set(-0.00386000000000003, -0.03197, 0.0);
  bone_middle_r_1.add(bone_middle_r_2);
  bones["middle-r-2"] = bone_middle_r_2;
  boneOrder.push("middle-r-2");
  const bone_middle_r_3 = new THREE.Bone();
  bone_middle_r_3.name = "middle-r-3";
  bone_middle_r_3.position.set(-0.0026800000000000157, -0.022239999999999982, 0.0);
  bone_middle_r_2.add(bone_middle_r_3);
  bones["middle-r-3"] = bone_middle_r_3;
  boneOrder.push("middle-r-3");
  const bone_ring_l_1 = new THREE.Bone();
  bone_ring_l_1.name = "ring-l-1";
  bone_ring_l_1.position.set(0.007000000000000006, -0.03763, 0.0027999999999999987);
  bone_hand_l.add(bone_ring_l_1);
  bones["ring-l-1"] = bone_ring_l_1;
  boneOrder.push("ring-l-1");
  const bone_ring_l_2 = new THREE.Bone();
  bone_ring_l_2.name = "ring-l-2";
  bone_ring_l_2.position.set(0.003520000000000023, -0.029189999999999994, 0.0);
  bone_ring_l_1.add(bone_ring_l_2);
  bones["ring-l-2"] = bone_ring_l_2;
  boneOrder.push("ring-l-2");
  const bone_ring_l_3 = new THREE.Bone();
  bone_ring_l_3.name = "ring-l-3";
  bone_ring_l_3.position.set(0.0024099999999999677, -0.020019999999999982, 0.0);
  bone_ring_l_2.add(bone_ring_l_3);
  bones["ring-l-3"] = bone_ring_l_3;
  boneOrder.push("ring-l-3");
  const bone_ring_r_1 = new THREE.Bone();
  bone_ring_r_1.name = "ring-r-1";
  bone_ring_r_1.position.set(-0.007000000000000006, -0.03763, 0.0027999999999999987);
  bone_hand_r.add(bone_ring_r_1);
  bones["ring-r-1"] = bone_ring_r_1;
  boneOrder.push("ring-r-1");
  const bone_ring_r_2 = new THREE.Bone();
  bone_ring_r_2.name = "ring-r-2";
  bone_ring_r_2.position.set(-0.003520000000000023, -0.029189999999999994, 0.0);
  bone_ring_r_1.add(bone_ring_r_2);
  bones["ring-r-2"] = bone_ring_r_2;
  boneOrder.push("ring-r-2");
  const bone_ring_r_3 = new THREE.Bone();
  bone_ring_r_3.name = "ring-r-3";
  bone_ring_r_3.position.set(-0.0024099999999999677, -0.020019999999999982, 0.0);
  bone_ring_r_2.add(bone_ring_r_3);
  bones["ring-r-3"] = bone_ring_r_3;
  boneOrder.push("ring-r-3");
  const bone_thumb_l_1 = new THREE.Bone();
  bone_thumb_l_1.name = "thumb-l-1";
  bone_thumb_l_1.position.set(-0.02799999999999997, -0.005379999999999996, 0.005599999999999999);
  bone_hand_l.add(bone_thumb_l_1);
  bones["thumb-l-1"] = bone_thumb_l_1;
  boneOrder.push("thumb-l-1");
  const bone_thumb_l_2 = new THREE.Bone();
  bone_thumb_l_2.name = "thumb-l-2";
  bone_thumb_l_2.position.set(-0.015120000000000022, -0.013020000000000004, 0.0063);
  bone_thumb_l_1.add(bone_thumb_l_2);
  bones["thumb-l-2"] = bone_thumb_l_2;
  boneOrder.push("thumb-l-2");
  const bone_thumb_l_3 = new THREE.Bone();
  bone_thumb_l_3.name = "thumb-l-3";
  bone_thumb_l_3.position.set(-0.011089999999999989, -0.009550000000000003, 0.004619999999999999);
  bone_thumb_l_2.add(bone_thumb_l_3);
  bones["thumb-l-3"] = bone_thumb_l_3;
  boneOrder.push("thumb-l-3");
  const bone_thumb_r_1 = new THREE.Bone();
  bone_thumb_r_1.name = "thumb-r-1";
  bone_thumb_r_1.position.set(0.02799999999999997, -0.005379999999999996, 0.005599999999999999);
  bone_hand_r.add(bone_thumb_r_1);
  bones["thumb-r-1"] = bone_thumb_r_1;
  boneOrder.push("thumb-r-1");
  const bone_thumb_r_2 = new THREE.Bone();
  bone_thumb_r_2.name = "thumb-r-2";
  bone_thumb_r_2.position.set(0.015120000000000022, -0.013020000000000004, 0.0063);
  bone_thumb_r_1.add(bone_thumb_r_2);
  bones["thumb-r-2"] = bone_thumb_r_2;
  boneOrder.push("thumb-r-2");
  const bone_thumb_r_3 = new THREE.Bone();
  bone_thumb_r_3.name = "thumb-r-3";
  bone_thumb_r_3.position.set(0.011089999999999989, -0.009550000000000003, 0.004619999999999999);
  bone_thumb_r_2.add(bone_thumb_r_3);
  bones["thumb-r-3"] = bone_thumb_r_3;
  boneOrder.push("thumb-r-3");
  // The bones are now in REST position. updateMatrixWorld() before constructing the
  // Skeleton is load-bearing: calculateInverses() reads each bone's CURRENT world matrix,
  // and those inverses are what cancel the rest pose during skinning. Constructed before
  // this call it captures identity matrices, the rest pose never cancels, and every
  // vertex is displaced by its bone's offset at rest. Measured, not assumed --
  // scratchpad/bind_experiment.mjs read (0, 3, 0) for a vertex authored at (0, 2, 0).
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(boneOrder.map((id) => bones[id]));
  const boneIndexOf = new Map<string, number>(boneOrder.map((id, i) => [id, i]));

  // ---- PLAN_1.5 §4 weight function: ONE function over the complete bone set. No
  // mesh-id or vertex-index branching -- only positions, segment endpoints and the
  // envelope radius derived per §4.3. Ported from forge/stage5_rig/emit_rig.py, which
  // measured max |sum(w) - 1| = 2.98e-8 on executed geometry.
  const BONE_JOINT: Record<string, number[]> = {"pelvis": [0.0, -0.203, 0.0], "abdomen": [0.0, -0.175, 0.0], "chest": [0.0, 0.10136, 0.0028], "clavicle-l": [0.03002, 0.4662, 0.0084], "clavicle-r": [-0.03002, 0.4662, 0.0084], "thigh-l": [0.07896, -0.26796, 0.0056], "shin-l": [0.07896, -0.64638, 0.0056], "foot-l": [0.07896, -0.99596, 0.0448], "thigh-r": [-0.07896, -0.26796, 0.0056], "shin-r": [-0.07896, -0.64638, 0.0056], "foot-r": [-0.07896, -0.99596, 0.0448], "upper-arm-l": [0.1876, 0.4606, 0.014], "forearm-l": [0.2559, 0.12365, 0.014], "upper-arm-r": [-0.1876, 0.4606, 0.014], "forearm-r": [-0.2559, 0.12365, 0.014], "hand-l": [0.29494, -0.2001, 0.014], "hand-r": [-0.29494, -0.2001, 0.014], "neck": [0.0, 0.4606, 0.0056], "head": [0.0, 0.6986, 0.0056], "index-l-1": [0.27394, -0.23773, 0.0168], "index-l-2": [0.27746, -0.26692, 0.0168], "index-l-3": [0.27987, -0.28694, 0.0168], "index-r-1": [-0.27394, -0.23773, 0.0168], "index-r-2": [-0.27746, -0.26692, 0.0168], "index-r-3": [-0.27987, -0.28694, 0.0168], "little-l-1": [0.31454, -0.23773, 0.0168], "little-l-2": [0.31722, -0.25997, 0.0168], "little-l-3": [0.31917, -0.2761, 0.0168], "little-r-1": [-0.31454, -0.23773, 0.0168], "little-r-2": [-0.31722, -0.25997, 0.0168], "little-r-3": [-0.31917, -0.2761, 0.0168], "middle-l-1": [0.28794, -0.23773, 0.0168], "middle-l-2": [0.2918, -0.2697, 0.0168], "middle-l-3": [0.29448, -0.29194, 0.0168], "middle-r-1": [-0.28794, -0.23773, 0.0168], "middle-r-2": [-0.2918, -0.2697, 0.0168], "middle-r-3": [-0.29448, -0.29194, 0.0168], "ring-l-1": [0.30194, -0.23773, 0.0168], "ring-l-2": [0.30546, -0.26692, 0.0168], "ring-l-3": [0.30787, -0.28694, 0.0168], "ring-r-1": [-0.30194, -0.23773, 0.0168], "ring-r-2": [-0.30546, -0.26692, 0.0168], "ring-r-3": [-0.30787, -0.28694, 0.0168], "thumb-l-1": [0.26694, -0.20548, 0.0196], "thumb-l-2": [0.25182, -0.2185, 0.0259], "thumb-l-3": [0.24073, -0.22805, 0.03052], "thumb-r-1": [-0.26694, -0.20548, 0.0196], "thumb-r-2": [-0.25182, -0.2185, 0.0259], "thumb-r-3": [-0.24073, -0.22805, 0.03052]};
  const BONE_TIP: Record<string, number[]> = {"pelvis": [0.0, -0.175, 0.0], "abdomen": [0.0, 0.10136, 0.0028], "chest": [0.0, 0.4606, 0.0056], "clavicle-l": [0.1876, 0.4606, 0.014], "clavicle-r": [-0.1876, 0.4606, 0.014], "thigh-l": [0.07896, -0.64638, 0.0056], "shin-l": [0.07896, -0.99596, 0.0448], "foot-l": [0.07896, -1.04048, 0.04979], "thigh-r": [-0.07896, -0.64638, 0.0056], "shin-r": [-0.07896, -0.99596, 0.0448], "foot-r": [-0.07896, -1.04048, 0.04979], "upper-arm-l": [0.2559, 0.12365, 0.014], "forearm-l": [0.29494, -0.2001, 0.014], "upper-arm-r": [-0.2559, 0.12365, 0.014], "forearm-r": [-0.29494, -0.2001, 0.014], "hand-l": [0.28794, -0.23773, 0.0168], "hand-r": [-0.28794, -0.23773, 0.0168], "neck": [0.0, 0.6986, 0.0056], "head": [0.0, 1.0122, 0.0056], "index-l-1": [0.27746, -0.26692, 0.0168], "index-l-2": [0.27987, -0.28694, 0.0168], "index-l-3": [0.28148, -0.30028, 0.0168], "index-r-1": [-0.27746, -0.26692, 0.0168], "index-r-2": [-0.27987, -0.28694, 0.0168], "index-r-3": [-0.28148, -0.30028, 0.0168], "little-l-1": [0.31722, -0.25997, 0.0168], "little-l-2": [0.31917, -0.2761, 0.0168], "little-l-3": [0.32044, -0.28666, 0.0168], "little-r-1": [-0.31722, -0.25997, 0.0168], "little-r-2": [-0.31917, -0.2761, 0.0168], "little-r-3": [-0.32044, -0.28666, 0.0168], "middle-l-1": [0.2918, -0.2697, 0.0168], "middle-l-2": [0.29448, -0.29194, 0.0168], "middle-l-3": [0.29615, -0.30584, 0.0168], "middle-r-1": [-0.2918, -0.2697, 0.0168], "middle-r-2": [-0.29448, -0.29194, 0.0168], "middle-r-3": [-0.29615, -0.30584, 0.0168], "ring-l-1": [0.30546, -0.26692, 0.0168], "ring-l-2": [0.30787, -0.28694, 0.0168], "ring-l-3": [0.30942, -0.29972, 0.0168], "ring-r-1": [-0.30546, -0.26692, 0.0168], "ring-r-2": [-0.30787, -0.28694, 0.0168], "ring-r-3": [-0.30942, -0.29972, 0.0168], "thumb-l-1": [0.25182, -0.2185, 0.0259], "thumb-l-2": [0.24073, -0.22805, 0.03052], "thumb-l-3": [0.23264, -0.23501, 0.03389], "thumb-r-1": [-0.25182, -0.2185, 0.0259], "thumb-r-2": [-0.24073, -0.22805, 0.03052], "thumb-r-3": [-0.23264, -0.23501, 0.03389]};
  const BONE_ENVELOPE: Record<string, number> = {"pelvis": 0.150024, "abdomen": 0.142128, "chest": 0.213864, "clavicle-l": 0.09455, "clavicle-r": 0.09455, "thigh-l": 0.06384, "shin-l": 0.04704, "foot-l": 0.07392, "thigh-r": 0.06384, "shin-r": 0.04704, "foot-r": 0.07392, "upper-arm-l": 0.05376, "forearm-l": 0.04368, "upper-arm-r": 0.05376, "forearm-r": 0.04368, "hand-l": 0.03696, "hand-r": 0.03696, "neck": 0.0924, "head": 0.16464, "index-l-1": 0.009408, "index-l-2": 0.009408, "index-l-3": 0.009408, "index-r-1": 0.009408, "index-r-2": 0.009408, "index-r-3": 0.009408, "little-l-1": 0.008064, "little-l-2": 0.008064, "little-l-3": 0.008064, "little-r-1": 0.008064, "little-r-2": 0.008064, "little-r-3": 0.008064, "middle-l-1": 0.009744, "middle-l-2": 0.009744, "middle-l-3": 0.009744, "middle-r-1": 0.009744, "middle-r-2": 0.009744, "middle-r-3": 0.009744, "ring-l-1": 0.009072, "ring-l-2": 0.009072, "ring-l-3": 0.009072, "ring-r-1": 0.009072, "ring-r-2": 0.009072, "ring-r-3": 0.009072, "thumb-l-1": 0.010752, "thumb-l-2": 0.010752, "thumb-l-3": 0.010752, "thumb-r-1": 0.010752, "thumb-r-2": 0.010752, "thumb-r-3": 0.010752};
  const _closest = new THREE.Vector3();
  const distanceToSegment = (p: THREE.Vector3, s: number[], e: number[]): number => {
    const ab = [e[0] - s[0], e[1] - s[1], e[2] - s[2]];
    const ap = [p.x - s[0], p.y - s[1], p.z - s[2]];
    const abLenSq = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    const t = abLenSq > 1e-12
      ? THREE.MathUtils.clamp((ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / abLenSq, 0, 1)
      : 0;
    _closest.set(s[0] + ab[0] * t, s[1] + ab[1] * t, s[2] + ab[2] * t);
    return p.distanceTo(_closest);
  };
  const computeVertexWeights = (p: THREE.Vector3) => {
    const scored = boneOrder.map((id) => {
      const d = distanceToSegment(p, BONE_JOINT[id], BONE_TIP[id]);
      const u = d / BONE_ENVELOPE[id];
      const falloff = Math.max(0, 1 - u * u);
      return { id, d, w: falloff * falloff };
    });
    scored.sort((a, b) => b.w - a.w);
    const kept = scored.slice(0, 4);
    const total = kept.reduce((sum, c) => sum + c.w, 0);
    const indices = [0, 0, 0, 0];
    const weights = [0, 0, 0, 0];
    if (total > 0) {
      for (let slot = 0; slot < kept.length; slot++) {
        indices[slot] = boneIndexOf.get(kept[slot].id) ?? 0;
        weights[slot] = kept[slot].w / total;
      }
      return { indices, weights, fallback: false };
    }
    // Mandatory zero-sum fallback (PLAN_1.5 §4 / ADR-8). Without it three.js's own
    // normalizeSkinWeights() rewrites an all-zero vertex to (1,0,0,0) against bone 0
    // regardless of distance, which spikes stray vertices toward the hips. Instead:
    // ignore the envelope and pin weight 1.0 to the absolutely nearest bone.
    let nearest = boneOrder[0];
    let nearestDistance = Infinity;
    for (const id of boneOrder) {
      const d = distanceToSegment(p, BONE_JOINT[id], BONE_TIP[id]);
      if (d < nearestDistance) { nearestDistance = d; nearest = id; }
    }
    indices[0] = boneIndexOf.get(nearest) ?? 0;
    weights[0] = 1;
    return { indices, weights, fallback: true };
  };

  // ---- Bake to model space, weight, and bind.
  //
  // The arrangement below was chosen by measurement, not derivation, because the same
  // geometry can be skinned four plausible ways and three of them are wrong. With a
  // vertex authored at model-space (0, 2, 0) fully weighted to a bone at (0, 1, 0) and
  // that bone rotated +90 degrees about X (correct answer: (0, 1, 1)):
  //
  //   pivot transform kept, bind identity     -> rest pose already wrong, no deformation
  //   pivot transform kept, bind matrixWorld  -> (0, 1.5, 0.5): HALF the correct swing,
  //                                              because the pivot applies on top of skinning
  //   geometry baked, pivot bypassed          -> (0, 1, 1): correct
  //   no pivot at all                         -> (0, 1, 1): correct, and identical
  //
  // The last two agreeing is the finding: what matters is that the mesh's own world
  // transform is identity and its geometry lives in the skeleton's space. So each skinned
  // mesh gets its world matrix folded into its vertex data and is reparented to `root`
  // with an identity transform. Meshes are leaves -- components are added to their pivot
  // Group, never to another mesh -- so reparenting one moves nothing else.
  // Pivots back to REST for the bake: the geometry that lands in the buffer must be
  // the same rest pose the skeleton's inverse bind matrices cancel, not the pose.
  nodes["thigh-l"]?.rotation.set(0, 0, 0);
  nodes["shin-l"]?.rotation.set(0, 0, 0);
  nodes["foot-l"]?.rotation.set(0, 0, 0);
  nodes["thigh-r"]?.rotation.set(0, 0, 0);
  nodes["shin-r"]?.rotation.set(0, 0, 0);
  nodes["foot-r"]?.rotation.set(0, 0, 0);
  nodes["upper-arm-l"]?.rotation.set(0, 0, 0);
  nodes["forearm-l"]?.rotation.set(0, 0, 0);
  nodes["upper-arm-r"]?.rotation.set(0, 0, 0);
  nodes["forearm-r"]?.rotation.set(0, 0, 0);
  nodes["hand-l"]?.rotation.set(0, 0, 0);
  nodes["hand-r"]?.rotation.set(0, 0, 0);
  nodes["neck"]?.rotation.set(0, 0, 0);
  root.updateMatrixWorld(true);
  const skinnedMeshNames: string[] = [];
  let boundCount = 0;
  for (const boneId of boneOrder) {
    const mesh = meshes[boneId];
    if (!mesh) continue;
    const position = mesh.geometry.getAttribute('position');
    if (!position) continue;
    mesh.updateWorldMatrix(true, false);
    mesh.geometry.applyMatrix4(mesh.matrixWorld);
    root.add(mesh);
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    mesh.updateMatrixWorld(true);
    // Vertices are model-space now, which is the space the weight function measures in,
    // so no per-vertex matrix multiply is needed any more.
    const count = position.count;
    const skinIndices = new Uint16Array(count * 4);
    const skinWeights = new Float32Array(count * 4);
    const vertex = new THREE.Vector3();
    for (let v = 0; v < count; v++) {
      vertex.fromBufferAttribute(position, v);
      const { indices, weights } = computeVertexWeights(vertex);
      for (let slot = 0; slot < 4; slot++) {
        skinIndices[v * 4 + slot] = indices[slot];
        skinWeights[v * 4 + slot] = weights[slot];
      }
    }
    mesh.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    mesh.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
    skinnedMeshNames.push(boneId);
    const skinned = mesh as THREE.SkinnedMesh;
    if (!skinned.isSkinnedMesh) continue;
    // bindMode is left at its default (AttachedBindMode). The bones live under `root`
    // rather than under any one mesh because a single Skeleton is shared by every skinned
    // mesh and cannot be parented under all of them; with root and each mesh at identity
    // the bone world matrices are the same either way.
    skinned.bind(skeleton, new THREE.Matrix4());
    // A SkinnedMesh's boundingSphere is computed from its REST vertex data and is not
    // recomputed when bones move, so a posed limb that swings outside its rest bounds gets
    // culled and vanishes -- worse, it vanishes only from certain camera angles, which
    // reads as a geometry bug rather than a culling one. Disabling the test outright is
    // chosen over recomputing bounds every frame because these are small, always-onscreen
    // character parts where the test saves nothing. Recorded in userData.rig so a consumer
    // that DOES need culling knows it has to supply its own bounds.
    skinned.frustumCulled = false;
    boundCount += 1;
  }

  // Pose restored on the pivots. The skinned meshes no longer hang off them -- they
  // were reparented to `root` -- so this drives only the non-skinned descendants
  // (ear shells, eye cavities), which have no bone of their own and would otherwise
  // stay at rest while the head they sit on turns. The bones get the same rotations
  // applied separately, so nothing is posed twice.
  nodes["thigh-l"]?.rotation.set(0.03490658503988659, 0.0, 0.05235987755982989);
  nodes["shin-l"]?.rotation.set(0.06981317007977318, 0.0, 0.0);
  nodes["foot-l"]?.rotation.set(0.0, 0.0, -0.03490658503988659);
  nodes["thigh-r"]?.rotation.set(-0.03490658503988659, 0.0, -0.05235987755982989);
  nodes["shin-r"]?.rotation.set(0.05235987755982989, 0.0, 0.0);
  nodes["foot-r"]?.rotation.set(0.0, 0.0, 0.03490658503988659);
  nodes["upper-arm-l"]?.rotation.set(0.06981317007977318, 0.0, -0.12217304763960307);
  nodes["forearm-l"]?.rotation.set(0.13962634015954636, 0.0, 0.03490658503988659);
  nodes["upper-arm-r"]?.rotation.set(0.05235987755982989, 0.0, 0.10471975511965978);
  nodes["forearm-r"]?.rotation.set(0.12217304763960307, 0.0, -0.03490658503988659);
  nodes["hand-l"]?.rotation.set(0.03490658503988659, 0.0, 0.06981317007977318);
  nodes["hand-r"]?.rotation.set(0.03490658503988659, 0.0, -0.06981317007977318);
  nodes["neck"]?.rotation.set(0.0, 0.03490658503988659, 0.0);
  root.updateMatrixWorld(true);

  // The authored pose, moved from the pivots onto the bones (see _rig_pose_lines). Set
  // AFTER bind() so that the rest pose -- not this one -- is what the skeleton's inverse
  // bind matrices cancel.
  bone_thigh_l.rotation.set(0.03490658503988659, 0.0, 0.05235987755982989);
  bone_shin_l.rotation.set(0.06981317007977318, 0.0, 0.0);
  bone_foot_l.rotation.set(0.0, 0.0, -0.03490658503988659);
  bone_thigh_r.rotation.set(-0.03490658503988659, 0.0, -0.05235987755982989);
  bone_shin_r.rotation.set(0.05235987755982989, 0.0, 0.0);
  bone_foot_r.rotation.set(0.0, 0.0, 0.03490658503988659);
  bone_upper_arm_l.rotation.set(0.06981317007977318, 0.0, -0.12217304763960307);
  bone_forearm_l.rotation.set(0.13962634015954636, 0.0, 0.03490658503988659);
  bone_upper_arm_r.rotation.set(0.05235987755982989, 0.0, 0.10471975511965978);
  bone_forearm_r.rotation.set(0.12217304763960307, 0.0, -0.03490658503988659);
  bone_hand_l.rotation.set(0.03490658503988659, 0.0, 0.06981317007977318);
  bone_hand_r.rotation.set(0.03490658503988659, 0.0, -0.06981317007977318);
  bone_neck.rotation.set(0.0, 0.03490658503988659, 0.0);
  root.updateMatrixWorld(true);
  skeleton.update();
  root.userData.rig = { bones, skeleton, boneOrder, boneIndexOf, skinAttributes: skinnedMeshNames, bound: skinnedMeshNames.length > 0 && boundCount === skinnedMeshNames.length, frustumCulled: false, cullingNote: 'skinned meshes set frustumCulled = false; bone motion does not update a SkinnedMesh boundingSphere, so a consumer that needs culling must recompute bounds per frame' };

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createCartoonCourierExplorerLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Cartoon Courier Explorer look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"type": "key light", "direction": "camera-left and above", "intensity": 2.4, "softness": 0.72}, {"type": "fill light", "direction": "camera-right", "intensity": 1.05, "ratioToKey": 0.44}, {"type": "rim light", "direction": "rear-right and above", "intensity": 1.35, "purpose": "separate hair and jacket silhouette"}, {"type": "render intent", "exposure": 1.0, "toneMapping": "ACESFilmic", "background": "warm neutral", "contact shadow": "soft ground contact beneath both soles"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createCartoonCourierExplorerEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameCartoonCourierExplorerCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createCartoonCourierExplorerPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureCartoonCourierExplorerRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createCartoonCourierExplorerInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
