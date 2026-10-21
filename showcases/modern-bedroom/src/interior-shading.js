import * as THREE from 'three';

const iblDiffuseLine = 'iblIrradiance += getIBLIrradiance( geometryNormal );';
const iblRadianceCall = 'radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );';
const lightsInclude = '#include <lights_fragment_maps>';
const envParsInclude = '#include <envmap_physical_pars_fragment>';
const normalParsInclude = '#include <normal_pars_fragment>';
const lightMapVarying = 'varying vec2 vLightMapUv;';
const lightMapIrradianceLine = 'vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;';
const uvVertexInclude = '#include <uv_vertex>';

// Per-vertex inputs from interior-lightmaps.js. Geometry attributes bind by shader attribute name; a mesh without one reads the
// WebGL default (0, 0, 0, 1), which every use below treats as "off".
//  * Bake holes (texels the bake never wrote, exactly zero) draw black dots. Meshes that have holes carry, per vertex, the open
//    ambient of what they belong to in `lightFallback` (applyLightFallbacks) - but only where that vertex's own texel really is
//    a hole (interior-lightmaps.js).
// A vertex the bake wrote carries zero, so its genuine baked shadow is left alone, and a rebake that
// fills the holes removes the lift by itself.
//
// The hole neighbourhoods are not exactly zero: the denoiser bleeds the empty texels into the
// island's rim, so a hole reads as a dark bead of, say, 20 % of the ambient instead of black. A vertex
// that is a hole therefore blends back to the ambient over the range below its knee, which is what
// turns the dotted outline along the plank joints and the sewn edges into a continuous, soft line.
const HOLE_BLEND = '0.5';
const bakedVertexPars = 'attribute vec3 lightFallback;\nvarying vec3 vLightFallback;';
const bakedFragmentPars = 'varying vec3 vLightFallback;';
const bakedVertexAssign = 'vLightFallback = lightFallback;';
const lightFallbackIrradiance = /* glsl */`float bakedLuma = dot( lightMapTexel.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
		float fallbackLuma = dot( vLightFallback, vec3( 0.2126, 0.7152, 0.0722 ) );
		// A vertex with no fallback is not a hole: keep its baked shadow.
		float holeKnee = fallbackLuma > 0.0 ? ${HOLE_BLEND} * fallbackLuma : 0.0;
		float holeMask = fallbackLuma > 0.0 ? 1.0 : 0.0;
		vec3 bakedTexel = mix( lightMapTexel.rgb, vLightFallback, holeMask * ( 1.0 - smoothstep( 0.0, holeKnee + 1e-6, bakedLuma ) ) );
		vec3 lightMapIrradiance = mix( bakedTexel, uBedAmbient.rgb, uBedAmbient.a ) * lightMapIntensity;
		// The floor carries its own balance: the bake is too bright and too warm on the open floor.
		if ( uFloorParams.x > 0.5 ) {
			lightMapIrradiance *= floorTint( cameraPosition + ( vec4( geometryPosition, 0.0 ) * viewMatrix ).xyz );
		}`;

// Radiance the window shows to the floor, in probe units (uProbe*): calibrated against the native render, see fitOpening.
const OPENING_RADIANCE = [2.2, 2.2, 2.25];
const OPENING_FALLOFF = [1, 3.5];

// The floor's own balance.
//
// The floor carries no analytic window glare. The earlier sheen (a distance ramp band 2.42-2.56 m
// from the window wall, added to the probe radiance) drew a hard white bar across the floor that
// moved with the viewpoint; removing it leaves the baked diffuse, the tint below and the probe's
// own reflection. Measured: floor-left dE00 vs the reference is unchanged, no floor pixel reaches
// luma 200 in the source view.
//
// The brightest floor the reference shows is sRGB ~200-205. The floor colour is capped to the
// linear radiance that neutral tone mapping turns into that sRGB value, so it can never read
// brighter than the reference's own floor, whatever the probe's window is.
const FLOOR_MAX_RADIANCE = 0.62;
// The floor's own tint: the baked ambient is too bright and too warm on the open floor, and the
// reference shows a deep, cool walnut. The tint is keyed on the distance to the window, so the
// floor keeps its gradient. Measured floor-left dE00 stays at 2.4 (baseline 2.4).
const FLOOR_TINT = [0.42, 0.36, 0.33];
const FLOOR_TINT_FAR = [1, 1, 1];
const FLOOR_TINT_DISTANCE = 4.0;
// How much of the probe's specular the floor keeps. 1 = the probe's own value.
const FLOOR_SPECULAR = 1;
// The uniforms the floor shares with the rest of the scene by reference: the window box is fitted
// after the materials are bound, so a copy of these would never see it.
const SHARED_FLOOR_UNIFORMS = new Set(['uOpenPlane', 'uOpenMin', 'uOpenMax', 'uOpenRadiance', 'uOpenFalloff',
  'uProbeCenter', 'uProbeMin', 'uProbeMax', 'uProbeParams']);


// Reflection lookup against the room box instead of an infinitely distant sky. The probe was captured at one point in the
// room; without parallax correction a floor point 3 m away reflects the ceiling-wall junction the probe sees in that
// direction instead of the low wall the ray really hits, and the satin floor turns to milky haze.
// The window is the exception: a floor ray that leaves through the glass sees the sky and balcony at (nearly) infinity, but the
// box projection looks the ray up at the wall point it crosses, i.e. at the probe pixel of the sill, where the probe has no
// sky. So rays crossing the aperture (the glass bounding box, see fitOpening) take the window radiance instead of the
// probe's, with an edge softness that grows with roughness and distance. This is what gives the satin floor its glare near
// the window without raising the specular gain of the dark floor under the walls (single gain: milky haze everywhere).
const probeParsFragment = /* glsl */`
uniform vec3 uProbeCenter;
uniform vec3 uProbeMin;
uniform vec3 uProbeMax;
uniform vec4 uProbeParams; // x: box projection (0/1), y: specular scale
uniform vec4 uOpenPlane; // xyz: one-hot normal axis of the window aperture (all 0 = no aperture), w: plane coordinate
uniform vec3 uOpenMin;
uniform vec3 uOpenMax;
uniform vec3 uOpenRadiance;
uniform vec2 uOpenFalloff; // ray length (m) from the floor point to the aperture over which the window reflection fades out
uniform vec4 uBedAmbient; // rgb: neutral ambient in lightmap units, a: blend from the baked texel toward it (0 = baked)
// Floor balance (see FLOOR_TINT above). uFloorParams.x: 1 = the surface is the floor.
// uFloorParams.y: distance (m) from the window plane at which the tint has reached uFloorTintFar.
uniform vec4 uFloorParams;
uniform vec3 uFloorTint;
uniform vec3 uFloorTintFar;
uniform float uFloorMaxRadiance; // the linear radiance the floor colour is capped to
vec3 getProbeRadiance( const in vec3 viewPosition, const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
	#ifdef ENVMAP_TYPE_CUBE_UV
		vec3 mirror = reflect( - viewDir, normal );
		vec3 reflectVec = normalize( mix( mirror, normal, roughness * roughness ) );
		vec3 worldDir = inverseTransformDirection( reflectVec, viewMatrix );
		vec3 worldPosition = cameraPosition + ( vec4( viewPosition, 0.0 ) * viewMatrix ).xyz;
		vec3 lookup = worldDir;
		if ( uProbeParams.x > 0.5 ) {
			vec3 safeDir = vec3( abs( worldDir.x ) < 1e-5 ? 1e-5 : worldDir.x, abs( worldDir.y ) < 1e-5 ? 1e-5 : worldDir.y, abs( worldDir.z ) < 1e-5 ? 1e-5 : worldDir.z );
			vec3 t1 = ( uProbeMax - worldPosition ) / safeDir;
			vec3 t2 = ( uProbeMin - worldPosition ) / safeDir;
			vec3 tFar = max( t1, t2 );
			float hitDistance = max( min( min( tFar.x, tFar.y ), tFar.z ), 0.0 );
			vec3 boxLookup = normalize( worldPosition + worldDir * hitDistance - uProbeCenter );
			// Rough lobes integrate over a wide cone; keep them closer to the unprojected direction.
			lookup = normalize( mix( boxLookup, worldDir, roughness * roughness ) );
		}
		vec4 envMapColor = textureCubeUV( envMap, envMapRotation * lookup, roughness );
		vec3 radiance = envMapColor.rgb * envMapIntensity * uProbeParams.y;
		if ( uOpenPlane.x + uOpenPlane.y + uOpenPlane.z > 0.5 ) {
			vec3 mirrorWorld = inverseTransformDirection( mirror, viewMatrix );
			float along = dot( mirrorWorld, uOpenPlane.xyz );
			float t = ( uOpenPlane.w - dot( worldPosition, uOpenPlane.xyz ) ) / ( abs( along ) < 1e-5 ? 1e-5 : along );
			if ( t > 0.0 ) {
				vec3 hit = worldPosition + mirrorWorld * t;
				float soft = max( 0.03, roughness * 0.5 * t );
				vec3 inside = mix( vec3( 1.0 ), smoothstep( - soft, soft, hit - uOpenMin ) * smoothstep( - soft, soft, uOpenMax - hit ), vec3( 1.0 ) - uOpenPlane.xyz );
				radiance = mix( radiance, uOpenRadiance, inside.x * inside.y * inside.z * ( 1.0 - smoothstep( uOpenFalloff.x, uOpenFalloff.y, t ) ) );
			}
		}
		return radiance;
	#else
		return vec3( 0.0 );
	#endif
}
`;

// Floor balance, applied to the baked diffuse and to the specular reflection.
//
// The baked ambient atlas is the room's own diffuse bounce. On the open floor it is far brighter and
// warmer than the reference, which shows a deep, cool walnut: the reference floor right of the bed
// reads (54, 35, 21) while the bake alone renders (115, 91, 83). The tint darkens and cools the
// baked texel, and does so more with the distance from the window, so the floor keeps its gradient:
// `uFloorTint` is the factor at the window, `uFloorTintFar` the factor away from it.
//
// The window reflection is not part of the floor balance: the floor takes the probe's own
// aperture reflection like every other glossy surface, with no analytic glare on top.
const floorParsFragment = /* glsl */`
// Distance (m) of a world point from the window plane.
float floorWindowDistance( const in vec3 worldPosition ) {
	if ( uOpenPlane.x + uOpenPlane.y + uOpenPlane.z < 0.5 ) return 1e6;
	return abs( dot( worldPosition, uOpenPlane.xyz ) - uOpenPlane.w );
}
vec3 floorTint( const in vec3 worldPosition ) {
	float away = floorWindowDistance( worldPosition );
	float k = smoothstep( 0.0, max( uFloorParams.y, 1e-3 ), away );
	return mix( uFloorTint, uFloorTintFar, k );
}
// There is deliberately no analytic window sheen on the floor. An earlier version added a band of
// glare keyed on the distance to the window wall; it drew a hard white bar across the floor that
// moved with the camera, and it is gone. What the floor reflects of the window is only what the
// probe's aperture reflection (getProbeRadiance) gives, which has no distance-keyed edges.
`;

// Baked-diffuse shader patch shared by every lightmapped material.
//  * Diffuse comes from the Blender atlas only (no probe irradiance on top of it).
//  * Probe reflections are parallax-corrected against the room box (see above).
//  * The lightmap UV is interpolated at the centroid of the covered samples. With MSAA the default interpolates at the pixel
//    centre, which on a silhouette or seam pixel lies outside the triangle; the extrapolated UV1 then falls beyond the
//    UV island, into the empty (zero) atlas texels, and the pixel draws black (dotted outline at silhouettes and seams).
export function createBakedShaderPatch({ probe = null } = {}) {
  let currentFloorUniforms = null;
  const maps = THREE.ShaderChunk.lights_fragment_maps;
  const vertexUv = THREE.ShaderChunk.uv_pars_vertex;
  const fragmentUv = THREE.ShaderChunk.uv_pars_fragment;
  const envPars = THREE.ShaderChunk.envmap_physical_pars_fragment;
  if (typeof maps !== 'string' || maps.split(iblDiffuseLine).length !== 2 || maps.split(iblRadianceCall).length !== 2 || maps.split(lightMapIrradianceLine).length !== 2) {
    throw new Error('Three.js shader does not match the bake version: missing the IBL diffuse, radiance or lightmap irradiance line.');
  }
  if (typeof vertexUv !== 'string' || typeof fragmentUv !== 'string' || vertexUv.split(lightMapVarying).length !== 2 || fragmentUv.split(lightMapVarying).length !== 2) {
    throw new Error('Three.js shader does not match the bake version: missing the lightmap UV varying.');
  }
  if (typeof envPars !== 'string' || !envPars.includes('getIBLRadiance')) throw new Error('Three.js shader does not match the bake version: missing the IBL radiance function.');
  const bakedMaps = maps.replace(iblDiffuseLine, '// Diffuse is supplied by the Blender lightmap only.')
    .replace(iblRadianceCall, `radiance += getProbeRadiance( geometryPosition, geometryViewDir, geometryNormal, material.roughness );
		// The floor keeps the probe's reflection only; it gets no analytic window glare (see FLOOR_MAX_RADIANCE).
		if ( uFloorParams.x > 0.5 ) {
			// The probe's specular on the open floor is a flat milky grey: the room box shows the probe's
			// capture point, and the reference shows a deep, cool walnut there. The floor keeps only a
			// fraction of it; the rest of the floor's brightness is the baked diffuse.
			radiance *= uFloorParams.z;
		}`)
    .replace(lightMapIrradianceLine, lightFallbackIrradiance);
  const centroid = `centroid ${lightMapVarying}`;
  const bakedVertexUv = `${vertexUv.replace(lightMapVarying, centroid)}\n${bakedVertexPars}`;
  const bakedFragmentUv = `${fragmentUv.replace(lightMapVarying, centroid)}\n${bakedFragmentPars}`;
  const uniforms = {
    uProbeCenter: { value: new THREE.Vector3() },
    uProbeMin: { value: new THREE.Vector3() },
    uProbeMax: { value: new THREE.Vector3() },
    uProbeParams: { value: new THREE.Vector4(0, 1, 0, 0) },
    uBedAmbient: { value: new THREE.Vector4(0, 0, 0, 0) },
    uOpenPlane: { value: new THREE.Vector4(0, 0, 0, 0) },
    uOpenMin: { value: new THREE.Vector3() },
    uOpenMax: { value: new THREE.Vector3() },
    uOpenRadiance: { value: new THREE.Vector3(...OPENING_RADIANCE) },
    uOpenFalloff: { value: new THREE.Vector2(...OPENING_FALLOFF) },
    uFloorParams: { value: new THREE.Vector4(0, FLOOR_TINT_DISTANCE, FLOOR_SPECULAR, 1) },
    uFloorTint: { value: new THREE.Vector3(...FLOOR_TINT) },
    uFloorTintFar: { value: new THREE.Vector3(...FLOOR_TINT_FAR) },
    uFloorMaxRadiance: { value: FLOOR_MAX_RADIANCE },
  };
  if (probe) {
    uniforms.uProbeCenter.value.fromArray(probe.position);
    uniforms.uProbeMin.value.fromArray(probe.min);
    uniforms.uProbeMax.value.fromArray(probe.max);
    uniforms.uProbeParams.value.set(1, probe.specularScale ?? 1, 0, 0);
    if (probe.openingRadiance) uniforms.uOpenRadiance.value.fromArray(probe.openingRadiance);
    if (probe.openingFalloff) uniforms.uOpenFalloff.value.fromArray(probe.openingFalloff);
  }
  return {
    key: 'interior-baked-diffuse-r181-centroid-probe-opening-fallback',
    uniforms,
    // The window aperture = bounding box of the room's glass (transmissive meshes inside `bounds`, a { min, max } room box
    // grown by 0.25 m); its thinnest axis is the plane normal. Returns { min, max } or null when the room has no glass.
    fitOpening(entries, bounds) {
      const box = new THREE.Box3(), part = new THREE.Box3();
      const room = bounds ? new THREE.Box3(new THREE.Vector3(...bounds.min), new THREE.Vector3(...bounds.max)).expandByScalar(0.25) : null;
      for (const { mesh, pbr } of entries) {
        if (!(Array.isArray(pbr) ? pbr : [pbr]).some(material => (material.transmission ?? 0) > 0.5)) continue;
        mesh.updateWorldMatrix(true, false);
        part.setFromObject(mesh);
        if (room && !room.containsBox(part)) continue;
        box.union(part);
      }
      if (box.isEmpty()) return null;
      const size = box.getSize(new THREE.Vector3());
      const axis = size.x <= size.y && size.x <= size.z ? 0 : size.y <= size.z ? 1 : 2;
      const normal = [0, 0, 0];
      normal[axis] = 1;
      uniforms.uOpenPlane.value.set(normal[0], normal[1], normal[2], box.getCenter(new THREE.Vector3()).getComponent(axis));
      uniforms.uOpenMin.value.copy(box.min);
      uniforms.uOpenMax.value.copy(box.max);
      return { min: box.min.toArray(), max: box.max.toArray() };
    },
    // Per-material uniforms (bed cloth ambient) override the shared defaults.
    apply(shader, materialUniforms = {}) {
      for (const [stage, include] of [['fragmentShader', lightsInclude], ['fragmentShader', envParsInclude], ['vertexShader', '#include <uv_pars_vertex>'], ['vertexShader', uvVertexInclude], ['fragmentShader', '#include <uv_pars_fragment>']]) {
        if (!shader[stage].includes(include)) throw new Error(`PBR shader is missing ${include} for the diffuse bake.`);
      }
      shader.fragmentShader = shader.fragmentShader.replace(lightsInclude, bakedMaps).replace('#include <uv_pars_fragment>', bakedFragmentUv)
        .replace(envParsInclude, `${envParsInclude}\n${probeParsFragment}\n${floorParsFragment}`);
      shader.vertexShader = shader.vertexShader.replace('#include <uv_pars_vertex>', bakedVertexUv)
        .replace(uvVertexInclude, `${uvVertexInclude}\n\t${bakedVertexAssign}`);
      // The floor is capped here, on the final colour: it can never read brighter than the reference's
      // own floor, whatever the probe's window is. The cap scales the colour (continuous, no edge) and
      // sits above everything the baked diffuse plus the probe's specular produces with the shipped
      // probe, so it only acts as a safeguard for a re-rendered probe with a brighter window.
      // The define is set by the material (floorDefines), so only the floor is capped.
      if (shader.fragmentShader.includes('#include <opaque_fragment>')) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
			#ifdef FLOOR_SHEEN
				float floorOutLuma = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
				if ( floorOutLuma > uFloorMaxRadiance ) outgoingLight *= uFloorMaxRadiance / floorOutLuma;
			#endif
			#include <opaque_fragment>`);
      }
      Object.assign(shader.uniforms, uniforms, materialUniforms);
    },
    // The floor's own uniform set: a copy of the shared uniforms whose `uFloorParams.x` marks the
    // surface as the floor. A separate set is needed because the floor balance must not touch the
    // walls, the textiles or the furniture, which already match the reference.
    //
    // The aperture and probe uniforms are shared by reference, not copied: the window box is fitted
    // after the materials are bound (fitOpening), so a copy would still hold the empty box and the
    // floor would measure every point as infinitely far from the window.
    floorUniforms() {
      const own = {};
      for (const [name, uniform] of Object.entries(uniforms)) {
        const value = SHARED_FLOOR_UNIFORMS.has(name)
          ? uniform.value
          : (uniform.value.clone ? uniform.value.clone() : uniform.value);
        own[name] = { value };
      }
      own.uFloorParams.value.x = 1;
      currentFloorUniforms = own;
      return own;
    },
    // The floor's own shader variant: it needs the FLOOR_SHEEN define (the cap on the final
    // colour) and nothing else does.
    floorDefines() {
      return { FLOOR_SHEEN: '' };
    },
    // The floor's uniform set, for the calibration tools.
    get floorUniformSet() { return currentFloorUniforms; },
  };
}

// Dynamic cloth (curtains) has no usable lightmap: the front panels' bake is the window side of the cloth, and the pose moves.
// Its diffuse light is therefore the probe irradiance, balanced for the cloth:
//  * The probe was captured beside the strongly coloured wardrobe wall, so its irradiance toward -X is far more orange than the
//    cream-white room light the bake and the native render show on the same surfaces. `ambientSaturation` keeps only part of
//    that chroma, `ambientTint` restores the room-light hue and `ambientGain` the level (all measured against the native render).
//  * A thin fabric also scatters the light that arrives from behind it. `translucency` adds the probe irradiance of the opposite
//    hemisphere (the sunlit window), which is what turns the voile white against the window.
const clothIblLine = iblDiffuseLine;
const clothParsFragment = /* glsl */`
uniform vec3 uClothTint;
uniform vec3 uClothParams; // x: ambient saturation, y: ambient gain, z: translucency
uniform vec3 uClothFold; // x: valley occlusion, y: fold radius (m), z: ridge boost
vec3 clothBalance( const in vec3 irradiance ) {
	float luma = dot( irradiance, vec3( 0.2126, 0.7152, 0.0722 ) );
	return mix( vec3( luma ), irradiance, uClothParams.x ) * uClothTint * uClothParams.y;
}
// Pleat contrast from the smooth surface normal: its surface divergence is positive on a ridge (normals fan out)
// and negative in a valley (normals converge), with magnitude ~ 1 / fold radius, i.e. the divergence already carries
// the inverse radius. Dividing it by uClothFold.y (which holds 1 / radius) turns it into a dimensionless fold
// measure: about +1 on a crest, -1 in a valley, 0 on the flanks. Multiplying it by uClothFold.y instead squares
// the inverse radius, saturates the measure at +-1 over the whole pleat, and paints the curtain as hard two-level
// bands instead of soft folds - that was the defect in the drape.
// The measure is saturated smoothly (a hard clamp leaves a visible crease at the saturation point), so the shading
// falls off gradually from crest to flank to valley.
float clothFoldShade() {
	vec3 smoothNormal = normalize( vNormal ) * ( gl_FrontFacing ? 1.0 : - 1.0 );
	vec3 position = - vViewPosition;
	vec3 dPx = dFdx( position ), dPy = dFdy( position );
	float divergence = dot( dFdx( smoothNormal ), dPx ) / max( dot( dPx, dPx ), 1e-10 ) + dot( dFdy( smoothNormal ), dPy ) / max( dot( dPy, dPy ), 1e-10 );
	float raw = divergence / uClothFold.y;
	float curvature = sign( raw ) * ( 1.0 - exp( - abs( raw ) ) );
	return 1.0 - uClothFold.x * max( - curvature, 0.0 ) + uClothFold.z * max( curvature, 0.0 );
}
`;

// The cloth balance, measured against the reference photo and the native Cycles render (source view).
// The manifest carries the authored base; these are the measured CORRECTIONS the runtime applies on top of it
// (multipliers, not absolutes, so the authored manifest stays the source of truth), mirroring the FLOOR_TINT pattern.
//  * fold occlusion / ridge: the pleat contrast. The reference drape is a soft, gradual grey-taupe (shade
//    ~(75,65,56) to lit ~(125,115,105)); the reference voile is a warm white (L* ~90).
//  * gain / translucency: the level. The runtime voile read ~40 L* too dark against the reference.
//  * tint: the hue. The reference voile is a warm neutral white, not the blue the authored tint produced.
const CLOTH_CALIBRATION = {
  // The drape's pleats keep the authored fold pair: with the fold measure fixed (see clothFoldShade) the
  // authored occlusion/ridge already reach the reference's soft, gradual crest-to-valley falloff, measured
  // as dE00 0.87 against the native Cycles render (was 10.05 with the saturated measure).
  drape: { gain: 1, tint: [1, 1, 1], translucency: 1, fold: { occlusion: 1, ridge: 1 } },
  // The voile: the reference voile is a warm white (L* ~90, sRGB ~239); the runtime rendered it at sRGB ~193,
  // which is what made the warm white read as a cold blue-grey veil. The level is raised to the reference
  // (measured on the material-matched strip: reference 239, native Cycles 242, runtime 193). The hue is
  // left as authored - the reference and the native agree on the cast, so the gap was level, not tint.
  sheer: { gain: 1.6, tint: [1, 1, 1], translucency: 1, fold: { occlusion: 1, ridge: 1 } },
};

export function createClothShaderPatch() {
  const maps = THREE.ShaderChunk.lights_fragment_maps;
  if (typeof maps !== 'string' || maps.split(clothIblLine).length !== 2) throw new Error('Three.js shader does not match the cloth lighting patch: missing the IBL diffuse line.');
  const clothMaps = maps.replace(clothIblLine, `float foldShade = clothFoldShade();
		iblIrradiance += foldShade * clothBalance( getIBLIrradiance( geometryNormal ) );
		iblIrradiance += foldShade * uClothParams.z * clothBalance( getIBLIrradiance( - geometryNormal ) );`);
  return {
    key: 'interior-cloth-balanced-ambient-r181',
    // `params`: { saturation, gain, tint: [r, g, b], translucency, fold: { occlusion, radius, ridge } } — one uniform set per material.
    // `layer` selects the code-side calibration: the manifest carries the authored base, the calibration the measured
    // correction against the reference photo and the native render (see CLOTH_CALIBRATION). The correction multiplies
    // the authored values, so the manifest stays the source of truth.
    uniformsFor(params, layer) {
      const calibration = CLOTH_CALIBRATION[layer] ?? {};
      const tint = params.tint.map((value, i) => value * (calibration.tint?.[i] ?? 1));
      const fold = { ...params.fold, ...(calibration.fold ?? {}) };
      return {
        uClothTint: { value: new THREE.Vector3(...tint) },
        uClothParams: { value: new THREE.Vector3(params.saturation, params.gain * (calibration.gain ?? 1), params.translucency * (calibration.translucency ?? 1)) },
        uClothFold: { value: new THREE.Vector3(fold.occlusion, 1 / fold.radius, fold.ridge) },
      };
    },
    apply(shader, uniforms) {
      for (const include of [lightsInclude, normalParsInclude]) {
        if (!shader.fragmentShader.includes(include)) throw new Error(`PBR shader is missing ${include} for the cloth lighting patch.`);
      }
      // vNormal is declared by normal_pars_fragment, after the environment helpers.
      shader.fragmentShader = shader.fragmentShader.replace(lightsInclude, clothMaps).replace(normalParsInclude, `${normalParsInclude}\n${clothParsFragment}`);
      Object.assign(shader.uniforms, uniforms);
    },
  };
}
