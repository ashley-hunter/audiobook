#!/usr/bin/env node
/* Did the move to TypeScript change what actually runs?
 *
 *   node scripts/same-code.js <ref> [file...]
 *
 * Compares the JavaScript a ref shipped against what the working tree now
 * compiles, by parsing both and comparing the syntax trees rather than the
 * text. Formatting, comments and the positions of things are ignored, because
 * TypeScript reprints all three; anything else is a real difference and worth
 * knowing about before it reaches a phone.
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ref = process.argv[2] || 'HEAD';
const files = process.argv.slice(3);

function shape(source) {
  const tree = acorn.parse(source, { ecmaVersion: 2018, sourceType: 'script' });
  /* TypeScript writes `"use strict";` at the top of what it emits. The files
   * it came from already ran in strict mode - every one of them is an IIFE
   * that says so on its first line - so the directive is noise here rather
   * than a change in meaning. */
  if (tree.body.length && tree.body[0].type === 'ExpressionStatement' &&
      tree.body[0].expression.type === 'Literal' && tree.body[0].expression.value === 'use strict') {
    tree.body.shift();
  }
  return JSON.stringify(tree, (key, value) => {
    /* A regex written with an escape and one written with the character it
     * stands for are the same expression. `\u0000` and a literal NUL byte are
     * the case that matters here, and the escape is the one worth keeping. */
    if (key === 'pattern' && typeof value === 'string') {
      return value.replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range' || key === 'raw') return undefined;
    return value;
  });
}

let differ = 0;
for (const file of files) {
  const now = path.join('assets', 'js', file);
  let before;
  try {
    before = execSync(`git show ${ref}:assets/js/${file}`, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    console.log(`SKIP  ${file} (not in ${ref})`);
    continue;
  }
  if (!fs.existsSync(now)) {
    console.log(`GONE  ${file}`);
    differ++;
    continue;
  }
  let a, b;
  try {
    a = shape(before);
    b = shape(fs.readFileSync(now, 'utf8'));
  } catch (err) {
    console.log(`PARSE ${file}: ${err.message}`);
    differ++;
    continue;
  }
  if (a === b) {
    console.log(`same  ${file}`);
  } else {
    console.log(`DIFFERS ${file}`);
    differ++;
  }
}

if (differ) {
  console.error(`\n${differ} file(s) differ in more than formatting. That may be fine - types can force a real change - but each one needs a reason.`);
  process.exit(1);
}
console.log('\nEvery file runs the same code it did before.');
