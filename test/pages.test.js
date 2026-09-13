#!/usr/bin/env node
/* Tests the app in the shape GitHub Pages actually serves it.
 *
 * A project site lives at https://<user>.github.io/<repo>/, not at the root of
 * a domain. An absolute path, a service worker scope assumption or a hardcoded
 * "/" would work perfectly on localhost and fail the moment it is deployed, so
 * this builds the real artifact, serves it from a subdirectory, and checks the
 * things that only break there:
 *
 *   - the app boots and the service worker takes control at the subpath
 *   - an import and a Range request work through the subpath media route
 *   - the whole thing still runs with the network switched off, which is the
 *     entire point of a bedtime player on a phone in a bedroom
 *
 *   node test/pages.test.js
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 8779;
const BASE = '/audiobook/';                      // stands in for /<repo>/
const ORIGIN = `http://127.0.0.1:${PORT}${BASE}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bedtime-pages-'));
const SITE = path.join(TMP, 'site');
const FIXTURE = path.join(TMP, 'Whalesong.wav');
const FIXTURE_BYTES = writeWav(FIXTURE, 12);
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-site.js');

const log = [];
let failed = 0;

function check(name, ok, detail) {
  if (!ok) failed++;
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

function writeWav(file, seconds) {
  const rate = 22050;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(11000 * Math.sin((2 * Math.PI * 300 * i) / rate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return 44 + data.length;
}

(async () => {
  // Build the real artifact, the same way the workflow does.
  execFileSync(process.execPath, [BUILD_SCRIPT, SITE], { stdio: 'inherit' });
  check('build produced an index', fs.existsSync(path.join(SITE, 'index.html')));

  /* A fixed service worker version means the browser sees identical bytes after
   * a deploy, skips the install, never reaches activate, and keeps serving the
   * previous release from cache. The stamped build id is what makes an update
   * actually reach a phone. */
  const readBuildId = (dir) =>
    (/var BUILD = '([^']+)'/.exec(fs.readFileSync(path.join(dir, 'sw.js'), 'utf8')) || [])[1];

  const buildId = readBuildId(SITE);
  check('the service worker carries a stamped build id',
    !!buildId && buildId !== 'dev' && buildId.length >= 8, buildId);

  // Same input, same id - a no-op deploy must not churn every phone's cache.
  const repeat = path.join(TMP, 'site-again');
  execFileSync(process.execPath, [BUILD_SCRIPT, repeat], { stdio: 'ignore' });
  check('an unchanged build keeps the same id', readBuildId(repeat) === buildId,
    `${buildId} vs ${readBuildId(repeat)}`);

  /* Changed input, changed id - otherwise the update never reaches anyone.
   * Built from a throwaway copy of the tree: editing a tracked file and putting
   * it back would leave the working tree dirty if this run were interrupted. */
  const srcCopy = path.join(TMP, 'src');
  const repoRoot = path.join(__dirname, '..');
  for (const entry of ['index.html', 'manifest.webmanifest', 'sw.js', 'assets']) {
    fs.cpSync(path.join(repoRoot, entry), path.join(srcCopy, entry), { recursive: true });
  }
  const copiedCss = path.join(srcCopy, 'assets', 'css', 'app.css');
  fs.writeFileSync(copiedCss, fs.readFileSync(copiedCss, 'utf8') + '\n/* build id probe */\n');

  const changed = path.join(TMP, 'site-changed');
  execFileSync(process.execPath, [BUILD_SCRIPT, changed, srcCopy], { stdio: 'ignore' });
  const changedId = readBuildId(changed);
  check('a changed file changes the id', !!changedId && changedId !== buildId,
    `${buildId} -> ${changedId}`);

  check('build left the tests behind', !fs.existsSync(path.join(SITE, 'test')));
  check('build left the design prototypes behind', !fs.existsSync(path.join(SITE, 'design')));

  const server = require('./serve.js')({ root: SITE, base: BASE });
  await new Promise((resolve) => server.listen(PORT, resolve));

  const launch = { args: ['--autoplay-policy=no-user-gesture-required'] };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;

  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 667 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  const failedRequests = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('requestfailed', (r) => failedRequests.push(r.url()));
  page.on('response', (r) => { if (r.status() === 404) failedRequests.push(r.url() + ' -> 404'); });

  await page.goto(ORIGIN, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  check('app boots from a subdirectory', await page.locator('#library-empty').isVisible());
  check('nothing 404s at the subpath', failedRequests.length === 0, failedRequests.join(' | '));
  check('no JavaScript errors', errors.length === 0, errors.join(' | '));

  // The service worker has to claim the page, or offline and the media route
  // both quietly stop working.
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
  const scope = await page.evaluate(() =>
    navigator.serviceWorker.getRegistration().then((r) => (r ? r.scope : null)));
  check('service worker scope is the subdirectory',
    typeof scope === 'string' && scope.indexOf(BASE) >= 0 && scope.indexOf('/audiobook/') >= 0, scope);
  check('media route is usable at the subpath', (await page.evaluate(() => App.media.probe())) === true);

  /* ------------------------------------------------------------- importing */
  const moon = await page.locator('#moon-btn').boundingBox();
  await page.mouse.move(moon.x + moon.width / 2, moon.y + moon.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(3400);
  await page.mouse.up();
  await page.locator('#parent-add').click();
  await page.waitForTimeout(400);
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await page.waitForFunction(
    () => { const n = document.querySelector('.import-status'); return n && n.textContent === 'Ready'; },
    null, { timeout: 60000 }
  );
  await page.locator('#add-close').click();
  await page.locator('#parent-close').click();
  await page.waitForTimeout(600);

  const story = await page.evaluate(() => App.debug.stories()[0]);
  check('import works at the subpath', !!story && story.size === FIXTURE_BYTES,
    story && `${story.title} ${story.size}`);

  const ranged = await page.evaluate(async (id) => {
    const r = await fetch('media/' + id, { headers: { Range: 'bytes=0-511' } });
    return { status: r.status, len: (await r.arrayBuffer()).byteLength, url: r.url };
  }, story.id);
  check('range request resolves under the subpath',
    ranged.status === 206 && ranged.len === 512 && ranged.url.indexOf(BASE + 'media/') >= 0,
    JSON.stringify(ranged));

  /* ------------------------------------------- with the network switched off */
  await ctx.setOffline(true);
  const offlineErrors = [];
  page.on('pageerror', (e) => offlineErrors.push(e.message));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  check('app still boots with no network',
    (await page.locator('#library-rows .row').count()) === 1);
  check('stylesheet survived offline',
    (await page.evaluate(() => getComputedStyle(document.body).fontFamily)).indexOf('Karla') >= 0);

  await page.locator('#library-rows .row .row-open').click();
  await page.waitForTimeout(2500);
  const offlinePlay = await page.evaluate(() => ({
    playing: App.player.playing(),
    t: App.player.position(),
  }));
  check('a story plays with no network', offlinePlay.playing && offlinePlay.t > 0,
    JSON.stringify(offlinePlay));
  check('no JavaScript errors offline', offlineErrors.length === 0, offlineErrors.join(' | '));

  await browser.close();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(log.join('\n'));
  console.log(failed ? `\n${failed} failing` : '\nAll Pages tests passed.');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.log(log.join('\n'));
  console.error('\nThrew: ' + err.message);
  process.exit(1);
});
