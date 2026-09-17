#!/usr/bin/env node
/* Bedtime - cover art lookup, with both search hosts faked.
 *
 *   npm run test:artfake
 *
 * One of four browser suites, split so they can run at once. The shared
 * fixtures and bookkeeping live in test/harness.js.
 */
'use strict';

const fs = require('fs');
const { chromium } = require('playwright');
const { fixtures, NO_ARTWORK_HOSTS, reporter, launchOptions } = require('./harness.js');

const PORT = 8780;
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

  /* The cover has to be bytes in storage, not a link to Apple's servers. A
   * remote URL would leave the library looking broken in the one place this
   * app is meant to work. */
  await artCtx.setOffline(true);
  await art.reload({ waitUntil: 'domcontentloaded' });
  await art.waitForTimeout(1500);
  const coverOffline = await art
    .locator('#library-rows .row .cover').first().evaluate((n) => n.style.backgroundImage);
  check('the cover still paints with no network',
    coverOffline.indexOf('blob:') >= 0, coverOffline.slice(0, 60));
  await artCtx.setOffline(false);

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

  /* A story imported with no signal must stay eligible: recording a miss when
   * nothing answered would write it off as having no cover for good. */
  const retryable = await art.evaluate(async () => {
    App.settings.set({ artwork: true });
    App.settings.flush();
    const story = App.debug.stories()[0];
    await App.store.patchStory(story.id, { hasArt: false, artTried: false });
    story.hasArt = false;
    story.artTried = false;

    const saved = window.fetch;
    window.fetch = function () { return Promise.reject(new TypeError('Failed to fetch')); };
    await App.debug.findArtwork(story);
    window.fetch = saved;

    const row = await App.store.getStory(story.id);
    return { artTried: row.artTried, hasArt: row.hasArt };
  });
  check('an unreachable lookup is not recorded as a miss',
    !retryable.artTried && !retryable.hasArt, JSON.stringify(retryable));

  // Not recording the miss is only worth anything if something comes back for
  // it, so the next boot with signal has to finish the job unprompted.
  await art.reload({ waitUntil: 'networkidle' });
  const caughtUp = await art.waitForFunction(
    () => { const s = App.debug.stories()[0]; return !!(s && s.hasArt); },
    null, { timeout: 25000 }
  ).then(() => true, () => false);
  check('and a later boot with signal picks the story back up', caughtUp);
  check('no JavaScript errors during artwork lookup', artErrors.length === 0, artErrors.join(' | '));
  await browser.close();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  out.finish('artwork lookup');
})().catch((err) => out.threw(err));
