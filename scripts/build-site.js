#!/usr/bin/env node
/* Assembles the deployable site into _site/.
 *
 * There is no build step in the usual sense - nothing is compiled or bundled.
 * This only copies the files that should reach a phone and leaves behind the
 * ones that should not: the tests, the build scripts, the vendored design
 * prototypes and the README.
 *
 * It also refuses to produce a site that is internally inconsistent, which is
 * the failure that would otherwise only show up as a blank screen on someone's
 * phone: a script tag pointing at a file that is not there, or a file missing
 * from the service worker's shell list so the app half works offline.
 *
 *   node scripts/build-site.js [outDir]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, process.argv[2] || '_site');

// Everything that ships. Directories are copied whole.
const INCLUDE = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'assets',
];

function copy(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) copy(path.join(from, entry), path.join(to, entry));
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function listFiles(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/* --------------------------------------------------------------- assemble */

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const entry of INCLUDE) {
  const from = path.join(ROOT, entry);
  if (!fs.existsSync(from)) {
    console.error(`Missing ${entry}`);
    process.exit(1);
  }
  copy(from, path.join(OUT, entry));
}

// Pages serves the uploaded artifact as-is, but this costs nothing and makes
// the intent explicit for any other static host that does run Jekyll.
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

const shipped = listFiles(OUT, OUT, []);

/* ---------------------------------------------------------------- verify */

const problems = [];
const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(OUT, 'sw.js'), 'utf8');

// Every local src/href in index.html must have landed in the output.
const referenced = [];
const refPattern = /(?:src|href)="([^"]+)"/g;
let match;
while ((match = refPattern.exec(html)) !== null) {
  const ref = match[1];
  if (/^(https?:)?\/\//.test(ref) || ref.charAt(0) === '#' || ref.indexOf('data:') === 0) continue;
  referenced.push(ref.replace(/^\.\//, ''));
}
for (const ref of referenced) {
  if (shipped.indexOf(ref) < 0) problems.push(`index.html references ${ref}, which is not in the site`);
}

// An absolute path would break a project site served from /<repo>/.
const absolute = referenced.filter((ref) => ref.charAt(0) === '/');
for (const ref of absolute) {
  problems.push(`index.html uses the absolute path ${ref}; GitHub Pages serves this app from a subdirectory, so paths must be relative`);
}

// The service worker's shell list is what makes the app work with no signal.
// Every script and stylesheet the page loads has to be in it, or the app comes
// back half broken on a phone with no reception.
const shellBlock = /var SHELL = \[([\s\S]*?)\];/.exec(sw);
if (!shellBlock) {
  problems.push('sw.js has no SHELL list to check');
} else {
  const shell = [];
  const shellPattern = /'([^']+)'/g;
  let entry;
  while ((entry = shellPattern.exec(shellBlock[1])) !== null) shell.push(entry[1]);

  for (const ref of referenced) {
    const isCode = /\.(js|css|webmanifest)$/.test(ref);
    if (isCode && shell.indexOf(ref) < 0) {
      problems.push(`${ref} is loaded by index.html but missing from the SHELL list in sw.js, so it will not be cached for offline use`);
    }
  }
  for (const ref of shell) {
    if (ref === './') continue;
    if (shipped.indexOf(ref) < 0) problems.push(`sw.js caches ${ref}, which is not in the site`);
  }
}

if (problems.length) {
  console.error('Site build failed:\n');
  problems.forEach((p) => console.error('  ' + p));
  process.exit(1);
}

let bytes = 0;
for (const file of shipped) bytes += fs.statSync(path.join(OUT, file)).size;

console.log(`Built ${path.relative(ROOT, OUT) || '.'}: ${shipped.length} files, ${(bytes / 1024).toFixed(0)} KB`);
