#!/usr/bin/env node
/* Bedtime - does the thing we actually ship run in a real WebKit?
 *
 *   npm run test:safari
 *
 * The rest of the suite runs in Chromium against the source tree. This one
 * runs against `_site`, the directory the deploy publishes, in WebKit - the
 * engine Safari is built on - at iPhone 6 size.
 *
 * What it proves: the build output is complete and nothing in it, Preact and
 * htm included, trips a real WebKit rather than a Chromium standing in for
 * one. What it does not prove: the Safari 12 floor. Playwright ships a current
 * WebKit, not the one on an iPhone 6. That floor is held by `npm run check`,
 * which refuses to ship syntax or APIs the phone has not got, and by the pass
 * in test/browser.test.js that deletes every post-floor API before the page
 * loads and drives the app without them.
 *
 * Gestures are left to the Chromium suite: WebKit has no constructable
 * TouchEvent, so a drag or a swipe here would be testing the harness.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { webkit } = require('playwright');
const createServer = require('./serve.js');

const SITE = path.join(__dirname, '..', '_site');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bedtime-webkit-'));
const STORY = path.join(TMP, 'Sleepy Foxes.wav');

let failures = 0;

function check(what, ok, detail) {
  if (ok) {
    console.log(`PASS  ${what}${detail ? '  -- ' + detail : ''}`);
    return;
  }
  failures++;
  console.log(`FAIL  ${what}${detail ? '  -- ' + detail : ''}`);
}

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

(async () => {
  if (!fs.existsSync(path.join(SITE, 'index.html'))) {
    console.error('No _site to test. Run `npm run build` first.');
    process.exit(1);
  }
  writeWav(STORY, 30);

  const server = createServer({ root: SITE, base: '/' });
  await new Promise((resolve) => server.listen(8793, resolve));

  const browser = await webkit.launch();
  // An iPhone 6: 375x667 points, two device pixels to the point.
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  let page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().indexOf('416') < 0) errors.push('console: ' + m.text());
  });

  await page.goto('http://127.0.0.1:8793/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  check('the app boots', await page.locator('#library').isVisible());
  check('the empty state is drawn by Preact',
    (await page.locator('#library-empty .empty-add').count()) === 1);

  /* ------------------------------------------------------------- importing */
  await page.locator('#add-btn').click();
  await page.locator('#file-input').setInputFiles(STORY);
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('.import-status');
    return rows.length > 0 && rows[rows.length - 1].textContent === 'Ready';
  }, null, { timeout: 60000 });
  await page.evaluate(() => document.getElementById('add-close').click());
  await page.waitForTimeout(600);

  check('an imported story appears in the library',
    (await page.locator('#library-rows .row').count()) === 1);
  check('its heart and menu are characters, not entities',
    (await page.locator('#library-rows .row-heart').textContent()) === '♥' &&
    (await page.locator('#library-rows .row-more').textContent()) === '⋯');

  /* -------------------------------------------------------------- playback */
  await page.evaluate(() => document.querySelector('#library-rows .row-open').click());
  await page.waitForTimeout(2500);
  const playing = await page.evaluate(() => ({
    open: document.getElementById('player').className.indexOf('is-open') >= 0,
    playing: App.player.playing(),
    at: App.player.position(),
    viaWorker: !!navigator.serviceWorker.controller,
  }));
  check('a story plays', playing.open && playing.playing && playing.at > 0, JSON.stringify(playing));

  const ranged = await page.evaluate(async () => {
    const story = App.debug.stories()[0];
    const res = await fetch('media/' + story.id, { headers: { Range: 'bytes=100-199' } });
    const body = await res.arrayBuffer();
    return { status: res.status, length: body.byteLength, range: res.headers.get('Content-Range') };
  });
  check('the service worker answers a range request',
    ranged.status === 206 && ranged.length === 100, JSON.stringify(ranged));

  const skipped = await page.evaluate(async () => {
    App.player.seekTo(20);
    await new Promise((r) => setTimeout(r, 400));
    const start = App.player.position();
    document.getElementById('skip-back').click();
    await new Promise((r) => setTimeout(r, 400));
    return { start, back: App.player.position() };
  });
  check('back 15 seconds works', Math.abs(skipped.back - (skipped.start - 15)) < 2,
    JSON.stringify(skipped));

  /* ----------------------------------------------------------- sleep timer */
  await page.evaluate(() => document.getElementById('open-sheet').click());
  await page.waitForTimeout(500);
  const sheet = await page.evaluate(() => ({
    open: document.getElementById('sheet').className.indexOf('is-open') >= 0,
    chips: document.querySelectorAll('#timer-options .timer-opt').length,
    custom: !!document.querySelector('#timer-options .timer-custom input'),
  }));
  check('the sleep timer sheet is drawn', sheet.open && sheet.chips >= 4 && sheet.custom,
    JSON.stringify(sheet));
  await page.locator('#timer-options .timer-opt').first().click();
  await page.waitForTimeout(400);
  check('a timer chip sets the timer',
    (await page.evaluate(() => App.player.currentSleepMinutes())) === 10);
  await page.evaluate(() => document.getElementById('player-close').click());
  await page.waitForTimeout(700);

  check('the mini player keeps the story in reach', await page.locator('#mini').isVisible());

  /* ---------------------------------------------------------------- queue */
  await page.evaluate(() => document.querySelector('#library-rows .row-more').click());
  await page.waitForTimeout(400);
  const menu = await page.evaluate(() =>
    [].slice.call(document.querySelectorAll('#menu-actions .confirm-btn')).map((b) => b.textContent.trim()));
  check('a story menu opens with its choices', menu.length >= 2, JSON.stringify(menu));
  await page.evaluate(() => {
    const buttons = [].slice.call(document.querySelectorAll('#menu-actions .confirm-btn'));
    const take = buttons.filter((b) => b.textContent.indexOf('Take out') >= 0)[0];
    (take || buttons[0]).click();
  });
  await page.waitForTimeout(400);
  check('the queue can be changed from the menu',
    (await page.evaluate(() => App.debug.lineup().length)) === 0);

  /* ------------------------------------------------------- parent controls */
  await page.evaluate(() => { document.getElementById('library').scrollTop = 0; });
  const moon = await page.locator('#moon-btn').boundingBox();
  await page.mouse.move(moon.x + moon.width / 2, moon.y + moon.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(3400);
  await page.mouse.up();
  await page.waitForTimeout(700);
  const parent = await page.evaluate(() => ({
    open: document.getElementById('parent').className.indexOf('is-open') >= 0,
    toggles: document.querySelectorAll('#toggles .card-row').length,
    stored: document.querySelectorAll('#stored-list .stored').length,
  }));
  check('parent controls open and are drawn',
    parent.open && parent.toggles === 3 && parent.stored === 1, JSON.stringify(parent));
  await page.evaluate(() => document.getElementById('parent-close').click());
  await page.waitForTimeout(500);

  /* --------------------------------------------------------- with no signal */

  /* The shell is checked in the cache rather than by reloading with the
   * network cut: Playwright's WebKit falls over navigating a controlled page
   * offline, which says nothing about the app. What an offline launch actually
   * needs is that every file it loads is in the cache, and the Chromium suite
   * drives a real offline launch end to end.
   */
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names[0]);
    const kept = (await cache.keys()).map((r) => r.url.replace(location.origin + '/', ''));
    const wanted = ['index.html', 'assets/css/app.css', 'assets/js/app.js', 'assets/js/views.js',
                    'assets/vendor/preact.umd.js', 'assets/vendor/htm.umd.js'];
    return { missing: wanted.filter((w) => kept.indexOf(w) < 0), count: kept.length };
  });
  check('the whole shell, renderer and all, is cached for an offline launch',
    cached.missing.length === 0 && cached.count > 10, JSON.stringify(cached));

  check('no JavaScript errors anywhere in that', errors.length === 0, errors.join(' | '));

  await browser.close();
  server.close();

  console.log('');
  if (failures) {
    console.error(`${failures} failing on WebKit.`);
    process.exit(1);
  }
  console.log('The build output runs in a real WebKit. The Safari 12 floor is held\nby `npm run check` and the stripped-API pass in test/browser.test.js.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
