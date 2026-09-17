#!/usr/bin/env node
/* Compares the screenshots two parity runs produced, pixel by pixel.
 *
 *   node test/parity-pixels.js <oldPrefix> <newPrefix>
 *
 * Chromium does the decoding, because it is already here and Node cannot read
 * a PNG on its own. Anything above a tiny per-channel tolerance counts, so
 * antialiasing noise does not pass for a change and a moved button does not
 * slip through either.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OLD = path.resolve(process.argv[2] || '/tmp/parity-old.txt');
const NEW = path.resolve(process.argv[3] || '/tmp/parity-new.txt');

function shots(file) {
  const dir = path.dirname(file);
  const prefix = path.basename(file, '.txt') + '-';
  return fs.readdirSync(dir)
    .filter((name) => name.indexOf(prefix) === 0 && name.slice(-4) === '.png')
    .map((name) => ({ name: name.slice(prefix.length), file: path.join(dir, name) }));
}

function asData(file) {
  return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
}

(async () => {
  const before = shots(OLD);
  if (!before.length) throw new Error('no screenshots found for ' + OLD);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  let failed = 0;

  for (const shot of before) {
    const other = path.join(path.dirname(NEW), path.basename(NEW, '.txt') + '-' + shot.name);
    if (!fs.existsSync(other)) {
      console.log(`MISSING  ${shot.name}`);
      failed++;
      continue;
    }
    const result = await page.evaluate(async (pair) => {
      function load(src) {
        return new Promise(function (resolve) {
          const image = new Image();
          image.onload = function () { resolve(image); };
          image.src = src;
        });
      }
      const a = await load(pair[0]);
      const b = await load(pair[1]);
      if (a.width !== b.width || a.height !== b.height) {
        return { sized: [a.width, a.height, b.width, b.height] };
      }
      const canvas = document.createElement('canvas');
      canvas.width = a.width;
      canvas.height = a.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(a, 0, 0);
      const one = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(b, 0, 0);
      const two = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let diff = 0;
      let left = Infinity, top = Infinity, right = -1, bottom = -1;
      for (let i = 0; i < one.length; i += 4) {
        const worst = Math.max(
          Math.abs(one[i] - two[i]),
          Math.abs(one[i + 1] - two[i + 1]),
          Math.abs(one[i + 2] - two[i + 2])
        );
        if (worst <= 8) continue;
        diff++;
        const pixel = i / 4;
        const y = Math.floor(pixel / canvas.width);
        const x = pixel % canvas.width;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
      return { diff: diff, total: one.length / 4, box: diff ? [left, top, right, bottom] : null };
    }, [asData(shot.file), asData(other)]);

    if (result.sized) {
      console.log(`SIZE     ${shot.name} ${result.sized.join('x')}`);
      failed++;
    } else if (result.diff) {
      console.log(`DIFFERS  ${shot.name} ${result.diff}/${result.total} pixels, box ${result.box.join(',')}`);
      failed++;
    } else {
      console.log(`same     ${shot.name}`);
    }
  }

  await browser.close();
  if (failed) {
    console.error(`\n${failed} screenshot(s) differ.`);
    process.exit(1);
  }
  console.log('\nEvery screenshot matches.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
