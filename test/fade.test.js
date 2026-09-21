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

  /* The context has to be unlocked while there is a tap to unlock it with:
   * created from a timer twenty seconds before the end, it is one iOS will
   * never start. But the element is not routed through it until a fade needs
   * it. An element routed through Web Audio can only be heard while the
   * context runs, and iOS stops the context when the screen locks, when a
   * call comes in, when the app goes to the background - leaving a story that
   * looks as if it is playing and makes no sound at all. */
  check('the audio context is unlocked when play is pressed',
    (await fadeCtx.pg.evaluate(() => {
      const ctx = App.player.audioContext();
      return !!ctx && ctx.state === 'running';
    })));
  check('but the story plays straight to the speaker until a fade needs the graph',
    (await fadeCtx.pg.evaluate(() => App.player.routed())) === false);

  /* What the screen locking does: iOS suspends the context. A story routed
   * through it goes on "playing" - the position moves, the button says Pause -
   * with nothing coming out. */
  const lockScreen = () => fadeCtx.pg.evaluate(async () => {
    const ctx = App.player.audioContext();
    await ctx.suspend();
    // iOS will not start a stopped context again without a tap. Chromium, told
    // to allow autoplay, would, so it is told no.
    ctx.resume = () => Promise.resolve();
  });
  const unlockScreen = () => fadeCtx.pg.evaluate(async () => {
    const ctx = App.player.audioContext();
    delete ctx.resume;
    await ctx.resume();
  });

  await lockScreen();
  const suspended = await fadeCtx.pg.evaluate(async () => {
    const before = App.player.position();
    await new Promise((r) => setTimeout(r, 2500));
    const ctx = App.player.audioContext();
    return {
      playing: App.player.playing(),
      moved: App.player.position() - before,
      audible: !App.player.routed() || (!!ctx && ctx.state === 'running'),
    };
  });
  check('a context stopped mid-story does not silence it',
    suspended.playing && suspended.moved > 1.5 && suspended.audible, JSON.stringify(suspended));

  /* And what a story running on into the next one does: the next story loads
   * into the same element, with no tap to resume a stopped context with. */
  const next = await fadeCtx.pg.evaluate(async () => {
    const story = App.debug.stories()[0];
    await App.player.load(story, { autoplay: true, startAt: 1 });
    await new Promise((r) => setTimeout(r, 2000));
    const ctx = App.player.audioContext();
    return {
      playing: App.player.playing(),
      audible: !App.player.routed() || (!!ctx && ctx.state === 'running'),
    };
  });
  check('the next story is not silenced by a context that stopped',
    next.playing && next.audible, JSON.stringify(next));

  // Back to a running context for the fade itself.
  await unlockScreen();
  await fadeCtx.pg.waitForTimeout(300);

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
  check('and lets go of the graph, so the next story plays straight to the speaker',
    (await fadeCtx.pg.evaluate(() => App.player.routed())) === false);

  await fadeCtx.pg.evaluate(() => App.player.wake());
  await fadeCtx.pg.waitForTimeout(700);
  const wokeUp = await fadeCtx.pg.evaluate(() => ({ playing: App.player.playing(), routed: App.player.routed() }));
  check('pressing play again comes back at full volume',
    wokeUp.playing && wokeUp.routed === false, JSON.stringify(wokeUp));

  /* A context that stops during the fade itself - the screen locking in the
   * last twenty seconds - has the element routed through it. The sound has to
   * come back, even though the fade is lost. */
  const midFade = await fadeCtx.pg.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    App.player.setSleepMinutes(25 / 60);
    await wait(7000);                              // into the fade
    const routedInFade = App.player.routed();
    const ctx0 = App.player.audioContext();
    await ctx0.suspend();
    ctx0.resume = () => Promise.resolve();       // no tap on a locked screen
    await wait(2500);
    const ctx = App.player.audioContext();
    return {
      routedInFade,
      playing: App.player.playing(),
      audible: !App.player.routed() || (!!ctx && ctx.state === 'running'),
    };
  });
  check('the fade is where the graph is used',
    midFade.routedInFade === true, JSON.stringify(midFade));
  check('and a context stopped during it gives the sound back',
    midFade.playing && midFade.audible, JSON.stringify(midFade));
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
