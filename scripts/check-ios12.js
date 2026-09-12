#!/usr/bin/env node
/* Guards the Safari 12 floor.
 *
 * An iPhone 6 tops out at iOS 12.5.7, and the app has to work there. Newer
 * APIs are welcome, but only behind a detection with a stated fallback, and
 * those all live in assets/js/capabilities.js. This script enforces both
 * halves of that:
 *
 *   SYNTAX rules are absolute. A `?.` on any line is a parse error on the
 *   target device, which stops the whole file from running - no amount of
 *   feature detection saves it. These are checked in every shipped file,
 *   capabilities.js included.
 *
 *   API rules are about reach, not parsing. They are allowed in the capability
 *   module, and anywhere else on a line marked `// caps-ok` for a use that is
 *   guarded in place. Everywhere else they fail, so a stray unguarded call
 *   cannot slip into the app.
 *
 * Usage: node scripts/check-ios12.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Only the files that actually reach the phone are checked. Build scripts,
// tests and the vendored design prototypes run elsewhere and are exempt.
const SHIPPED = ['assets', 'sw.js'];

// Where post-floor APIs are allowed to be named.
const CAPABILITY_FILES = [path.join('assets', 'js', 'capabilities.js')];

// An inline escape hatch for a guarded one-off outside the capability module.
const INLINE_ALLOW = '// caps-ok';

/* Parse errors on Safari 12. Never allowed, anywhere. */
const SYNTAX_RULES = [
  [/(^|[^?\w.])\?\.(?![\d])/, 'optional chaining `?.` (Safari 13.1)'],
  [/\?\?[^=]|\?\?$/, 'nullish coalescing `??` (Safari 13.1)'],
  [/\|\|=|&&=|\?\?=/, 'logical assignment operators (Safari 14)'],
  [/^\s*(static\s+)?#[A-Za-z_]/m, 'private class fields (Safari 14.1)'],
  [/^\s*static\s*\{/m, 'static initialisation blocks (Safari 16.4)'],
];

/* Post-floor APIs. Allowed only in the capability module, or on a marked line. */
const API_RULES = [
  [/\bObject\.fromEntries\b/, 'Object.fromEntries (Safari 12.1)'],
  [/\bglobalThis\b/, 'globalThis (Safari 12.1)'],
  [/\bqueueMicrotask\b/, 'queueMicrotask (Safari 12.1)'],
  [/\bPromise\.allSettled\b/, 'Promise.allSettled (Safari 13)'],
  [/\bPromise\.any\b/, 'Promise.any (Safari 15)'],
  [/\.replaceAll\s*\(/, 'String.replaceAll (Safari 13.1)'],
  [/\.matchAll\s*\(/, 'String.matchAll (Safari 13)'],
  [/\.at\s*\(\s*-?\d/, 'Array.at (Safari 15.4)'],
  [/\.flatMap\s*\(/, 'Array.flatMap (Safari 12, unreliable on 12.0)'],
  [/\bstructuredClone\b/, 'structuredClone (Safari 15.4)'],
  [/\bResizeObserver\b/, 'ResizeObserver (Safari 13.1)'],
  [/\bBroadcastChannel\b/, 'BroadcastChannel (Safari 15.4)'],
  [/\bnavigator\.storage\b|\bnav\.storage\b/, 'navigator.storage (Safari 15.2)'],
  [/\.persisted\s*\(|\.persist\s*\(/, 'StorageManager.persist (Safari 15.2)'],
  [/\bnavigator\.mediaSession\b|\bnav\.mediaSession\b/, 'Media Session API (Safari 15)'],
  [/\bMediaMetadata\b/, 'MediaMetadata (Safari 15)'],
  [/\bsetPositionState\b/, 'MediaSession.setPositionState (Safari 15.4)'],
  [/\bnavigator\.audioSession\b|\bnav\.audioSession\b/, 'navigator.audioSession (Safari 16.4)'],
  [/\brequestIdleCallback\b/, 'requestIdleCallback (Safari 18)'],
  [/\.arrayBuffer\s*\(/, 'Blob.arrayBuffer (Safari 14)'],
  [/beforeinstallprompt/, 'beforeinstallprompt (Chromium only)'],
  [/\bWakeLock\b|navigator\.wakeLock/, 'Screen Wake Lock API (not on iOS at all)'],
  [/\bshowOpenFilePicker\b|\bgetDirectory\s*\(/, 'File System Access / OPFS (Safari 15.2)'],
];

/* CSS that is silently ignored on Safari 12, taking the layout with it. */
const CSS_RULES = [
  [/^\s*(row-|column-)?gap\s*:/m, 'flexbox `gap` is unsupported until Safari 14.1 - use margins'],
  [/^\s*inset\s*:/m, '`inset` shorthand (Safari 14.1) - write out top/right/bottom/left'],
  [/conic-gradient/, 'conic-gradient (Safari 12.2) - use an SVG ring'],
  [/aspect-ratio\s*:/, 'aspect-ratio (Safari 15)'],
  [/:is\(|:where\(/, ':is() / :where() (Safari 14)'],
  [/\d(dvh|svh|lvh|dvw|svw|lvw)\b/, 'dynamic viewport units (Safari 15.4)'],
  [/color-mix\(|oklch\(|oklab\(/, 'modern colour functions (Safari 15+)'],
  [/accent-color\s*:/, 'accent-color (Safari 15.4)'],
  [/@container/, 'container queries (Safari 16)'],
  [/text-wrap\s*:/, 'text-wrap (Safari 17.4)'],
  [/@layer\b/, 'cascade layers (Safari 15.4)'],
];

/* CSS that Safari 12 ignores harmlessly, so it is fine on its own line but
 * never as the only way a rule works. Each must sit in its own rule block,
 * which is checked by hand rather than here. */
const CSS_PROGRESSIVE = [':focus-visible', 'overscroll-behavior'];

function collect() {
  const out = [];
  for (const entry of SHIPPED) {
    const full = path.join(ROOT, entry);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function blankComments(text, lineComments) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  if (lineComments) out = out.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return out;
}

const failures = [];

function fail(rel, line, label, source) {
  failures.push(`${rel}:${line}  ${label}\n    ${source.trim()}`);
}

for (const file of collect()) {
  const rel = path.relative(ROOT, file);
  const raw = fs.readFileSync(file, 'utf8');

  if (file.endsWith('.js')) {
    const isCapabilityModule = CAPABILITY_FILES.indexOf(rel) >= 0;
    const rawLines = raw.split('\n');
    const lines = blankComments(raw, true).split('\n');

    lines.forEach((line, i) => {
      for (const [pattern, label] of SYNTAX_RULES) {
        if (pattern.test(line)) fail(rel, i + 1, label, rawLines[i]);
      }
      if (isCapabilityModule) return;
      if (rawLines[i].indexOf(INLINE_ALLOW) >= 0) return;
      for (const [pattern, label] of API_RULES) {
        if (pattern.test(line)) {
          fail(rel, i + 1, `${label} - put it in assets/js/capabilities.js, or mark the line \`${INLINE_ALLOW}\``, rawLines[i]);
        }
      }
    });
  } else if (file.endsWith('.css')) {
    const rawLines = raw.split('\n');
    blankComments(raw, false).split('\n').forEach((line, i) => {
      for (const [pattern, label] of CSS_RULES) {
        if (pattern.test(line)) fail(rel, i + 1, label, rawLines[i]);
      }
    });
  }
}

// Every backdrop-filter needs the -webkit- prefix that iOS 12 actually reads.
const css = fs.readFileSync(path.join(ROOT, 'assets', 'css', 'app.css'), 'utf8');
const plain = (css.match(/(^|[^-])backdrop-filter\s*:/g) || []).length;
const prefixed = (css.match(/-webkit-backdrop-filter\s*:/g) || []).length;
if (plain > prefixed) {
  failures.push('assets/css/app.css  backdrop-filter used without a matching -webkit-backdrop-filter');
}

// Progressive CSS must never share a selector list with a rule the app needs,
// because Safari 12 throws away the whole rule when one selector is unknown.
for (const token of CSS_PROGRESSIVE) {
  const pattern = new RegExp('^[^{\\n]*,[^{\\n]*' + token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm');
  if (pattern.test(css)) {
    failures.push(`assets/css/app.css  \`${token}\` shares a selector list; Safari 12 drops the whole rule. Give it its own block.`);
  }
}

if (failures.length) {
  console.error('iOS 12 compatibility check failed:\n');
  failures.forEach((f) => console.error('  ' + f + '\n'));
  process.exit(1);
}

console.log('iOS 12 compatibility check passed.');
