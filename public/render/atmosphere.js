import * as THREE from 'three';
import { RENDER_CONFIG } from './config.js';

// Aerial perspective. THREE's FogExp2 is purely quadratic in depth — near-zero haze
// across the whole playable course, then a wall of fog — so the course read as one
// flat, equally-saturated plane. The fog curve below adds a LINEAR term: a light,
// even recession through the course (layers of depth between tee and green) that
// still closes to the horizon colour by a few km, where the ground apron ends. Kept
// light: at address the player reads the green 300-500 m off through it (about 5%
// haze at 350 m, from 6.6% with the old 0.32).
// Patched once at module load, before any material compiles; only the FOG_EXP2 path
// changes, so linear THREE.Fog users are untouched.
THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogD = fogDensity * vFogDepth;
    float fogFactor = 1.0 - exp( - fogD * ( 0.2 + fogD ) );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`;

// Fog tinted to the HDRI horizon. horizonColor may be a hex (sRGB, legacy) or a
// THREE.Color already in linear working space (matches the rendered sky exactly).
export function makeAerialFog(horizonColor) {
  return new THREE.FogExp2(horizonColor, RENDER_CONFIG.fogDensity);
}
