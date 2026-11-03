'use strict';
// One HD hole in a process of its own, for cloud/hd-holes.js (runHoleInChild): takes
// { coursePath, hole, manifest } from the parent, builds the hole with the HD tools into
// BIRDIE_DATA_DIR/hd-courses (the environment is the parent's), and answers
// { bundleId } or { code, message }. It exits once the answer is out, whatever the HD
// tools left open, and at once if the build that started it goes away.
// CommonJS on purpose: it loads synchronously, so both listeners are on before the
// parent's message can arrive, whatever Node does with a message nobody listens for.

const fs = require('node:fs');
const { buildOneHole, loadTools } = require('./hd-holes');

// The parent died (killed, out of memory): nobody will read the answer, so stop rather
// than build the rest of the hole as an orphan.
process.once('disconnect', () => process.exit(1));

process.once('message', async ({ coursePath, hole, manifest }) => {
  let answer;
  try {
    let tools;
    try { tools = await loadTools(); }
    catch (error) { throw Object.assign(new Error(`HD tools unavailable: ${error.message}`), { code: 'HD_TOOLS_UNAVAILABLE' }); }
    const course = JSON.parse(fs.readFileSync(coursePath, 'utf8'));
    const { bundleId } = await buildOneHole(tools, { course, hole, manifest });
    answer = { bundleId };
  } catch (error) {
    answer = { code: String((error && error.code) || 'HD_BUILD_FAILED'), message: String((error && error.message) || error).slice(0, 200) };
  }
  process.send(answer, () => process.exit(0));
});
