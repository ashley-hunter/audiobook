#!/usr/bin/env node
/* Dumps the markup of the two lists that moved to Preact, so the old
 * hand-written rendering and the new one can be compared byte for byte.
 *
 *   node test/parity.js <outFile> [srcDir]
 *
 * Boots the app, imports two stories, hearts one, queues both, and writes out
 * the library list and the picks strip along with a few states that have to
 * survive the move: a missing story, an empty queue, a re-render. Run it once
 * against each tree and diff the files; anything that differs is a change the
 * migration made to what the screen actually is.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const OUT = path.resolve(process.argv[2] || 'parity.txt');
const ROOT = path.resolve(process.argv[3] || path.join(__dirname, '..'));
const createServer = require(path.join(ROOT, 'test', 'serve.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bedtime-parity-'));
const FIRST = path.join(TMP, 'Sleepy Foxes.wav');
const SECOND = path.join(TMP, 'Moon Boat.wav');

function writeWav(file, seconds) {
  const rate = 8000;
  const samples = rate * seconds;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples, 40);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.alloc(samples, 128)]));
}

writeWav(FIRST, 8);
writeWav(SECOND, 6);

// Ids and generated cover hues differ run to run; the shape is what matters.
function normalise(html) {
  return String(html)
    .replace(/\s+/g, ' ')
    .replace(/background-image:[^"';]*;?/g, 'background-image:…')
    .replace(/></g, '>\n<');
}

(async () => {
  const server = createServer({ base: '/' });
  await new Promise((resolve) => server.listen(8791, resolve));
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  const out = [];

  await page.goto('http://127.0.0.1:8791/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  // Cover art lookups reach the network and find different things on different
  // runs, which has nothing to do with how the lists are drawn.
  await page.evaluate(() => App.settings.set({ artwork: false }));
  await page.locator('#add-btn').click();
  await page.locator('#file-input').setInputFiles([FIRST, SECOND]);
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('.import-status');
    return rows.length === 2 && [].every.call(rows, (r) => r.textContent === 'Ready');
  }, null, { timeout: 60000 });
  await page.locator('#add-close').click();
  await page.waitForTimeout(600);

  // Covers are striped from a hue picked at import time, and the greeting
  // carries the time of day, so both are pinned before anything is compared.
  const settle = async () => {
    await page.evaluate(() => {
      // Striped covers are coloured from the story's id, which is new on every
      // import, so the colour is pinned for the comparison.
      App.debug.stories().forEach(function (story, index) { story.hue = index * 40; });
    });
    // A heart on and off again: the cheapest repaint that exists in both trees.
    const heart = page.locator('#library-rows .row .row-heart').first();
    await heart.click();
    await page.waitForTimeout(150);
    await heart.click();
    await page.waitForTimeout(250);
  };

  const shot = async (label) => {
    const file = path.join(path.dirname(OUT), path.basename(OUT, '.txt') + '-' +
      label.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png');
    await page.locator('#screen-home').screenshot({ path: file });
  };

  const dump = async (label) => {
    await settle();
    const html = await page.evaluate(() => ({
      rows: document.getElementById('library-rows').innerHTML,
      picks: document.getElementById('picks').innerHTML,
      empty: document.getElementById('picks-empty').hidden,
    }));
    out.push(`===== ${label} =====`);
    out.push('--- library rows');
    out.push(normalise(html.rows));
    out.push('--- picks strip');
    out.push(normalise(html.picks));
    out.push(`--- picks-empty hidden: ${html.empty}`);
    await shot(label);
  };

  await dump('fresh library, empty queue');

  await page.locator('#library-rows .row').filter({ hasText: 'Sleepy Foxes' })
    .locator('.row-heart').click();
  await page.waitForTimeout(300);
  await dump('one story hearted');

  await page.evaluate(() => {
    App.debug.stories().forEach((s) => App.debug.togglePick(s.id));
  });
  await page.waitForTimeout(300);
  await dump('both stories queued');

  await page.evaluate(async () => {
    const story = App.debug.stories()[0];
    await App.store.deleteChunks(story.id);
    App.debug.verifyStorage();
    await new Promise((r) => setTimeout(r, 600));
  });
  await page.waitForTimeout(300);
  await dump('one story whose audio was cleared');

  fs.writeFileSync(OUT, out.join('\n') + '\n');
  console.log(`Wrote ${OUT}`);

  await browser.close();
  server.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
