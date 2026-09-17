/* Bedtime - playback, the sleep timer and the bookkeeping around them.
 *
 * The player owns the <audio> element outright because the fade-out at the end
 * of the sleep timer has to route it through Web Audio - iOS ignores
 * audio.volume - and that routing is permanent for the life of the element.
 *
 * The routing is the delicate part. Connecting an element to a graph takes its
 * sound away from the speakers and hands it to the graph, so an element joined
 * to a context iOS has not unlocked goes completely silent. That has to happen
 * from inside a user gesture, which is why the graph is built when play is
 * pressed rather than at fade time, and why the element is only ever connected
 * once the context is confirmed running. If it never runs there is no fade and
 * the story plays straight to the speakers, which is the right way to fail.
 */
window.App = window.App || {};

App.player = (function () {
  'use strict';

  var FADE_SECONDS = 20;    // how long the story takes to fade to silence
  var SAVE_EVERY = 5;       // seconds between position checkpoints
  var SEEK_STEP = 15;       // lock screen skip, where the platform offers one

  var audio = null;
  var story = null;
  var handlers = {};
  var ticker = null;

  var sleepMinutes = 20;
  var sleepDeadline = 0;    // absolute ms while the timer is running, else 0
  var sleepRemaining = 20 * 60; // seconds left while the timer is paused
  var storiesChosen = 0;    // stop after this many stories; 0 means the timer is in minutes
  var sleepStories = 0;     // stories still to finish, this one included
  var fading = false;
  var fadeTimer = null;
  var asleep = false;
  var usedServiceWorker = false;
  var lastSaved = 0;
  var listenedCarry = 0;
  var lastTickAt = 0;

  var ctx = null;
  var gain = null;
  var graphEl = null;       // the element currently wired into the graph
  var volumeWorks = null;

  function on(map) {
    for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) handlers[k] = map[k];
  }

  function emit(name, a, b) {
    if (handlers[name]) handlers[name](a, b);
  }

  /* The once-a-second tick only runs while sound is actually coming out.
   * Left running it would wake the phone every second for a story that is
   * paused, or for no story at all, which is a real cost on an old battery.
   */
  function startTicker() {
    if (!ticker) ticker = setInterval(tick, 1000);
  }

  function stopTicker() {
    clearInterval(ticker);
    ticker = null;
  }

  function makeAudio() {
    var el = document.createElement('audio');
    el.preload = 'metadata';
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    el.id = 'audio';
    el.addEventListener('error', onAudioError);
    el.addEventListener('ended', onEnded);
    // The sleep timer follows the element, not our own calls, so an
    // interruption (a phone call, another app taking audio) pauses it too.
    el.addEventListener('play', function () {
      startTicker();
      resumeSleep();
      App.caps.media.setPlaybackState(true);
      emit('state', true);
    });
    el.addEventListener('pause', function () {
      stopTicker();
      suspendSleep();
      App.caps.media.setPlaybackState(false);
      emit('state', false);
      tick();                 // settle the labels on the way out
    });
    el.addEventListener('loadedmetadata', function () { emit('tick', position(), duration()); });
    return el;
  }

  function init() {
    var existing = document.getElementById('audio');
    audio = makeAudio();
    if (existing && existing.parentNode) existing.parentNode.replaceChild(audio, existing);
    else document.body.appendChild(audio);

    // Safari 16.4 and up: mark this as playback rather than an incidental
    // sound, so it survives the silent switch. Older iOS simply does without.
    App.caps.claimPlaybackAudio();
    registerLockScreenControls();

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) tick();     // catch up after the app was backgrounded
      else checkpoint(true);
    });
    window.addEventListener('pagehide', function () { checkpoint(true); });
  }

  /* Lock screen and headphone controls on iOS 15+, Android and desktop. On an
   * iPhone 6 none of this exists and the in-app controls are the only ones.
   */
  function registerLockScreenControls() {
    App.caps.media.setActions({
      play: function () { play(); },
      pause: function () { pause(); },
      stop: function () { pause(); },
      back: function () { seekBy(-SEEK_STEP); },
      forward: function () { seekBy(SEEK_STEP); }
    });
  }

  function publishNowPlaying() {
    if (!story) return;
    App.caps.media.setMetadata({
      title: story.title,
      artist: story.narrator && story.narrator !== 'you' ? 'Read by ' + story.narrator : 'Bedtime',
      album: story.album || 'Bedtime'
    });
    App.caps.media.setPlaybackState(playing());
    if (story.hasArt) {
      App.media.artUrl(story.id).then(function (url) {
        if (!url || !story || story.id !== (currentStory() && currentStory().id)) return;
        App.caps.media.setMetadata({
          title: story.title,
          artist: story.narrator && story.narrator !== 'you' ? 'Read by ' + story.narrator : 'Bedtime',
          album: story.album || 'Bedtime',
          artwork: url
        });
      });
    }
  }

  function seekBy(seconds) {
    seekTo(position() + seconds);
  }

  function seekTo(seconds) {
    if (!story || !audio) return;
    var total = duration();
    // Landing exactly on the end fires `ended` and throws the story away, which
    // is not what dragging the slider to the right edge should mean.
    var target = Math.max(0, Math.min(total > 1 ? total - 1 : 0, seconds));
    try { audio.currentTime = target; } catch (err) { void err; }
    checkpoint(true);
    App.caps.media.setPosition(total, target, audio.playbackRate || 1);
    emit('tick', position(), total);
  }

  /* ------------------------------------------------------------- loading */

  function load(next, options) {
    var opts = options || {};
    checkpoint(true);
    story = next;
    asleep = false;
    fading = false;
    listenedCarry = 0;
    lastTickAt = 0;
    lastSaved = 0;

    return App.media.source(story).then(function (src) {
      usedServiceWorker = src.viaServiceWorker;
      audio.src = src.url;
      audio.load();
      var startAt = typeof opts.startAt === 'number' ? opts.startAt : (story.pos || 0);
      if (startAt > 1) seekWhenReady(startAt);
      publishNowPlaying();
      emit('loaded', story);
      if (opts.autoplay) return play();
      return null;
    });
  }

  function seekWhenReady(seconds) {
    function trySeek() {
      try {
        if (audio.readyState >= 1 && isFinite(audio.duration) && audio.duration > 0) {
          audio.currentTime = Math.min(seconds, Math.max(0, audio.duration - 2));
          return true;
        }
        audio.currentTime = seconds;
        return true;
      } catch (err) { void err; return false; }
    }
    if (trySeek()) return;
    audio.addEventListener('loadedmetadata', function once() {
      audio.removeEventListener('loadedmetadata', once);
      trySeek();
    });
  }

  /* ----------------------------------------------------------- transport */

  function play() {
    if (!story) return Promise.resolve();
    asleep = false;
    /* Pressing play is the user gesture the audio graph needs. Building it here
     * rather than when the fade starts is the whole reason the fade works: a
     * context first created from a timer, twenty seconds before the end, is one
     * iOS will never unlock. */
    ensureGraph();
    restoreGain();
    var result = audio.play();
    if (result && result['catch']) {
      return result['catch'](function (err) {
        if (err && err.name === 'NotAllowedError') {
          emit('error', 'Tap play once more to start the story.');
        } else {
          emit('error', 'That story would not start.');
        }
      });
    }
    return Promise.resolve();
  }

  function pause() {
    if (audio) audio.pause();
    checkpoint(true);
  }

  // Stops and lets go of the story, keeping its place for next time.
  function unload() {
    if (!story) return;
    pause();
    stopTicker();
    story = null;
    fading = false;
    restoreGain();
    audio.removeAttribute('src');
    audio.load();
    App.caps.media.setPlaybackState(false);
  }

  function toggle() {
    if (!story) return Promise.resolve();
    if (audio.paused) return play();
    pause();
    recordNight(false);
    return Promise.resolve();
  }

  function position() { return audio && isFinite(audio.currentTime) ? audio.currentTime : 0; }

  function duration() {
    if (audio && isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    return story && story.len ? story.len : 0;
  }

  function playing() { return !!(audio && !audio.paused && !audio.ended); }

  function currentStory() { return story; }
  function ended() { return !!(audio && audio.ended); }

  /* --------------------------------------------------------- sleep timer */

  function armSleep(minutes) {
    storiesChosen = 0;
    sleepStories = 0;
    sleepMinutes = minutes;
    sleepRemaining = minutes * 60;
    sleepDeadline = playing() ? Date.now() + sleepRemaining * 1000 : 0;
    fading = false;
    restoreGain();
  }

  // The countdown only runs while sound is actually coming out.
  function resumeSleep() {
    if (storiesChosen) {
      if (!sleepStories) sleepStories = storiesChosen;   // a new night after the last one ended
      return;
    }
    if (sleepDeadline) return;
    if (sleepRemaining <= 0) sleepRemaining = sleepMinutes * 60;
    sleepDeadline = Date.now() + sleepRemaining * 1000;
  }

  function suspendSleep() {
    if (storiesChosen) {
      fading = false;
      return;
    }
    if (!sleepDeadline) return;
    sleepRemaining = sleepLeft();
    sleepDeadline = 0;
    /* A fade in progress is abandoned along with the countdown. Without this,
     * pausing inside the last twenty seconds and playing again leaves `fading`
     * set: play() restores the volume, the tick sees a fade already running and
     * never starts another, and the story is cut off at full volume instead of
     * being faded out.
     */
    fading = false;
  }

  function setSleepMinutes(minutes) {
    armSleep(minutes);
    emit('sleep', sleepLeft());
  }

  /* Stops after `count` stories, counting the one playing now however far into
   * it the child already is. The last one fades out over its closing seconds
   * and the night ends when it does.
   */
  function setSleepStories(count) {
    storiesChosen = count;
    sleepStories = count;
    sleepDeadline = 0;
    fading = false;
    restoreGain();
    emit('sleep', sleepLeft());
  }

  function defaultSleepMinutes(minutes) {
    sleepMinutes = minutes;
    sleepRemaining = minutes * 60;
    if (sleepDeadline) sleepDeadline = Date.now() + sleepRemaining * 1000;
  }

  /* Hands an unfinished countdown to the story that follows. Ending a story
   * resets the timer, which is right when that was the last of the night and
   * wrong when a line-up runs on: twenty minutes of sleep timer has to mean
   * twenty minutes, not twenty minutes per story.
   */
  function carrySleep(seconds) {
    if (!(seconds > 0)) return;
    if (storiesChosen) {   // the count already carries itself; `seconds` is stories left
      fading = false;
      restoreGain();
      emit('sleep', sleepLeft());
      return;
    }
    sleepRemaining = seconds;
    sleepDeadline = playing() ? Date.now() + seconds * 1000 : 0;
    fading = false;
    restoreGain();
    emit('sleep', sleepLeft());
  }

  function sleepLeft() {
    // In story mode, anything above zero means the night is still going.
    if (storiesChosen) return sleepStories ? Math.max(1, Math.round(duration() - position())) : 0;
    if (!sleepDeadline) return sleepRemaining;
    return Math.max(0, Math.round((sleepDeadline - Date.now()) / 1000));
  }

  function currentSleepMinutes() { return sleepMinutes; }
  function currentSleepStories() { return sleepStories; }
  function sleepByStories() { return storiesChosen; }

  function wake() {
    asleep = false;
    if (storiesChosen) setSleepStories(storiesChosen);
    else armSleep(sleepMinutes);
    return play();
  }

  /* -------------------------------------------------------------- ticker */

  function tick() {
    if (!story) return;
    var isPlaying = playing();

    if (isPlaying) {
      var now = Date.now();
      if (lastTickAt) {
        var gapSeconds = Math.min(60, (now - lastTickAt) / 1000);
        listenedCarry += gapSeconds;
      }
      lastTickAt = now;
      if (listenedCarry >= 15) {
        App.stats.addListening(Math.round(listenedCarry));
        listenedCarry = 0;
      }
      checkpoint(false);
    } else {
      lastTickAt = 0;
    }

    emit('tick', position(), duration());
    if (isPlaying) App.caps.media.setPosition(duration(), position(), audio.playbackRate || 1);
    // A context unlocked a moment after play was pressed still gets wired up,
    // so the fade is ready long before the timer needs it.
    if (isPlaying && ctx && !gain) connectGraph();

    if (storiesChosen) {
      emit('sleep', sleepLeft());
      tickStoryFade(isPlaying);
      return;
    }

    if (!sleepDeadline || !isPlaying) {
      emit('sleep', sleepLeft());
      return;
    }

    var left = sleepLeft();
    emit('sleep', left);

    if (left <= 0) {
      finishSleep();
    } else if (left <= FADE_SECONDS && !fading) {
      startFade(left);
    }
  }

  function tickStoryFade(isPlaying) {
    var tail = duration() - position();
    if (!isPlaying || sleepStories !== 1 || !(duration() > 0)) return;
    if (!fading && tail <= FADE_SECONDS) {
      startFade(tail);
    } else if (fading && tail > FADE_SECONDS + 2) {
      // Scrubbed back out of the ending: full volume until it comes round again.
      fading = false;
      restoreGain();
    }
  }

  function finishSleep() {
    fading = false;
    audio.pause();          // clears sleepDeadline through the pause handler
    sleepDeadline = 0;
    sleepRemaining = 0;     // stays at zero so the label reads "finished"
    checkpoint(true);
    restoreGain();
    asleep = true;
    recordNight(true);
    emit('asleep');
  }

  /* ---------------------------------------------------------------- fade */

  function volumeIsWritable() {
    if (volumeWorks !== null) return volumeWorks;
    try {
      var before = audio.volume;
      audio.volume = 0.42;
      volumeWorks = Math.abs(audio.volume - 0.42) < 0.01;
      audio.volume = before;
    } catch (err) {
      void err;
      volumeWorks = false;
    }
    return volumeWorks;
  }

  function startFade(seconds) {
    if (volumeIsWritable()) {
      fading = true;
      fadeWithVolume(seconds);
      return;
    }
    if (gain && ctx && ctx.state === 'running') {
      fading = true;
      fadeWithGain(seconds);
      return;
    }
    /* No live graph, so there is no way to fade on this device. Leaving `fading`
     * unset means the tick tries again a second later, in case the context
     * finishes unlocking inside the window; if it never does, the timer stops
     * the story unfaded. That is worse than a fade and far better than the
     * alternative this replaced, which reached for a graph that was not ready
     * and silenced the story on the spot.
     */
    fading = false;
  }

  function fadeWithVolume(seconds) {
    var startedAt = Date.now();
    var from = audio.volume;
    clearInterval(fadeTimer);
    fadeTimer = setInterval(function () {
      var elapsed = (Date.now() - startedAt) / 1000;
      var ratio = Math.max(0, 1 - elapsed / seconds);
      try { audio.volume = from * ratio * ratio; } catch (err) { void err; }
      if (ratio <= 0 || audio.paused) clearInterval(fadeTimer);
    }, 120);
  }

  /* A straight line in amplitude falls away faster than the ear expects, so the
   * curve is the same quadratic the volume path uses, scheduled as a handful of
   * short ramps. setValueCurveAtTime would say it in one call, but it is the
   * least reliable corner of Web Audio on older WebKit and this needs none of
   * its cleverness.
   */
  function fadeWithGain(seconds) {
    var STEPS = 24;
    try {
      var now = ctx.currentTime;
      var from = gain.gain.value || 1;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(from, now);
      for (var i = 1; i <= STEPS; i++) {
        var through = i / STEPS;
        var level = from * (1 - through) * (1 - through);
        // A gain of exactly zero is inaudible either way and keeps the ramp legal.
        gain.gain.linearRampToValueAtTime(Math.max(0.0001, level), now + seconds * through);
      }
    } catch (err) {
      void err;
      fading = false;
    }
  }

  /* Builds the graph, and unlocks it if iOS will allow it right now. Safe to
   * call on every play: making a context costs nothing, and the element is not
   * joined to it until the context is actually running.
   */
  function ensureGraph() {
    if (volumeIsWritable()) return;      // the plain element can fade itself
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    try {
      if (!ctx) {
        ctx = new Ctor();
        unlockContext(ctx);
      }
      if (ctx.state === 'suspended' && ctx.resume) {
        var resumed = ctx.resume();
        if (resumed && resumed.then) resumed.then(connectGraph, function () { return null; });
      }
      connectGraph();
    } catch (err) {
      void err;
      ctx = null;
      gain = null;
      graphEl = null;
    }
  }

  // Older iOS only really starts a context once something has played through it
  // inside a gesture. One silent sample is the long-standing handshake.
  function unlockContext(context) {
    try {
      var source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 1, 22050);
      source.connect(context.destination);
      if (source.start) source.start(0);
      else if (source.noteOn) source.noteOn(0);
    } catch (err) { void err; }
  }

  /* The one dangerous call in the file. createMediaElementSource takes the
   * element's sound away from the speakers for good, so it only ever runs
   * against a context that is already running.
   */
  function connectGraph() {
    if (!ctx || !audio) return;
    if (graphEl === audio && gain) return;
    if (ctx.state !== 'running') return;
    try {
      var source = ctx.createMediaElementSource(audio);
      gain = ctx.createGain();
      gain.gain.value = 1;
      source.connect(gain);
      gain.connect(ctx.destination);
      graphEl = audio;
    } catch (err) {
      void err;
      gain = null;
      graphEl = null;
    }
  }

  // Whatever happened last night, the story starts at full volume.
  function restoreGain() {
    clearInterval(fadeTimer);   // or a fade still running pulls the volume back down
    if (gain && ctx) {
      try {
        var now = ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(1, now);
        gain.gain.value = 1;
      } catch (err) { void err; }
    }
    if (audio && volumeWorks) {
      try { audio.volume = 1; } catch (err) { void err; }
    }
  }

  /* ----------------------------------------------------------- bookkeeping */

  function checkpoint(force) {
    if (!story) return;
    // onEnded already put a finished story back to the start. Saving the end
    // position over that would make its next play finish straight away.
    if (audio && audio.ended) return;
    var pos = position();
    if (!force && Math.abs(pos - lastSaved) < SAVE_EVERY) return;
    lastSaved = pos;
    story.pos = pos;
    story.lastPlayedAt = Date.now();
    App.store.patchStory(story.id, { pos: pos, lastPlayedAt: story.lastPlayedAt })['catch'](function () { return null; });
    if (listenedCarry >= 1) {
      App.stats.addListening(Math.round(listenedCarry));
      listenedCarry = 0;
    }
  }

  function recordNight(sleptThrough) {
    if (!story) return;
    App.stats.recordNight(sleptThrough);
  }

  function onEnded() {
    stopTicker();
    var carried;
    if (storiesChosen) {
      sleepStories = Math.max(0, sleepStories - 1);
      carried = sleepStories;
      fading = false;
      restoreGain();
    } else {
      carried = sleepLeft();      // read before the reset below throws it away
      sleepDeadline = 0;
      sleepRemaining = sleepMinutes * 60;
    }

    if (story) {
      story.pos = 0;
      App.store.patchStory(story.id, { pos: 0 })['catch'](function () { return null; });
    }
    emit('ended', carried);
    // After `ended`, whose handler clears the curtain for the story that follows.
    if (storiesChosen && !carried) {
      asleep = true;
      recordNight(true);
      emit('asleep');
    }
  }

  function onAudioError() {
    if (!story) return;
    if (usedServiceWorker) {
      // Some WebKit builds will not let a media element load through a service
      // worker. Fall back to a Blob URL and pick up where we were.
      App.media.demote();
      usedServiceWorker = false;
      var resumeAt = position() || story.pos || 0;
      var wasPlaying = playing();
      App.media.blobUrl(story).then(function (url) {
        audio.src = url;
        audio.load();
        seekWhenReady(resumeAt);
        if (wasPlaying) play();
      })['catch'](function () {
        emit('error', 'That story could not be read back from storage.');
      });
      return;
    }
    emit('error', 'That story could not be played.');
  }

  return {
    init: init,
    on: on,
    load: load,
    play: play,
    pause: pause,
    toggle: toggle,
    unload: unload,
    seekBy: seekBy,
    seekTo: seekTo,
    wake: wake,
    position: position,
    duration: duration,
    playing: playing,
    currentStory: currentStory,
    ended: ended,
    setSleepMinutes: setSleepMinutes,
    setSleepStories: setSleepStories,
    carrySleep: carrySleep,
    defaultSleepMinutes: defaultSleepMinutes,
    currentSleepMinutes: currentSleepMinutes,
    currentSleepStories: currentSleepStories,
    sleepByStories: sleepByStories,
    sleepLeft: sleepLeft,
    fadeLevel: function () { return gain ? gain.gain.value : null; },
    ticking: function () { return !!ticker; },
    isAsleep: function () { return asleep; },
    checkpoint: checkpoint
  };
})();
