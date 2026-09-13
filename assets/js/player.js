/* Bedtime - playback, the sleep timer and the bookkeeping around them.
 *
 * The player owns the <audio> element outright because the fade-out at the end
 * of the sleep timer has to route the element through Web Audio (iOS ignores
 * audio.volume), and that routing is permanent for the life of the element.
 * After a fade the element is thrown away and a fresh one takes its place.
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
  var fading = false;
  var asleep = false;
  var usedServiceWorker = false;
  var lastSaved = 0;
  var listenedCarry = 0;
  var lastTickAt = 0;

  var ctx = null;
  var gain = null;
  var volumeWorks = null;

  function on(map) {
    for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) handlers[k] = map[k];
  }

  function emit(name, a, b) {
    if (handlers[name]) handlers[name](a, b);
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
      resumeSleep();
      App.caps.media.setPlaybackState(true);
      emit('state', true);
    });
    el.addEventListener('pause', function () {
      suspendSleep();
      App.caps.media.setPlaybackState(false);
      emit('state', false);
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

    ticker = setInterval(tick, 1000);
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

  function replaceAudio() {
    var old = audio;
    audio = makeAudio();
    if (old && old.parentNode) old.parentNode.replaceChild(audio, old);
    else document.body.appendChild(audio);
    if (old) {
      old.removeAttribute('src');
      try { old.load(); } catch (err) { void err; }
    }
    ctx = null;
    gain = null;
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
    if (ctx) replaceAudio();

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

  /* --------------------------------------------------------- sleep timer */

  function armSleep(minutes) {
    sleepMinutes = minutes;
    sleepRemaining = minutes * 60;
    sleepDeadline = playing() ? Date.now() + sleepRemaining * 1000 : 0;
    fading = false;
    restoreGain();
  }

  // The countdown only runs while sound is actually coming out.
  function resumeSleep() {
    if (sleepDeadline) return;
    if (sleepRemaining <= 0) sleepRemaining = sleepMinutes * 60;
    sleepDeadline = Date.now() + sleepRemaining * 1000;
  }

  function suspendSleep() {
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

  function defaultSleepMinutes(minutes) {
    sleepMinutes = minutes;
    sleepRemaining = minutes * 60;
    if (sleepDeadline) sleepDeadline = Date.now() + sleepRemaining * 1000;
  }

  function sleepLeft() {
    if (!sleepDeadline) return sleepRemaining;
    return Math.max(0, Math.round((sleepDeadline - Date.now()) / 1000));
  }

  function currentSleepMinutes() { return sleepMinutes; }

  function wake() {
    asleep = false;
    armSleep(sleepMinutes);
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
    fading = true;
    if (volumeIsWritable()) {
      fadeWithVolume(seconds);
      return;
    }
    if (!fadeWithWebAudio(seconds)) {
      // No way to fade on this device - the timer just stops the story.
      fading = false;
    }
  }

  function fadeWithVolume(seconds) {
    var startedAt = Date.now();
    var from = audio.volume;
    var handle = setInterval(function () {
      var elapsed = (Date.now() - startedAt) / 1000;
      var ratio = Math.max(0, 1 - elapsed / seconds);
      try { audio.volume = from * ratio * ratio; } catch (err) { void err; }
      if (ratio <= 0 || audio.paused) clearInterval(handle);
    }, 120);
  }

  function fadeWithWebAudio(seconds) {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return false;
    try {
      if (!ctx) {
        ctx = new Ctor();
        var sourceNode = ctx.createMediaElementSource(audio);
        gain = ctx.createGain();
        sourceNode.connect(gain);
        gain.connect(ctx.destination);
      }
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      var now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value || 1, now);
      gain.gain.linearRampToValueAtTime(0.0001, now + seconds);
      return true;
    } catch (err) {
      void err;
      ctx = null;
      gain = null;
      return false;
    }
  }

  function restoreGain() {
    if (gain && ctx) {
      try {
        gain.gain.cancelScheduledValues(ctx.currentTime);
        gain.gain.setValueAtTime(1, ctx.currentTime);
      } catch (err) { void err; }
    }
    if (audio && volumeWorks) {
      try { audio.volume = 1; } catch (err) { void err; }
    }
  }

  /* ----------------------------------------------------------- bookkeeping */

  function checkpoint(force) {
    if (!story) return;
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
    sleepDeadline = 0;
    sleepRemaining = sleepMinutes * 60;

    if (story) {
      story.pos = 0;
      App.store.patchStory(story.id, { pos: 0 })['catch'](function () { return null; });
    }
    emit('ended');
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
    seekBy: seekBy,
    seekTo: seekTo,
    wake: wake,
    position: position,
    duration: duration,
    playing: playing,
    currentStory: currentStory,
    setSleepMinutes: setSleepMinutes,
    defaultSleepMinutes: defaultSleepMinutes,
    currentSleepMinutes: currentSleepMinutes,
    sleepLeft: sleepLeft,
    isAsleep: function () { return asleep; },
    checkpoint: checkpoint
  };
})();
