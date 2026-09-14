import { surfaceMeta, surfaceBase64 } from './surfaceData';
import { buildMeasuredSurface, applySurfaceRefinement } from './surfaceCodec';
import { refinementMeta, refinementBase64 } from './surfaceRefinement';
import { Mesh, Color, Vector3 } from 'three';
import { woodColourRepair } from './woodColourRepair';

export function createOceanMeasuredModel(refine = true) {
  const model = buildMeasuredSurface(surfaceMeta, surfaceBase64);
  if (refine) applySurfaceRefinement(model, refinementBase64, refinementMeta.vertexCount);
  const brown = new Color();
  model.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const colours = object.geometry.getAttribute('color');
    const shading = object.geometry.getAttribute('measuredNormal');
    const pbr = object.geometry.getAttribute('measuredPbr');
    const normal = new Vector3();
    const repairedNormal = new Vector3();
    for (const [vertex, r, g, b, nx, ny, nz, blend, roughness, metalness] of woodColourRepair) {
      brown.setRGB(r / 255, g / 255, b / 255, 'srgb');
      colours.setXYZ(vertex, brown.r, brown.g, brown.b);
      if (shading) {
        normal.set(shading.getX(vertex), shading.getY(vertex), shading.getZ(vertex));
        normal.multiplyScalar(1 - blend).addScaledVector(repairedNormal.set(nx, ny, nz), blend).normalize();
        shading.setXYZ(vertex, normal.x, normal.y, normal.z);
      }
      if (pbr) pbr.setXY(vertex,
        pbr.getX(vertex) * (1 - blend) + roughness / 255 * blend,
        pbr.getY(vertex) * (1 - blend) + metalness / 255 * blend);
    }
    colours.needsUpdate = true;
    if (shading) shading.needsUpdate = true;
    if (pbr) pbr.needsUpdate = true;
  });
  return model;
}
