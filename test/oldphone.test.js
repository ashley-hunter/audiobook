#!/usr/bin/env node
/* Bedtime - the iPhone 6 pass: every post-floor API deleted before the page loads.
 *
 *   npm run test:oldphone
 *
 * One of four browser suites, split so they can run at once. The shared
 * fixtures and bookkeeping live in test/harness.js.
 */
'use strict';

const fs = require('fs');
const { chromium } = require('playwright');
const { fixtures, NO_ARTWORK_HOSTS, reporter, launchOptions } = require('./harness.js');

const PORT = 8779;
const ORIGIN = `http://127.0.0.1:${PORT}/`;

const files = fixtures();
const TMP = files.dir;
const FIXTURE = files.first;
const FIXTURE_BYTES = files.firstBytes;
const BIG = files.big;
const BIG_BYTES = files.bigBytes;
const SECOND = files.second;

const out = reporter();
const check = out.check;

(async () => {
  const server = require('./serve.js')();
  await new Promise((resolve) => server.listen(PORT, resolve));
  const browser = await chromium.launch(launchOptions());
  /* ============================================================================
     Second pass with every post-floor API removed, which is what an iPhone 6
     actually presents. The app has to behave identically, minus the extras.
     ========================================================================== */
  const oldCtx = await browser.newContext({
    viewport: { width: 375, height: 667 },
    isMobile: true,
    hasTouch: true,
  });
  await oldCtx.addInitScript(NO_ARTWORK_HOSTS);
  await oldCtx.addInitScript(() => {
    delete Blob.prototype.arrayBuffer;
    delete window.requestIdleCallback;
    try { Object.defineProperty(navigator, 'mediaSession', { get: () => undefined }); } catch (e) { /* ignore */ }
    try { Object.defineProperty(navigator, 'storage', { get: () => undefined }); } catch (e) { /* ignore */ }
    delete window.MediaMetadata;
  });

  const old = await oldCtx.newPage();
  const oldErrors = [];
  old.on('pageerror', (e) => oldErrors.push('pageerror: ' + e.message));
  old.on('console', (m) => {
    if (m.type() === 'error' && m.text().indexOf('416') < 0) oldErrors.push('console: ' + m.text());
  });

  await old.goto(ORIGIN, { waitUntil: 'networkidle' });
  await old.waitForTimeout(900);

  const caps = await old.evaluate(() => ({
    mediaSession: App.caps.supports('mediaSession'),
    blobArrayBuffer: App.caps.supports('blobArrayBuffer'),
    persistentStorage: App.caps.supports('persistentStorage'),
    storageEstimate: App.caps.supports('storageEstimate'),
    idleCallback: App.caps.supports('idleCallback'),
    serviceWorker: App.caps.supports('serviceWorker'),
  }));
  check('old device reports the modern APIs as absent',
    !caps.mediaSession && !caps.blobArrayBuffer && !caps.persistentStorage &&
    !caps.storageEstimate && !caps.idleCallback && caps.serviceWorker,
    JSON.stringify(caps));

  /* Preact and htm are the only dependency that reaches the phone, and an
     iPhone 6 is the machine they have to run on. If either one needed
     something this pass has taken away, nothing below would be drawn at all. */
  check('the renderer runs with the modern APIs gone',
    await old.evaluate(() => !!(window.preact && window.htm && window.App.views)));
  check('and draws the empty library',
    (await old.locator('#library-empty .empty-add').count()) === 1);

  const oldMoon = await old.locator('#moon-btn').boundingBox();
  await old.mouse.move(oldMoon.x + oldMoon.width / 2, oldMoon.y + oldMoon.height / 2);
  await old.mouse.down();
  await old.waitForTimeout(3400);
  await old.mouse.up();
  await old.locator('#parent-add').click();
  await old.waitForTimeout(400);
  await old.locator('#file-input').setInputFiles(FIXTURE);
  await old.waitForFunction(
    () => { const n = document.querySelector('.import-status'); return n && n.textContent === 'Ready'; },
    null, { timeout: 60000 }
  );
  const oldRecord = await old.evaluate(() => App.debug.stories()[0]);
  check('import works through FileReader',
    oldRecord && oldRecord.size === FIXTURE_BYTES && oldRecord.len === 40,
    JSON.stringify(oldRecord && { size: oldRecord.size, len: oldRecord.len }));

  await old.locator('#add-close').click();
  await old.locator('#parent-close').click();
  await old.waitForTimeout(600);
  await old.locator('#library-rows .row .row-open').click();
  await old.waitForTimeout(2500);
  const oldState = await old.evaluate(() => ({ playing: App.player.playing(), t: App.player.position() }));
  check('playback works with no Media Session', oldState.playing && oldState.t > 0, JSON.stringify(oldState));

  const oldDrawn = await old.evaluate(() => ({
    heart: (document.querySelector('#library-rows .row-heart') || {}).textContent,
    more: (document.querySelector('#library-rows .row-more') || {}).textContent,
    rows: document.querySelectorAll('#library-rows .row').length,
    chips: document.querySelectorAll('#timer-options .timer-opt').length,
    custom: !!document.querySelector('#timer-options .timer-custom input'),
  }));
  check('every drawn list is there on the old device',
    oldDrawn.rows === 1 && oldDrawn.heart === '\u2665' && oldDrawn.more === '\u22ef' &&
    oldDrawn.chips >= 4 && oldDrawn.custom, JSON.stringify(oldDrawn));

  await old.evaluate(() => document.querySelector('#library-rows .row-more').click());
  await old.waitForTimeout(400);
  const oldMenu = await old.evaluate(() => ({
    open: document.getElementById('menu').className.indexOf('is-on') >= 0,
    items: document.querySelectorAll('#menu-actions .confirm-btn').length,
  }));
  check('and a story menu opens there too',
    oldMenu.open && oldMenu.items >= 2, JSON.stringify(oldMenu));
  await old.evaluate(() => {
    const buttons = [].slice.call(document.querySelectorAll('#menu-actions .confirm-btn'));
    buttons[buttons.length - 1].click();
  });
  await old.waitForTimeout(300);

  await old.locator('#player-close').click();
  await old.waitForTimeout(400);
  const oldMoon2 = await old.locator('#moon-btn').boundingBox();
  await old.mouse.move(oldMoon2.x + oldMoon2.width / 2, oldMoon2.y + oldMoon2.height / 2);
  await old.mouse.down();
  await old.waitForTimeout(3400);
  await old.mouse.up();
  await old.waitForTimeout(500);

  const note = await old.evaluate(() => document.getElementById('storage-note').textContent);
  check('storage note falls back to bytes held',
    note.indexOf('play with no signal') >= 0 || note.indexOf('no signal') >= 0, note);

  check('no JavaScript errors on the old device', oldErrors.length === 0, oldErrors.join(' | '));
  await browser.close();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  out.finish('old phone');
})().catch((err) => out.threw(err));
