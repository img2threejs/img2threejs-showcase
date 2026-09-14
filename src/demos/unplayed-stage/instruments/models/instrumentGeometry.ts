import * as THREE from 'three';

export type XYPoint = readonly [number, number];

export function createProfileMesh(
  points: readonly XYPoint[],
  depth: number,
  material: THREE.Material,
  name: string,
  bevelSize = 0.008,
  smoothProfile = false,
  sideMaterial?: THREE.Material,
): THREE.Mesh<THREE.ExtrudeGeometry, THREE.Material | THREE.Material[]> {
  const profile: readonly XYPoint[] = smoothProfile && points.length > 3
    ? new THREE.CatmullRomCurve3(
      points.map(([x, y]) => new THREE.Vector3(x, y, 0)),
      true,
      'centripetal',
      0.5,
    ).getPoints(points.length * 4).map((point) => [point.x, point.y] as XYPoint)
    : points;
  const shape = new THREE.Shape();
  const [first, ...rest] = profile;
  if (!first) throw new Error(`Profile ${name} needs at least one point`);
  shape.moveTo(first[0], first[1]);
  for (const point of rest) shape.lineTo(point[0], point[1]);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevelSize > 0,
    bevelSegments: 3,
    bevelSize,
    bevelThickness: bevelSize,
    curveSegments: 8,
    steps: 1,
  });
  geometry.translate(0, 0, -depth / 2);
  // ExtrudeGeometry assigns front/back caps to group 0 and the perimeter to
  // group 1.  A quieter side material keeps procedural grain from wrapping
  // around the bevel as repeating horizontal bands while preserving the
  // authored finish on the visible cap.
  const mesh = new THREE.Mesh(
    geometry,
    sideMaterial ? [material, sideMaterial] : material,
  );
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function createRoundedBox(
  size: readonly [number, number, number],
  position: readonly [number, number, number],
  material: THREE.Material,
  name: string,
  bevelSize = 0.003,
): THREE.Mesh<THREE.ExtrudeGeometry, THREE.Material> {
  const [width, height, depth] = size;
  const points: XYPoint[] = [
    [-width / 2 + bevelSize, -height / 2],
    [width / 2 - bevelSize, -height / 2],
    [width / 2, -height / 2 + bevelSize],
    [width / 2, height / 2 - bevelSize],
    [width / 2 - bevelSize, height / 2],
    [-width / 2 + bevelSize, height / 2],
    [-width / 2, height / 2 - bevelSize],
    [-width / 2, -height / 2 + bevelSize],
  ];
  const mesh = createProfileMesh(points, depth, material, name, bevelSize) as
    THREE.Mesh<THREE.ExtrudeGeometry, THREE.Material>;
  mesh.position.set(position[0], position[1], position[2]);
  return mesh;
}

export function addCylinderBetween(
  parent: THREE.Object3D,
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  name: string,
  radialSegments = 10,
): THREE.Mesh<THREE.CylinderGeometry, THREE.Material> {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, radialSegments),
    material,
  );
  mesh.name = name;
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize(),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function createLathedKnob(
  material: THREE.Material,
  name: string,
  radius: number,
  height: number,
  ringMaterial?: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  const profile = [
    new THREE.Vector2(0, -height / 2),
    new THREE.Vector2(radius * 0.72, -height / 2),
    new THREE.Vector2(radius, -height * 0.3),
    new THREE.Vector2(radius * 0.96, height * 0.28),
    new THREE.Vector2(radius * 0.76, height / 2),
    new THREE.Vector2(0, height / 2),
  ];
  const body = new THREE.Mesh(
    new THREE.LatheGeometry(profile, 16),
    material,
  );
  // LatheGeometry's axis is Y. Rotate it so the control shaft points out of
  // the instrument's front (+Z), matching the other front-facing hardware.
  body.rotation.x = Math.PI / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);
  const rings = ringMaterial ?? material;
  for (const z of [-height * 0.3, height * 0.16]) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 0.8, Math.max(0.0008, radius * 0.055), 5, 16),
      rings,
    );
    ring.position.z = z;
    ring.castShadow = true;
    ring.receiveShadow = true;
    group.add(ring);
  }
  const indicator = new THREE.Mesh(
    new THREE.BoxGeometry(radius * 0.07, height * 0.35, height * 0.025),
    ringMaterial ?? material,
  );
  indicator.position.set(0, radius * 0.45, height * 0.51);
  indicator.castShadow = true;
  group.add(indicator);
  return group;
}

export function addFrontCylinder(
  parent: THREE.Object3D,
  radius: number,
  depth: number,
  position: readonly [number, number, number],
  material: THREE.Material,
  name: string,
  radialSegments = 12,
): THREE.Mesh<THREE.CylinderGeometry, THREE.Material> {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, depth, radialSegments),
    material,
  );
  mesh.name = name;
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(position[0], position[1], position[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function addBodyBinding(
  parent: THREE.Object3D,
  points: readonly XYPoint[],
  z: number,
  radius: number,
  material: THREE.Material,
  name: string,
): THREE.Mesh<THREE.TubeGeometry, THREE.Material> {
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, y]) => new THREE.Vector3(x, y, z)),
    true,
    'centripetal',
    0.5,
  );
  const mesh = new THREE.Mesh(
    new THREE.TubeGeometry(curve, Math.max(64, points.length * 8), radius, 5, true),
    material,
  );
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function addGrainLine(
  parent: THREE.Object3D,
  points: readonly THREE.Vector3[],
  material: THREE.Material,
  name: string,
): THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial> {
  const geometry = new THREE.BufferGeometry().setFromPoints(
    points.map((point) => point.clone()),
  );
  const line = new THREE.Line(geometry, material as THREE.LineBasicMaterial);
  line.name = name;
  parent.add(line);
  return line;
}

export function addFrontDot(
  parent: THREE.Object3D,
  position: readonly [number, number, number],
  radius: number,
  material: THREE.Material,
  name: string,
): THREE.Mesh<THREE.CylinderGeometry, THREE.Material> {
  return addFrontCylinder(parent, radius, 0.002, position, material, name, 16);
}

export function createTrianglePick(
  material: THREE.Material,
  name: string,
): THREE.Mesh<THREE.ShapeGeometry, THREE.Material> {
  const shape = new THREE.Shape();
  // Put the pointed contact vertex at the pivot origin.  The performance rig
  // rotates the pick around local Z, so the origin remains on the sampled
  // string centerline at the onset instead of sweeping the whole triangle
  // several millimetres away from it.
  shape.moveTo(-0.007, -0.028);
  shape.lineTo(0.007, -0.028);
  shape.lineTo(0, 0);
  shape.closePath();
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
