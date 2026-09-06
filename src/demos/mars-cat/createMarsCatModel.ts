import * as THREE from 'three';
import { decodeSurfaceNode, decodeSurfaces, type EncodedNode } from './surfaceCodec';
import { SURFACE_NODES as HIGH_NODES, SURFACE_STREAM as HIGH_STREAM } from './surfaceData';
import { SURFACE_NODES as MEDIUM_NODES, SURFACE_STREAM as MEDIUM_STREAM } from './surfaceDataMedium';
import { SURFACE_NODES as LOW_NODES, SURFACE_STREAM as LOW_STREAM } from './surfaceDataLow';
import {
  SURFACE_NODES as HOODIE_BASE_NODES,
  SURFACE_STREAM as HOODIE_BASE_STREAM,
} from './surfaceDataHoodieBase';
import {
  SURFACE_NODES as HOODIE_POUCH_NODES,
  SURFACE_STREAM as HOODIE_POUCH_STREAM,
} from './surfaceDataHoodiePouch';
import {
  SURFACE_NODES as SHORTS_NODES,
  SURFACE_STREAM as SHORTS_STREAM,
} from './surfaceDataShorts';
import { createMeasuredTailGeometry } from './measuredTail';
import { applyMeasuredNoseCalibration } from './measuredNose';
import {
  applyMeasuredEarFragmentPalette,
  applyMeasuredEarNormalFilter,
  applyMeasuredEarPalette,
  applyMeasuredEarSpatialPalette,
} from './measuredEarColours';
import {
  applyMeasuredHoodieColours,
  applyMeasuredHoodieFragmentMask,
  applyMeasuredHoodieNormalFilter,
} from './measuredHoodieColours';
import { createMeasuredRigDebug } from './measuredRigDebug';
import { applyMeasuredEyeFragmentMask } from './measuredEyeFragment';
import {
  applyMeasuredShoeShadingAttribute,
  applyMeasuredShoeShadingMaterial,
} from './measuredShoeShading';
import {
  applyMeasuredShoeColourRegions,
  createMeasuredOuterShoeTrianglePatch,
} from './measuredShoeColours';
import { bindMarsCatRig } from './marsCatRig';
import { MARS_CAT_SOURCE_ANIMATION_PROVENANCE } from './rig/sourceAnimationData';
export { createMarsCatLookDevLights } from './renderContract';

export type MarsCatQuality = 'high' | 'medium' | 'low';

export interface MarsCatOptions {
  quality?: MarsCatQuality;
  tailMode?: 'surface-nets' | 'measured-sweep';
  noseMode?: 'surface-nets' | 'measured-calibration';
  earColourMode?: 'surface-transfer' | 'measured-palette' | 'measured-spatial';
  hoodieColourMode?: 'surface-transfer' | 'measured-uv-mask';
  eyeQualityMode?: 'matched' | 'high';
  shoeQualityMode?: 'matched' | 'high';
  shoeShadingMode?: 'geometry' | 'separate';
  shoeColourMode?: 'source-transfer' | 'measured-regions';
  shortsQualityMode?: 'matched' | 'high';
  shortsPocketQualityMode?: 'matched' | 'high';
  hoodieQualityMode?: 'matched' | 'high';
  hoodieNormalMode?: 'computed' | 'one-ring';
  hoodieSpecularMode?: 'three-default' | 'measured-zero';
  hoodieRenderMode?: 'vertex' | 'measured-fragment';
  drawstringQualityMode?: 'matched' | 'high';
  earHairQualityMode?: 'matched' | 'high';
  earRenderMode?: 'vertex' | 'measured-fragment';
  bodyQualityMode?: 'matched' | 'high';
  earNormalMode?: 'computed' | 'one-ring';
  eyeRenderMode?: 'vertex' | 'measured-fragment';
  rigDebug?: boolean;
  rigged?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

function qualityFromUrl(): MarsCatQuality {
  const value = typeof location === 'undefined'
    ? null
    : new URLSearchParams(location.search).get('quality');
  return value === 'high' || value === 'low' ? value : 'medium';
}

function level(quality: MarsCatQuality) {
  if (quality === 'high') return { nodes: HIGH_NODES, stream: HIGH_STREAM };
  if (quality === 'low') return { nodes: LOW_NODES, stream: LOW_STREAM };
  return { nodes: MEDIUM_NODES, stream: MEDIUM_STREAM };
}

function tailModeFromUrl(): 'surface-nets' | 'measured-sweep' {
  if (typeof location === 'undefined') return 'measured-sweep';
  return new URLSearchParams(location.search).get('tail') === 'surface-nets'
    ? 'surface-nets'
    : 'measured-sweep';
}

function noseModeFromUrl(): 'surface-nets' | 'measured-calibration' {
  if (typeof location === 'undefined') return 'measured-calibration';
  return new URLSearchParams(location.search).get('nose') === 'surface-nets'
    ? 'surface-nets'
    : 'measured-calibration';
}

function earColourModeFromUrl(): 'surface-transfer' | 'measured-palette' | 'measured-spatial' {
  if (typeof location === 'undefined') return 'measured-spatial';
  const value = new URLSearchParams(location.search).get('ears');
  if (value === 'surface-transfer' || value === 'measured-palette') return value;
  return 'measured-spatial';
}

function hoodieColourModeFromUrl(): 'surface-transfer' | 'measured-uv-mask' {
  if (typeof location === 'undefined') return 'measured-uv-mask';
  return new URLSearchParams(location.search).get('hoodie-colours') === 'surface-transfer'
    ? 'surface-transfer'
    : 'measured-uv-mask';
}

function eyeQualityModeFromUrl(): 'matched' | 'high' {
  if (typeof location === 'undefined') return 'high';
  return new URLSearchParams(location.search).get('eye-quality') === 'matched' ? 'matched' : 'high';
}

function shoeQualityModeFromUrl(): 'matched' | 'high' {
  if (typeof location === 'undefined') return 'high';
  return new URLSearchParams(location.search).get('shoe-quality') === 'matched' ? 'matched' : 'high';
}

function shoeShadingModeFromUrl(): 'geometry' | 'separate' {
  if (typeof location === 'undefined') return 'separate';
  return new URLSearchParams(location.search).get('shoe-shading') === 'geometry'
    ? 'geometry'
    : 'separate';
}

function shoeColourModeFromUrl(): 'source-transfer' | 'measured-regions' {
  if (typeof location === 'undefined') return 'measured-regions';
  return new URLSearchParams(location.search).get('shoe-colours') === 'source-transfer'
    ? 'source-transfer'
    : 'measured-regions';
}

function shortsQualityModeFromUrl(): 'matched' | 'high' {
  if (typeof location === 'undefined') return 'high';
  return new URLSearchParams(location.search).get('shorts-quality') === 'matched'
    ? 'matched'
    : 'high';
}

function shortsPocketQualityModeFromUrl(): 'matched' | 'high' {
  if (typeof location === 'undefined') return 'high';
  return new URLSearchParams(location.search).get('shorts-pocket-quality') === 'matched'
    ? 'matched'
    : 'high';
}

function hoodieQualityModeFromUrl(): 'matched' | 'high' {
  if (typeof location === 'undefined') return 'high';
  return new URLSearchParams(location.search).get('hoodie-quality') === 'matched' ? 'matched' : 'high';
}

function hoodieNormalModeFromUrl(): 'computed' | 'one-ring' {
  if (typeof location === 'undefined') return 'one-ring';
  return new URLSearchParams(location.search).get('hoodie-normals') === 'computed'
    ? 'computed'
    : 'one-ring';
}

function hoodieSpecularModeFromUrl(): 'three-default' | 'measured-zero' {
  if (typeof location === 'undefined') return 'measured-zero';
  return new URLSearchParams(location.search).get('hoodie-specular') === 'three-default'
    ? 'three-default'
    : 'measured-zero';
}

function hoodieRenderModeFromUrl(): 'vertex' | 'measured-fragment' {
  if (typeof location === 'undefined') return 'measured-fragment';
  return new URLSearchParams(location.search).get('hoodie-render') === 'vertex'
    ? 'vertex'
    : 'measured-fragment';
}

function drawstringQualityModeFromUrl(): 'matched' | 'high' {
  if (typeof location === 'undefined') return 'high';
  return new URLSearchParams(location.search).get('drawstring-quality') === 'matched'
    ? 'matched'
    : 'high';
}

function earHairQualityModeFromUrl(): 'matched' | 'high' {
  if (typeof location === 'undefined') return 'high';
  return new URLSearchParams(location.search).get('ear-hair-quality') === 'matched'
    ? 'matched'
    : 'high';
}

function earRenderModeFromUrl(): 'vertex' | 'measured-fragment' {
  if (typeof location === 'undefined') return 'measured-fragment';
  return new URLSearchParams(location.search).get('ear-render') === 'vertex'
    ? 'vertex'
    : 'measured-fragment';
}

function bodyQualityModeFromUrl(): 'matched' | 'high' {
  if (typeof location === 'undefined') return 'high';
  return new URLSearchParams(location.search).get('body-quality') === 'matched' ? 'matched' : 'high';
}

function earNormalModeFromUrl(): 'computed' | 'one-ring' {
  if (typeof location === 'undefined') return 'one-ring';
  return new URLSearchParams(location.search).get('ear-normals') === 'computed'
    ? 'computed'
    : 'one-ring';
}

function eyeRenderModeFromUrl(): 'vertex' | 'measured-fragment' {
  if (typeof location === 'undefined') return 'measured-fragment';
  return new URLSearchParams(location.search).get('eye-render') === 'vertex'
    ? 'vertex'
    : 'measured-fragment';
}


function rigDebugFromUrl(): boolean {
  return typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('rig-debug') === '1';
}

function riggedFromUrl(): boolean {
  return typeof location === 'undefined'
    || new URLSearchParams(location.search).get('rig') !== '0';
}

export function createMarsCatModel(options: MarsCatOptions = {}): THREE.Group {
  const quality = options.quality ?? qualityFromUrl();
  const tailMode = options.tailMode ?? tailModeFromUrl();
  const noseMode = options.noseMode ?? noseModeFromUrl();
  const earColourMode = options.earColourMode ?? earColourModeFromUrl();
  const hoodieColourMode = options.hoodieColourMode ?? hoodieColourModeFromUrl();
  const eyeQualityMode = options.eyeQualityMode ?? (quality === 'low' ? 'matched' : eyeQualityModeFromUrl());
  const shoeQualityMode = options.shoeQualityMode ?? (quality === 'low' ? 'matched' : shoeQualityModeFromUrl());
  const shoeShadingMode = options.shoeShadingMode ?? shoeShadingModeFromUrl();
  const shoeColourMode = options.shoeColourMode ?? shoeColourModeFromUrl();
  const shortsQualityMode = options.shortsQualityMode ?? (quality === 'low' ? 'matched' : shortsQualityModeFromUrl());
  const shortsPocketQualityMode = options.shortsPocketQualityMode ?? (quality === 'low' ? 'matched' : shortsPocketQualityModeFromUrl());
  const hoodieQualityMode = options.hoodieQualityMode ?? (quality === 'low' ? 'matched' : hoodieQualityModeFromUrl());
  const hoodieNormalMode = options.hoodieNormalMode ?? hoodieNormalModeFromUrl();
  const hoodieSpecularMode = options.hoodieSpecularMode ?? hoodieSpecularModeFromUrl();
  const hoodieRenderMode = options.hoodieRenderMode ?? hoodieRenderModeFromUrl();
  const drawstringQualityMode = options.drawstringQualityMode ?? (quality === 'low' ? 'matched' : drawstringQualityModeFromUrl());
  const earHairQualityMode = options.earHairQualityMode ?? (quality === 'low' ? 'matched' : earHairQualityModeFromUrl());
  const earRenderMode = options.earRenderMode ?? earRenderModeFromUrl();
  const bodyQualityMode = options.bodyQualityMode ?? (quality === 'low' ? 'matched' : bodyQualityModeFromUrl());
  const earNormalMode = options.earNormalMode ?? earNormalModeFromUrl();
  const eyeRenderMode = options.eyeRenderMode ?? eyeRenderModeFromUrl();
  const rigDebug = options.rigDebug ?? rigDebugFromUrl();
  const rigged = options.rigged ?? (riggedFromUrl() && quality !== 'high');
  const data = level(quality);
  const surfaces = decodeSurfaces(data.stream, data.nodes as readonly EncodedNode[]);
  const originalHoodieIndex = surfaces.findIndex((surface) => surface.node === 102);
  if (originalHoodieIndex >= 0 && hoodieQualityMode === 'high') {
    surfaces.splice(
      originalHoodieIndex,
      1,
      decodeSurfaceNode(
        HOODIE_BASE_STREAM,
        HOODIE_BASE_NODES as readonly EncodedNode[],
        102,
      ),
      decodeSurfaceNode(
        HOODIE_POUCH_STREAM,
        HOODIE_POUCH_NODES as readonly EncodedNode[],
        102,
      ),
    );
  }
  if (quality !== 'high' && bodyQualityMode === 'high') {
    const bodyIndex = surfaces.findIndex((surface) => surface.node === 97);
    if (bodyIndex >= 0) {
      surfaces[bodyIndex] = decodeSurfaceNode(
        HIGH_STREAM,
        HIGH_NODES as readonly EncodedNode[],
        97,
      );
    }
  }
  if (quality !== 'high' && eyeQualityMode === 'high') {
    const eyeIndex = surfaces.findIndex((surface) => surface.node === 101);
    if (eyeIndex >= 0) {
      surfaces[eyeIndex] = decodeSurfaceNode(HIGH_STREAM, HIGH_NODES as readonly EncodedNode[], 101);
    }
  }
  if (quality !== 'high' && shoeQualityMode === 'high') {
    for (const shoeNode of [114, 115]) {
      const shoeIndex = surfaces.findIndex((surface) => surface.node === shoeNode);
      if (shoeIndex >= 0) {
        surfaces[shoeIndex] = decodeSurfaceNode(
          HIGH_STREAM,
          HIGH_NODES as readonly EncodedNode[],
          shoeNode,
        );
      }
    }
  }
  if (shortsQualityMode === 'high') {
    const shortsIndex = surfaces.findIndex((surface) => surface.node === 116);
    if (shortsIndex >= 0) {
      surfaces[shortsIndex] = decodeSurfaceNode(
        SHORTS_STREAM,
        SHORTS_NODES as readonly EncodedNode[],
        116,
      );
    }
  }
  if (quality !== 'high' && shortsPocketQualityMode === 'high') {
    const shortsPocketIndex = surfaces.findIndex((surface) => surface.node === 117);
    if (shortsPocketIndex >= 0) {
      surfaces[shortsPocketIndex] = decodeSurfaceNode(
        HIGH_STREAM,
        HIGH_NODES as readonly EncodedNode[],
        117,
      );
    }
  }
  if (quality !== 'high' && earHairQualityMode === 'high') {
    const earHairIndex = surfaces.findIndex((surface) => surface.node === 99);
    if (earHairIndex >= 0) {
      surfaces[earHairIndex] = decodeSurfaceNode(
        HIGH_STREAM,
        HIGH_NODES as readonly EncodedNode[],
        99,
      );
    }
  }
  if (quality !== 'high' && drawstringQualityMode === 'high') {
    const drawstringIndex = surfaces.findIndex((surface) => surface.node === 107);
    if (drawstringIndex >= 0) {
      surfaces[drawstringIndex] = decodeSurfaceNode(
        HIGH_STREAM,
        HIGH_NODES as readonly EncodedNode[],
        107,
      );
    }
  }
  const root = new THREE.Group();
  root.name = 'mars-cat-procedural';
  const parts: Record<string, THREE.Mesh> = {};
  let vertexCount = 0;

  for (const surface of surfaces) {
    const measuredTail = surface.node === 118 && tailMode === 'measured-sweep';
    const measuredNose = surface.node === 106 && noseMode === 'measured-calibration';
    const measuredEarColours = surface.node === 97 && earColourMode !== 'surface-transfer';
    const measuredHoodieColours = surface.node === 102 && hoodieColourMode === 'measured-uv-mask';
    const geometry = measuredTail
      ? createMeasuredTailGeometry(surface.cellMillimetres)
      : new THREE.BufferGeometry();
    if (!measuredTail) {
      geometry.setAttribute('position', new THREE.BufferAttribute(surface.position, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(surface.colour, 3, true));
      geometry.setIndex(new THREE.BufferAttribute(surface.index, 1));
      if (measuredEarColours) {
        if (earColourMode === 'measured-spatial') applyMeasuredEarSpatialPalette(geometry);
        else applyMeasuredEarPalette(geometry);
      }
      if (measuredHoodieColours) applyMeasuredHoodieColours(geometry);
      if (measuredNose) applyMeasuredNoseCalibration(geometry);
      else geometry.computeVertexNormals();
      if (surface.node === 97 && earNormalMode !== 'computed') {
        applyMeasuredEarNormalFilter(geometry);
      }
      if (surface.node === 102 && hoodieNormalMode !== 'computed') {
        applyMeasuredHoodieNormalFilter(geometry);
        if (surface.region === 'hoodie-pouch') applyMeasuredHoodieNormalFilter(geometry);
      }
      if (surface.node === 116) {
        applyMeasuredHoodieNormalFilter(geometry);
        applyMeasuredHoodieNormalFilter(geometry);
      }
      if (surface.node === 114 || surface.node === 115) {
        applyMeasuredHoodieNormalFilter(geometry);
        if (shoeShadingMode === 'separate') applyMeasuredShoeShadingAttribute(geometry);
      }
    }
    vertexCount += geometry.getAttribute('position').count;

    const material = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: surface.material?.roughnessMedian ?? 1,
      metalness: surface.material?.metalnessMedian ?? 0,
      side: surface.material?.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    });
    if ([98, 102, 107].includes(surface.node) && hoodieSpecularMode === 'measured-zero') {
      material.specularColor.setRGB(0, 0, 0);
    }
    if (surface.node === 102 && hoodieRenderMode === 'measured-fragment') {
      applyMeasuredHoodieFragmentMask(material);
    }
    const measuredEyeFragment = surface.node === 101 && eyeRenderMode === 'measured-fragment';
    const measuredEarFragment = surface.node === 97 && earRenderMode === 'measured-fragment';
    if (measuredEyeFragment) applyMeasuredEyeFragmentMask(material);
    if (measuredEarFragment) applyMeasuredEarFragmentPalette(material);
    if ((surface.node === 114 || surface.node === 115) && shoeShadingMode === 'separate') {
      applyMeasuredShoeShadingMaterial(material);
    }
    if ((surface.node === 114 || surface.node === 115) && shoeColourMode === 'measured-regions') {
      applyMeasuredShoeColourRegions(material, surface.node);
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = surface.region;
    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? true;
    mesh.frustumCulled = false;
    mesh.userData.selectable = true;
    mesh.userData.region = surface.region;
    // The review exporter uses this flag as its generic "include this procedural surface" marker.
    // `measuredSweep` below records that node 118 is not SDF-derived in the candidate route.
    mesh.userData.sdfSurface = true;
    mesh.userData.measuredSweep = measuredTail;
    mesh.userData.measuredNoseCalibration = measuredNose;
    mesh.userData.measuredEarColours = measuredEarColours;
    mesh.userData.measuredHoodieColours = measuredHoodieColours;
    mesh.userData.measuredEyeFragment = measuredEyeFragment;
    mesh.userData.measuredEarFragment = measuredEarFragment;
    root.add(mesh);
    parts[surface.region] = mesh;
    if ((surface.node === 114 || surface.node === 115) && shoeColourMode === 'measured-regions') {
      const outerTrianglePatch = createMeasuredOuterShoeTrianglePatch(
        geometry,
        surface.node,
        surface.cellMillimetres,
        material.roughness,
        material.metalness,
      );
      outerTrianglePatch.castShadow = options.castShadow ?? true;
      outerTrianglePatch.receiveShadow = options.receiveShadow ?? true;
      root.add(outerTrianglePatch);
      parts[outerTrianglePatch.name] = outerTrianglePatch;
      vertexCount += outerTrianglePatch.geometry.getAttribute('position').count;
    }
  }


  if (rigDebug) root.add(createMeasuredRigDebug());

  root.userData.referenceSha256 = 'bceae6100affece98b1987d752b515f08e9c57e3282eb007e1cc63a9b1b7c6fb';
  root.userData.parts = parts;
  root.userData.sculptRuntime = {
    selectableParts: Object.keys(parts),
    rig: {
      kind: 'measured-rest-skeleton-unbound',
      deliverable: 'validated-payload-and-debug-overlay',
      measuredReferenceOnly: { skinCount: 1, jointCount: 95, animationCount: 0 },
      debugVisible: rigDebug,
      bindingBlockedByInheritedJointLoopFailures: 12,
    },
    staticCollider: {
      kind: 'box',
      size: [1.0466609597206116, 1.1693148398771882, 0.5642208158969879],
    },
    detailLevels: {
      current: quality,
      vertexCount,
      options: ['high', 'medium', 'low'],
    },
    tail: {
      mode: tailMode,
      sourceNode: 118,
      measuredParametersOnly: tailMode === 'measured-sweep',
    },
    nose: {
      mode: noseMode,
      sourceNode: 106,
      measuredBoundsOnly: noseMode === 'measured-calibration',
    },
    earColours: {
      mode: earColourMode,
      sourceNode: 97,
      measuredPalette: earColourMode === 'measured-palette',
      measuredSpatialClassifier: earColourMode === 'measured-spatial',
      fragmentEvaluated: earRenderMode === 'measured-fragment',
    },
    bodyQuality: {
      mode: bodyQualityMode,
      sourceNode: 97,
      measuredCellMillimetres: surfaces.find((surface) => surface.node === 97)?.cellMillimetres,
      measuredHighTierOverride: quality !== 'high' && bodyQualityMode === 'high',
    },
    earNormals: {
      mode: earNormalMode,
      sourceNode: 97,
      geometryChanged: false,
    },
    hoodieColours: {
      mode: hoodieColourMode,
      sourceNode: 102,
      measuredUvMask: hoodieColourMode === 'measured-uv-mask',
      textureShipped: false,
    },
    eyeQuality: {
      mode: eyeQualityMode,
      sourceNode: 101,
      cellMillimetres: parts.eyes?.geometry.userData?.cellMillimetres
        ?? surfaces.find((surface) => surface.node === 101)?.cellMillimetres,
      measuredHighTierOverride: quality !== 'high' && eyeQualityMode === 'high',
    },
    eyeRender: {
      mode: eyeRenderMode,
      sourceNode: 101,
      measuredFragmentBoundary: eyeRenderMode === 'measured-fragment',
      geometryChanged: false,
    },
    shoeQuality: {
      mode: shoeQualityMode,
      sourceNodes: [114, 115],
      measuredCellMillimetres: surfaces
        .filter((surface) => surface.node === 114 || surface.node === 115)
        .map((surface) => surface.cellMillimetres),
      measuredHighTierOverride: quality !== 'high' && shoeQualityMode === 'high',
    },
    shoeShading: {
      mode: shoeShadingMode,
      sourceNodes: [114, 115],
      geometryNormalChanged: false,
    },
    shoeColours: {
      mode: shoeColourMode,
      sourceNodes: [114, 115],
      textureShipped: false,
    },
    shortsQuality: {
      mode: shortsQualityMode,
      sourceNode: 116,
      measuredCellMillimetres: surfaces.find((surface) => surface.node === 116)?.cellMillimetres,
      measuredHighTierOverride: shortsQualityMode === 'high',
    },
    shortsPocketQuality: {
      mode: shortsPocketQualityMode,
      sourceNode: 117,
      measuredCellMillimetres: surfaces.find((surface) => surface.node === 117)?.cellMillimetres,
      measuredHighTierOverride: quality !== 'high' && shortsPocketQualityMode === 'high',
    },
    hoodieQuality: {
      mode: hoodieQualityMode,
      sourceNode: 102,
      measuredCellMillimetres: surfaces.find((surface) => surface.node === 102)?.cellMillimetres,
      measuredHighTierOverride: false,
      componentSplit: {
        hoodieVertices: HOODIE_BASE_NODES[0]?.vertexCount,
        pouchVertices: HOODIE_POUCH_NODES[0]?.vertexCount,
        cellMillimetres: HOODIE_POUCH_NODES[0]?.cellMillimetres,
      },
    },
    hoodieNormals: {
      mode: hoodieNormalMode,
      sourceNode: 102,
      geometryChanged: false,
    },
    hoodieSpecular: {
      mode: hoodieSpecularMode,
      sourceNodes: [98, 102, 107],
      measuredSpecularColorFactor: [0, 0, 0],
    },
    hoodieRender: {
      mode: hoodieRenderMode,
      sourceNode: 102,
      measuredFragmentMask: hoodieRenderMode === 'measured-fragment',
      geometryChanged: false,
    },
    drawstringQuality: {
      mode: drawstringQualityMode,
      sourceNode: 107,
      measuredCellMillimetres: surfaces.find((surface) => surface.node === 107)?.cellMillimetres,
      measuredHighTierOverride: quality !== 'high' && drawstringQualityMode === 'high',
    },
    earHairQuality: {
      mode: earHairQualityMode,
      sourceNode: 99,
      measuredCellMillimetres: surfaces.find((surface) => surface.node === 99)?.cellMillimetres,
      measuredHighTierOverride: quality !== 'high' && earHairQualityMode === 'high',
    },
  };
  if (rigged) {
    const skinTier = quality === 'low' ? 'game' : 'fidelity';
    const rigRuntime = bindMarsCatRig(root, skinTier);
    root.userData.sculptRuntime.rig = {
      kind: 'glb-referenced-skeleton-and-skin',
      sourceSkinIndex: 0,
      jointCount: rigRuntime.bones.length,
      jointOrder: 'GLB skin[0].joints order',
      sourceAnimationCount: MARS_CAT_SOURCE_ANIMATION_PROVENANCE.sourceClipCount,
      authoredAnimationCount: 0,
      sourceAnimationSha256: MARS_CAT_SOURCE_ANIMATION_PROVENANCE.sourceSha256,
      sourceTrackCount: MARS_CAT_SOURCE_ANIMATION_PROVENANCE.sourceTrackCount,
      retainedTranslationQuaternionTrackCount:
        MARS_CAT_SOURCE_ANIMATION_PROVENANCE.retainedTranslationQuaternionTrackCount,
      normalizedScaleTrackCount: MARS_CAT_SOURCE_ANIMATION_PROVENANCE.normalizedScaleTrackCount,
      scaleNormalization: MARS_CAT_SOURCE_ANIMATION_PROVENANCE.scaleNormalization,
      animationJointCorrespondence: MARS_CAT_SOURCE_ANIMATION_PROVENANCE.correspondence,
      skinTier,
      restCancellationResidualMax: 7.076254341897131e-7,
      meshParityFrozen: true,
    };
    root.userData.sculptRuntime.animationController = rigRuntime.animationController;
    root.userData.tick = (deltaSeconds: number): void => rigRuntime.update(deltaSeconds);
  }
  return root;
}
