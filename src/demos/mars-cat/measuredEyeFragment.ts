import * as THREE from 'three';

// Node 101 measurement, after baseColorTexture × baseColorFactor and sRGB→linear.
const SCLERA_LINEAR = [
  0.9301108583754237,
  0.8713671191987972,
  0.7379104087727308,
] as const;

// Reflection-symmetric pupil cap measured from the 130 exactly-black GLB samples.
// The boundary is the midpoint of the unsampled interval between the largest
// exact-black ellipse coordinate and the first texture-transition sample.
const PUPIL = {
  absXCenter: 0.07844658009707928,
  yCenter: 0.9249970018863678,
  xRadius: 0.024596745148301125,
  yRadius: 0.024888426065444946,
  frontZMin: 0.12343906611204147,
  boundarySquared: 1.5003755471959472,
} as const;

export function applyMeasuredEyeFragmentMask(material: THREE.MeshPhysicalMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vMeasuredEyePosition;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvMeasuredEyePosition = position;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vMeasuredEyePosition;',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float measuredDx = (abs(vMeasuredEyePosition.x) - ${PUPIL.absXCenter}) / ${PUPIL.xRadius};
        float measuredDy = (vMeasuredEyePosition.y - ${PUPIL.yCenter}) / ${PUPIL.yRadius};
        float measuredEllipse = measuredDx * measuredDx + measuredDy * measuredDy;
        float measuredEdgeWidth = max(fwidth(measuredEllipse), 0.002);
        float measuredPupil = (1.0 - smoothstep(
          ${PUPIL.boundarySquared} - measuredEdgeWidth,
          ${PUPIL.boundarySquared} + measuredEdgeWidth,
          measuredEllipse
        )) * smoothstep(${PUPIL.frontZMin} - 0.0005, ${PUPIL.frontZMin} + 0.0005, vMeasuredEyePosition.z);
        float measuredCorridor = (1.0 - smoothstep(3.95, 4.0, measuredEllipse))
          * smoothstep(0.109, 0.111, vMeasuredEyePosition.z);
        vec3 measuredEyeColour = mix(
          vec3(${SCLERA_LINEAR.join(', ')}),
          vec3(0.0),
          measuredPupil
        );
        diffuseColor.rgb = mix(diffuseColor.rgb, measuredEyeColour, measuredCorridor);`,
      );
  };
  material.customProgramCacheKey = () => 'mars-cat-measured-eye-fragment-v1';
  material.needsUpdate = true;
  material.userData.measuredEyeFragment = {
    sourceNode: 101,
    exactBlackSourceSamples: 130,
    method: 'analytic-fragment-mask-from-measured-reflected-front-cap',
    boundarySquared: PUPIL.boundarySquared,
    textureShipped: false,
    geometryChanged: false,
  };
}
