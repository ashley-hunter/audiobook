#!/usr/bin/env node
/* Bedtime - the sleep timer on a phone whose volume cannot be set.
 *
 *   npm run test:fade
 *
 * On iOS `audio.volume` is read-only, so the only way to fade a story is to
 * route it through Web Audio. That routing was the cause of a story that went
 * silent while it looked as if it was playing, and of the sound flickering off
 * and on as a fade began or a story started after the phone had been locked:
 * iOS stops and restarts Web Audio whenever the screen locks, and an element
 * routed through it goes with it. The fade could not run with the screen
 * locked anyway, which is how the phone sits at bedtime. So on such a phone
 * the player does not touch Web Audio at all, and the timer stops the story
 * cleanly instead. Where volume can be set, the story still fades; that path
 * is covered in test/browser.test.js.
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

const out = reporter();
const check = out.check;

/* What an iPhone presents: the assignment is accepted and ignored. */
const iosVolume = () => {
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
    configurable: true, get: d.get, set: function () {},
  });
};

/* Counts every audio context the page makes, under either name. Watching from
 * outside rather than asking the player means this cannot be satisfied by a
 * player that simply stops reporting what it does. */
const countContexts = () => {
  window.__contexts = 0;
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Real = window[name];
    if (!Real) continue;
    window[name] = function () {
      window.__contexts++;
      return new Real();
    };
  }
};

(async () => {
  const server = require('./serve.js')();
  await new Promise((resolve) => server.listen(PORT, resolve));
  const browser = await chromium.launch(launchOptions());

  const c = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  await c.addInitScript(iosVolume);
  await c.addInitScript(countContexts);
  await c.addInitScript(NO_ARTWORK_HOSTS);
  const pg = await c.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

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

  check('the phone under test cannot set its volume',
    await pg.evaluate(() => {
      const a = document.getElementById('audio');
      a.volume = 0.3;
      return a.volume !== 0.3;
    }));

  const started = await pg.evaluate(() => ({ playing: App.player.playing(), at: App.player.position() }));
  check('a story plays', started.playing && started.at > 0, JSON.stringify(started));
  check('without the player making an audio context to play it through',
    (await pg.evaluate(() => window.__contexts)) === 0);

  /* The timer, set to run out 25 seconds from now: the window a fade would
   * have covered is the last twenty of those. */
  await pg.evaluate(() => App.player.setSleepMinutes(25 / 60));
  await pg.waitForTimeout(8000);
  const early = await pg.evaluate(() => App.player.position());
  await pg.waitForTimeout(8000);
  const late = await pg.evaluate(() => ({ t: App.player.position(), playing: App.player.playing() }));
  check('the story keeps playing through what would have been the fade',
    late.playing && late.t - early > 6, `${early} -> ${late.t}`);
  check('still without an audio context, even as the timer nears its end',
    (await pg.evaluate(() => window.__contexts)) === 0);

  await pg.waitForFunction(() => App.player.isAsleep(), null, { timeout: 20000 });
  const done = await pg.evaluate(() => ({ playing: App.player.playing(), asleep: App.player.isAsleep() }));
  check('the timer stops the story when it runs out', !done.playing && done.asleep, JSON.stringify(done));

  /* A play after the stop is the "new track after the phone was locked" case
   * that used to blip, as a stopped context was woken to go with it. */
  await pg.evaluate(() => App.player.wake());
  await pg.waitForTimeout(1500);
  const woke = await pg.evaluate(() => ({ playing: App.player.playing(), at: App.player.position() }));
  check('pressing play again plays at once', woke.playing, JSON.stringify(woke));
  check('and nothing along the way ever made an audio context',
    (await pg.evaluate(() => window.__contexts)) === 0);

  check('no JavaScript errors', errors.length === 0, errors.join(' | '));

  await c.close();
  await browser.close();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  out.finish('fade');
})().catch((err) => out.threw(err));
