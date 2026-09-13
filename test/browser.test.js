#!/usr/bin/env node
/* End to end tests: import a file, stream it back out of IndexedDB, play it.
 *
 * Runs against Chromium because that is what is installable in CI. It cannot
 * prove anything about Safari 12 - `node scripts/check-ios12.js` guards the
 * syntax floor, and the device notes in README.md list what still has to be
 * checked by hand on the phone. What this does prove is that the storage,
 * range streaming, playback and persistence logic is correct.
 *
 *   npm install && npx playwright install chromium
 *   node test/browser.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 8778;
const ORIGIN = `http://127.0.0.1:${PORT}/`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bedtime-'));
const FIXTURE = path.join(TMP, 'Sleepy Foxes.wav');
const FIXTURE_BYTES = writeWav(FIXTURE, 40);
const BIG = path.join(TMP, 'The Button Kingdom.wav');   // over the 4 MiB window
const BIG_BYTES = writeWav(BIG, 130);

const log = [];
let failed = 0;

/* Cover art lookup is on by default, so every context that is not testing it
 * would otherwise reach for itunes.apple.com. The app handles that failing -
 * that is what the unit tests cover - but the browser still logs a network
 * error for it, which would blunt the "no console errors" assertions. Failing
 * the fetch in the page keeps those assertions strict and the lookup honest:
 * this is exactly what a phone with no signal presents.
 */
const NO_ARTWORK_HOSTS = () => {
  const real = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = String(input && input.url ? input.url : input);
    if (url.indexOf('itunes.apple.com') >= 0 || url.indexOf('openlibrary.org') >= 0) {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    return real(input, init);
  };
};

function check(name, ok, detail) {
  if (!ok) failed++;
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

// A 40 second mono WAV, big enough to land in more than one 1 MiB chunk.
function writeWav(file, seconds) {
  const rate = 22050;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
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
  const server = require('./serve.js')();
  await new Promise((resolve) => server.listen(PORT, resolve));

  const launch = {};
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  launch.args = ['--autoplay-policy=no-user-gesture-required'];

  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 667 }, // iPhone 6
    isMobile: true,
    hasTouch: true,
  });
  await ctx.addInitScript(NO_ARTWORK_HOSTS);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    // The 416 probe below is deliberate; everything else is a real problem.
    if (m.type() === 'error' && m.text().indexOf('416') < 0) errors.push('console: ' + m.text());
  });

  await page.goto(ORIGIN, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  check('boots cleanly', errors.length === 0, errors.join(' | '));
  check('empty state is shown', await page.locator('#library-empty').isVisible());

  /* Adding is open to anyone, so both routes are always present. A fresh
   * install must never be a dead end that invites you to add a story with no
   * button to do it. */
  check('the header Add button is there on a fresh install',
    await page.locator('#add-btn').isVisible());
  check('the empty state offers its own Add button',
    await page.locator('.empty-add').isVisible());
  check('the empty state does not point at a button that is not there',
    (await page.locator('#library-empty').textContent()).indexOf('Tap Add') < 0);

  // and it has to actually work, not just be present
  await page.locator('.empty-add').click();
  await page.waitForTimeout(400);
  check('the empty state Add button opens the import sheet',
    await page.locator('#add').evaluate((n) => n.className.indexOf('is-open') >= 0));
  await page.locator('#add-close').click();
  await page.waitForTimeout(400);

  /* ------------------------------------------- hold the moon for 3 seconds */
  const moon = await page.locator('#moon-btn').boundingBox();
  await page.mouse.move(moon.x + moon.width / 2, moon.y + moon.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(3400);
  await page.mouse.up();
  check('holding the moon opens parent controls',
    await page.locator('#parent').evaluate((n) => n.className.indexOf('is-open') >= 0));

  /* ------------------------------------------------------------- importing */
  await page.locator('#parent-add').click();
  await page.waitForTimeout(400);
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await page.waitForFunction(
    () => { const n = document.querySelector('.import-status'); return n && n.textContent === 'Ready'; },
    null, { timeout: 60000 }
  );

  const record = await page.evaluate(() => App.debug.stories()[0]);
  check('story record written', !!record && record.chunkCount === 2,
    JSON.stringify(record && { title: record.title, size: record.size, chunks: record.chunkCount }));
  check('title taken from the filename', record.title === 'Sleepy Foxes', record.title);
  check('duration measured from the audio', record.len === 40, 'len=' + record.len);
  check('bytes stored match the file', record.size === FIXTURE_BYTES, `${record.size} vs ${FIXTURE_BYTES}`);

  await page.locator('#add-close').click();
  await page.locator('#parent-close').click();
  await page.waitForTimeout(1000);
  check('library shows one row', (await page.locator('#library-rows .row').count()) === 1);
  check('the Add button stays put once there is a library',
    await page.locator('#add-btn').isVisible());
  check('no add gate is left in the settings',
    (await page.evaluate(() => Object.keys(App.settings.get()).join(','))).indexOf('lock') < 0);

  /* --------------------------------------------- service worker media route */
  check('media route is usable', (await page.evaluate(() => App.media.probe())) === true);

  const ranged = await page.evaluate(async (id) => {
    const r = await fetch('media/' + id, { headers: { Range: 'bytes=100-1099' } });
    return { status: r.status, len: (await r.arrayBuffer()).byteLength, cr: r.headers.get('Content-Range') };
  }, record.id);
  check('range request answered from storage',
    ranged.status === 206 && ranged.len === 1000, JSON.stringify(ranged));

  const straddle = await page.evaluate(async (id) => {
    const r = await fetch('media/' + id, { headers: { Range: 'bytes=1048000-1049999' } });
    return { status: r.status, len: (await r.arrayBuffer()).byteLength };
  }, record.id);
  check('range spanning two chunks is stitched', straddle.status === 206 && straddle.len === 2000,
    JSON.stringify(straddle));

  const openEnded = await page.evaluate(async (id) => {
    const r = await fetch('media/' + id, { headers: { Range: 'bytes=0-' } });
    return { status: r.status, len: (await r.arrayBuffer()).byteLength, cr: r.headers.get('Content-Range') };
  }, record.id);
  check('open ended range is capped, not buffered whole',
    openEnded.status === 206 && openEnded.len === Math.min(4 * 1024 * 1024, FIXTURE_BYTES),
    JSON.stringify(openEnded));

  const past = await page.evaluate(async (id) => {
    const r = await fetch('media/' + id, { headers: { Range: 'bytes=99999999-' } });
    return r.status;
  }, record.id);
  check('range past the end returns 416', past === 416, 'status=' + past);

  /* ------------------------------ the window cap on a file larger than 4 MiB */
  await page.locator('#add-btn').click();
  await page.waitForTimeout(300);
  await page.locator('#file-input').setInputFiles(BIG);
  await page.waitForFunction(
    () => {
      const rows = document.querySelectorAll('.import-status');
      return rows.length > 0 && rows[rows.length - 1].textContent === 'Ready';
    },
    null, { timeout: 60000 }
  );
  const bigId = await page.evaluate(() => {
    const found = App.debug.stories().filter(function (s) { return s.title === 'The Button Kingdom'; });
    return found.length ? found[0].id : null;
  });
  const capped = await page.evaluate(async (id) => {
    const r = await fetch('media/' + id, { headers: { Range: 'bytes=0-' } });
    return { status: r.status, len: (await r.arrayBuffer()).byteLength, cr: r.headers.get('Content-Range') };
  }, bigId);
  check('a long story is served 4 MiB at a time',
    capped.status === 206 && capped.len === 4 * 1024 * 1024 &&
    capped.cr === 'bytes 0-4194303/' + BIG_BYTES, JSON.stringify(capped));
  await page.locator('#add-close').click();
  await page.waitForTimeout(500);
  await page.evaluate(async () => {
    const found = App.debug.stories().filter(function (s) { return s.title === 'The Button Kingdom'; });
    if (found.length) await App.store.deleteStory(found[0].id);
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  /* ---------------------------------------------------------------- playing */
  await page.locator('#library-rows .row .row-open').click();
  await page.waitForTimeout(2500);
  check('player opens', await page.locator('#player').evaluate((n) => n.className.indexOf('is-open') >= 0));

  const state = await page.evaluate(() => ({
    playing: App.player.playing(),
    t: App.player.position(),
    d: App.player.duration(),
    label: document.getElementById('play-label').textContent,
  }));
  check('audio plays from stored chunks', state.playing && state.t > 0, JSON.stringify(state));
  check('duration reaches the player', state.d === 40, 'd=' + state.d);

  const session = await page.evaluate(() => ({
    supported: App.caps.supports('mediaSession'),
    title: navigator.mediaSession && navigator.mediaSession.metadata
      ? navigator.mediaSession.metadata.title : null,
    playbackState: navigator.mediaSession ? navigator.mediaSession.playbackState : null,
  }));
  check('lock screen metadata is published where supported',
    session.supported && session.title === 'Sleepy Foxes' && session.playbackState === 'playing',
    JSON.stringify(session));

  /* ------------------------------------------------------------ sleep timer */
  await page.locator('#open-sheet').click();
  await page.waitForTimeout(500);
  check('sleep sheet opens',
    await page.locator('#sheet').evaluate((n) => n.className.indexOf('is-open') >= 0));
  await page.locator('.timer-opt').first().click();
  await page.waitForTimeout(300);
  check('sleep timer set to 10 minutes',
    (await page.evaluate(() => App.player.currentSleepMinutes())) === 10);

  // The countdown must stop while the story is paused.
  const before = await page.evaluate(() => { App.player.pause(); return App.player.sleepLeft(); });
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => App.player.sleepLeft());
  check('countdown freezes while paused', after === before, `${before} -> ${after}`);
  await page.evaluate(() => App.player.play());
  await page.waitForTimeout(2200);
  const resumed = await page.evaluate(() => App.player.sleepLeft());
  check('countdown resumes on play', resumed < before, `${before} -> ${resumed}`);

  /* ------------------------------------------------------------ persistence */
  await page.locator('#player-fav').click();
  await page.locator('#player-close').click();
  await page.waitForTimeout(500);
  await page.locator('#tab-saved').click();
  await page.waitForTimeout(300);
  check('saved tab lists the favourite', (await page.locator('#saved-rows .row').count()) === 1);

  await page.evaluate(() => App.player.checkpoint(true));
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const reloaded = await page.evaluate(() => {
    const s = App.debug.stories()[0];
    return { pos: s.pos, fav: s.fav, title: s.title };
  });
  check('position survives a reload', reloaded.pos > 0, JSON.stringify(reloaded));
  check('favourite survives a reload', reloaded.fav === true);
  check('keep-going card returns', await page.locator('#keepgoing').isVisible());

  /* ------------------------------------ blob fallback, for WebKit builds that
     will not load a media element through a service worker ------------------ */
  const blobBytes = await page.evaluate(async () => {
    App.media.demote();
    const url = await App.media.blobUrl(App.debug.stories()[0]);
    return (await (await fetch(url)).arrayBuffer()).byteLength;
  });
  check('blob fallback reassembles the file', blobBytes === FIXTURE_BYTES, 'bytes=' + blobBytes);

  /* ---------------------------------------------- removal, through the UI */
  const moon2 = await page.locator('#moon-btn').boundingBox();
  await page.mouse.move(moon2.x + moon2.width / 2, moon2.y + moon2.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(3400);
  await page.mouse.up();
  await page.waitForTimeout(500);

  check('parent controls list what is stored',
    (await page.locator('#stored-list .remove').count()) === 1);

  // Nothing destructive happens without a confirmation, and "keep it" keeps it.
  await page.locator('#stored-list .remove').first().click();
  await page.waitForTimeout(400);
  check('remove asks first',
    await page.locator('#confirm').evaluate((n) => n.className.indexOf('is-on') >= 0));
  const confirmBody = await page.locator('#confirm-body').textContent();
  check('the confirmation names the story and the space it frees',
    (await page.locator('#confirm-title').textContent()).indexOf('Sleepy Foxes') >= 0 &&
    confirmBody.indexOf('MB') >= 0, confirmBody);

  await page.locator('#confirm-no').click();
  await page.waitForTimeout(400);
  check('declining keeps the story', (await page.evaluate(() => App.debug.stories().length)) === 1);
  check('declining closes the confirmation',
    !(await page.locator('#confirm').evaluate((n) => n.className.indexOf('is-on') >= 0)));

  await page.locator('#stored-list .remove').first().click();
  await page.waitForTimeout(300);
  await page.locator('#confirm-yes').click();
  await page.waitForTimeout(1500);
  check('confirming removes the story', (await page.evaluate(() => App.debug.stories().length)) === 0);
  check('and takes its audio with it',
    (await page.evaluate(() => App.store.chunkOwners())).length === 0);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  check('removal survives a reload', (await page.evaluate(() => App.debug.stories().length)) === 0);
  check('empty state returns', await page.locator('#library-empty').isVisible());

  /* An import writes chunks before the story row, so anything that kills the
   * app part way through leaves chunks nothing can reach or delete. */
  const orphans = await page.evaluate(async () => {
    await App.store.putChunk('ghost-story', 0, new ArrayBuffer(2048));
    await App.store.putChunk('ghost-story', 1, new ArrayBuffer(2048));
    const before = await App.store.chunkOwners();
    await App.debug.reclaimOrphanChunks();
    await new Promise((r) => setTimeout(r, 600));
    const after = await App.store.chunkOwners();
    return { before, after };
  });
  check('chunks from an unfinished import are found',
    orphans.before.indexOf('ghost-story') >= 0, JSON.stringify(orphans.before));
  check('and swept up rather than leaking storage',
    orphans.after.indexOf('ghost-story') < 0, JSON.stringify(orphans.after));

  check('no JavaScript errors at any point', errors.length === 0, errors.join(' | '));

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

  const capRows = await old.evaluate(() => {
    return Array.prototype.map.call(document.querySelectorAll('#device-caps .cap'), (n) => ({
      label: n.querySelector('.cap-label').textContent,
      on: n.querySelector('.cap-mark').className.indexOf('is-on') >= 0,
    }));
  });
  check('device list names the four capabilities', capRows.length === 4, JSON.stringify(capRows.map((r) => r.label)));
  check('device list marks lock screen controls as missing',
    capRows.length === 4 && capRows[1].on === false, JSON.stringify(capRows[1]));
  check('device list still confirms offline playback',
    capRows.length === 4 && capRows[0].on === true, JSON.stringify(capRows[0]));

  check('no JavaScript errors on the old device', oldErrors.length === 0, oldErrors.join(' | '));

  /* ============================================================================
     Cover art lookup, with the two hosts faked. The real ones cannot be reached
     from CI, and what matters here is the wiring: a story that arrives without
     embedded art ends up with stored bytes, and the switch actually stops it.
     ========================================================================== */
  const artCtx = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  await artCtx.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.__artCalls = [];
    window.fetch = function (input, init) {
      const url = String(input && input.url ? input.url : input);
      if (url.indexOf('itunes.apple.com') >= 0) {
        window.__artCalls.push(url);
        return Promise.resolve(new Response(JSON.stringify({
          results: [{ collectionName: 'Sleepy Foxes', artworkUrl100: 'https://is1.mzstatic.com/x/100x100bb.jpg' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.indexOf('mzstatic.com') >= 0) {
        window.__artCalls.push(url);
        return Promise.resolve(new Response(
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3, 4]),
          { status: 200, headers: { 'Content-Type': 'image/png' } }
        ));
      }
      return real(input, init);
    };
  });

  const art = await artCtx.newPage();
  const artErrors = [];
  art.on('pageerror', (e) => artErrors.push(e.message));
  await art.goto(ORIGIN, { waitUntil: 'networkidle' });
  await art.waitForTimeout(900);

  await art.locator('.empty-add').click();
  await art.waitForTimeout(300);
  await art.locator('#file-input').setInputFiles(FIXTURE);
  await art.waitForFunction(
    () => { const n = document.querySelector('.import-status'); return n && n.textContent === 'Ready'; },
    null, { timeout: 60000 }
  );
  await art.waitForFunction(() => {
    const s = App.debug.stories()[0];
    return s && (s.hasArt || s.artTried);
  }, null, { timeout: 20000 });

  const cover = await art.evaluate(async () => {
    const s = App.debug.stories()[0];
    const row = await App.store.getArt(s.id);
    return {
      hasArt: s.hasArt,
      bytes: row && row.data ? row.data.byteLength : 0,
      type: row && row.type,
      calls: window.__artCalls.length,
      query: window.__artCalls[0] || '',
    };
  });
  check('an untagged import gets a cover looked up',
    cover.hasArt === true && cover.bytes === 12 && cover.type === 'image/png', JSON.stringify(cover));
  check('the search used the story title',
    cover.query.indexOf(encodeURIComponent('Sleepy Foxes')) >= 0, cover.query);
  check('the found cover is rendered in the library',
    (await art.locator('#library-rows .row .cover').first().evaluate((n) => n.style.backgroundImage))
      .indexOf('blob:') >= 0);

  // Turning it off has to actually stop it.
  await art.evaluate(async () => {
    App.settings.set({ artwork: false });
    App.settings.flush();
    const s = App.debug.stories()[0];
    await App.store.deleteStory(s.id);
    window.__artCalls.length = 0;
  });
  await art.reload({ waitUntil: 'networkidle' });
  await art.waitForTimeout(900);
  await art.locator('.empty-add').click();
  await art.waitForTimeout(300);
  await art.locator('#file-input').setInputFiles(FIXTURE);
  await art.waitForFunction(
    () => { const n = document.querySelector('.import-status'); return n && n.textContent === 'Ready'; },
    null, { timeout: 60000 }
  );
  await art.waitForTimeout(2500);
  const off = await art.evaluate(() => ({
    calls: window.__artCalls.length,
    hasArt: App.debug.stories()[0].hasArt,
  }));
  check('the switch stops the lookup', off.calls === 0 && !off.hasArt, JSON.stringify(off));
  check('no JavaScript errors during artwork lookup', artErrors.length === 0, artErrors.join(' | '));

  await browser.close();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(log.join('\n'));
  console.log(failed ? `\n${failed} failing` : '\nAll browser tests passed.');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.log(log.join('\n'));
  console.error('\nThrew: ' + err.message);
  process.exit(1);
});
