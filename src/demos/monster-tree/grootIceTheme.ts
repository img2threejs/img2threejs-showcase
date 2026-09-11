import * as THREE from 'three';
export type GrootSkillTheme='wood'|'ice'|'bloom';
export const BLOOM_SPORE=new THREE.Color('#b6ed61'),BLOOM_GLOW=new THREE.Color('#58cf48');
export const ICE_SPORE=new THREE.Color('#d4faff'),ICE_GLOW=new THREE.Color('#66cfff');
/** Immutable variants, assigned to narrowly owned effects, never mutate shared forest bark.
 * One variant per original material; persistent owners keep the chosen material reference. */
export class GrootIceTheme {
 private readonly variants=new Map<THREE.Material,THREE.Material>();
 private readonly bloomVariants=new Map<THREE.Material,THREE.Material>();
 private readonly originals=new WeakMap<THREE.Object3D,THREE.Material|THREE.Material[]>();
 private readonly lightColors=new WeakMap<THREE.Light,THREE.Color>();
 private variant(base:THREE.Material,theme:GrootSkillTheme):THREE.Material {
  const bloom=theme==='bloom',variants=bloom?this.bloomVariants:this.variants;
  let material=variants.get(base);if(material)return material;
  material=base.clone();material.name=`${theme}-effect:${base.name}`;
  if(material instanceof THREE.ShaderMaterial&&base instanceof THREE.ShaderMaterial){
   // clone() deep-copies uniforms, disconnecting owner-animated uPower/uTime cells.
   // This variant belongs to the SAME effect owner: retain its live non-color controls,
   // while cloned color uniforms stay private to the theme (never retint the base).
   for(const [name,uniform] of Object.entries(base.uniforms))if(!(uniform.value instanceof THREE.Color))material.uniforms[name]=uniform;else if(bloom)material.uniforms[name].value.copy(BLOOM_GLOW);
   // Owner shaders also contain literal/vertex blue palettes (moonbeam/fireflies).
   // Tint their final RGB only; preserve live power/time cells and alpha envelope.
   if(bloom)material.fragmentShader=material.fragmentShader.replace(/}\s*$/, 'gl_FragColor.rgb=vec3(.30,.86,.12)*dot(gl_FragColor.rgb,vec3(.2126,.7152,.0722));}');
  }else if(material instanceof THREE.MeshStandardMaterial){
   material.roughness=bloom?.78:.24;material.metalness=bloom?.02:.16;material.emissive.set(bloom?'#153b08':'#174453');material.emissiveIntensity=.3;
   const prior=base.onBeforeCompile;
   material.onBeforeCompile=(shader,renderer)=>{
    prior.call(material,shader,renderer);
    shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
     float iceLuma=dot(diffuseColor.rgb,vec3(.2126,.7152,.0722));
     float frost=pow(abs(normalize(vNormal).y),5.);
     diffuseColor.rgb=mix(${bloom?'vec3(.045,.22,.018),vec3(.40,.76,.12)':'vec3(.055,.37,.52),vec3(.72,.95,1.)'},clamp(iceLuma*1.6+frost*.28,0.,1.));
    `);
   };const key=base.customProgramCacheKey();material.customProgramCacheKey=()=>key+`-${theme}-crystal-frost-v1`;
  }else if(material instanceof THREE.MeshBasicMaterial||material instanceof THREE.PointsMaterial||material instanceof THREE.SpriteMaterial)material.color.copy(bloom?BLOOM_GLOW:ICE_GLOW);
  variants.set(base,material);return material;
 }
 set(object:THREE.Object3D,theme:GrootSkillTheme):void {
  const drawable=object as THREE.Mesh;
  if(drawable.material){
   let base=this.originals.get(object);if(!base){base=drawable.material;this.originals.set(object,base);}
   drawable.material=theme==='wood'?base:Array.isArray(base)?base.map(m=>this.variant(m,theme)):this.variant(base,theme);
   object.userData.skillTheme=theme;
  }
  if(object instanceof THREE.Light){let base=this.lightColors.get(object);if(!base){base=object.color.clone();this.lightColors.set(object,base);}object.color.copy(theme==='ice'?ICE_GLOW:theme==='bloom'?BLOOM_GLOW:base);}
 }
 tree(root:THREE.Object3D,theme:GrootSkillTheme):void{root.traverse(o=>this.set(o,theme));root.userData.skillTheme=theme;}
 dispose():void{for(const material of this.variants.values())material.dispose();this.variants.clear();for(const material of this.bloomVariants.values())material.dispose();this.bloomVariants.clear();}
}
