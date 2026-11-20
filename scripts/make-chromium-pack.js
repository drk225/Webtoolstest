// Runs as this repo's `postinstall` (see package.json). Packs the full @sparticuz/chromium
// dev-dependency's Chromium binary into a single tar, written to the repo root so it's served
// as a plain static file (same as every other file here — this repo has no /public subfolder,
// the root *is* the static root) at <deployment>/chromium-pack.tar. api/price.js points
// @sparticuz/chromium-min at that URL at runtime to download and unpack the binary into /tmp.
//
// @sparticuz/chromium (full package, with the binary) is a devDependency only — Vercel's build
// installs it to run this script, but it's never part of the deployed function; only the much
// smaller @sparticuz/chromium-min ships at runtime.
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// Deliberately fails loud (non-zero exit) on any problem below, rather than logging and
// continuing — a silent miss here means a Vercel build that "succeeds" but ships an /api/price
// function with no Chromium to launch, which is a much worse failure mode to debug than a build
// that visibly fails with a clear reason in the build log.
function main() {
  let chromiumPkgJsonPath;
  try {
    chromiumPkgJsonPath = require.resolve('@sparticuz/chromium/package.json');
  } catch (e) {
    throw new Error('[make-chromium-pack] @sparticuz/chromium not found in node_modules — is it still ' +
      'listed in package.json devDependencies?');
  }

  const chromiumDir = path.dirname(chromiumPkgJsonPath);
  const binDir = path.join(chromiumDir, 'bin');
  if (!fs.existsSync(binDir)) {
    throw new Error(`[make-chromium-pack] expected a bin/ directory at ${binDir} but it isn't there. ` +
      '@sparticuz/chromium may have changed its package layout — check its current README.');
  }

  const repoRoot = path.resolve(__dirname, '..');
  const tarPath = path.join(repoRoot, 'chromium-pack.tar');

  console.log(`[make-chromium-pack] packing ${binDir} -> ${tarPath}`);
  // `tar` is present on Vercel's Linux build image; if you're running `npm install` locally on
  // Windows and don't have `tar` on PATH, this step will just fail loudly here and the function
  // will error until a real deploy (which does have tar) runs it.
  execFileSync('tar', ['-cf', tarPath, '-C', binDir, '.'], { stdio: 'inherit' });
  console.log('[make-chromium-pack] done.');
}

main();
