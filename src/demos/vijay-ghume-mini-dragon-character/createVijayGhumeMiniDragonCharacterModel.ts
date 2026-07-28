import * as THREE from 'three';
import {
  createRiggedDragon,
  type RiggedDragonMaterials,
  type RiggedDragonRuntime,
} from './createRiggedDragon';

import dragonBodySkinAlbedoUrl from './dragon-body-skin_albedo.png';
import dragonBodySkinAoUrl from './dragon-body-skin_ao.png';
import dragonBodySkinHeightUrl from './dragon-body-skin_height.png';
import dragonBodySkinNormalUrl from './dragon-body-skin_normal.png';
import dragonBodySkinRoughnessUrl from './dragon-body-skin_roughness.png';
import dragonSkinAlbedoUrl from './dragon-skin_albedo.png';
import dragonSkinAoUrl from './dragon-skin_ao.png';
import dragonSkinHeightUrl from './dragon-skin_height.png';
import dragonSkinNormalUrl from './dragon-skin_normal.png';
import dragonSkinRoughnessUrl from './dragon-skin_roughness.png';
import goldOrnamentAlbedoUrl from './gold-ornament_albedo.png';
import goldOrnamentAoUrl from './gold-ornament_ao.png';
import goldOrnamentHeightUrl from './gold-ornament_height.png';
import goldOrnamentNormalUrl from './gold-ornament_normal.png';
import goldOrnamentRoughnessUrl from './gold-ornament_roughness.png';
import hornBlackAlbedoUrl from './horn-black_albedo.png';
import hornBlackAoUrl from './horn-black_ao.png';
import hornBlackHeightUrl from './horn-black_height.png';
import hornBlackNormalUrl from './horn-black_normal.png';
import hornBlackRoughnessUrl from './horn-black_roughness.png';
import loinclothPurpleAlbedoUrl from './loincloth-purple_albedo.png';
import loinclothPurpleAoUrl from './loincloth-purple_ao.png';
import loinclothPurpleHeightUrl from './loincloth-purple_height.png';
import loinclothPurpleNormalUrl from './loincloth-purple_normal.png';
import loinclothPurpleRoughnessUrl from './loincloth-purple_roughness.png';
import wingMembranePinkAlbedoUrl from './wing-membrane-pink_albedo.png';
import wingMembranePinkAoUrl from './wing-membrane-pink_ao.png';
import wingMembranePinkHeightUrl from './wing-membrane-pink_height.png';
import wingMembranePinkNormalUrl from './wing-membrane-pink_normal.png';
import wingMembranePinkRoughnessUrl from './wing-membrane-pink_roughness.png';

const REFERENCE_PBR_ASSETS = {
  body: {
    albedo: dragonBodySkinAlbedoUrl,
    ao: dragonBodySkinAoUrl,
    height: dragonBodySkinHeightUrl,
    normal: dragonBodySkinNormalUrl,
    roughness: dragonBodySkinRoughnessUrl,
  },
  tail: {
    albedo: dragonSkinAlbedoUrl,
    ao: dragonSkinAoUrl,
    height: dragonSkinHeightUrl,
    normal: dragonSkinNormalUrl,
    roughness: dragonSkinRoughnessUrl,
  },
  gold: {
    albedo: goldOrnamentAlbedoUrl,
    ao: goldOrnamentAoUrl,
    height: goldOrnamentHeightUrl,
    normal: goldOrnamentNormalUrl,
    roughness: goldOrnamentRoughnessUrl,
  },
  horn: {
    albedo: hornBlackAlbedoUrl,
    ao: hornBlackAoUrl,
    height: hornBlackHeightUrl,
    normal: hornBlackNormalUrl,
    roughness: hornBlackRoughnessUrl,
  },
  cloth: {
    albedo: loinclothPurpleAlbedoUrl,
    ao: loinclothPurpleAoUrl,
    height: loinclothPurpleHeightUrl,
    normal: loinclothPurpleNormalUrl,
    roughness: loinclothPurpleRoughnessUrl,
  },
  wing: {
    albedo: wingMembranePinkAlbedoUrl,
    ao: wingMembranePinkAoUrl,
    height: wingMembranePinkHeightUrl,
    normal: wingMembranePinkNormalUrl,
    roughness: wingMembranePinkRoughnessUrl,
  },
} as const;

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = RiggedDragonRuntime;

function material(
  name: string,
  color: THREE.ColorRepresentation,
  options: ProceduralModelOptions,
  parameters: Partial<THREE.MeshPhysicalMaterialParameters> = {},
): THREE.MeshPhysicalMaterial {
  const result = new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0,
    roughness: 0.5,
    wireframe: options.wireframe ?? false,
    ...parameters,
  });
  result.name = name;
  result.userData.referenceDerived = true;
  return result;
}

function makeMaterials(options: ProceduralModelOptions): RiggedDragonMaterials {
  return {
    body: material('dragon-body-skin', 0xc7285c, options, {
      roughness: 0.61,
      sheen: 0.22,
      sheenColor: new THREE.Color(0xff7897),
      sheenRoughness: 0.68,
      specularIntensity: 0.34,
      clearcoat: 0,
    }),
    bodyDark: material('dragon-purple-markings', 0x563487, options, {
      roughness: 0.5,
      clearcoat: 0.04,
    }),
    innerEar: material('dragon-inner-ear', 0xf17673, options, {
      roughness: 0.48,
      clearcoat: 0.04,
    }),
    muzzle: material('dragon-muzzle', 0xe99a4b, options, {
      roughness: 0.47,
      clearcoat: 0.08,
    }),
    horn: material('horn-black', 0x1b1925, options, {
      roughness: 0.42,
      clearcoat: 0.12,
    }),
    membrane: material('wing-membrane-pink', 0xd53669, options, {
      roughness: 0.57,
      clearcoat: 0.02,
      side: THREE.DoubleSide,
    }),
    gold: material('gold-ornament', 0xf0bd24, options, {
      roughness: 0.28,
      metalness: 0.78,
      clearcoat: 0.22,
      envMapIntensity: 1.02,
    }),
    cuff: material('cuff-black', 0x11121a, options, {
      roughness: 0.24,
      metalness: 0.16,
      clearcoat: 0.24,
    }),
    strap: material('leather-strap', 0x5a2d27, options, {
      roughness: 0.58,
      clearcoat: 0.02,
    }),
    cloth: material('loincloth-purple', 0x17152f, options, {
      roughness: 0.78,
      side: THREE.DoubleSide,
    }),
    eye: material('eye-amber', 0xf4c62f, options, {
      roughness: 0.14,
      clearcoat: 0.58,
      emissive: 0x6a2600,
      emissiveIntensity: 0.12,
    }),
    pupil: material('eye-pupil', 0x09070b, options, {
      roughness: 0.09,
      clearcoat: 0.65,
    }),
    ivory: material('fang-ivory', 0xffead0, options, {
      roughness: 0.3,
      clearcoat: 0.12,
    }),
  };
}

export function createVijayGhumeMiniDragonCharacterModel(
  options: ProceduralModelOptions = {},
): THREE.Group {
  const { root, runtime } = createRiggedDragon(makeMaterials(options), options);

  root.userData.reconstructionEvidence = {
    track: 'character-v1.5-rebuilt',
    implementation: 'continuous implicit body surface with explicit skeletal deformation',
    admittedViews: ['front-primary', 'front-three-quarter', 'rear-three-quarter', 'side', 'rear'],
    referencePbrAssets: REFERENCE_PBR_ASSETS,
    sourceSpec: 'provenance/dragon-character-spec.json',
    geometryDecision:
      'Organic anatomy is polygonized from a smooth-union signed-distance field into one body surface. Separate meshes are reserved for intentional material and construction boundaries: eyes, horns, wing membranes, claws, cuffs and clothing.',
    approximationNotes: [
      'Cross-sections and hidden wing undersides remain inferred from five exterior views.',
      'The body, skin weights and bone hierarchy are generated in code; no downloaded mesh, GLB or FBX is used.',
    ],
  };
  root.userData.actionReadiness = {
    pivots: Object.keys(runtime.nodes),
    sockets: Object.keys(runtime.sockets),
    colliders: Object.keys(runtime.colliders),
    rigType: 'THREE.SkinnedMesh',
    boneCount: runtime.skeleton.bones.length,
    skinAttributes: ['skinIndex', 'skinWeight'],
    bodyTopology: 'single continuous implicit surface',
    explodable: true,
    clickable: true,
  };

  const reviewParams = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : null;
  if (reviewParams?.get('rigPose') === 'stress') {
    runtime.bones.jaw.rotation.x = 0.16;
    runtime.bones.upperArmL.rotation.z = -0.28;
    runtime.bones.forearmL.rotation.z = 0.38;
    runtime.bones.upperArmR.rotation.z = 0.28;
    runtime.bones.forearmR.rotation.z = -0.38;
    runtime.bones.wingRootL.rotation.z = 0.18;
    runtime.bones.wingRootR.rotation.z = -0.18;
    runtime.bones.wingElbowL.rotation.z = -0.24;
    runtime.bones.wingElbowR.rotation.z = 0.24;
    runtime.bones.tail2.rotation.z = 0.2;
    runtime.bones.tail3.rotation.z = -0.28;
    root.updateMatrixWorld(true);
  }

  if (reviewParams?.get('rigDebug') === '1') {
    const helper = new THREE.SkeletonHelper(runtime.body);
    helper.name = 'dragon-skeleton-debug';
    const helperMaterial = helper.material as THREE.LineBasicMaterial;
    helperMaterial.depthTest = false;
    helperMaterial.transparent = true;
    helperMaterial.opacity = 0.9;
    helper.renderOrder = 10;
    root.add(helper);
  }

  return root;
}

export function createVijayGhumeMiniDragonCharacterLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'reference',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = 'Vijay Ghume Mini Dragon Character look-dev lights';

  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xffe6d8 : 0xe6edff,
    0x222337,
    mode === 'grazing' ? 0.3 : 0.44,
  );
  lights.add(hemi);

  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffd0ad : 0xfff3e7,
    mode === 'grazing' ? 3.4 : 1.65,
  );
  key.position.set(-4.6, 7.2, 6.4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 5;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -5;
  key.shadow.camera.right = 5;
  key.shadow.camera.top = 5;
  key.shadow.camera.bottom = -5;
  lights.add(key);

  const fill = new THREE.DirectionalLight(0x8aa8ff, mode === 'grazing' ? 0.14 : 0.34);
  fill.position.set(5.2, 2.4, 4.5);
  lights.add(fill);

  const rim = new THREE.DirectionalLight(0xff5c9a, mode === 'grazing' ? 0.7 : 0.95);
  rim.position.set(0.8, 4.8, -6.2);
  lights.add(rim);

  const face = new THREE.PointLight(0xffba67, 0.34, 8, 2);
  face.position.set(0, 2.4, 4);
  lights.add(face);

  lights.userData.reviewMode = mode;
  lights.userData.referenceEvidence = {
    key: 'upper-front warm highlight from front-primary',
    fill: 'cool front-side fill preserving horn and cloth value separation',
    rim: 'pink rear rim separating dark wing bones from the background',
  };
  return lights;
}
