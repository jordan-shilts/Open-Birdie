'use strict';
// electron-builder hook (package.json build.onNodeModuleFile). electron-builder drops every
// dependency's top-level "examples" folder, but the renderer imports the three.js addons
// (post-processing, HDR/glTF/Draco loaders, Reflector, ...) from three/examples/jsm through
// /vendor/three/ — without this the packaged app can't load its renderer. Force-include that
// folder; build.files then drops examples/fonts, which nothing uses.
module.exports = (file) => /[\\/]node_modules[\\/]three[\\/]examples(?:[\\/]jsm(?:[\\/]|$)|$)/.test(file);
