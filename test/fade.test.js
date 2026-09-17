#!/usr/bin/env node
/* Bedtime - the iOS fade: audio.volume read-only, so the timer fades a gain node.
 *
 *   npm run test:fade
 *
 * One of four browser suites, split so they can run at once. The shared
 * fixtures and bookkeeping live in test/harness.js.
 */
'use strict';

const fs = require('fs');
const { chromium } = require('playwright');
const { fixtures, NO_ARTWORK_HOSTS, reporter, launchOptions } = require('./harness.js');

const PORT = 8781;
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
     The iOS fade. audio.volume is read-only there, so the sleep timer has to
     fade a gain node instead - a path no other test here can reach, because
     Chromium's volume is writable and takes the other branch every time. That
     gap hid a bug that stopped the story dead twenty seconds early instead of
     fading it, which is a much worse thing to do to a sleeping child.
     ========================================================================== */
  const iosVolume = () => {
    // iOS accepts the assignment and ignores it.
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      configurable: true, get: d.get, set: function () {},
    });
  };

  async function playWithIosVolume(extraInit) {
    const c = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
    await c.addInitScript(iosVolume);
    if (extraInit) await c.addInitScript(extraInit);
    await c.addInitScript(NO_ARTWORK_HOSTS);
    const pg = await c.newPage();
    await pg.goto(ORIGIN, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(800);
    await pg.locator('.empty-add').click();
    await pg.waitForTimeout(300);
    await pg.locator('#file-input').setInputFiles(FIXTURE);
    await pg.waitForFunction(
      () => { const n = document.querySelector('.import-status'); return n && n.textContent === 'Ready'; },
      null, { timeout: 60000 });
    await pg.locator('#add-close').click();
    await pg.waitForTimeout(400);
    await pg.locator('#library-rows .row .row-open').click();
    await pg.waitForTimeout(2000);
    return { c, pg };
  }

  const fadeCtx = await playWithIosVolume();
  check('the iOS branch is the one under test',
    await fadeCtx.pg.evaluate(() => {
      const a = document.getElementById('audio');
      a.volume = 0.3;
      return a.volume !== 0.3;
    }));

  /* The graph has to exist before the fade needs it. Built at fade time, from a
   * timer, it is a graph iOS will never unlock - and joining the element to it
   * is what silenced the story. */
  check('the audio graph is ready from the moment play is pressed',
    (await fadeCtx.pg.evaluate(() => App.player.fadeLevel())) === 1);

  await fadeCtx.pg.evaluate(() => App.player.setSleepMinutes(25 / 60));   // 20s fade, 5s in
  await fadeCtx.pg.waitForTimeout(1200);
  const fadeBefore = await fadeCtx.pg.evaluate(() => ({ t: App.player.position(), level: App.player.fadeLevel() }));
  await fadeCtx.pg.waitForTimeout(9000);
  const fadeDuring = await fadeCtx.pg.evaluate(() => ({
    t: App.player.position(), level: App.player.fadeLevel(), playing: App.player.playing(),
  }));
  check('the story fades down rather than stopping dead',
    fadeDuring.playing && fadeDuring.level < 0.9 && fadeDuring.level > 0,
    JSON.stringify(fadeDuring));
  check('and keeps playing the whole way through the fade',
    fadeDuring.t - fadeBefore.t > 7, `${fadeBefore.t} -> ${fadeDuring.t}`);

  await fadeCtx.pg.waitForTimeout(16000);
  const fadeDone = await fadeCtx.pg.evaluate(() => ({
    playing: App.player.playing(), asleep: App.player.isAsleep(), level: App.player.fadeLevel(),
  }));
  check('the timer still stops the story at the end', !fadeDone.playing && fadeDone.asleep,
    JSON.stringify(fadeDone));
  check('and leaves the level where a fresh story expects it', fadeDone.level === 1, String(fadeDone.level));

  await fadeCtx.pg.evaluate(() => App.player.wake());
  await fadeCtx.pg.waitForTimeout(700);
  const wokeUp = await fadeCtx.pg.evaluate(() => ({ playing: App.player.playing(), level: App.player.fadeLevel() }));
  check('pressing play again comes back at full volume',
    wokeUp.playing && wokeUp.level === 1, JSON.stringify(wokeUp));
  await fadeCtx.c.close();

  /* The safety property. An element joined to a context iOS has not unlocked
   * plays to nobody, so a context that never reports running must never get the
   * element at all - no fade is a poor night, silence is a woken child. */
  const stuckCtx = await playWithIosVolume(() => {
    const Real = window.AudioContext || window.webkitAudioContext;
    function Stuck() {
      const made = new Real();
      try { Object.defineProperty(made, 'state', { get: function () { return 'suspended'; } }); } catch (e) { void e; }
      made.resume = function () { return Promise.resolve(); };
      return made;
    }
    window.AudioContext = Stuck;
    window.webkitAudioContext = Stuck;
  });
  await stuckCtx.pg.evaluate(() => App.player.setSleepMinutes(25 / 60));
  await stuckCtx.pg.waitForTimeout(1200);
  const stuckBefore = await stuckCtx.pg.evaluate(() => App.player.position());
  await stuckCtx.pg.waitForTimeout(9000);
  const stuck = await stuckCtx.pg.evaluate(() => ({
    t: App.player.position(), level: App.player.fadeLevel(), playing: App.player.playing(),
  }));
  check('a context that never unlocks never gets the element', stuck.level === null, String(stuck.level));
  check('so the story plays on unfaded instead of going silent',
    stuck.playing && stuck.t - stuckBefore > 7, `${stuckBefore} -> ${stuck.t}`);
  await stuckCtx.c.close();
  await browser.close();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  out.finish('fade');
})().catch((err) => out.threw(err));
