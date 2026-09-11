import type * as THREE from 'three';
/** A single spatial cut shared by colour/depth/distance passes of each body. */
export function patchFormReveal(material:THREE.Material,progress:{value:number},direction:{value:number},height=1):void {
 const prior=material.onBeforeCompile,key=material.customProgramCacheKey();
 material.onBeforeCompile=(shader,renderer)=>{
  prior.call(material,shader,renderer);shader.uniforms.formProgress=progress;shader.uniforms.formDirection=direction;
  shader.vertexShader='varying vec3 formRest;\n'+shader.vertexShader;
  shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nformRest=position;');
  shader.fragmentShader='varying vec3 formRest;uniform float formProgress;uniform float formDirection;\n'+shader.fragmentShader;
  shader.fragmentShader=shader.fragmentShader.replace('#include <clipping_planes_fragment>',`#include <clipping_planes_fragment>
   float formNoise=sin(formRest.x*79.+sin(formRest.z*53.)*2.)*sin(formRest.y*91.+formRest.z*37.);
   float formCut=formRest.y/${height.toFixed(6)}+formNoise*.035;
   float formBand=formProgress*1.18-.09;
   if(formDirection>.5){if(formProgress<=0. || (formProgress<1. && formCut>formBand))discard;}
   else{if(formProgress>=1. || (formProgress>0. && formCut<formBand))discard;}
  `);
  shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>','float edge=exp(-abs(formCut-formBand)*100.)*step(.001,formProgress)*step(formProgress,.999);outgoingLight+=vec3(.08,.95,1.)*edge*2.;\n#include <opaque_fragment>');
 };
 material.customProgramCacheKey=()=>`${key}-form-reveal-${height}-v1`;material.needsUpdate=true;
}
