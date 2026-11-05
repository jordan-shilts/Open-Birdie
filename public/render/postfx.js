// Post-processing for GolfScene — bloom + SMAA over the base render.
// Stock three.js passes only (see docs/visual-upgrade-plan.md, Step 1):
//   RenderPass -> UnrealBloomPass -> OutputPass (tone map + sRGB + grade) -> SMAAPass (FXAA at Low) -> CAS.
// SAO/SSAO are intentionally omitted: the terrain is a flat height grid with
// nothing to self-occlude, and SAO haloes over the 12000m far plane.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { RENDER_CONFIG } from './config.js';
import { replaceGtaoNoiseTexture } from './gtao-noise.js';

// Cinematic grade in display space (after tone-map/sRGB): gentle contrast +
// saturation, a warm-highlight / cool-shadow split-tone, and a soft vignette. It runs at
// the end of the OutputPass (gradeInto), not as a pass of its own: that was one more
// full-screen read and write a frame for a few multiply-adds a pixel (~0.2 ms at 1.3 MP
// on the dev Mac, several ms on the sim PC's integrated GPU; docs/machines.md).
const GRADE_UNIFORMS = {
  // natural: the old 1.16 saturation pushed sunlit turf toward lime once the sun
  // became the key light
  uContrast: 1.08,
  uSaturation: 1.08,
  uVignette: 0.34,
};
const GRADE_GLSL = `
  {
    vec3 col = (gl_FragColor.rgb - 0.5) * uContrast + 0.5;   // contrast
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(l), col, uSaturation);                 // saturation
    col += vec3(0.006, 0.004, -0.012) * (1.0 - l);        // warm, desaturated shadows (turf greens, not blue)
    col += vec3(0.028, 0.018, -0.012) * l;                // warm highlights
    float v = smoothstep(0.85, 0.42, length(vUv - 0.5));  // vignette
    col *= mix(1.0, v, uVignette);
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), gl_FragColor.a);
  }`;

// The grade appended to an OutputPass's shader, after its tone mapping and sRGB encode.
// OutputPass rebuilds only its defines when the tone mapping changes, never the shader
// text, so the grade stays.
export function gradeInto(pass) {
  const m = pass.material;
  for (const [k, v] of Object.entries(GRADE_UNIFORMS)) m.uniforms[k] = { value: v };
  const fs = m.fragmentShader.replace('varying vec2 vUv;', 'varying vec2 vUv;\nuniform float uContrast, uSaturation, uVignette;');
  const end = fs.lastIndexOf('}');
  if (end < 0 || fs === m.fragmentShader) throw new Error('OutputPass shader changed: the grade has nowhere to go');
  m.fragmentShader = fs.slice(0, end) + GRADE_GLSL + '\n' + fs.slice(end);
  m.needsUpdate = true;
  return pass;
}

// Contrast-adaptive sharpening (after AMD FidelityFX CAS): restores detail when the frame
// is rendered under the display's resolution (dynamic resolution, retina budgets),
// sharpening flat detail more than edges that are already crisp.
const CAS_SHADER = {
  uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) }, uSharp: { value: 0.2 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uSharp; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      vec3 n = texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb, s = texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb;
      vec3 e = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb, w = texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb;
      vec3 mn = min(c, min(min(n, s), min(e, w))), mx = max(c, max(max(n, s), max(e, w)));
      vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
      vec3 wt = -amp / mix(8.0, 5.0, uSharp);
      vec3 col = ((n + s + e + w) * wt + c) / (1.0 + 4.0 * wt);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    const size = renderer.getSize(new THREE.Vector2());

    // EffectComposer reads renderer.getPixelRatio() and uses HalfFloat targets,
    // so the scene stays HDR/linear until OutputPass tone-maps it. The targets carry a
    // depth TEXTURE so GTAO can read the main pass's depth instead of drawing the whole
    // course again into its own normal/depth buffers (one geometry pass a frame fewer).
    const target = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: THREE.HalfFloatType });
    target.depthTexture = new THREE.DepthTexture(Math.max(1, size.x), Math.max(1, size.y));
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));

    // GTAO for contact grounding (tree bases, terrain folds, bunker lips). Small
    // WORLD-space radius + steep falloff so it darkens only nearby contacts and
    // never haloes over the 12000m far plane (the reason plain SAO was omitted).
    if (RENDER_CONFIG.gtao) {
      const gtao = new GTAOPass(scene, camera, size.x, size.y);
      replaceGtaoNoiseTexture(gtao);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.updateGtaoMaterial({
        radius: 1.6, distanceExponent: 2.0, thickness: 1.0,
        scale: 1.4, samples: 12, distanceFallOff: 1.0, screenSpaceRadius: false,
      });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 16 });
      // GTAO's normal/depth pre-pass renders the scene with ONE override material,
      // which ignores alpha cutouts and transparency: every leaf card, flower bush,
      // tracer ribbon and haze band became a solid quad in the AO buffers, greying
      // the sky in card-shaped 'glass shards' around canopies. Keep cutout and
      // transparent geometry out of the AO pre-pass (it has real shadows anyway).
      const hideBase = gtao._overrideVisibility.bind(gtao);
      gtao._overrideVisibility = function overrideVisibility() {
        hideBase();
        const cache = this._visibilityCache;
        this.scene.traverse((o) => {
          if (!o.visible) return;
          const m = o.material;
          if (o.userData?.noAO || (m && !Array.isArray(m) && (m.transparent || m.alphaTest > 0))) {
            o.visible = false;
            cache.push(o);
          }
        });
      };
      // AO buffers at a fraction of the frame (quality.js aoScale): the pre-pass,
      // the GTAO march and the denoise all scale with pixels; the blend upsamples.
      this.aoScale = 1;
      const gtaoSetSize = gtao.setSize.bind(gtao);
      gtao.setSize = (w, h) => gtaoSetSize(Math.max(1, Math.round(w * this.aoScale)), Math.max(1, Math.round(h * this.aoScale)));
      this.composer.addPass(gtao);
      this.gtao = gtao;
      // read the scene depth the RenderPass just wrote; normals are rebuilt from it
      // (GTAO's own normal pass — and its whole-scene draw — is skipped)
      gtao.setGBuffer(this.composer.readBuffer.depthTexture);
      // Normals rebuilt from depth go wrong at depth edges past a few dozen metres (a
      // 12 km far plane leaves little depth precision), where AO printed dark tree-shaped
      // halos on the turf behind distant trees. A 1.6 m contact AO only matters up close
      // (grounding.js lays the tree-base contact shadows), so fade it out from 35 to 70 m.
      const gm = gtao.gtaoMaterial;
      gm.fragmentShader = gm.fragmentShader.replace(
        'ao = pow(ao, scale);',
        'ao = pow(ao, scale);\n\t\t\tao = mix(ao, 1.0, smoothstep(35.0, 70.0, length(viewPos)));',
      );
      gm.needsUpdate = true;
    }

    // Bloom must NOT touch turf: sun-lit bright grass (esp. the greens) sits near
    // linear 1.0, so a 1.0 threshold haloed the greens into glowing blobs at the
    // overview camera. Raise the threshold to 1.6 so only true speculars (sun glint
    // on water, the brightest sand) bloom, and keep strength low. (strength, radius, threshold).
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.06, 0.4, 1.6);
    this.composer.addPass(this.bloom);

    // OutputPass applies renderer.toneMapping + toneMappingExposure and converts
    // to the renderer's output color space (composer render targets are linear); the
    // cinematic grade runs at its end, in display space, before SMAA.
    const output = new OutputPass();
    if (RENDER_CONFIG.colorGrade) gradeInto(output);
    this.composer.addPass(output);

    // Composer render targets carry no MSAA; SMAA antialiases the final image.
    // (The last pass renders to the default framebuffer, so preserveDrawingBuffer
    // still captures the composited frame for the screenshot/recording path.)
    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);
    // Low's antialiasing instead (setQuality, quality.js aa): one pass where SMAA takes three
    this.fxaa = new FXAAPass();
    this.fxaa.enabled = false;
    this.composer.addPass(this.fxaa);
    // sharpening last, over the antialiased frame (setSharpness follows the upscale)
    this.cas = new ShaderPass(CAS_SHADER);
    this.composer.addPass(this.cas);
  }

  // Graphics quality (quality.js): toggle the optional passes live.
  setQuality({ gtao = true, bloom = true, aoScale = 1, aa = 'smaa' } = {}) {
    this.aoScale = aoScale;
    if (this.gtao) this.gtao.enabled = !!gtao;
    if (this.bloom) this.bloom.enabled = !!bloom;
    this.smaa.enabled = aa !== 'fxaa';
    this.fxaa.enabled = aa === 'fxaa';
  }

  setSize(w, h) {
    // Track the renderer's current pixel ratio, then size the composer; it
    // multiplies by pixelRatio internally and propagates to every pass.
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.cas.uniforms.uTexel.value.set(1 / Math.max(1, w * pr), 1 / Math.max(1, h * pr));
  }

  setSharpness(v) {
    this.cas.uniforms.uSharp.value = v;
  }

  render() {
    // the composer ping-pongs its targets: point GTAO at the one the scene renders into
    if (this.gtao?.enabled) this.gtao.setGBuffer(this.composer.readBuffer.depthTexture);
    this.composer.render();
  }
}
