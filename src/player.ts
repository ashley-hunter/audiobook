/* Bedtime - playback, the sleep timer and the bookkeeping around them.
 *
 * The player owns the <audio> element, and the element always plays straight
 * to the speaker. Web Audio is deliberately not used. On iOS, where a fade
 * would need it because `audio.volume` is read-only, routing the element
 * through Web Audio made it hostage to a context iOS stops whenever the screen
 * locks: the story went silent while every sign said it was playing, and
 * waking the context again flickered the sound. So the sleep timer fades by
 * the element's own volume where the phone allows it, and on an iPhone it
 * stops the story when it runs out.
 */
window.App = window.App || ({} as typeof App);

App.player = (function (): PlayerModule {
  'use strict';

  var FADE_SECONDS = 20;    // how long the story takes to fade to silence
  var SAVE_EVERY = 5;       // seconds between position checkpoints
  var SEEK_STEP = 15;       // lock screen skip, where the platform offers one

  var audio: HTMLAudioElement | null = null;
  var story: Story | null = null;
  var handlers: PlayerHandlers = {};
  var ticker: number | undefined;        // undefined rather than null, so clearInterval takes it as it is

  var sleepMinutes = 20;
  var sleepDeadline = 0;    // absolute ms while the timer is running, else 0
  var sleepRemaining = 20 * 60; // seconds left while the timer is paused
  var storiesChosen = 0;    // stop after this many stories; 0 means the timer is in minutes
  var sleepStories = 0;     // stories still to finish, this one included
  var fading = false;
  var fadeTimer: number | undefined;
  var asleep = false;
  var usedServiceWorker = false;
  var lastSaved = 0;
  var listenedCarry = 0;
  var lastTickAt = 0;

  var volumeWorks: boolean | null = null;

  function on(map: PlayerHandlers): void {
    for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) handlers[k] = map[k];
  }

  function emit(name: string, a?: any, b?: any): void {
    if (handlers[name]) handlers[name](a, b);
  }

  /* The once-a-second tick only runs while sound is actually coming out.
   * Left running it would wake the phone every second for a story that is
   * paused, or for no story at all, which is a real cost on an old battery.
   */
  function startTicker(): void {
    if (!ticker) ticker = setInterval(tick, 1000);
  }

  function stopTicker(): void {
    clearInterval(ticker);
    ticker = undefined;
  }

  function makeAudio(): HTMLAudioElement {
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

    /* What the element does, in the diagnostics log. These are the events that
     * would have shown the silent-playback bug for what it was: playing, while
     * the position stood still. Waiting and stalled are where a phone short of
     * data - or a route that has stopped delivering - shows itself. */
    el.addEventListener('play', function () { note('Playing'); });
    el.addEventListener('pause', function () { note('Paused'); });
    el.addEventListener('ended', function () { note('Reached the end'); });
    el.addEventListener('waiting', function () { note('Waiting for audio'); });
    el.addEventListener('stalled', function () { note('Stalled'); });
    return el;
  }

  // One line for the log: what happened, where, in which story.
  function note(what: string): void {
    var title = story ? ' in "' + story.title + '"' : '';
    App.log.add('audio', what + ' at ' + App.ui.clock(position()) + title);
  }

  function init(): void {
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
  function registerLockScreenControls(): void {
    App.caps.media.setActions({
      play: function () { play(); },
      pause: function () { pause(); },
      stop: function () { pause(); },
      back: function () { seekBy(-SEEK_STEP); },
      forward: function () { seekBy(SEEK_STEP); }
    });
  }

  function publishNowPlaying(): void {
    if (!story) return;
    App.caps.media.setMetadata({
      title: story.title,
      artist: story.narrator && story.narrator !== 'you' ? 'Read by ' + story.narrator : 'Bedtime',
      album: story.album || 'Bedtime'
    });
    App.caps.media.setPlaybackState(playing());
    if (story!.hasArt) {
      App.media.artUrl(story!.id).then(function (url) {
        // `currentStory()` is called twice on purpose - it is a plain read of
        // the closure variable, not something worth caching - but the second
        // call's result is not narrowed by the `&&`, so it is asserted here.
        if (!url || !story || story.id !== (currentStory() && (currentStory() as Story).id)) return;
        App.caps.media.setMetadata({
          title: story.title,
          artist: story.narrator && story.narrator !== 'you' ? 'Read by ' + story.narrator : 'Bedtime',
          album: story.album || 'Bedtime',
          artwork: url
        });
      });
    }
  }

  function seekBy(seconds: number): void {
    seekTo(position() + seconds);
  }

  function seekTo(seconds: number): void {
    if (!story || !audio) return;
    var total = duration();
    // Landing exactly on the end fires `ended` and throws the story away, which
    // is not what dragging the slider to the right edge should mean.
    var target = Math.max(0, Math.min(total > 1 ? total - 1 : 0, seconds));
    try { audio!.currentTime = target; } catch (err) { void err; }
    checkpoint(true);
    App.caps.media.setPosition(total, target, audio!.playbackRate || 1);
    emit('tick', position(), total);
  }

  /* ------------------------------------------------------------- loading */

  function load(next: Story, options?: LoadOptions): Promise<unknown> {
    var opts = options || {};
    checkpoint(true);
    /* Where the service worker route is unusable, a story is played from a Blob
     * holding the whole file. Letting go of the last one keeps a night of
     * several stories from stacking up whole audiobooks in memory.
     */
    if (story && story.id !== next.id) App.media.release(story.id);
    story = next;
    asleep = false;
    fading = false;
    listenedCarry = 0;
    lastTickAt = 0;
    lastSaved = 0;

    return App.media.source(story).then(function (src) {
      usedServiceWorker = src.viaServiceWorker;
      App.log.add('audio', 'Loading "' + story!.title + '" through ' +
        (src.viaServiceWorker ? 'the service worker' : 'a Blob'));
      audio!.src = src.url;
      audio!.load();
      var startAt = typeof opts.startAt === 'number' ? opts.startAt : (story!.pos || 0);
      if (startAt > 1) seekWhenReady(startAt);
      publishNowPlaying();
      emit('loaded', story);
      if (opts.autoplay) return play();
      return null;
    });
  }

  /* Resuming where a story stopped.
   *
   * A seek only sticks once the element knows how long the audio is. Setting
   * currentTime before that is honoured by Chromium and quietly dropped by
   * WebKit, which is why this waits for metadata rather than trusting the
   * first attempt - and why the browser tests, which run in Chromium, cannot
   * tell the difference.
   */
  var seekToken = 0;

  function seekWhenReady(seconds: number): void {
    var mine = ++seekToken;

    function ready(): boolean {
      return audio!.readyState >= 1 && isFinite(audio!.duration) && audio!.duration > 0;
    }

    function trySeek(): boolean {
      if (!ready()) return false;
      try {
        audio!.currentTime = Math.min(seconds, Math.max(0, audio!.duration - 2));
        return true;
      } catch (err) { void err; return false; }
    }

    if (trySeek()) return;
    // Optimistic, for engines that queue it; the listener is what makes it stick.
    try { audio!.currentTime = seconds; } catch (err) { void err; }
    audio!.addEventListener('loadedmetadata', function once() {
      audio!.removeEventListener('loadedmetadata', once);
      if (mine !== seekToken) return;   // another story was loaded meanwhile
      trySeek();
    });
  }

  /* ----------------------------------------------------------- transport */

  function play(): Promise<unknown> {
    if (!story) return Promise.resolve();
    asleep = false;
    restoreVolume();
    var result = audio!.play();
    if (result && result['catch']) {
      return result['catch'](function (err) {
        if (err && err.name === 'NotAllowedError') {
          App.log.add('audio', 'The phone would not start playback without a tap');
          emit('error', 'Tap play once more to start the story.');
        } else {
          emit('error', 'That story would not start.');
        }
      });
    }
    return Promise.resolve();
  }

  function pause(): void {
    if (audio) audio.pause();
    checkpoint(true);
  }

  // Stops and lets go of the story, keeping its place for next time.
  function unload(): void {
    if (!story) return;
    pause();
    stopTicker();
    story = null;
    fading = false;
    restoreVolume();
    audio!.removeAttribute('src');
    audio!.load();
    App.caps.media.setPlaybackState(false);
    /* Said out loud, because the element will not say it: load() cancels the
     * pause event pause() queued a moment ago, so without this the rest of the
     * app never hears that the story stopped. */
    emit('state', false);
  }

  function toggle(): Promise<unknown> {
    if (!story) return Promise.resolve();
    if (audio!.paused) return play();
    pause();
    recordNight(false);
    return Promise.resolve();
  }

  function position(): number { return audio && isFinite(audio.currentTime) ? audio.currentTime : 0; }

  function duration(): number {
    if (audio && isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    return story && story.len ? story.len : 0;
  }

  function playing(): boolean { return !!(audio && !audio.paused && !audio.ended); }

  function currentStory(): Story | null { return story; }
  function ended(): boolean { return !!(audio && audio.ended); }

  /* --------------------------------------------------------- sleep timer */

  function armSleep(minutes: number): void {
    storiesChosen = 0;
    sleepStories = 0;
    sleepMinutes = minutes;
    sleepRemaining = minutes * 60;
    sleepDeadline = playing() ? Date.now() + sleepRemaining * 1000 : 0;
    fading = false;
    restoreVolume();
  }

  // The countdown only runs while sound is actually coming out.
  function resumeSleep(): void {
    if (storiesChosen) {
      if (!sleepStories) sleepStories = storiesChosen;   // a new night after the last one ended
      return;
    }
    if (sleepDeadline) return;
    if (sleepRemaining <= 0) sleepRemaining = sleepMinutes * 60;
    sleepDeadline = Date.now() + sleepRemaining * 1000;
  }

  function suspendSleep(): void {
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

  function setSleepMinutes(minutes: number): void {
    var seconds = Math.round(minutes * 60);
    App.log.add('sleep', 'Timer set to ' + (seconds % 60 === 0 ? seconds / 60 + ' min' : seconds + 's'));
    armSleep(minutes);
    emit('sleep', sleepLeft());
  }

  /* Stops after `count` stories, counting the one playing now however far into
   * it the child already is. The last one fades out over its closing seconds
   * and the night ends when it does.
   */
  function setSleepStories(count: number): void {
    App.log.add('sleep', 'Stopping after ' + count + (count === 1 ? ' story' : ' stories'));
    storiesChosen = count;
    sleepStories = count;
    sleepDeadline = 0;
    fading = false;
    restoreVolume();
    emit('sleep', sleepLeft());
  }

  function defaultSleepMinutes(minutes: number): void {
    sleepMinutes = minutes;
    sleepRemaining = minutes * 60;
    if (sleepDeadline) sleepDeadline = Date.now() + sleepRemaining * 1000;
  }

  /* Hands an unfinished countdown to the story that follows. Ending a story
   * resets the timer, which is right when that was the last of the night and
   * wrong when a line-up runs on: twenty minutes of sleep timer has to mean
   * twenty minutes, not twenty minutes per story.
   */
  function carrySleep(seconds: number): void {
    if (!(seconds > 0)) return;
    if (storiesChosen) {   // the count already carries itself; `seconds` is stories left
      fading = false;
      restoreVolume();
      emit('sleep', sleepLeft());
      return;
    }
    sleepRemaining = seconds;
    sleepDeadline = playing() ? Date.now() + seconds * 1000 : 0;
    fading = false;
    restoreVolume();
    emit('sleep', sleepLeft());
  }

  function sleepLeft(): number {
    // In story mode, anything above zero means the night is still going.
    if (storiesChosen) return sleepStories ? Math.max(1, Math.round(duration() - position())) : 0;
    if (!sleepDeadline) return sleepRemaining;
    return Math.max(0, Math.round((sleepDeadline - Date.now()) / 1000));
  }

  function currentSleepMinutes(): number { return sleepMinutes; }
  function currentSleepStories(): number { return sleepStories; }
  function sleepByStories(): number { return storiesChosen; }

  function wake(): Promise<unknown> {
    asleep = false;
    if (storiesChosen) setSleepStories(storiesChosen);
    else armSleep(sleepMinutes);
    return play();
  }

  /* -------------------------------------------------------------- ticker */

  function tick(): void {
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
    if (isPlaying) App.caps.media.setPosition(duration(), position(), audio!.playbackRate || 1);

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

  function tickStoryFade(isPlaying: boolean): void {
    var tail = duration() - position();
    if (!isPlaying || sleepStories !== 1 || !(duration() > 0)) return;
    if (!fading && tail <= FADE_SECONDS) {
      startFade(tail);
    } else if (fading && tail > FADE_SECONDS + 2) {
      // Scrubbed back out of the ending: full volume until it comes round again.
      fading = false;
      restoreVolume();
    }
  }

  function finishSleep(): void {
    App.log.add('sleep', 'Timer ran out; story stopped');
    fading = false;
    audio!.pause();          // clears sleepDeadline through the pause handler
    sleepDeadline = 0;
    sleepRemaining = 0;     // stays at zero so the label reads "finished"
    checkpoint(true);
    restoreVolume();
    asleep = true;
    recordNight(true);
    emit('asleep');
  }

  /* ---------------------------------------------------------------- fade */

  function volumeIsWritable(): boolean {
    if (volumeWorks !== null) return volumeWorks;
    try {
      var before = audio!.volume;
      audio!.volume = 0.42;
      volumeWorks = Math.abs(audio!.volume - 0.42) < 0.01;
      audio!.volume = before;
    } catch (err) {
      void err;
      volumeWorks = false;
    }
    return volumeWorks;
  }

  /* Fades by the element's own volume, where the phone lets it be set.
   *
   * Where it cannot - every iPhone - there is no fade, and the timer stops the
   * story when it runs out. The only other way to fade on iOS is to route the
   * element through Web Audio, and that was worse than no fade: iOS stops Web
   * Audio whenever the screen locks, a routed element goes silent with it while
   * everything else says it is playing, and waking it again flickers the sound.
   * It could not fade with the screen locked in any case, which is how the
   * phone sits at bedtime. `fading` is left unset so the tick simply moves on.
   */
  function startFade(seconds: number): void {
    if (!volumeIsWritable()) return;
    fading = true;
    fadeWithVolume(seconds);
  }

  function fadeWithVolume(seconds: number): void {
    var startedAt = Date.now();
    var from = audio!.volume;
    clearInterval(fadeTimer);
    fadeTimer = setInterval(function () {
      var elapsed = (Date.now() - startedAt) / 1000;
      var ratio = Math.max(0, 1 - elapsed / seconds);
      try { audio!.volume = from * ratio * ratio; } catch (err) { void err; }
      if (ratio <= 0 || audio!.paused) clearInterval(fadeTimer);
    }, 120);
  }

  // Whatever happened last night, the story starts at full volume.
  function restoreVolume(): void {
    clearInterval(fadeTimer);   // or a fade still running pulls the volume back down
    if (audio && volumeWorks) {
      try { audio.volume = 1; } catch (err) { void err; }
    }
  }

  /* ----------------------------------------------------------- bookkeeping */

  function checkpoint(force: boolean): void {
    if (!story) return;
    // onEnded already put a finished story back to the start. Saving the end
    // position over that would make its next play finish straight away.
    if (audio && audio.ended) return;
    var pos = position();
    if (!force && Math.abs(pos - lastSaved) < SAVE_EVERY) return;
    lastSaved = pos;
    story!.pos = pos;
    story!.lastPlayedAt = Date.now();
    App.store.patchStory(story!.id, { pos: pos, lastPlayedAt: story!.lastPlayedAt })['catch'](function () { return null; });
    if (listenedCarry >= 1) {
      App.stats.addListening(Math.round(listenedCarry));
      listenedCarry = 0;
    }
  }

  function recordNight(sleptThrough: boolean): void {
    if (!story) return;
    App.stats.recordNight(sleptThrough);
  }

  function onEnded(): void {
    stopTicker();
    var carried;
    if (storiesChosen) {
      sleepStories = Math.max(0, sleepStories - 1);
      carried = sleepStories;
      fading = false;
      restoreVolume();
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

  function onAudioError(): void {
    var failure = audio && audio.error;
    App.log.add('error', 'Media error ' + (failure ? failure.code : '?') +
      (failure && failure.message ? ': ' + failure.message : '') +
      (usedServiceWorker ? ', falling back to a Blob' : ''));
    if (!story) return;
    if (usedServiceWorker) {
      // Some WebKit builds will not let a media element load through a service
      // worker. Fall back to a Blob URL and pick up where we were.
      App.media.demote();
      usedServiceWorker = false;
      var resumeAt = position() || story!.pos || 0;
      var wasPlaying = playing();
      App.media.blobUrl(story!).then(function (url) {
        audio!.src = url;
        audio!.load();
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
    ticking: function () { return !!ticker; },
    isAsleep: function () { return asleep; },
    checkpoint: checkpoint
  };
})();
