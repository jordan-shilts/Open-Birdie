// Depth pre-pass for water shoreline foam. Renders the course depth with the
// water meshes hidden, into a DepthTexture the water material samples to find
// where terrain sits just under the surface (the shallow/contact zone -> foam).
//
// We never override the WATER material (that path broke the turf shader for GTAO
// — see config.gtao). This pass uses MeshDepthMaterial as a temporary scene
// override so it skips lighting/env/splat work, then restores it immediately —
// the turf's onBeforeCompile program is bypassed, not recompiled.
import * as THREE from 'three';

export function makeWaterDepth(renderer) {
  const size = renderer.getSize(new THREE.Vector2());

  const depthTexture = new THREE.DepthTexture(1, 1);
  depthTexture.type = THREE.UnsignedIntType; // 24-bit; smooth foam over the 0.3..12000m frustum
  depthTexture.minFilter = THREE.NearestFilter;
  depthTexture.magFilter = THREE.NearestFilter;

  const target = new THREE.WebGLRenderTarget(1, 1, {
    depthTexture, depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });

  const resolution = new THREE.Vector2();
  let verified = false;   // framebuffer completeness checked since the last resize

  function setSize(w, h) {
    const ratio = renderer.getPixelRatio();
    const W = Math.max(1, Math.floor(w * ratio)), H = Math.max(1, Math.floor(h * ratio));
    if (W !== target.width || H !== target.height) {
      target.setSize(W, H);
      // RenderTarget.setSize resizes only the colour attachment: the depth texture kept
      // its old GPU storage, so the next pre-pass hit an incomplete framebuffer
      // (attachments of different sizes). Free it so it is rebuilt at the new size.
      depthTexture.dispose();
      verified = false;
    }
    resolution.set(W, H); // device pixels, to match gl_FragCoord.xy
  }
  setSize(size.x, size.y);

  // Only the TERRAIN sits under the water, so render just that mesh into the depth
  // target. Its turf material is swapped for a depth-only one for this one render
  // (the turf shader was the whole cost: ~3.5 ms a frame for depth alone); the
  // material objects are restored untouched, so nothing recompiles.
  const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
  const swapped = [];
  function prepass(terrain, camera) {
    if (!terrain) return;
    terrain.traverse((o) => { if (o.isMesh) { swapped.push(o, o.material); o.material = depthOnly; } });
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    if (!verified) {
      // Once per size: a depth texture can keep GPU storage from an earlier size (or
      // from a pass that bound it first), which leaves this framebuffer incomplete.
      // Rebuild both attachments if so.
      const gl = renderer.getContext();
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        target.dispose();
        depthTexture.dispose();
        renderer.setRenderTarget(target);
      }
      verified = true;
    }
    renderer.clear(true, true, false);
    try { renderer.render(terrain, camera); } finally {
      renderer.setRenderTarget(prevTarget);
      for (let i = 0; i < swapped.length; i += 2) swapped[i].material = swapped[i + 1];
      swapped.length = 0;
    }
  }

  function dispose() { target.dispose(); depthTexture.dispose(); depthOnly.dispose(); }

  return { depthTexture, resolution, prepass, setSize, dispose };
}
