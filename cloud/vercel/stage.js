'use strict';
// Stages the Vercel deployment of the cloud course service in one folder: the API
// function, the cloud modules it loads and their lib/ helpers, with this folder's
// package.json and vercel.json at its root. Nothing else is deployed — builds run in
// a Vercel Sandbox from a git checkout of the repository (cloud/sandbox-jobs.js).
//
//   node cloud/vercel/stage.js <dir>        then, in <dir>:  vercel deploy --prod
//
// Only these files are written (overwritten if present); anything else in <dir>,
// such as the .vercel project link from an earlier deploy, is left alone.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// [source in the repository, path in the deployment]
const FILES = [
  ['api/index.js', 'api/index.js'],
  ['cloud/app.js', 'cloud/app.js'],
  ['cloud/store.js', 'cloud/store.js'],
  ['cloud/vercel-blob-store.js', 'cloud/vercel-blob-store.js'],
  ['cloud/sandbox-jobs.js', 'cloud/sandbox-jobs.js'],
  ['lib/course-identity.js', 'lib/course-identity.js'],
  ['lib/course-key.js', 'lib/course-key.js'],
  ['cloud/vercel/package.json', 'package.json'],
  ['cloud/vercel/vercel.json', 'vercel.json'],
];

function stage(dir) {
  for (const [from, to] of FILES) {
    const target = path.join(dir, to);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, from), target);
  }
  return FILES.map(([, to]) => to);
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node cloud/vercel/stage.js <dir>');
    process.exit(2);
  }
  const files = stage(path.resolve(dir));
  console.log(`staged ${files.length} files in ${path.resolve(dir)}`);
}

module.exports = { FILES, stage };
