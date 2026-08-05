import * as THREE from 'three';

export interface ElectricMouseMascotRuntime {
  nodes: Record<string, THREE.Object3D>;
  parts: Record<string, THREE.Object3D>;
  getBellyTune: () => ElectricMouseBellyTune;
  setBellyTune: (next: Partial<ElectricMouseBellyTune>) => void;
  update: (elapsedSeconds: number) => void;
}

export interface ElectricMouseMascotOptions {
  includeSpeechBubble?: boolean;
}

export interface ElectricMouseBellyTune {
  /** Geometry crease offset from the fixed contact-shadow ring. Positive is upward. */
  creaseOffsetPx: number;
  /** Vertical width of the geometry crease in calibrated scene pixels. */
  creaseWidthPx: number;
  /** Radial X/Z pinch at the crease, normalized against the capsule radius. */
  creaseDepth: number;
  /** Additional X-only pinch so the side silhouette also caves in. */
  sidePinchDepth: number;
  /** Contact-shadow vertical width in calibrated scene pixels. */
  shadowWidthPx: number;
  /** Contact-shadow radial falloff in body-local units. */
  shadowZSpread: number;
  /** Contact-shadow multiplier. */
  shadowStrength: number;
}

export const DEFAULT_ELECTRIC_MOUSE_BELLY_TUNE: ElectricMouseBellyTune = {
  // Tuned through the dedicated Belly Tune panel against the supplied
  // reference. These values are shared by every factory instance and by the
  // panel's Reset action.
  creaseOffsetPx: 11,
  creaseWidthPx: 10.5,
  creaseDepth: 0.06,
  sidePinchDepth: 0.13,
  shadowWidthPx: 22,
  shadowZSpread: 0.70,
  shadowStrength: 0.5,
};

const YELLOW = 0xffca08;
const TEN_K_ROLL_LABELS = ['10K', '9.80K', '9.86K', '9.91K', '9.95K', '9.98K', '9.99K', '9,999', '10K'];

function physical(color: number, roughness: number, options: THREE.MeshPhysicalMaterialParameters = {}) {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness,
    metalness: 0,
    clearcoat: 0.12,
    clearcoatRoughness: 0.32,
    ...options,
  });
}

function makeCreaseShadowMaterial(
  baseMaterial: THREE.MeshPhysicalMaterial,
  creaseLocalY: number,
  shadowWidth: number,
  shadowZSpread = 0.85,
  shadowStrength = 0.36,
): THREE.MeshPhysicalMaterial {
  const material = baseMaterial.clone();
  const uniformState = {
    center: creaseLocalY,
    width: shadowWidth,
    zSpread: shadowZSpread,
    strength: shadowStrength,
    breath: 0,
  };
  material.onBeforeCompile = (shader) => {
    material.userData.shader = shader;
    shader.uniforms.uElectricMouseCreaseCenter = { value: uniformState.center };
    shader.uniforms.uElectricMouseCreaseWidth = { value: uniformState.width };
    shader.uniforms.uElectricMouseCreaseZSpread = { value: uniformState.zSpread };
    shader.uniforms.uElectricMouseCreaseStrength = { value: uniformState.strength };
    shader.uniforms.uElectricMouseBreath = { value: uniformState.breath };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vBodyLocalPosition;\nuniform float uElectricMouseBreath;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n'
          + 'float bellyBreathMask = 1.0 - smoothstep(-0.78, 0.15, transformed.y);\n'
          + 'transformed.xz *= 1.0 + uElectricMouseBreath * bellyBreathMask;\n'
          + 'transformed.y -= uElectricMouseBreath * 0.035 * bellyBreathMask;\n'
          + 'vBodyLocalPosition = transformed;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vBodyLocalPosition;\nuniform float uElectricMouseCreaseCenter;\nuniform float uElectricMouseCreaseWidth;\nuniform float uElectricMouseCreaseZSpread;\nuniform float uElectricMouseCreaseStrength;',
      )
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\nfloat creaseBand = exp(-0.5 * pow((vBodyLocalPosition.y - uElectricMouseCreaseCenter) / uElectricMouseCreaseWidth, 2.0));\nfloat radialXZ = length(vBodyLocalPosition.xz);\nfloat zBlur = exp(-0.5 * pow(radialXZ / uElectricMouseCreaseZSpread, 2.0));\nfloat creaseCore = smoothstep(0.24, 0.92, creaseBand);\nfloat creaseShadow = creaseBand * (0.58 + 0.42 * creaseCore) * (0.72 + 0.28 * zBlur);\ndiffuseColor.rgb *= (1.0 - uElectricMouseCreaseStrength * creaseShadow);',
      );
  };
  material.customProgramCacheKey = () => 'electric-mouse-body-crease-shadow-runtime-tunable';
  material.userData.electricMouseCreaseUniforms = uniformState;
  return material;
}

function updateCreaseShadowMaterial(
  material: THREE.MeshPhysicalMaterial,
  creaseLocalY: number,
  shadowWidth: number,
  shadowZSpread: number,
  shadowStrength: number,
): void {
  const state = material.userData.electricMouseCreaseUniforms as {
    center: number;
    width: number;
    zSpread: number;
    strength: number;
    breath: number;
  } | undefined;
  if (!state) return;
  state.center = creaseLocalY;
  state.width = shadowWidth;
  state.zSpread = shadowZSpread;
  state.strength = shadowStrength;
  const shader = material.userData.shader as { uniforms?: Record<string, { value: number }> } | undefined;
  if (!shader?.uniforms) return;
  shader.uniforms.uElectricMouseCreaseCenter.value = creaseLocalY;
  shader.uniforms.uElectricMouseCreaseWidth.value = shadowWidth;
  shader.uniforms.uElectricMouseCreaseZSpread.value = shadowZSpread;
  shader.uniforms.uElectricMouseCreaseStrength.value = shadowStrength;
}

function updateBreathMaterial(material: THREE.MeshPhysicalMaterial, amount: number): void {
  const state = material.userData.electricMouseCreaseUniforms as { breath?: number } | undefined;
  if (!state) return;
  state.breath = amount;
  const shader = material.userData.shader as { uniforms?: Record<string, { value: number }> } | undefined;
  if (shader?.uniforms?.uElectricMouseBreath) {
    shader.uniforms.uElectricMouseBreath.value = amount;
  }
}

function mesh(
  name: string,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const result = new THREE.Mesh(geometry, material);
  result.name = name;
  result.position.set(...position);
  result.castShadow = true;
  result.receiveShadow = true;
  return result;
}

function ellipsoid(
  name: string,
  radius: number,
  scale: [number, number, number],
  material: THREE.Material,
  position: [number, number, number],
  segments = 32,
): THREE.Mesh {
  const result = mesh(name, new THREE.SphereGeometry(radius, segments, Math.max(16, segments / 2)), material, position);
  result.scale.set(...scale);
  result.geometry.computeVertexNormals();
  return result;
}

function makeEarMaterial(baseMaterial: THREE.MeshPhysicalMaterial): THREE.MeshPhysicalMaterial {
  const earMaterial = baseMaterial.clone();
  const tipColor = new THREE.Color(0x090706).convertSRGBToLinear();
  const tipColorGlsl = `vec3(${tipColor.r.toFixed(6)}, ${tipColor.g.toFixed(6)}, ${tipColor.b.toFixed(6)})`;
  earMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vEarLocalY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEarLocalY = transformed.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vEarLocalY;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>\nif (vEarLocalY > 0.90) { diffuseColor.rgb = ${tipColorGlsl}; }`,
      );
  };
  earMaterial.customProgramCacheKey = () => 'electric-mouse-ear-two-tone-v1';
  return earMaterial;
}

function makeEar(name: string, material: THREE.MeshPhysicalMaterial): THREE.Group {
  const ear = new THREE.Group();
  ear.name = name;
  const earMaterial = makeEarMaterial(material);
  const earShape = new THREE.Shape();
  earShape.moveTo(-0.16, 0.02);
  // Long, softly elliptical sides: curved rather than straight segments, with
  // one shared pointed apex for the yellow volume and black material region.
  earShape.quadraticCurveTo(-0.19, 0.34, -0.165, 0.70);
  earShape.quadraticCurveTo(-0.145, 0.99, -0.038, 1.22);
  earShape.lineTo(0.012, 1.34);
  earShape.lineTo(0.060, 1.22);
  earShape.quadraticCurveTo(0.145, 0.98, 0.165, 0.70);
  earShape.quadraticCurveTo(0.19, 0.34, 0.10, 0.02);
  earShape.closePath();
  const body = mesh(`${name}_Body`, new THREE.ExtrudeGeometry(earShape, {
    depth: 0.16,
    bevelEnabled: true,
    bevelSegments: 2,
    bevelSize: 0.015,
    bevelThickness: 0.012,
  }), earMaterial, [0, 0, 0]);
  // One continuous ear volume. The shader paints the local-Y region above
  // the seam black on front, rear, and side faces without z-offsets.
  body.geometry.translate(0.02, 0, -0.08);
  ear.add(body);
  return ear;
}

function makeTailShape(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  // Four deliberate Z-shaped turns, followed by a broad 3/4-square terminal.
  // The outer end is flat and vertical; the root remains narrow so it can be
  // sunk into the rear rump without reading as a tail held by the arm.
  shape.moveTo(-0.66, -0.10);
  shape.lineTo(-0.16, -0.10);
  shape.lineTo(0.04, 0.02);
  shape.lineTo(0.04, 0.24);
  shape.lineTo(0.38, 0.24);
  shape.lineTo(0.54, 0.49);
  shape.lineTo(0.90, 0.66);
  shape.lineTo(1.42, 0.66);
  shape.lineTo(1.42, -0.02);
  shape.lineTo(0.96, -0.02);
  shape.lineTo(0.58, 0.14);
  shape.lineTo(0.44, 0.02);
  shape.lineTo(0.12, 0.02);
  shape.lineTo(0.02, -0.10);
  shape.lineTo(-0.60, -0.10);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.22,
    bevelEnabled: true,
    curveSegments: 8,
    bevelSegments: 4,
    bevelSize: 0.028,
    bevelThickness: 0.024,
  });
  geometry.center();
  geometry.computeVertexNormals();
  return geometry;
}

function makeTailMaterial(baseMaterial: THREE.MeshPhysicalMaterial): THREE.MeshPhysicalMaterial {
  const material = baseMaterial.clone();
  const rootBrown = new THREE.Color(0x8c3f16).convertSRGBToLinear();
  const rootBrownGlsl = `vec3(${rootBrown.r.toFixed(6)}, ${rootBrown.g.toFixed(6)}, ${rootBrown.b.toFixed(6)})`;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vTailLocalX;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTailLocalX = transformed.x;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vTailLocalX;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>\nif (vTailLocalX < -0.52) { diffuseColor.rgb = ${rootBrownGlsl}; }`,
      );
  };
  material.customProgramCacheKey = () => 'electric-mouse-tail-six-step-brown-root-v1';
  return material;
}

function makeCelebrationStar(): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  const outerRadius = 0.14;
  const innerRadius = 0.062;
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = Math.PI * 0.5 + (i * Math.PI) / 5;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

function drawTenKLabelText(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  label: string,
  y: number,
  finalLabel: boolean,
  alpha = 1,
): void {
  context.save();
  context.globalAlpha = alpha;
  context.shadowColor = finalLabel ? 'rgba(255, 194, 27, 0.95)' : 'rgba(255, 194, 27, 0.45)';
  context.shadowBlur = finalLabel ? 10 : 5;
  context.strokeStyle = '#ffd21f';
  context.lineWidth = finalLabel ? 5 : 3;
  context.fillStyle = '#241005';
  const fontSize = label.length >= 5 ? 46 : 64;
  context.font = `700 ${fontSize}px Arial, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.strokeText(label, canvas.width / 2, y);
  context.fillText(label, canvas.width / 2, y);
  context.restore();
}

function drawTenKLabel(canvas: HTMLCanvasElement, label: string, finalLabel: boolean): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to draw the 10k celebration label.');
  context.clearRect(0, 0, canvas.width, canvas.height);
  drawTenKLabelText(context, canvas, label, canvas.height / 2 + 2, finalLabel);
}

function drawRollingTenKLabel(
  canvas: HTMLCanvasElement,
  currentLabel: string,
  nextLabel: string,
  progress: number,
): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to draw the rolling 10k celebration label.');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.beginPath();
  context.rect(0, 0, canvas.width, canvas.height);
  context.clip();
  const travel = canvas.height * 0.92;
  const centerY = canvas.height / 2 + 2;
  drawTenKLabelText(context, canvas, currentLabel, centerY - progress * travel, currentLabel === '10K');
  drawTenKLabelText(context, canvas, nextLabel, centerY + (1 - progress) * travel, nextLabel === '10K');
  context.restore();
}

function makeTenKLabelTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 72;
  drawTenKLabel(canvas, '10K', true);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function makeSmileOpening(width: number, height: number): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  // A shallow downward-facing two-curve upper lip: anchor-like in rhythm,
  // with the center sitting slightly lower than the two outer corners.
  shape.moveTo(-halfWidth, halfHeight * 0.20);
  shape.quadraticCurveTo(-halfWidth * 0.40, halfHeight * 0.04, 0, halfHeight * 0.14);
  shape.quadraticCurveTo(halfWidth * 0.40, halfHeight * 0.04, halfWidth, halfHeight * 0.20);
  shape.quadraticCurveTo(halfWidth * 0.84, -halfHeight, 0, -halfHeight);
  shape.quadraticCurveTo(-halfWidth * 0.84, -halfHeight, -halfWidth, halfHeight * 0.20);
  shape.closePath();
  return new THREE.ShapeGeometry(shape, 32);
}

function makeMouthMatchedTongue(width: number, height: number): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  // Increase only the lower curvature by 0.02 world units; the upper round
  // arc remains unchanged.
  const lowerDepth = Math.max(0, halfHeight - 0.08);
  // Match Mouth_Outer's side anchor exactly; previously the tongue used 0,
  // creating the small visible curvature mismatch at both lower corners.
  const sideY = halfHeight * 0.20;
  const topPeakY = sideY + halfHeight * 0.66;
  // The tongue top stays as one smooth round arc.  Only its lower boundary
  // follows Mouth_Outer's lower curve; it must not inherit the two-segment
  // anchor-like upper lip profile.
  shape.moveTo(-halfWidth, sideY);
  shape.quadraticCurveTo(0, topPeakY, halfWidth, sideY);
  shape.quadraticCurveTo(halfWidth * 0.84, -lowerDepth, 0, -lowerDepth);
  shape.quadraticCurveTo(-halfWidth * 0.84, -lowerDepth, -halfWidth, sideY);
  shape.closePath();
  return new THREE.ShapeGeometry(shape, 32);
}

function makeSpeechBubblePointer(): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  // Author the polygon around its own center.  The 180-degree runtime turn
  // below therefore changes only the sharp-tip direction, not its position.
  // After rotation the tip points down-right, outside the disc.
  // These coordinates are authored opposite to the final direction because
  // the mesh is rotated 180 degrees below. After rotation, the wide base is
  // inside the disc and the sharp point aims right toward Pikachu.
  shape.moveTo(0.08, -0.06);
  shape.quadraticCurveTo(0.02, -0.01, 0.08, 0.06);
  shape.lineTo(-0.20, 0.04);
  shape.quadraticCurveTo(-0.08, -0.01, 0.08, -0.06);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, {
    depth: 0.05,
    bevelEnabled: true,
    bevelSegments: 2,
    bevelSize: 0.008,
    bevelThickness: 0.006,
  });
}

const BODY_CAPSULE_RADIUS = 0.86;
const BODY_CAPSULE_LENGTH = 0.594;
// Increase Body_Head_Main height by 10% while shifting its center upward so
// the lower contact point remains planted on the same ground level.
const BODY_WORLD_SCALE_Y = 0.935;
const BODY_WORLD_CENTER_Y = 1.279 + (BODY_WORLD_SCALE_Y - 0.85) *
  (BODY_CAPSULE_RADIUS + BODY_CAPSULE_LENGTH * 0.5);
const MOUTH_OUTER_WORLD_Y = 1.70;
// In this validation camera, 1 px is approximately 0.006 world units.
// Lower the ring another 20 px: 70 px below Mouth_Outer.
const BODY_FACE_RING_WORLD_Y = MOUTH_OUTER_WORLD_Y - 70 * 0.006;
// The reference has one soft body transition under the face. Keep the
// geometric pinch and the contact-shadow shader centered on that same ring;
// they remain separate mechanisms, but must not create two visible lines.
const BODY_INDENTATION_WORLD_Y = BODY_FACE_RING_WORLD_Y;
const BODY_LOCAL_BOTTOM_Y = -BODY_CAPSULE_RADIUS - BODY_CAPSULE_LENGTH * 0.5;
const BODY_WORLD_BOTTOM_Y = BODY_WORLD_CENTER_Y + BODY_WORLD_SCALE_Y * BODY_LOCAL_BOTTOM_Y;
const BODY_WORLD_HEIGHT = BODY_WORLD_SCALE_Y * (BODY_CAPSULE_RADIUS * 2 + BODY_CAPSULE_LENGTH);
const BODY_FACE_RING_FRACTION = (BODY_FACE_RING_WORLD_Y - BODY_WORLD_BOTTOM_Y) / BODY_WORLD_HEIGHT;

function getBodyFaceRingLocalY(): number {
  const localBottom = -BODY_CAPSULE_RADIUS - BODY_CAPSULE_LENGTH * 0.5;
  const localHeight = BODY_CAPSULE_RADIUS * 2 + BODY_CAPSULE_LENGTH;
  return localBottom + localHeight * BODY_FACE_RING_FRACTION;
}

function getBodyIndentationLocalY(tune: ElectricMouseBellyTune): number {
  // Convert the reference body-ring world-space landmark into local Y. The
  // flank accents remain separate scene parts and are not used as anchors.
  const worldY = BODY_INDENTATION_WORLD_Y + tune.creaseOffsetPx * 0.006;
  return (worldY - BODY_WORLD_CENTER_Y) / BODY_WORLD_SCALE_Y;
}

function makeBodyHeadGeometry(tune: ElectricMouseBellyTune): THREE.CapsuleGeometry {
  // Extend the current capsule length by another 10%; width and depth stay
  // unchanged so the mascot remains plump rather than becoming thin.
  const geometry = new THREE.CapsuleGeometry(BODY_CAPSULE_RADIUS, BODY_CAPSULE_LENGTH, 20, 48);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;

  // The reference has one soft horizontal compression where the rounded head
  // transitions into the belly.  Sculpt it into the same continuous capsule
  // instead of adding a separate ring or decal that could look detached.
  // Place the circular face boundary at exactly 4/6 of the capsule's height,
  // measured from the grounded lower pole. The radial compression affects X
  // and Z together, so it forms one continuous ring around the body.
  // A small real waist indentation, centered exactly on the shadow line.
  // The geometry supplies the inward body profile; the shader supplies only
  // the soft contact shading around that same center.
  const creaseLocalY = getBodyIndentationLocalY(tune);
  // Shape the one continuous capsule as three soft zones: a slightly oval
  // head, a shallow neck pinch, and a visibly broader chibi belly.
  // A shallow, rounded geometric neck groove: narrow enough to separate the
  // head and torso, but not sharp enough to look like a hard plastic cut.
  // One shallow Gaussian ring is enough for the reference's soft crease.
  const creaseWidth = (tune.creaseWidthPx * 0.006) / BODY_WORLD_SCALE_Y;
  // Slightly deepen the symmetric radial pinch so the left and right front
  // silhouette both show a visible, rounded indentation.
  // A literal 10x increase would invert the radial shell. Cap the requested
  // extreme depth just before inversion so the body remains a valid mesh.
  // Keep the body surface continuous; the reference's single visible line is
  // carried by the narrow contact-shadow shader rather than stacked geometry.
  const creaseDepth = tune.creaseDepth;
  // Add an explicit side pinch on X so the left/right silhouette visibly
  // caves inward at the waist instead of reading as only a front shadow.
  const sidePinchDepth = tune.sidePinchDepth;
  // Keep the lower-belly transition anchored to the original shadow ring.
  // Only the geometric indentation moves to the upper-flank landmark.
  const bellyRingLocalY = getBodyFaceRingLocalY();
  const smoothstep = (edge0: number, edge1: number, value: number): number => {
    const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  for (let i = 0; i < position.count; i += 1) {
    const y = position.getY(i);
    const creaseBand = Math.exp(-0.5 * ((y - creaseLocalY) / creaseWidth) ** 2);
    // Apply the groove by radial distance from the Y axis. This is explicitly
    // azimuth-independent: every vertex around the full 360-degree body ring
    // receives the same inward movement, including front, back, and both sides.
    const x = position.getX(i);
    const z = position.getZ(i);
    const radialDistance = Math.hypot(x, z);
    const belowRing = smoothstep(0, 0.34, bellyRingLocalY - y);
    // Keep the belly almost the same width as the head; it is only slightly
    // fuller, never a flared jar or bell silhouette.
    // Add a small, broad lower-belly bulge: soft and marshmallow-like, never
    // large enough to flare into a jar silhouette.
    // Keep the torso nearly straight below the shadow ring. Only the lowest
    // quarter receives a restrained outward curve, creating the reference's
    // soft elliptical lower belly without pinching the whole abdomen.
    // Restore most of the lower torso width immediately after the small
    // rounded crease, then add only a restrained hanging curve at the base.
    const lowerBodyRestore = 0.000;
    const bottomRound = smoothstep(0.28, 1.05, -y);
    const bellyBulge = 0.400 * belowRing * bottomRound;
    // A continuous Gaussian head volume keeps the upper form round without a
    // hard start edge that could read as a second horizontal body line.
    const headBulge = 0.20 * Math.exp(-0.5 * ((y - 0.62) / 0.60) ** 2);
    const radialScale = 1 - creaseDepth * creaseBand + lowerBodyRestore + bellyBulge + headBulge;
    const sidePinch = 1 - sidePinchDepth * creaseBand;
    if (radialDistance > 1e-6) {
      position.setXYZ(i, x * radialScale * sidePinch, y, z * radialScale);
    }
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function makeLightningBoltGeometry(
  path: Array<[number, number]>,
  width: number,
): THREE.BufferGeometry {
  const points = path.map(([x, y]) => new THREE.Vector3(x, y, 0));
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const lastIndex = points.length - 1;
  for (let i = 0; i < points.length; i += 1) {
    const previous = points[Math.max(0, i - 1)];
    const current = points[i];
    const next = points[Math.min(lastIndex, i + 1)];
    const incoming = current.clone().sub(previous).normalize();
    const outgoing = next.clone().sub(current).normalize();
    const tangent = incoming.clone().add(outgoing);
    if (tangent.lengthSq() < 1e-6) tangent.copy(incoming);
    tangent.normalize();
    const normal = new THREE.Vector3(-tangent.y, tangent.x, 0);
    // The first and last vertices collapse to a point, creating the two
    // pointed ends. The middle remains broad and graphic rather than tubular.
    const taper = i === 0 || i === lastIndex ? 0 : 1;
    const halfWidth = width * 0.5 * taper;
    const left = current.clone().addScaledVector(normal, halfWidth);
    const right = current.clone().addScaledVector(normal, -halfWidth);
    positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
    const u = i / lastIndex;
    uvs.push(u, 0, u, 1);
    if (i < lastIndex) {
      const vertex = i * 2;
      indices.push(vertex, vertex + 1, vertex + 2, vertex + 1, vertex + 3, vertex + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function makeLightningGlowMaterial(): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uGlowColor: { value: new THREE.Color(0xd98700) },
      uInnerGlowColor: { value: new THREE.Color(0xffd45a) },
      uHighlightColor: { value: new THREE.Color(0xffffd6) },
    },
    vertexShader: `
      varying vec2 vLightningUv;
      void main() {
        vLightningUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vLightningUv;
      uniform float uTime;
      uniform float uIntensity;
      uniform vec3 uGlowColor;
      uniform vec3 uInnerGlowColor;
      uniform vec3 uHighlightColor;
      void main() {
        float radial = max(sin(vLightningUv.y * 3.14159265), 0.0);
        float core = pow(radial, 5.5);
        float halo = pow(radial, 1.05);
        float endTaper = smoothstep(0.0, 0.10, vLightningUv.x)
          * (1.0 - smoothstep(0.90, 1.0, vLightningUv.x));
        float travelingLight = 0.84 + 0.16 * sin(vLightningUv.x * 20.0 - uTime * 14.0);
        // A soft yellow-white band travels along the bolt and wraps subtly
        // across its width. The cyclic distance keeps the sweep seamless at
        // the UV 0/1 boundary instead of popping at the endpoint.
        float sweepCenter = fract(uTime * 0.42);
        float sweepDistance = abs(vLightningUv.x - sweepCenter);
        sweepDistance = min(sweepDistance, 1.0 - sweepDistance);
        float sweepAlong = exp(-pow(sweepDistance / 0.085, 2.0));
        float sweepAcross = pow(radial, 0.72);
        float orbit = 0.5 + 0.5 * sin(vLightningUv.y * 6.2831853 + uTime * 8.0);
        float movingHighlight = (sweepAlong * sweepAcross + orbit * 0.16 * halo) * endTaper;
        float alpha = uIntensity * (0.88 * halo * endTaper * travelingLight + movingHighlight * 0.34);
        vec3 color = mix(uGlowColor, uInnerGlowColor, core);
        color = mix(color, uHighlightColor, clamp(movingHighlight * 0.92, 0.0, 1.0));
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  material.toneMapped = false;
  return material;
}

function updateLightningGroup(
  group: THREE.Object3D,
  energy: number,
  time: number,
  baseScale: number,
  energyScale: number,
  rotation: number,
): void {
  group.visible = energy > 0.008;
  group.scale.setScalar(baseScale + energy * energyScale);
  group.rotation.z = rotation;
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || Array.isArray(child.material)) return;
    const material = child.material;
    const index = Number(child.userData.lightningBoltIndex ?? 0);
    const flicker = 0.82 + 0.18 * Math.abs(Math.sin(time * (7.0 + index * 0.7) + index));
    if (material instanceof THREE.ShaderMaterial) {
      const uniforms = material.uniforms;
      uniforms.uTime.value = time;
      uniforms.uIntensity.value = energy * flicker;
    } else {
      material.opacity = energy * flicker;
    }
  });
}

function makeTeardropHandGeometry(): THREE.SphereGeometry {
  // Start with the same closed SphereGeometry construction as the feet, then
  // make only the upper half narrower so the solid remains rounded and sealed.
  const radius = 0.17;
  const geometry = new THREE.SphereGeometry(radius, 28, 16);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) {
    const normalizedY = THREE.MathUtils.clamp(
      (position.getY(i) + radius) / (radius * 2),
      0,
      1,
    );
    const lowerBulbScale = 1 - 0.26 * normalizedY;
    position.setX(i, position.getX(i) * lowerBulbScale);
    position.setZ(i, position.getZ(i) * lowerBulbScale);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

// Approximate the visible front of Body_Head_Main after its authored scale.
// Face landmarks use this surface instead of a shared arbitrary Z plane.
const BODY_FACE_CENTER_Y = BODY_WORLD_CENTER_Y + 0.061;
const BODY_FACE_HEAD_SCALE = 1.09;
const BODY_FACE_RX = 0.86 * 0.81 * BODY_FACE_HEAD_SCALE;
const BODY_FACE_RY = 1.085 * BODY_WORLD_SCALE_Y;
const BODY_FACE_RZ = 0.86 * 0.70 * BODY_FACE_HEAD_SCALE;

function frontSurfaceZ(x: number, y: number): number {
  const nx = x / BODY_FACE_RX;
  const ny = (y - BODY_FACE_CENTER_Y) / BODY_FACE_RY;
  const remaining = Math.max(0.04, 1 - nx * nx - ny * ny);
  return BODY_FACE_RZ * Math.sqrt(remaining);
}

function conformFaceGeometry(
  geometry: THREE.BufferGeometry,
  centerX: number,
  centerY: number,
  offset = 0.004,
): THREE.BufferGeometry {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) {
    const worldX = centerX + position.getX(i);
    const worldY = centerY + position.getY(i);
    position.setX(i, worldX);
    position.setY(i, worldY);
    position.setZ(i, frontSurfaceZ(worldX, worldY) + offset);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

const SPEECH_BUBBLE_RX = 0.29;
const SPEECH_BUBBLE_RY = 0.29;
const SPEECH_BUBBLE_RZ = 0.29 * 0.28;

function conformBubbleDiscGeometry(
  geometry: THREE.BufferGeometry,
  centerY: number,
  offset = 0.006,
): THREE.BufferGeometry {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = centerY + position.getY(i);
    const nx = x / SPEECH_BUBBLE_RX;
    const ny = y / SPEECH_BUBBLE_RY;
    const remaining = Math.max(0.04, 1 - nx * nx - ny * ny);
    const z = SPEECH_BUBBLE_RZ * Math.sqrt(remaining);
    const normal = new THREE.Vector3(
      x / (SPEECH_BUBBLE_RX * SPEECH_BUBBLE_RX),
      y / (SPEECH_BUBBLE_RY * SPEECH_BUBBLE_RY),
      z / (SPEECH_BUBBLE_RZ * SPEECH_BUBBLE_RZ),
    ).normalize();
    position.setXYZ(i, x + normal.x * offset, y + normal.y * offset, z + normal.z * offset);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function conformSidePatchGeometry(
  geometry: THREE.BufferGeometry,
  centerX: number,
  centerY: number,
  offset = 0.015,
): THREE.BufferGeometry {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) {
    // Use the same authored X/Y decal shape for both flank marks, then solve
    // Z against the capsule surface per vertex. This preserves the Upper
    // oval's silhouette at Lower instead of squashing it in a changing tangent
    // frame at the lower flank.
    const pointX = THREE.MathUtils.clamp(
      centerX + position.getX(i),
      -BODY_FACE_RX * 0.98,
      BODY_FACE_RX * 0.98,
    );
    const pointY = centerY + position.getY(i);
    const pointZ = frontSurfaceZ(pointX, pointY);
    const surfaceNormal = new THREE.Vector3(
      pointX / (BODY_FACE_RX * BODY_FACE_RX),
      (pointY - BODY_FACE_CENTER_Y) / (BODY_FACE_RY * BODY_FACE_RY),
      pointZ / (BODY_FACE_RZ * BODY_FACE_RZ),
    ).normalize();
    const point = new THREE.Vector3(pointX, pointY, pointZ)
      .addScaledVector(surfaceNormal, offset);
    position.setXYZ(i, point.x, point.y, point.z);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

const FLANK_PATCH_RADIUS = 0.12;
// Tall rounded ellipses matching the reference flank marks; CircleGeometry
// keeps both ends fully rounded instead of creating pointed caps.
const FLANK_PATCH_SCALE_X = 0.90;
const FLANK_PATCH_SCALE_Y = 0.65;
const FLANK_PATCH_HEIGHT = FLANK_PATCH_RADIUS * 2 * FLANK_PATCH_SCALE_Y;
const FLANK_PATCH_CENTER_SPACING = FLANK_PATCH_HEIGHT * 1.5;
const FLANK_PATCH_UPPER_CENTER_Y = 1.12 * 1.20;

function makeFlankPatchGeometry(): THREE.CircleGeometry {
  const geometry = new THREE.CircleGeometry(FLANK_PATCH_RADIUS, 32);
  geometry.scale(FLANK_PATCH_SCALE_X, FLANK_PATCH_SCALE_Y, 1);
  return geometry;
}

export function createElectricMouseMascotModel(options: ElectricMouseMascotOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'Character_Root';

  const nodes: Record<string, THREE.Object3D> = { Character_Root: root };
  const parts: Record<string, THREE.Object3D> = {};
  let bellyTune: ElectricMouseBellyTune = { ...DEFAULT_ELECTRIC_MOUSE_BELLY_TUNE };
  const yellow = physical(YELLOW, 0.34, { specularIntensity: 0.55 });
  const tailGolden = physical(0xf2b308, 0.30, { specularIntensity: 0.50 });
  const dark = physical(0x241005, 0.42);
  // Face details are graphic, flush-mounted pads in the reference.  Basic
  // materials avoid a separate specular highlight that makes them look like
  // floating marbles on the yellow shell.
  const eyeBlack = physical(0x070504, 0.18, {
    clearcoat: 0.65,
    clearcoatRoughness: 0.08,
    specularIntensity: 1,
  });
  const eyeHighlight = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const cheek = new THREE.MeshBasicMaterial({ color: 0xe83b32 });
  const mouth = new THREE.MeshBasicMaterial({ color: 0x180604 });
  const tongue = new THREE.MeshBasicMaterial({ color: 0xd83b36 });
  const speechBubbleMilk = physical(0xfff6efe0, 0.32, {
    specularIntensity: 0.38,
    clearcoat: 0.06,
    clearcoatRoughness: 0.40,
  });

  const register = (object: THREE.Object3D, key = object.name): THREE.Object3D => {
    if (!object.name && key) object.name = key;
    nodes[key] = object;
    parts[key] = object;
    return object;
  };

  const bodyCreaseLocalY = getBodyFaceRingLocalY();
  // Reference-matched narrow contact crease: a short line under the face,
  // with restrained Z falloff rather than a broad dark belt.
  const bodyMaterial = makeCreaseShadowMaterial(
    yellow,
    bodyCreaseLocalY,
    (bellyTune.shadowWidthPx * 0.006) / BODY_WORLD_SCALE_Y,
    bellyTune.shadowZSpread,
    bellyTune.shadowStrength,
  );
  const body = register(mesh(
    'Body_Head_Main',
    makeBodyHeadGeometry(bellyTune),
    bodyMaterial,
    // Shift the center down by half the added scaled length, keeping the head
    // apex stable while the new length is added toward the lower belly.
    [0, BODY_WORLD_CENTER_Y, 0],
  )) as THREE.Mesh;
  // The head and belly share the same full rounded mass, separated only by a
  // small sculpted transition under the mouth.
  // Reduce only the horizontal width by 10%; preserve height and depth.
  body.scale.set(0.81, BODY_WORLD_SCALE_Y, 0.70);
  root.add(body);

  const setBellyTune = (next: Partial<ElectricMouseBellyTune>): void => {
    const nextTune = { ...bellyTune, ...next };
    const geometryChanged =
      nextTune.creaseOffsetPx !== bellyTune.creaseOffsetPx ||
      nextTune.creaseWidthPx !== bellyTune.creaseWidthPx ||
      nextTune.creaseDepth !== bellyTune.creaseDepth ||
      nextTune.sidePinchDepth !== bellyTune.sidePinchDepth;
    const shadowChanged =
      nextTune.shadowWidthPx !== bellyTune.shadowWidthPx ||
      nextTune.shadowZSpread !== bellyTune.shadowZSpread ||
      nextTune.shadowStrength !== bellyTune.shadowStrength;

    if (!geometryChanged && !shadowChanged) return;
    bellyTune = nextTune;

    // Slider changes to the shader do not need a new mesh. Rebuild only when
    // one of the four geometry parameters changes, keeping panel interaction
    // inexpensive while preserving the live preview.
    if (geometryChanged) {
      const previousGeometry = body.geometry;
      body.geometry = makeBodyHeadGeometry(bellyTune);
      previousGeometry.dispose();
    }
    if (shadowChanged) {
      updateCreaseShadowMaterial(
        bodyMaterial,
        bodyCreaseLocalY,
        (bellyTune.shadowWidthPx * 0.006) / BODY_WORLD_SCALE_Y,
        bellyTune.shadowZSpread,
        bellyTune.shadowStrength,
      );
    }
  };

  const earL = register(makeEar('Ear_L', yellow));
  // Sink both ears 0.03 world units (~5 px) into the head to hide the joint.
  earL.position.set(-0.45, 2.03, -0.015);
  earL.scale.y = 0.90;
  earL.rotation.z = 0.28;
  root.add(earL);
  const earR = register(makeEar('Ear_R', yellow));
  earR.position.set(0.45, 2.03, -0.015);
  earR.scale.y = 0.90;
  earR.rotation.z = -0.28;
  root.add(earR);

  // These are surface-conformed discs, not small spheres.  The extra surface
  // offset is intentional: the validation camera is a mild 3/4 view, so a
  // mathematically exact +Z projection would be hidden by the capsule's
  // near-side shoulder.  It still follows the shell at every vertex and has
  // no cast shadow, so it reads as a contact-mounted graphic detail.
  const eyeL = register(mesh(
    'Eye_L', conformFaceGeometry(new THREE.CircleGeometry(0.070, 32), -0.42, 1.90, 0.018), eyeBlack,
  ));
  const eyeR = register(mesh(
    'Eye_R', conformFaceGeometry(new THREE.CircleGeometry(0.070, 32), 0.42, 1.90, 0.018), eyeBlack,
  ));
  const eyeHighlightL = register(mesh(
    'EyeHighlight_L', conformFaceGeometry(new THREE.CircleGeometry(0.016, 20), -0.442, 1.924, 0.030), eyeHighlight,
  ));
  const eyeHighlightR = register(mesh(
    'EyeHighlight_R', conformFaceGeometry(new THREE.CircleGeometry(0.016, 20), 0.398, 1.924, 0.030), eyeHighlight,
  ));
  root.add(eyeL, eyeR, eyeHighlightL, eyeHighlightR);
  const noseDepth = 0.026 * 0.42;
  const nose = register(ellipsoid(
    'Nose', 0.026, [1.0, 1.0, 0.42], dark,
    [0, 1.88, frontSurfaceZ(0, 1.88) + noseDepth + 0.018], 16,
  ));
  root.add(nose);

  // A flat, rounded smile silhouette follows the face instead of projecting as a muzzle.
  const mouthOuterGeometry = conformFaceGeometry(makeSmileOpening(0.70, 0.48), 0, 1.70, 0.016);
  const mouthInnerGeometry = conformFaceGeometry(makeSmileOpening(0.59, 0.35), 0, 1.67, 0.022);
  const mouthOuter = register(mesh('Mouth_Outer', mouthOuterGeometry, mouth, [0, 0, 0]));
  const mouthInner = register(mesh('Mouth_Inner', mouthInnerGeometry, dark, [0, 0, 0]));
  // Match Mouth_Outer's face anchor and use a deeper lower arc.  The local
  // downward shift keeps the red tongue on the lower lip while the geometry
  // still shares Mouth_Outer's curved capsule surface and depth offset.
  // 90% of the previous tongue footprint, keeping the same mouth-matched
  // curvature while leaving more black cavity visible around it.
  const tongueGeometryBase = makeMouthMatchedTongue(0.5112, 0.306);
  // Three.js positions are world units, not pixels.  Keep the current
  // Lower the validated placement by another ~0.5 px.
  tongueGeometryBase.translate(0, -0.159, 0);
  const tongueGeometry = conformFaceGeometry(tongueGeometryBase, 0, 1.70, 0.016);
  const tonguePart = register(mesh('Tongue', tongueGeometry, tongue, [0, 0, 0]));
  root.add(mouthOuter, mouthInner, tonguePart);

  // Embed the round cheek discs into the capsule surface so they read as attached facial pads.
  const cheekL = register(mesh(
    'Cheek_L', conformFaceGeometry(new THREE.CircleGeometry(0.150, 32), -0.59, 1.64, 0.020), cheek,
  ));
  const cheekR = register(mesh(
    'Cheek_R', conformFaceGeometry(new THREE.CircleGeometry(0.150, 32), 0.59, 1.64, 0.020), cheek,
  ));
  root.add(cheekL, cheekR);

  // Face details are flush-mounted decals/pads, not shadow-casting floating
  // props.  Their silhouettes remain visible while their own cast shadows do
  // not create a dark gap from the yellow shell.
  for (const facePart of [eyeL, eyeR, eyeHighlightL, eyeHighlightR, nose, mouthOuter, mouthInner, tonguePart, cheekL, cheekR]) {
    facePart.castShadow = false;
    facePart.receiveShadow = false;
    facePart.renderOrder = 3;
    if (facePart instanceof THREE.Mesh && !Array.isArray(facePart.material)) {
      // The vertices already lie on the body shell.  Disable depth testing so
      // the near-side shoulder cannot clip a contact decal in the 3/4 view.
      facePart.material.depthTest = false;
      facePart.material.depthWrite = false;
    }
  }
  tonguePart.renderOrder = 4;
  eyeHighlightL.renderOrder = 4;
  eyeHighlightR.renderOrder = 4;

  // Small top, larger rounded lower bulb: the two teardrops angle inward while
  // sharing the feet's physical yellow material and shadow response.
  const armL = register(mesh('Arm_L', makeTeardropHandGeometry(), yellow, [-0.27, 0.90, 0.60]));
  const armR = register(mesh('Arm_R', makeTeardropHandGeometry(), yellow, [0.27, 0.90, 0.60]));
  armL.rotation.z = 0.24;
  armR.rotation.z = -0.24;
  // Reuse the feet's ellipsoid proportions; the smaller base radius is the
  // only size difference.
  armL.scale.set(0.82, 1.10, 0.82);
  armR.scale.set(0.82, 1.10, 0.82);
  root.add(armL, armR);

  // Raise and slightly enlarge the feet so their upper surfaces overlap the
  // lower body shell instead of floating below it.
  const footL = register(ellipsoid('Foot_L', 0.23, [1.36, 0.68, 1.05], yellow, [-0.35, 0.36, 0.18], 28));
  const footR = register(ellipsoid('Foot_R', 0.23, [1.36, 0.68, 1.05], yellow, [0.35, 0.36, 0.18], 28));
  // Turn both feet 90 degrees so their long axis faces toward the viewer.
  footL.rotation.y = -Math.PI * 0.5 - THREE.MathUtils.degToRad(15);
  footR.rotation.y = Math.PI * 0.5 + THREE.MathUtils.degToRad(15);
  footL.castShadow = true;
  footR.castShadow = true;
  footL.receiveShadow = true;
  footR.receiveShadow = true;
  root.add(footL, footR);

  const tailPivot = register(new THREE.Group(), 'Tail_Pivot');
  // The tail originates behind the rump, not on the visible side of the torso.
  // Camera/front is +Z, so -Z places the root behind the body while the bolt still
  // projects to the character's right in X.
  // Sink the tail root into the rear-lower rump so no gap is visible at the
  // attachment.  It remains behind the body on -Z while the bolt projects
  // toward viewer-right.
  // Sink the root into the rear-lower rump.  The previous -Z offset left a
  // visible gap in the rear camera, so the attachment now overlaps the shell.
  // Keep the tail anatomically independent from both arms and place its root
  // inside the lower rear rump: +X is the character's right, -Z is the back.
  tailPivot.position.set(0.40, 0.68, -0.82);
  root.add(tailPivot);
  const tail = register(mesh('Tail_Main', makeTailShape(), makeTailMaterial(tailGolden), [0.44, 0.55, 0.04]));
  // Slim the lightning silhouette so it reads as a compact tail rather than
  // a large block beside the arm.
  tail.scale.set(0.90, 0.72, 1);
  // Lift the whole zig-zag from its embedded root by 32 degrees so the broad
  // terminal blade rises dynamically instead of lying flat beside the body.
  tail.rotation.z = THREE.MathUtils.degToRad(18);
  tailPivot.add(tail);

  // Celebration lightning belongs to the tail, not the speech bubble.  It is
  // intentionally a child of Tail_Main so the flash follows the tail's rear
  // attachment and never reads as a detached decoration around the bubble.
  const tailLightningBurst = register(new THREE.Group(), 'Star_Lightning_Burst');
  const lightningPaths: Array<Array<[number, number]>> = [
    [[-0.02, 0.20], [-0.07, 0.25], [-0.03, 0.27], [-0.10, 0.34]],
    [[0.10, 0.16], [0.16, 0.21], [0.13, 0.24], [0.22, 0.29]],
    [[-0.14, 0.03], [-0.22, 0.04], [-0.18, 0.08], [-0.29, 0.10]],
    [[0.14, 0.01], [0.22, -0.01], [0.18, -0.05], [0.29, -0.07]],
  ];
  for (let i = 0; i < lightningPaths.length; i += 1) {
    const boltMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd52a,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    });
    const bolt = register(mesh(
      `Star_Lightning_Bolt_${i + 1}`,
      makeLightningBoltGeometry(lightningPaths[i], 0.055),
      boltMaterial,
    ));
    bolt.userData.lightningBoltIndex = i;
    bolt.renderOrder = 8;
    const glow = mesh(
      `Star_Lightning_Glow_${i + 1}`,
      makeLightningBoltGeometry(lightningPaths[i], 0.082),
      makeLightningGlowMaterial(),
    );
    glow.userData.lightningBoltIndex = i;
    glow.renderOrder = 6;
    tailLightningBurst.add(glow, bolt);
  }
  tailLightningBurst.visible = false;
  tailLightningBurst.position.set(0.82, 0.22, 0.14);
  tail.add(tailLightningBurst);

  // Additional celebration bolts frame the whole mascot during the final
  // 10K hold. They are separate from the tail flash so the silhouette reads
  // as a celebratory electric aura rather than one oversized tail effect.
  const celebrationLightningAura = register(new THREE.Group(), 'Celebration_Lightning_Aura');
  const auraPaths: Array<Array<[number, number]>> = [
    [[-0.84, 2.55], [-0.94, 2.68], [-0.88, 2.77], [-1.02, 2.88]],
    [[0.78, 2.48], [0.91, 2.59], [0.86, 2.70], [1.01, 2.82]],
    [[-0.92, 1.86], [-1.06, 1.92], [-1.00, 2.02], [-1.16, 2.08]],
    [[0.92, 1.78], [1.07, 1.84], [1.01, 1.94], [1.18, 2.00]],
    [[-0.86, 1.04], [-1.00, 1.10], [-0.94, 1.20], [-1.10, 1.27]],
    [[0.85, 0.98], [1.00, 1.04], [0.94, 1.14], [1.10, 1.20]],
    [[-0.60, 0.30], [-0.72, 0.20], [-0.66, 0.11], [-0.82, 0.04]],
    [[0.60, 0.28], [0.73, 0.18], [0.67, 0.08], [0.83, 0.01]],
  ];
  for (let i = 0; i < auraPaths.length; i += 1) {
    const bolt = register(mesh(
      `Celebration_Lightning_Aura_Bolt_${i + 1}`,
      makeLightningBoltGeometry(auraPaths[i], 0.050),
      new THREE.MeshBasicMaterial({
        color: 0xffd52a,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
      }),
    ));
    bolt.userData.lightningBoltIndex = i;
    bolt.renderOrder = 8;
    const glow = mesh(
      `Celebration_Lightning_Aura_Glow_${i + 1}`,
      makeLightningBoltGeometry(auraPaths[i], 0.074),
      makeLightningGlowMaterial(),
    );
    glow.userData.lightningBoltIndex = i;
    glow.renderOrder = 6;
    celebrationLightningAura.add(glow, bolt);
  }
  celebrationLightningAura.visible = false;
  celebrationLightningAura.position.z = 0.72;
  root.add(celebrationLightningAura);

  // A shallow embedded patch, not a freestanding cuboid on top of the tail.
  const accent = register(mesh('Tail_Accent', new THREE.BoxGeometry(0.14, 0.20, 0.06), tailGolden, [0.05, 0.02, 0.13]));
  accent.rotation.z = -0.10;
  // Keep this legacy helper hidden; the visible tail root is now the same
  // continuous golden Tail_Main material and cannot read as a detached patch.
  accent.visible = false;
  tailPivot.add(accent);

  // Reference-matched brown patches sit on the lower viewer-right flank at
  // the tail root.  These shallow pads make the tail read as an anatomical
  // continuation of the rump instead of a separate prop behind it.
  const tailAccentFace = new THREE.MeshBasicMaterial({ color: 0xb65a1b });
  const flankPatchUpperGeometry = makeFlankPatchGeometry();
  const flankPatchUpper = register(mesh(
    'Tail_Accent_Flank_Upper',
    conformSidePatchGeometry(flankPatchUpperGeometry, 0.62, FLANK_PATCH_UPPER_CENTER_Y, 0.012),
    tailAccentFace,
  ));
  // Keep the same X position and exact same geometry as Upper.  The center
  // spacing equals one patch height, so the two decals are parallel and do
  // not overlap while both remain on the tail-side contour of the torso.
  const flankPatchLowerGeometry = makeFlankPatchGeometry();
  const flankPatchLower = register(mesh(
    'Tail_Accent_Flank_Lower',
    conformSidePatchGeometry(
      flankPatchLowerGeometry,
      0.62,
      FLANK_PATCH_UPPER_CENTER_Y - FLANK_PATCH_CENTER_SPACING,
      0.012,
    ),
    tailAccentFace,
  ));
  flankPatchUpper.renderOrder = 3;
  flankPatchLower.renderOrder = 3;
  tailAccentFace.depthTest = false;
  tailAccentFace.depthWrite = false;
  root.add(flankPatchUpper, flankPatchLower);

  let tenKTexture: THREE.CanvasTexture | null = null;
  if (options.includeSpeechBubble !== false) {
    const bubble = register(new THREE.Group(), 'SpeechBubble_Optional');
    bubble.position.set(-1.12, 1.92, 0.05);
    const disc = mesh('SpeechBubble_Disc', new THREE.SphereGeometry(0.29, 32, 18), speechBubbleMilk, [0, 0, 0]);
    disc.scale.set(1.0, 1.0, 0.28);
    bubble.add(disc);
    const pointer = mesh('SpeechBubble_Pointer', makeSpeechBubblePointer(), speechBubbleMilk, [0.17, -0.20, -0.025]);
    // Raise the pointer by about 10 px without changing X/Z.  Its accumulated
    // turn is now 130°: 30° counterclockwise from the previous 100°.
    pointer.rotation.z = Math.PI - THREE.MathUtils.degToRad(50);
    bubble.add(pointer);
    const starGeometry = makeCelebrationStar();
    starGeometry.translate(0, 0.075, 0);
    const star = mesh(
      'Heart_Optional',
      conformBubbleDiscGeometry(starGeometry, 0, 0.012),
      new THREE.MeshBasicMaterial({
        color: 0xffd21f,
        depthTest: false,
        depthWrite: false,
      }),
      [0, 0, 0],
    );
    star.renderOrder = 4;
    bubble.add(star);

    tenKTexture = makeTenKLabelTexture();
    const tenKLabelGeometry = new THREE.PlaneGeometry(0.23, 0.066);
    tenKLabelGeometry.translate(0, -0.14, 0);
    const tenKLabel = mesh(
      'Star_10K_Label',
      conformBubbleDiscGeometry(tenKLabelGeometry, 0, 0.014),
      new THREE.MeshBasicMaterial({
        map: tenKTexture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
      [0, 0, 0],
    );
    tenKLabel.renderOrder = 5;
    bubble.add(tenKLabel);
    root.add(bubble);
  }

  // Animation anchors are captured after the authored pose is complete. The
  // runtime loop below only applies small deltas, so the reference pose is
  // still the exact pose at t=0 and all existing anatomy stays attached.
  const rootBaseY = root.position.y;
  const armLBaseY = armL.position.y;
  const armRBaseY = armR.position.y;
  const armLBaseRotationZ = armL.rotation.z;
  const armRBaseRotationZ = armR.rotation.z;
  const footLBaseY = footL.position.y;
  const footRBaseY = footR.position.y;
  const footLBaseRotationZ = footL.rotation.z;
  const footRBaseRotationZ = footR.rotation.z;
  const mouthOuterBasePosition = mouthOuter.position.clone();
  const mouthInnerBasePosition = mouthInner.position.clone();
  const tongueBasePosition = tonguePart.position.clone();
  const mouthOuterBaseScale = mouthOuter.scale.clone();
  const mouthInnerBaseScale = mouthInner.scale.clone();
  const tongueBaseScale = tonguePart.scale.clone();
  const eyeLWorldY = 1.90;
  const eyeRWorldY = 1.90;
  const eyeHighlightLWorldY = 1.924;
  const eyeHighlightRWorldY = 1.924;
  const speechBubble = root.getObjectByName('SpeechBubble_Optional');
  const speechBubbleBaseY = speechBubble?.position.y ?? 0;
  const speechBubbleDisc = speechBubble?.getObjectByName('SpeechBubble_Disc') as THREE.Mesh | undefined;
  const speechBubbleDiscBasePosition = speechBubbleDisc?.position.clone() ?? new THREE.Vector3();
  const speechBubbleDiscBaseScale = speechBubbleDisc?.scale.clone() ?? new THREE.Vector3(1, 1, 1);
  const speechBubbleDiscBaseRotationZ = speechBubbleDisc?.rotation.z ?? 0;
  const celebrationStar = speechBubble?.getObjectByName('Heart_Optional');
  const lightningBurst = root.getObjectByName('Star_Lightning_Burst');
  const lightningAura = root.getObjectByName('Celebration_Lightning_Aura');
  const tenKLabel = speechBubble?.getObjectByName('Star_10K_Label');

  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  const runtime: ElectricMouseMascotRuntime = {
    nodes,
    parts,
    getBellyTune: () => ({ ...bellyTune }),
    setBellyTune,
    update: (elapsedSeconds) => {
      const t = elapsedSeconds;
      const rollingDuration = 6.4;
      const finalHoldDuration = 2.0;
      const finalExitDuration = 0.4;
      const finalHoldStart = rollingDuration;
      const finalHoldEnd = finalHoldStart + finalHoldDuration;
      const celebrationCycle = finalHoldEnd + finalExitDuration;
      const celebrationPhase = t % celebrationCycle;
      const cycleProgress = celebrationPhase / celebrationCycle;
      // The rolling phase ends on 10K, then holds that result for exactly two
      // seconds. A short eased exit returns to the start of the next loop so
      // scale, lightning energy, and the label all meet without a snap.
      const rollingProgress = THREE.MathUtils.clamp(celebrationPhase / rollingDuration, 0, 1);
      const finalRevealStart = rollingDuration * (TEN_K_ROLL_LABELS.length - 2) / (TEN_K_ROLL_LABELS.length - 1);
      const finalRevealProgress = THREE.MathUtils.clamp(
        (celebrationPhase - finalRevealStart) / (rollingDuration - finalRevealStart),
        0,
        1,
      );
      const smoothStep = (value: number): number => {
        const x = THREE.MathUtils.clamp(value, 0, 1);
        return x * x * (3 - 2 * x);
      };
      let finalEnergy = 0;
      if (celebrationPhase < finalHoldStart) {
        finalEnergy = smoothStep(finalRevealProgress);
      } else if (celebrationPhase < finalHoldEnd) {
        finalEnergy = 1;
      } else {
        finalEnergy = 1 - smoothStep((celebrationPhase - finalHoldEnd) / finalExitDuration);
      }
      const cyclePulse = 0.5 - 0.5 * Math.cos(Math.PI * 2 * rollingProgress);
      const bubblePopScale = 1 + cyclePulse * 0.22 + finalEnergy * 0.18;
      const jump = Math.pow(finalEnergy, 1.15);
      const handSway = Math.sin(t * 2.35 + 0.35) * 0.042;
      const waddle = Math.sin(t * 2.35 + Math.PI * 0.5) * 0.028;
      if (tenKTexture) {
        if (celebrationPhase < rollingDuration) {
          const segmentFloat = rollingProgress * (TEN_K_ROLL_LABELS.length - 1);
          const segmentIndex = Math.min(TEN_K_ROLL_LABELS.length - 2, Math.floor(segmentFloat));
          const segmentProgress = segmentFloat - segmentIndex;
          drawRollingTenKLabel(
            tenKTexture.image as HTMLCanvasElement,
            TEN_K_ROLL_LABELS[segmentIndex],
            TEN_K_ROLL_LABELS[segmentIndex + 1],
            segmentProgress,
          );
        } else {
          drawTenKLabel(tenKTexture.image as HTMLCanvasElement, '10K', true);
        }
        tenKTexture.needsUpdate = true;
      }
      // Expand only the lower-body band in the body shader. The head, face
      // decals, ears, arms, and feet remain anchored while the belly gently
      // inhales and exhales like a soft, heavy mascot body.
      const bellyBreath = Math.sin(t * 1.15 - 0.45) * 0.028;
      updateBreathMaterial(bodyMaterial, bellyBreath);

      // A soft two-beat hop keeps the mascot lively without changing the
      // authored silhouette or causing the feet to leave the ground visibly.
      root.position.y = rootBaseY + jump * 0.12;
      root.rotation.z = Math.sin(t * 1.18) * 0.016;
      root.rotation.x = Math.sin(t * 2.35 + 0.45) * 0.014;

      // Tail and ears respond with different phase offsets, avoiding a rigid
      // synchronized motion while preserving their original attachment.
      tailPivot.rotation.z = Math.sin(t * 2.1) * 0.045;
      tailPivot.rotation.y = Math.sin(t * 1.55 + 0.4) * 0.022;
      const earCelebrationWiggle = finalEnergy * (0.045 + Math.sin(t * 7.0) * 0.035);
      earL.rotation.z = 0.28 + Math.sin(t * 1.4) * 0.018 + earCelebrationWiggle;
      earR.rotation.z = -0.28 + Math.sin(t * 1.4 + 0.7) * 0.018 - earCelebrationWiggle;
      earL.rotation.x = finalEnergy * Math.sin(t * 6.5 + 0.3) * 0.055;
      earR.rotation.x = finalEnergy * Math.sin(t * 6.5 + 1.1) * 0.055;

      // The hands gently cuddle inward on each bounce; their local positions
      // remain unchanged, so they never detach from the belly.
      armL.rotation.z = armLBaseRotationZ + handSway;
      armR.rotation.z = armRBaseRotationZ - handSway;
      armL.position.y = armLBaseY + jump * 0.026;
      armR.position.y = armRBaseY + jump * 0.026;
      const footCelebrationKick = finalEnergy * (0.105 + Math.sin(t * 7.0 + 0.8) * 0.035);
      const footCelebrationLift = finalEnergy * (0.018 + Math.max(0, Math.sin(t * 7.0 + 0.4)) * 0.012);
      footL.rotation.z = footLBaseRotationZ + waddle + footCelebrationKick;
      footR.rotation.z = footRBaseRotationZ - waddle - footCelebrationKick;
      footL.position.y = footLBaseY + footCelebrationLift;
      footR.position.y = footRBaseY + footCelebrationLift;

      // Blink once per loop. Scaling around the authored eye center prevents
      // the face decals from sliding vertically while the eyelids close.
      const blinkPhase = t % 5.2;
      const blink = THREE.MathUtils.clamp(1 - Math.abs(blinkPhase - 4.78) / 0.13, 0, 1);
      const eyeOpen = 1 - blink * 0.92;
      eyeL.scale.y = eyeOpen;
      eyeR.scale.y = eyeOpen;
      eyeL.position.y = eyeLWorldY * (1 - eyeOpen);
      eyeR.position.y = eyeRWorldY * (1 - eyeOpen);
      eyeHighlightL.scale.y = eyeOpen;
      eyeHighlightR.scale.y = eyeOpen;
      eyeHighlightL.position.y = eyeHighlightLWorldY * (1 - eyeOpen);
      eyeHighlightR.position.y = eyeHighlightRWorldY * (1 - eyeOpen);
      eyeHighlightL.visible = eyeOpen > 0.45;
      eyeHighlightR.visible = eyeOpen > 0.45;

      // The optional speech bubble floats a fraction behind the character and
      // the star plus 10k label celebrate the milestone together.
      if (speechBubble) {
        speechBubble.position.y = speechBubbleBaseY + Math.sin(t * 1.25 + 0.6) * 0.012;
        speechBubble.rotation.z = Math.sin(t * 1.25 + 0.6) * 0.018;
      }
      if (speechBubbleDisc) {
        // The 10K announcement starts as a soft bubble-pop: it grows from a
        // compact scale, overshoots slightly, then settles into a smooth idle
        // pulse. The disc remains the only animated bubble volume.
        const bubbleWave = Math.sin(cycleProgress * Math.PI * 4);
        const bubblePulse = 1 + bubbleWave * 0.008;
        const bubbleSquash = 1 - bubbleWave * 0.004;
        speechBubbleDisc.scale.set(
          speechBubbleDiscBaseScale.x * bubblePopScale * bubblePulse,
          speechBubbleDiscBaseScale.y * bubblePopScale * bubbleSquash,
          speechBubbleDiscBaseScale.z * bubblePopScale * (1 + Math.abs(bubbleWave) * 0.004),
        );
        speechBubbleDisc.position.x = speechBubbleDiscBasePosition.x + bubbleWave * 0.004;
        speechBubbleDisc.rotation.z = speechBubbleDiscBaseRotationZ + bubbleWave * 0.022;
      }
      if (celebrationStar) {
        const starScale = 1 + cyclePulse * 0.10 + finalEnergy * 0.28;
        celebrationStar.scale.setScalar(starScale);
        celebrationStar.position.y = 0.075 * (1 - starScale);
        celebrationStar.rotation.z = Math.sin(cycleProgress * Math.PI * 2) * 0.035;
      }
      // A small open-mouth bounce makes the mascot feel alive during the
      // 10K cheer while keeping all facial pieces surface-conforming.
      const mouthCheerPulse = finalEnergy * (0.075 + Math.max(0, Math.sin(t * 6.5)) * 0.045);
      const mouthOuterScaleY = 1 + mouthCheerPulse;
      const mouthInnerScaleY = 1 + mouthCheerPulse * 0.92;
      const tongueScaleY = 1 + mouthCheerPulse * 0.55;
      mouthOuter.scale.set(
        mouthOuterBaseScale.x,
        mouthOuterBaseScale.y * mouthOuterScaleY,
        mouthOuterBaseScale.z,
      );
      mouthInner.scale.set(
        mouthInnerBaseScale.x,
        mouthInnerBaseScale.y * mouthInnerScaleY,
        mouthInnerBaseScale.z,
      );
      tonguePart.scale.set(
        tongueBaseScale.x,
        tongueBaseScale.y * tongueScaleY,
        tongueBaseScale.z,
      );
      mouthOuter.position.y = mouthOuterBasePosition.y + 1.70 * (1 - mouthOuterScaleY);
      mouthInner.position.y = mouthInnerBasePosition.y + 1.67 * (1 - mouthInnerScaleY);
      tonguePart.position.y = tongueBasePosition.y + 1.70 * (1 - tongueScaleY);
      if (lightningBurst) {
        updateLightningGroup(
          lightningBurst,
          finalEnergy,
          t,
          0.84,
          0.72,
          Math.sin(cycleProgress * Math.PI * 2 * 3) * 0.025,
        );
      }
      if (lightningAura) {
        updateLightningGroup(
          lightningAura,
          finalEnergy,
          t,
          0.96,
          0.30,
          Math.sin(cycleProgress * Math.PI * 2 * 2) * 0.012,
        );
      }
      if (tenKLabel) {
        const labelScale = 1 + cyclePulse * 0.04 + finalEnergy * 0.38;
        tenKLabel.scale.setScalar(labelScale);
        tenKLabel.position.y = -0.14 * (1 - labelScale);
      }
    },
  };
  root.userData.electricMouseMascotRuntime = runtime;
  root.userData.parts = parts;
  root.userData.nodes = nodes;
  return root;
}

export function createElectricMouseMascotLookDevLights(): THREE.Group {
  const lights = new THREE.Group();
  lights.name = 'ElectricMouseMascot_LookDevLights';
  const key = new THREE.DirectionalLight(0xfff3d1, 2.05);
  key.position.set(-3.5, 6.5, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -5;
  key.shadow.camera.right = 5;
  key.shadow.camera.top = 5;
  key.shadow.camera.bottom = -3;
  lights.add(key);
  const fill = new THREE.HemisphereLight(0xffa4bd, 0x6f2b3b, 0.72);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xff789e, 0.72);
  rim.position.set(4, 3, -4);
  lights.add(rim);
  return lights;
}
