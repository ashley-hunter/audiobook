#!/usr/bin/env node
/* Guards the Safari 12 floor.
 *
 * An iPhone 6 tops out at iOS 12.5.7, so anything that shipped in a later
 * WebKit will fail silently on the target device - a CSS property is ignored
 * and the layout quietly collapses, a JS operator is a parse error and the
 * whole file stops running. This script fails the build on the ones that are
 * easy to write by accident.
 *
 * Usage: node scripts/check-ios12.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const JS_RULES = [
  [/(^|[^?\w.])\?\.(?![\d])/, 'optional chaining `?.` (Safari 13.1)'],
  [/\?\?[^=]|\?\?$/, 'nullish coalescing `??` (Safari 13.1)'],
  [/\|\|=|&&=|\?\?=/, 'logical assignment operators (Safari 14)'],
  [/\bObject\.fromEntries\b/, 'Object.fromEntries (Safari 12.1)'],
  [/\bglobalThis\b/, 'globalThis (Safari 12.1)'],
  [/\bqueueMicrotask\b/, 'queueMicrotask (Safari 12.1)'],
  [/\bPromise\.allSettled\b/, 'Promise.allSettled (Safari 13)'],
  [/\bPromise\.any\b/, 'Promise.any (Safari 15)'],
  [/\.replaceAll\s*\(/, 'String.replaceAll (Safari 13.1)'],
  [/\.matchAll\s*\(/, 'String.matchAll (Safari 13)'],
  [/\.at\s*\(\s*-?\d/, 'Array.at (Safari 15.4)'],
  [/\bstructuredClone\b/, 'structuredClone (Safari 15.4)'],
  [/\bResizeObserver\b/, 'ResizeObserver (Safari 13.1)'],
  [/\bBroadcastChannel\b/, 'BroadcastChannel (Safari 15.4)'],
  [/navigator\.storage\b/, 'navigator.storage (Safari 15.2, and persist() never on iOS 12)'],
  [/\bnavigator\.mediaSession\b/, 'Media Session API (Safari 15)'],
  [/\bWakeLock\b|navigator\.wakeLock/, 'Screen Wake Lock API (not on iOS)'],
  [/^\s*(static\s+)?#[A-Za-z_]/m, 'private class fields (Safari 14.1)'],
];

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
  [/:has\(/, ':has() (Safari 15.4)'],
];

// Only the files that actually reach the phone are checked. Build scripts,
// tests and the vendored design prototypes run elsewhere and are exempt.
const SHIPPED = ['assets', 'sw.js'];

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

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

function stripJsComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const failures = [];

for (const file of collect()) {
  const rel = path.relative(ROOT, file);
  if (file.endsWith('.js')) {
    const lines = stripJsComments(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const [pattern, label] of JS_RULES) {
        if (pattern.test(line)) failures.push(`${rel}:${i + 1}  ${label}\n    ${line.trim()}`);
      }
    });
  } else if (file.endsWith('.css')) {
    const lines = stripCssComments(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const [pattern, label] of CSS_RULES) {
        if (pattern.test(line)) failures.push(`${rel}:${i + 1}  ${label}\n    ${line.trim()}`);
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

if (failures.length) {
  console.error('iOS 12 compatibility check failed:\n');
  failures.forEach((f) => console.error('  ' + f + '\n'));
  process.exit(1);
}

console.log('iOS 12 compatibility check passed.');
