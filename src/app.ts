/* Bedtime - screen wiring.
 *
 * The markup for every screen already exists in index.html; this file keeps it
 * in step with the data. Lists are rebuilt when the library changes, but the
 * player is updated field by field so the once-a-second tick never rebuilds
 * nodes or restarts the starfield animation.
 */
window.App = window.App || ({} as typeof App);

(function () {
  'use strict';

  var ui = App.ui;
  var $ = ui.$;

  var HOLD_MS = 3000;       // how long the moon must be held to reach parent controls
  var SKIP_SECONDS = 15;    // the player's back and forward buttons
  var UPDATE_CHECK_MS = 15 * 60 * 1000;   // how often a foregrounded app looks for a new release

  var stories: Story[] = [];
  var mood = 'All';
  var currentId: string | null = null;
  var importRows: Record<string, ImportRow> = {};
  var importOrder: ImportRow[] = [];
  var holdTimer: ReturnType<typeof setInterval> | null = null;
  var holdStart = 0;
  var persistedState: boolean | null = null;   // null until the browser has been asked
  var spaceEstimate: { usage: number; quota: number } | null = null;    // null on browsers that will not say
  var importing = false;       // chunks are being written; do not reload
  var scrubbing = false;       // a finger is on the position slider
  var suppressClickUntil = 0;  // a pick was just dropped; its click is not a tap

  /* ==================================================================== boot */

  function boot(): void {
    // Which phone, which iOS: the first thing anyone reading the log will ask.
    App.log.add('app', 'Opened on ' + navigator.userAgent);
    watchForInteraction();   // before the async work: a tap during boot counts
    // iOS ignores user-scalable=no, so a pinch would zoom the whole app.
    document.addEventListener('gesturestart', function (event) { event.preventDefault(); }, false);
    registerServiceWorker();

    App.store.open()
      .then(function () {
        return Promise.all([App.settings.load(), App.stats.load(), App.store.getStories(), App.log.load()]);
      })
      .then(function (results) {
        stories = sortStories(results[2] || []);
        App.player.init();
        wirePlayerEvents();
        wireControls();
        applySettingsToForm();
        App.player.defaultSleepMinutes(App.settings.get().sleepMinutes);
        renderAll();
        App.caps.idle(verifyStorage, 3000);
        App.caps.idle(reclaimOrphanChunks, 8000);
        App.caps.idle(sweepArtwork, 12000);
        refreshStorageFacts();
        wireInstallRow();
        wireTeardown();
      })
      ['catch'](function (err) {
        ui.toast(err && err.message ? err.message : 'This browser will not let the app store stories.');
      });
  }

  // iOS kills a backgrounded Home Screen app without notice, so pending
  // settings and listening time are written out the moment it goes away.
  function wireTeardown(): void {
    function flush() {
      App.settings.flush();
      App.stats.flush();
      App.player.checkpoint(true);
      App.log.flush();
    }
    window.addEventListener('pagehide', flush, false);
    document.addEventListener('visibilitychange', function () {
      App.log.add('app', document.hidden ? 'Put away' : 'Back on screen');
      if (document.hidden) flush();
    }, false);
  }

  function registerServiceWorker(): void {
    if (!('serviceWorker' in navigator)) return;

    // updateViaCache is ignored before Safari 14, so update() is what actually
    // forces a check for a new worker rather than reusing an HTTP cached one.
    // Its rejection has to be returned, or an offline launch - the normal case
    // for this app - raises an unhandled rejection on every boot.
    var registered = navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    registration = registered;
    var lastCheck = 0;
    function checkForUpdate() {
      // Every trip to the foreground would otherwise be a network request.
      if (Date.now() - lastCheck < UPDATE_CHECK_MS) return;
      lastCheck = Date.now();
      registered.then(function (reg) {
        return reg && reg.update ? reg.update() : null;
      })['catch'](function () { return null; });
    }
    checkForUpdate();
    // iOS resumes a Home Screen app far more often than it relaunches one, so
    // a check that only ran at boot would rarely run at all.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkForUpdate();
    }, false);

    /* A deploy ships a worker with a new build id, which claims this page the
     * moment it activates. The HTML and scripts already running are still the
     * previous release, so reload to pick up the new ones.
     */
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController) return;          // first run has nothing to replace
      updateWaiting = true;
      updateState = 'ready';
      App.log.add('update', 'A new version took over the page');
      renderUpdate();
      takeUpdate();
    });

    /* An update that arrives mid-use waits rather than reloading under a
     * finger. Leaving the app is the moment it can be taken without costing
     * anything: the reload happens on a screen nobody is looking at, and the
     * next launch is the new release rather than the one after that.
     */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) takeUpdate();
    }, false);
  }

  var updateWaiting = false;

  /* ---------------------------------------------------------- the update UI */

  /* An update that waits is taken on its own the moment the app is put away.
   * These are the other routes: a card on the home screen that says one is
   * ready, and a row in parent controls that can also go and look. Neither is
   * ever shown over the player or while a story plays - a tap on Update
   * reloads the page, and that is not something to offer a child mid-story.
   */
  var updateState: 'idle' | 'checking' | 'latest' | 'ready' | 'failed' = 'idle';
  var updatePutOff = false;          // "Later", until the next launch
  var registration: Promise<ServiceWorkerRegistration> | null = null;
  var UPDATE_WAIT_MS = 20000;        // how long a found update has to arrive

  function renderUpdate(): void {
    var playerOpen = $('player').className.indexOf('is-open') >= 0;
    App.views.updateBanner($('update-host'), {
      show: updateState === 'ready' && !updatePutOff && !playerOpen && !App.player.playing()
    }, {
      apply: applyUpdate,
      later: function () { updatePutOff = true; renderUpdate(); }
    });
    App.views.updateRow($('update-row'), { state: updateState }, {
      check: checkForUpdateNow,
      apply: applyUpdate
    });
  }

  /* The new worker already controls the page, so a reload is all it takes.
   * Everything that would be written on the way out is written first, and the
   * guard against reload loops is not consulted: that guards the automatic
   * reload, and a tap is not a loop. */
  function applyUpdate(): void {
    App.log.add('update', 'Reloading into the new version');
    App.log.flush();
    App.settings.flush();
    App.stats.flush();
    App.player.checkpoint(true);
    window.location.reload();
  }

  function checkForUpdateNow(): void {
    if (!registration) {
      updateState = 'failed';
      renderUpdate();
      return;
    }
    updateState = 'checking';
    renderUpdate();
    registration.then(function (reg) {
      return reg.update().then(function () { return reg; });
    }).then(function (reg) {
      if (updateState !== 'checking') return;          // the controller changed first
      if (reg.installing || reg.waiting) {
        // Found, and on its way: the controller change will say it is ready.
        setTimeout(function () {
          if (updateState === 'checking') { updateState = 'idle'; renderUpdate(); }
        }, UPDATE_WAIT_MS);
        return;
      }
      updateState = 'latest';
      App.log.add('update', 'Checked: already up to date');
      renderUpdate();
    })['catch'](function (err) {
      updateState = 'failed';
      App.log.add('update', 'Check failed: ' + (err && err.message ? err.message : String(err)));
      renderUpdate();
    });
  }

  function takeUpdate(): void {
    if (!updateWaiting) return;
    if (!safeToReload()) return;
    if (alreadyReloaded()) return;       // see below: this must survive a reload
    markReloaded();
    window.location.reload();
  }

  /* Reasons to leave a running app alone. An update is never worth interrupting
   * a bedtime story, and a reload part way through an import would orphan the
   * chunks already written, since the story row is only saved at the end.
   */
  /* Reloading is only ever an optimisation. The new worker already controls
   * this page, so the next launch picks up the new release whether this reload
   * happens or not - at worst the update lands one launch later. That makes
   * anything the user is part way through worth more than landing it sooner: a
   * page that reloads under a finger loses whatever was open, and on iOS it
   * takes the file picker with it, so tapping the dropzone appears to do
   * nothing at all.
   */
  function safeToReload(): boolean {
    if (importing) return false;
    if (App.player.currentStory()) return false;   // not just "not playing": a
                                                   // paused story is still
                                                   // someone's place in it
    /* Out of sight, so there is no finger to pull the page out from under and
     * nothing on screen to lose - the one case where an earlier tap does not
     * rule a reload out.
     */
    if (document.hidden) return true;
    if (interacted) return false;
    return !anythingOpen();
  }

  var interacted = false;

  function noteInteraction(): void { interacted = true; }

  function watchForInteraction(): void {
    // Capture, so a handler that stops propagation cannot hide the tap.
    document.addEventListener('touchstart', noteInteraction, true);
    document.addEventListener('mousedown', noteInteraction, true);
    document.addEventListener('keydown', noteInteraction, true);
  }

  function anythingOpen(): boolean {
    var ids = ['player', 'add', 'parent', 'sheet', 'confirm', 'menu'];
    for (var i = 0; i < ids.length; i++) {
      var node = $(ids[i]);
      if (!node) continue;
      var name = node.className || '';
      if (name.indexOf('is-open') >= 0 || name.indexOf('is-on') >= 0) return true;
    }
    return false;
  }

  /* On Safari 12 updateViaCache is ignored, so an HTTP cached sw.js and a fresh
   * one can alternate and each swap fires controllerchange. A flag that only
   * lives for one page lifetime would let that loop forever, flipping between
   * releases. This one survives the reload it causes.
   */
  var RELOAD_KEY = 'bedtime:swReloaded';

  function alreadyReloaded(): boolean {
    try {
      return window.sessionStorage.getItem(RELOAD_KEY) === '1';
    } catch (err) {
      void err;
      return true;   // no session storage, so no way to stop a loop: do not start one
    }
  }

  function markReloaded(): void {
    try {
      window.sessionStorage.setItem(RELOAD_KEY, '1');
    } catch (err) { void err; }
  }

  /* Asks for protected storage and reads the real free space, where the
   * browser offers either. On an iPhone 6 both come back null and the app
   * falls back to reporting the bytes it holds, plus the startup audit that
   * spots audio iOS has already reclaimed.
   */
  function refreshStorageFacts(): void {
    App.caps.requestPersistence().then(function (granted) {
      persistedState = granted;
      return App.caps.estimate();
    }).then(function (estimate) {
      spaceEstimate = estimate;
      renderStorage();
    })['catch'](function () { return null; });
  }

  // Chromium can install from a button, so show the row when it offers one.
  // Safari cannot, and is left alone rather than nagged about it.
  function wireInstallRow(): void {
    App.caps.onInstallAvailable(function (available) {
      ui.show($('install-row'), available);
    });
  }

  /* ================================================================== data */

  // Hearted stories first, then newest first.
  function sortStories(list: Story[]): Story[] {
    return list.slice().sort(function (a, b) {
      return (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || (b.addedAt || 0) - (a.addedAt || 0);
    });
  }

  function byId(id: string | null): Story | null {
    for (var i = 0; i < stories.length; i++) if (stories[i].id === id) return stories[i];
    return null;
  }

  // Stories the child is allowed to see.
  function visibleStories(): Story[] {
    if (App.settings.get().showOurs) return stories;
    return stories.filter(function (s) { return s.mood !== 'Ours'; });
  }

  function filteredStories(): Story[] {
    var list = visibleStories();
    if (mood === 'All') return list;
    return list.filter(function (s) { return s.mood === mood; });
  }

  /* Tonight's picks: the queue.
   *
   * `pickAt` orders it. Adding from a row's menu appends, playing a story
   * straight from the library appends it too, and a story leaves the queue
   * once it has played to the end, so the queue is always what is still to
   * come. Each story runs on into the one after it.
   */
  function lineup(): Story[] {
    return visibleStories().filter(function (s) {
      return s.pickAt && !s.missing;
    // The filter just above guarantees pickAt is set on everything being sorted.
    }).sort(function (a, b) { return (a.pickAt as number) - (b.pickAt as number); });
  }

  function queuedAfter(id: string): number {
    var chosen = lineup();
    for (var i = 0; i < chosen.length; i++) {
      if (chosen[i].id === id) return chosen.length - i - 1;
    }
    return 0;
  }

  function inQueue(id: string | null): boolean {
    var story = byId(id);
    return !!(story && story.pickAt);
  }

  function nextAfter(id: string | null): Story | null {
    var chosen = lineup();
    for (var i = 0; i < chosen.length; i++) {
      if (chosen[i].id === id) return chosen[i + 1] || null;
    }
    return null;
  }

  function keepGoingStory(): Story | null {
    var best: Story | null = null;
    var list = visibleStories();
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s.lastPlayedAt || !s.pos || s.missing) continue;
      if (s.len && s.pos >= s.len - 5) continue;
      // best is only ever assigned an `s` that passed the lastPlayedAt check above.
      if (!best || s.lastPlayedAt > (best.lastPlayedAt as number)) best = s;
    }
    return best;
  }

  function current(): Story | null {
    return byId(currentId) || keepGoingStory() || visibleStories()[0] || null;
  }

  // Marks stories whose audio WebKit has evicted, so the library can say so
  // rather than failing at the moment a child presses play.
  function verifyStorage(): void {
    var pending = stories.slice();
    function step() {
      if (!pending.length) return;
      var story = pending.shift() as Story;
      App.store.hasChunk(story.id, 0).then(function (present) {
        var missing = !present;
        if (missing !== !!story.missing) {
          story.missing = missing;
          if (missing) App.log.add('storage', 'Audio gone for "' + story.title + '"');
          renderAll();
        }
        step();
      })['catch'](step);
    }
    step();
  }

  /* Fills in a cover for a story that arrived without embedded art. Runs after
   * the audio is already stored, so a slow or failed lookup costs nothing but
   * the striped cover the story would have had anyway. `artTried` stops the
   * same miss being looked up again on every launch.
   */
  function findArtwork(story: Story): Promise<boolean> {
    if (story.hasArt || story.artTried) return Promise.resolve(false);
    if (App.settings.get().artwork === false) return Promise.resolve(false);

    return App.artwork.find(story.title, story.narrator).then(function (result) {
      var found = result && result.image;
      if (!found) {
        // Nothing answered, so nothing is known yet. Leaving artTried unset is
        // what lets a story imported with no signal pick up a cover later.
        if (!result || !result.searched) return false;
        story.artTried = true;
        return App.store.patchStory(story.id, { artTried: true }).then(falseValue);
      }
      story.artTried = true;
      story.hasArt = true;
      return App.artwork.store(story.id, found.data, found.type)
        .then(function () {
          return App.store.patchStory(story.id, { hasArt: true, artTried: true });
        })
        .then(function () {
          App.media.forgetArt(story.id);
          renderAll();
          return true;
        });
    })['catch'](function () { return false; });
  }

  function falseValue(): boolean { return false; }

  /* Stories imported before this existed, or added while offline, get a cover
   * the next time there is a connection. One at a time and capped per launch,
   * so a library of fifty does not arrive at the search API all at once.
   */
  function sweepArtwork(): void {
    if (App.settings.get().artwork === false) return;
    var pending = stories.filter(function (s) {
      return !s.hasArt && !s.artTried && !s.missing;
    }).slice(0, 8);

    function step(): Promise<null> | null {
      if (!pending.length) return null;
      return findArtwork(pending.shift() as Story).then(function () {
        return new Promise<null>(function (resolve) { setTimeout(resolve, 1200); });
      }).then(step);
    }
    Promise.resolve().then(step)['catch'](function () { return null; });
  }

  /* Deletes chunks left behind by an import that never finished. Skipped while
   * an import is running, because those chunks have no story row yet either.
   */
  function reclaimOrphanChunks(): string | void {
    // An import running now owns chunks with no story row yet, so this waits
    // rather than giving up for the rest of the session.
    if (importing) {
      App.caps.idle(reclaimOrphanChunks, 20000);
      return 'deferred';
    }
    App.store.chunkOwners().then(function (owners) {
      var known: Record<string, boolean> = {};
      for (var i = 0; i < stories.length; i++) known[stories[i].id] = true;
      var orphans = owners.filter(function (id) { return !known[id]; });
      if (!orphans.length) return null;

      function step(): Promise<null> | null {
        if (!orphans.length || importing) return null;
        var id = orphans.shift() as string;
        return App.store.deleteChunks(id)['catch'](function () { return null; }).then(step);
      }
      return step();
    })['catch'](function () { return null; });
  }

  /* ================================================================ render */

  function renderAll() {
    renderHome();
    renderPlayer();
    renderParent();
    renderMini();
    renderUpdate();
  }

  function renderHome() {
    var settings = App.settings.get();
    ui.text($('home-name'), settings.childName || 'you');
    ui.text($('home-sub'), homeSubtitle());

    var keep = keepGoingStory();
    ui.show($('keepgoing'), !!keep);
    if (keep) {
      ui.paintCover($('kg-cover'), keep);
      ui.text($('kg-title'), keep.title);
      // pos is optional on Story; a keep-going story only exists once it has one, per keepGoingStory().
      var pct = keep.len ? Math.min(1, (keep.pos as number) / keep.len) : 0;
      $('kg-bar').style.width = (pct * 100).toFixed(1) + '%';
      var keepId = keep.id;
      $('keepgoing').onclick = function () { openStory(keepId); };
    }

    var visible = visibleStories();
    var chosen = lineup();
    ui.show($('picks-block'), visible.length > 0);
    ui.show($('picks-empty'), !chosen.length);
    renderPicks(chosen);

    renderMoods(visible);
    renderRows($('library-rows'), filteredStories());

    var empty = $('library-empty');
    ui.show(empty, visible.length === 0);
    if (visible.length === 0) renderEmptyState(empty);
  }

  function renderEmptyState(empty: HTMLElement): void {
    App.views.emptyState(empty, stories.length > 0, { add: openAdd });
  }

  function homeSubtitle(): string {
    var settings = App.settings.get();
    if (!visibleStories().length) return 'Add a story to get started';

    var tonight = App.stats.storiesTonight(stories);
    if (settings.perNight > 0) {
      if (tonight >= settings.perNight) return 'That is ' + settings.perNight + ' for tonight. Time to sleep.';
      if (tonight === settings.perNight - 1) return 'One story left before lights out';
    }
    if (pastBedtime(settings.bedtime)) return 'It is past bedtime - pick a short one';
    return 'Pick something for tonight';
  }

  function pastBedtime(bedtime: string): boolean {
    if (!bedtime || bedtime.indexOf(':') < 0) return false;
    var parts = bedtime.split(':');
    var now = new Date();
    var minutesNow = now.getHours() * 60 + now.getMinutes();
    var minutesBed = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    // Only counts in the evening, so 7am does not read as "past bedtime".
    return minutesNow >= minutesBed && now.getHours() >= 12;
  }

  function renderPicks(picks: Story[]): void {
    App.views.picks($('picks'), picks, { open: openStory });
  }

  function renderMoods(list: Story[]): void {
    var names = ['All'];
    list.forEach(function (s) {
      if (s.mood && names.indexOf(s.mood) < 0) names.push(s.mood);
    });
    // With a single category the filter row is noise, so it stays empty.
    if (names.length < 3) {
      mood = 'All';
      names = [];
    }
    App.views.moods($('moods'), names, mood, {
      pick: function (name: string) { mood = name; renderHome(); }
    });
  }

  function renderRows(host: HTMLElement, list: Story[]): void {
    App.views.rows(host, list, {
      open: openStory,
      fav: toggleFav,
      menu: openStoryMenu,
      meta: rowMeta
    });
  }

  function rowMeta(story: Story): string {
    if (story.missing) return 'Needs adding again - the phone cleared it';
    var parts = [ui.minutes(story.len)];
    if (story.narrator && story.narrator !== 'you') parts.push('read by ' + story.narrator);
    else parts.push('added by you');
    return parts.join(' · ');
  }

  /* ================================================================ player */

  function renderPlayer(): void {
    var story = current();
    if (!story) return;
    ui.text($('player-title'), story.title);
    ui.text($('player-meta'), rowMeta(story));
    ui.paintCover($('disc-cover'), story);
    renderTimerOptions();
    renderUpNext();
    updateProgress(App.player.position(), App.player.duration());
  }

  /* Auto-advance is a surprise unless the player says it is coming, so the line
   * that names the next story is also the thing that makes the behaviour
   * understandable. Nothing lined up after this one, nothing shown.
   */
  function renderUpNext(): void {
    var node = $('upnext');
    if (!node) return;
    var story = current();
    var next = story ? nextAfter(story.id) : null;
    ui.text(node, next ? 'Up next \u00b7 ' + next.title : '');
    ui.show(node, !!next);
  }

  function updateProgress(position: number, length: number): void {
    var story = current();
    var total = length || (story ? story.len : 0) || 0;
    var fraction = total ? Math.min(1, position / total) : 0;

    // Nothing behind the closed player is worth repainting every second.
    if ($('player').className.indexOf('is-open') >= 0) {
      // While a finger is on the slider the thumb belongs to the finger, not to
      // the once-a-second tick, or it would fight the drag.
      if (!scrubbing) {
        paintScrubber(position, total);
        ui.text($('elapsed'), ui.clock(position));
        ui.text($('remaining'), '-' + ui.clock(Math.max(0, total - position)));
      }
      ui.ring($('disc-fill'), fraction);

      var dim = App.settings.get().dim && App.player.playing() ? Math.min(0.5, fraction * 0.8) : 0;
      $('sky-dim').style.opacity = String(dim);
    }

    if (story && $('keepgoing') && !$('keepgoing').hidden) {
      var keep = keepGoingStory();
      if (keep && keep.id === story.id) {
        $('kg-bar').style.width = (fraction * 100).toFixed(1) + '%';
      }
    }
  }

  /* Safari draws no fill for the elapsed part of a range input, so the track
   * carries a gradient sized to the value.
   */
  function paintScrubber(position: number, total: number): void {
    // The slider is a range input, so it has .disabled, .max and .value.
    var slider = $('scrub') as HTMLInputElement;
    var usable = total > 0;
    slider.disabled = !usable;
    slider.max = usable ? String(Math.round(total)) : '0';
    slider.value = usable ? String(Math.round(Math.min(position, total))) : '0';
    scrubberFill(usable ? Math.min(1, position / total) : 0);
  }

  function scrubberFill(fraction: number): void {
    // Fill width, then the full-width groove behind it.
    $('scrub').style.backgroundSize = (fraction * 100).toFixed(2) + '% 4px, 100% 4px';
  }

  function wireScrubber(): void {
    var slider = $('scrub') as HTMLInputElement;

    // `input` fires throughout the drag, `change` when the finger lifts. Seeking
    // on every input event would stutter the audio, so the drag only previews
    // the time and the seek happens once, on release.
    slider.addEventListener('input', function () {
      if (!App.player.currentStory()) return;
      scrubbing = true;
      var total = App.player.duration();
      var seconds = Number(slider.value) || 0;
      ui.text($('elapsed'), ui.clock(seconds));
      ui.text($('remaining'), '-' + ui.clock(Math.max(0, total - seconds)));
      scrubberFill(total ? Math.min(1, seconds / total) : 0);
    }, false);

    slider.addEventListener('change', function () {
      scrubbing = false;
      if (!App.player.currentStory()) return;
      App.player.seekTo(Number(slider.value) || 0);
    }, false);

    // A drag that ends outside the slider never fires `change` on some builds,
    // so the tick would stay locked out. These let go of it either way.
    slider.addEventListener('touchend', releaseScrubber, false);
    slider.addEventListener('touchcancel', releaseScrubber, false);
    slider.addEventListener('blur', releaseScrubber, false);
  }

  function releaseScrubber(): void {
    if (!scrubbing) return;
    scrubbing = false;
    updateProgress(App.player.position(), App.player.duration());
  }

  var TIMER_MINUTES = [10, 20, 30];
  var MAX_MINUTES = 240;
  var MAX_STORIES = 4;

  /* Two ways to end the night: a number of minutes, or a number of stories.
   * The story that is playing counts as one however far into it the child is,
   * and the rest come from tonight's picks, so the counts on offer stop at
   * however many are lined up after it.
   */
  function renderTimerOptions(): void {
    var story = current();
    var byStories = App.player.sleepByStories();
    var minutes = byStories ? 0 : App.player.currentSleepMinutes();

    App.views.timerOptions($('timer-options'), {
      minutes: TIMER_MINUTES,
      maxMinutes: MAX_MINUTES,
      chosenMinutes: minutes,
      custom: TIMER_MINUTES.indexOf(minutes) < 0 ? minutes : 0,
      chosenStories: byStories,
      mostStories: Math.min(MAX_STORIES, 1 + (story ? queuedAfter(story.id) : 0))
    }, {
      minutes: function (m: number) { chooseTimer(function () { App.player.setSleepMinutes(m); }); },
      stories: function (n: number) { chooseTimer(function () { App.player.setSleepStories(n); }); }
    });
  }

  function chooseTimer(choose: () => void): void {
    choose();
    closeSheet();
    renderTimerOptions();
    App.player.play();
  }

  function sleepLabel(secondsLeft: number): string {
    var stories = App.player.sleepByStories() ? App.player.currentSleepStories() : 0;
    if (stories === 1) return 'Stops at the end of this story';
    if (stories > 1) return 'Stops after this story and ' + (stories - 1) + ' more';
    return secondsLeft > 0
      ? 'Sleep timer · ' + Math.ceil(secondsLeft / 60) + ' min left'
      : 'Sleep timer finished';
  }

  function wirePlayerEvents(): void {
    App.player.on({
      tick: function (position, length) {
        updateProgress(position, length);
      },
      state: function (isPlaying) {
        ui.text($('play-label'), isPlaying ? 'Pause' : 'Play');
        renderMini();
        renderUpdate();
        if (isPlaying) ui.toggleClass($('asleep'), 'is-on', false);
      },
      sleep: function (secondsLeft) {
        ui.text($('sleep-label'), sleepLabel(secondsLeft));
      },
      asleep: function () {
        ui.toggleClass($('asleep'), 'is-on', true);
      },
      ended: function (sleepCarried) {
        ui.toggleClass($('asleep'), 'is-on', false);
        /* Taken out of the queue while it played? Then there is no "after this
         * one" to find, and the head of the queue is what comes next. */
        var next = nextAfter(currentId) || (inQueue(currentId) ? null : lineup()[0]);
        unqueue(currentId);
        /* Only a deliberate line-up runs on. Falling out of one story and into
         * the rest of the library at bedtime is the opposite of what this app
         * is for, and a countdown already at zero means the night is over. */
        if (next && sleepCarried > 0) openStory(next.id, { carrySleep: sleepCarried });
        else renderUpNext();
      },
      loaded: function (story) {
        currentId = story.id;
        renderPlayer();
        renderMini();
      },
      error: function (message) {
        ui.toast(message);
      }
    });
  }

  /* The options bag a caller can pass to openStory: `carrySleep` is the
   * seconds (or stories) a sleep timer should keep counting down by rather
   * than resetting, when auto-advance opens the next story in the queue.
   */
  interface OpenStoryOptions {
    carrySleep?: number;
  }

  function openStory(id: string, options?: OpenStoryOptions): void {
    var opts = options || {};
    var story = byId(id);
    if (!story) return;
    App.log.add('story', (opts.carrySleep ? 'Ran on into "' : 'Opened "') + story.title + '"');
    if (story.missing) {
      ui.toast('This phone cleared that audio. Add the file again.');
      return;
    }
    currentId = id;
    if (!opts.carrySleep) queue(id);
    openPlayer();
    // Already loaded: loading it again would stop and restart the sound.
    var loaded = App.player.currentStory();
    if (loaded && loaded.id === id && !App.player.ended()) {
      if (!App.player.playing()) App.player.play();
      renderPlayer();
      return;
    }
    var resume = App.settings.get().resume === false ? 0 : (story.pos || 0);
    App.player.load(story, { autoplay: true, startAt: resume })['catch'](function (err) {
      ui.toast(err && err.message ? err.message : 'That story could not be opened.');
    });
    // carrySleep is optional; the comparison is false whether it is absent or zero, as before.
    if ((opts.carrySleep || 0) > 0) App.player.carrySleep(opts.carrySleep as number);
    else App.player.setSleepMinutes(App.settings.get().sleepMinutes);
    renderPlayer();
  }

  function openPlayer(): void {
    ui.toggleClass($('player'), 'is-open', true);
    $('player').setAttribute('aria-hidden', 'false');
    renderMini();
    renderUpdate();
  }

  function closePlayer(): void {
    ui.toggleClass($('player'), 'is-open', false);
    $('player').setAttribute('aria-hidden', 'true');
    renderHome();
    renderMini();
    renderUpdate();
  }

  /* The mini player, as in Apple Music: whenever a story is loaded and the full
   * player is put away, a bar along the bottom keeps it in reach.
   */
  function renderMini(): void {
    var loaded = App.player.currentStory();
    var story = loaded ? byId(loaded.id) : null;
    var show = !!story && $('player').className.indexOf('is-open') < 0;
    ui.show($('mini'), show);
    ui.toggleClass($('library'), 'has-mini', show);
    if (!story) return;
    ui.text($('mini-title'), story.title);
    if ($('mini-cover').getAttribute('data-id') !== story.id) {
      $('mini-cover').setAttribute('data-id', story.id);
      ui.paintCover($('mini-cover'), story);
    }
    var playing = App.player.playing();
    ui.toggleClass($('mini-play'), 'is-playing', playing);
    $('mini-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  /* Swipe down to put something away, the way Apple Music does: it follows the
   * finger, and a long enough or quick enough pull dismisses it. `dismiss` gets
   * the node with the finger's offset still applied, so it can animate on from
   * there; otherwise the node springs back.
   */
  var SWIPE_CLOSE_FRACTION = 0.25;   // of the node's height
  var SWIPE_CLOSE_MIN = 40;          // px, so a short bar is not dismissed by a twitch
  var SWIPE_CLOSE_SPEED = 0.5;       // px per ms at the moment of release

  /* One finger's progress down a swipeable sheet, from the moment it moves
   * enough to count as a drag rather than a tap.
   */
  interface SwipeState {
    x: number;
    y: number;
    dy: number;
    on: boolean;
    lastY: number;
    lastAt: number;
    speed: number;
  }

  function wireSwipeDown(node: HTMLElement, canStart: (target: EventTarget | null) => boolean, dismiss: () => void): void {
    var swipe: SwipeState | null = null;

    function start(event: TouchEvent): void {
      if (event.touches.length !== 1 || !canStart(event.target)) return;
      var touch = event.touches[0];
      swipe = { x: touch.clientX, y: touch.clientY, dy: 0, on: false,
                lastY: touch.clientY, lastAt: Date.now(), speed: 0 };
    }

    function move(event: TouchEvent): void {
      if (!swipe) return;
      var touch = event.touches[0];
      var dx = touch.clientX - swipe.x;
      var dy = touch.clientY - swipe.y;
      if (!swipe.on) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (dy <= 0 || Math.abs(dx) > dy) { swipe = null; return; }   // sideways or up
        swipe.on = true;
        node.style.transition = 'none';
      }
      event.preventDefault();
      var now = Date.now();
      swipe.speed = (touch.clientY - swipe.lastY) / Math.max(1, now - swipe.lastAt);
      swipe.lastY = touch.clientY;
      swipe.lastAt = now;
      swipe.dy = Math.max(0, dy);
      node.style.transform = 'translateY(' + swipe.dy + 'px)';
    }

    function end(): void {
      if (!swipe) return;
      var done = swipe;
      swipe = null;
      if (!done.on) return;
      var flicked = Date.now() - done.lastAt < 100 && done.speed > SWIPE_CLOSE_SPEED;
      // Handing back to the stylesheet animates from wherever the finger left it.
      node.style.transition = '';
      if (flicked || done.dy > Math.max(SWIPE_CLOSE_MIN, node.offsetHeight * SWIPE_CLOSE_FRACTION)) {
        dismiss();
      } else {
        node.style.transform = '';
      }
    }

    node.addEventListener('touchstart', start, false);
    node.addEventListener('touchmove', move, { passive: false });
    node.addEventListener('touchend', end, false);
    node.addEventListener('touchcancel', end, false);
  }

  function wireSwipes(): void {
    var player = $('player');
    // The scrubber keeps its own drag, and the sheet and curtain their taps.
    wireSwipeDown(player, function (target) {
      if ($('sheet').className.indexOf('is-open') >= 0) return false;
      // Touch targets here are always elements on the way up to <player>.
      for (var node = target as Element | null; node && node !== player; node = node.parentNode as Element | null) {
        if (node.id === 'scrub' || node.id === 'asleep') return false;
      }
      return true;
    }, function () {
      player.style.transform = '';
      closePlayer();
    });

    // Only from the top of its scroll, as with a native sheet; further down,
    // the finger is scrolling the sheet.
    var sheet = $('sheet');
    wireSwipeDown(sheet, function () { return sheet.scrollTop <= 0; }, function () {
      sheet.style.transform = '';
      closeSheet();
    });

    // Putting the mini player away ends the story for now: paused, its place
    // kept, and nothing loaded, so the bar has no reason to come back.
    var mini = $('mini');
    wireSwipeDown(mini, function () { return true; }, function () {
      ui.toggleClass(mini, 'is-leaving', true);
      mini.style.transform = '';
      setTimeout(function () {
        ui.toggleClass(mini, 'is-leaving', false);
        App.player.unload();
        renderMini();
        renderHome();
      }, 260);
    });
  }

  function openSheet(): void { ui.toggleClass($('sheet'), 'is-open', true); ui.toggleClass($('sheet-scrim'), 'is-on', true); }
  function closeSheet(): void { ui.toggleClass($('sheet'), 'is-open', false); ui.toggleClass($('sheet-scrim'), 'is-on', false); }

  function toggleFav(id: string): void {
    var story = byId(id);
    if (!story) return;
    story.fav = !story.fav;
    App.store.patchStory(id, { fav: story.fav })['catch'](function () { return null; });
    stories = sortStories(stories);
    renderHome();
  }

  /* ======================================================= parent controls */

  /* ------------------------------------------------------ diagnostics panel */

  var logOpen = false;
  var logCopied: 'idle' | 'copied' | 'failed' = 'idle';

  function renderLog(): void {
    App.views.logPanel($('log-panel'), {
      open: logOpen,
      entries: App.log.list(),
      copied: logCopied
    }, {
      toggle: function () { logOpen = !logOpen; logCopied = 'idle'; renderLog(); },
      copy: function () {
        App.caps.copyText(App.log.text()).then(function (ok) {
          logCopied = ok ? 'copied' : 'failed';
          renderLog();
        });
      },
      clear: function () { logCopied = 'idle'; App.log.clear(); }
    });
  }

  function renderParent(): void {
    renderLog();
    var settings = App.settings.get();
    ui.text($('parent-name'), settings.childName || 'Your child');
    ui.text($('ours-name'), settings.childName ? settings.childName + '’s' : 'the');
    ui.toggleClass($('ours-switch'), 'is-on', !!settings.showOurs);
    $('ours-switch').setAttribute('aria-checked', settings.showOurs ? 'true' : 'false');

    var count = stories.length;
    ui.text($('added-count'), count ? count + (count === 1 ? ' file' : ' files') : 'None yet');

    renderToggles();
    renderStorage();
    renderWeek();
  }

  function togglePick(id: string): void {
    var story = byId(id);
    if (story && story.pickAt) unqueue(id);
    else queue(id);
  }

  function queue(id: string): void {
    var story = byId(id);
    if (!story || story.missing || story.pickAt) return;
    /* Two taps inside the same millisecond would tie, and a tie has no order.
     * Nudging past the last one keeps the sequence strict. */
    var last = 0;
    stories.forEach(function (s) {
      // pickAt is optional; falling back to 0 keeps unqueued stories out of the max.
      if ((s.pickAt || 0) > last) last = s.pickAt as number;
    });
    setPick(story, Math.max(Date.now(), last + 1));
    lineupChanged();
  }

  function unqueue(id: string | null): void {
    var story = byId(id);
    if (story && story.pickAt) setPick(story, 0);
    lineupChanged();
  }

  function setPick(story: Story, pickAt: number): void {
    story.pickAt = pickAt;
    App.store.patchStory(story.id, { pickAt: pickAt })['catch'](function () { return null; });
  }

  /* Moves a story within the line-up by handing the existing pickAt values out
   * again in the new order, so the sequence stays strictly increasing.
   */
  function movePick(from: number, to: number): void {
    var chosen = lineup();
    if (from === to || from < 0 || to < 0 || from >= chosen.length || to >= chosen.length) return;
    var slots = chosen.map(function (s) { return s.pickAt as number; });
    chosen.splice(to, 0, chosen.splice(from, 1)[0]);
    chosen.forEach(function (story, index) {
      if (story.pickAt !== slots[index]) setPick(story, slots[index]);
    });
    lineupChanged();
  }

  function lineupChanged(): void {
    renderHome();
    renderUpNext();
  }

  /* A row in a story's \u22ef menu. "Cancel" carries no action, hence the null. */
  interface MenuItem {
    label: string;
    run: (() => void) | null;
  }

  /* The menu behind each row's ellipsis button. "Play sooner" is also the way
   * to reorder without dragging, for anyone who cannot hold and drag.
   */
  function openStoryMenu(story: Story): void {
    var chosen = lineup();
    var at = chosen.indexOf(story);
    var items: MenuItem[] = [
      at >= 0
        ? { label: 'Take out of tonight\u2019s picks', run: function () { togglePick(story.id); } }
        : { label: 'Add to tonight\u2019s picks', run: function () { togglePick(story.id); } }
    ];
    if (at > 0) items.push({ label: 'Play sooner', run: function () { movePick(at, at - 1); } });
    items.push({ label: 'Cancel', run: null });

    var node = $('menu');
    ui.text($('menu-title'), story.title);
    App.views.menuActions($('menu-actions'), items.map(function (item) {
      return {
        label: item.label,
        run: function () {
          closeStoryMenu();
          if (item.run) item.run();
        }
      };
    }));
    $('menu-scrim').onclick = closeStoryMenu;
    ui.toggleClass(node, 'is-on', true);
    node.setAttribute('aria-hidden', 'false');
  }

  function closeStoryMenu(): void {
    ui.toggleClass($('menu'), 'is-on', false);
    $('menu').setAttribute('aria-hidden', 'true');
  }

  /* Press and hold a pick and it lifts. Move while it is lifted and it drags
   * along the strip: the other picks make way as it passes them, and the strip
   * scrolls when it is held near an edge. Let go without moving and its menu
   * opens instead. Waiting for the release is what keeps the two apart - a menu
   * that opened mid-hold would sit under the finger that meant to drag.
   * Touch events rather than HTML drag and drop or pointer
   * events, neither of which an iPhone on iOS 12 has. Mouse is wired too, for
   * desktop and tests.
   */
  var DRAG_HOLD_MS = 450;
  var DRAG_EDGE = 44;        // px from the strip's edge that starts it scrolling

  /* A pick being pressed, held and possibly dragged along the strip. Fields
   * past `shift` only exist once the corresponding stage of the gesture has
   * been reached - `timer`/`grab` once held, `scroller`/`width`/`home`/
   * `scrollAt` once actually dragging.
   */
  interface DragPoint {
    x: number;
    y: number;
  }

  interface DragState {
    node: HTMLElement;
    start: DragPoint;
    last: DragPoint;
    held: boolean;
    on: boolean;
    from: number;
    after: HTMLElement | null;
    shift: number;
    timer?: ReturnType<typeof setTimeout>;
    grab?: number;
    scroller?: ReturnType<typeof setInterval>;
    width?: number;
    home?: number;
    scrollAt?: number;
  }

  function wirePicksDrag(): void {
    var host = $('picks');
    var drag: DragState | null = null;

    function point(event: TouchEvent | MouseEvent): DragPoint {
      // Touch events carry their coordinates on a Touch; mouse events carry them directly.
      var withTouches = event as TouchEvent;
      var touch: Touch | MouseEvent = withTouches.touches
        ? (withTouches.touches[0] || withTouches.changedTouches[0])
        : (event as MouseEvent);
      return { x: touch.clientX, y: touch.clientY };
    }

    function start(event: TouchEvent | MouseEvent): void {
      if (drag) return;
      // Picks are always elements walking up to <picks>, so this is HTMLElement throughout.
      var node = event.target as HTMLElement | null;
      while (node && node.parentNode !== host) node = node.parentNode as HTMLElement | null;
      if (!node) return;
      var p = point(event);
      drag = { node: node, start: p, last: p, held: false, on: false,
               from: indexIn(node), after: node.nextElementSibling as HTMLElement | null, shift: 0 };
      // node is narrowed to Element just above, but that does not reach into
      // this callback, which runs later; drag itself is the same story.
      var liftedNode = node;
      drag.timer = setTimeout(function () {
        (drag as DragState).held = true;
        (drag as DragState).grab = p.x - liftedNode.getBoundingClientRect().left;   // finger's place on the cover
        ui.toggleClass(liftedNode, 'is-lifted', true);
      }, DRAG_HOLD_MS);
    }

    function move(event: TouchEvent | MouseEvent): void {
      if (!drag) return;
      var p = point(event);
      var dx = p.x - drag.start.x;
      var dy = p.y - drag.start.y;
      var moved = dx * dx + dy * dy > 100;
      if (!drag.held) {
        if (moved) stop();   // moved before the hold: a scroll
        return;
      }
      event.preventDefault();
      if (!drag.on) {
        if (!moved) return;
        drag.on = true;
        measure();
        drag.scroller = setInterval(edgeScroll, 16);
        ui.toggleClass(drag.node, 'is-dragging', true);
      }
      drag.last = p;
      follow();
    }

  /* Keeps the dragged pick under the finger, and moves it past any neighbour
   * whose middle the finger has crossed.
   *
   * Every measurement here is taken once, when the picks last moved, rather
   * than on each touchmove: reading a box straight after writing a transform
   * makes the engine lay the page out again on the spot, which is the last
   * thing a finger-tracking loop should be doing sixty times a second.
   */
    function measure(): void {
      // Only called once a drag is under way.
      var d = drag as DragState;
      d.width = d.node.offsetWidth;
      d.home = d.node.getBoundingClientRect().left - d.shift;
      d.scrollAt = host.scrollLeft;
    }

    function follow(): void {
      // Only called once a drag is under way, after measure() has run.
      var d = drag as DragState;
      var node = d.node;
      var x = d.last.x;
      // The row shifts under the finger when the strip scrolls; the home
      // position moves with it rather than being measured again.
      d.home = (d.home as number) - (host.scrollLeft - (d.scrollAt as number));
      d.scrollAt = host.scrollLeft;

      var edge = d.home + d.shift;      // where the pick is drawn now
      var prev = node.previousElementSibling;
      var next = node.nextElementSibling;
      if (prev && edge < d.home - (d.width as number) / 2) {
        host.insertBefore(node, prev);
        measure();
      } else if (next && edge > d.home + (d.width as number) / 2) {
        host.insertBefore(node, next.nextElementSibling);
        measure();
      }

      d.shift = x - (d.grab as number) - d.home;
      node.style.transform = 'translateX(' + d.shift + 'px)';
    }

    function edgeScroll(): void {
      if (!drag || !drag.on) return;
      var box = host.getBoundingClientRect();
      var step = 0;
      if (drag.last.x < box.left + DRAG_EDGE) step = -8;
      else if (drag.last.x > box.right - DRAG_EDGE) step = 8;
      if (!step) return;
      var before = host.scrollLeft;
      host.scrollLeft = before + step;
      if (host.scrollLeft !== before) follow();
    }

    function stop(event?: TouchEvent | MouseEvent): void {
      if (!drag) return;
      var done = drag;
      drag = null;
      clearTimeout(done.timer);
      clearInterval(done.scroller);
      if (!done.held) return;
      // The hold was the gesture, so the release is not also a tap: without
      // this the click lands on the menu's scrim and closes it at once.
      if (event && event.type === 'touchend') event.preventDefault();
      suppressClickUntil = Date.now() + 500;
      ui.toggleClass(done.node, 'is-lifted', false);
      if (!done.on) {
        var story = lineup()[done.from];
        if (story && indexIn(done.node) >= 0) openStoryMenu(story);
        return;
      }
      done.node.style.transform = '';
      ui.toggleClass(done.node, 'is-dragging', false);
      // -1 if the strip was rebuilt mid-drag, in which case there is nothing to move.
      var to = indexIn(done.node);
      /* The drag moved this node by hand, behind the renderer's back. Putting it
       * back where it started leaves the DOM matching what was last rendered,
       * so the re-render below is the only thing that reorders anything. */
      if (to >= 0) host.insertBefore(done.node, done.after);
      if (to >= 0) movePick(done.from, to);
    }

    // Same function as [].indexOf; spelled this way so an empty array literal
    // does not leave TypeScript with nothing to infer indexOf's element type from.
    function indexIn(node: Element): number { return Array.prototype.indexOf.call(host.children, node); }

    host.addEventListener('touchstart', start, false);
    host.addEventListener('touchmove', move, { passive: false });
    host.addEventListener('touchend', stop, false);
    host.addEventListener('touchcancel', stop, false);
    host.addEventListener('mousedown', start, false);
    document.addEventListener('mousemove', move, false);
    document.addEventListener('mouseup', stop, false);
    host.addEventListener('contextmenu', function (event) { event.preventDefault(); }, false);
    // Lifting the finger after a drag would otherwise open the story.
    host.addEventListener('click', function (event) {
      if (Date.now() > suppressClickUntil) return;
      event.stopPropagation();
      event.preventDefault();
    }, true);
  }

  var PLAYBACK_TOGGLES = [
    { key: 'dim', label: 'Screen dims while playing' },
    { key: 'resume', label: 'Remember where each story stopped' },
    { key: 'artwork', label: 'Find cover art online' }
  ];

  function renderToggles(): void {
    var settings = App.settings.get();
    App.views.toggles($('toggles'), PLAYBACK_TOGGLES.map(function (row) {
      return { key: row.key, label: row.label, on: settings[row.key as keyof Settings] !== false };
    }), {
      toggle: function (key: string, on: boolean) {
        var patch: Partial<Settings> = {};
        (patch as any)[key] = on;
        App.settings.set(patch);
        renderToggles();
        renderHome();
      }
    });
  }

  function renderStorage(): void {
    var total = 0;
    stories.forEach(function (s) { total += s.size || 0; });
    ui.text($('storage-used'), ui.bytes(total) + ' stored');
    ui.text($('storage-note'), storageNote());

    var host = $('stored-list');
    ui.show(host, stories.length > 0);
    App.views.storedList(host, stories, { remove: removeStory });
  }

  function storageNote(): string {
    var parts: string[] = [];
    if (spaceEstimate && spaceEstimate.quota > spaceEstimate.usage) {
      parts.push(ui.bytes(spaceEstimate.quota - spaceEstimate.usage) + ' still free for this app');
    } else {
      parts.push('Copied into this app, so they play with no signal');
    }
    if (persistedState === true) parts.push('this phone has promised to keep them');
    else if (persistedState === false) parts.push('iOS may reclaim them if space runs short');
    return parts.join(' · ');
  }

  /* An in-app confirmation rather than window.confirm, which a Home Screen web
   * app renders as a system alert captioned with the site's origin.
   */
  /* The options bag askConfirm shows in the in-app confirmation sheet. */
  interface ConfirmOptions {
    title: string;
    body?: string;
    confirmLabel?: string;
    cancelLabel?: string;
  }

  function askConfirm(options: ConfirmOptions, onConfirm: () => void): void {
    var node = $('confirm');
    ui.text($('confirm-title'), options.title);
    ui.text($('confirm-body'), options.body || '');
    ui.text($('confirm-yes'), options.confirmLabel || 'Remove');
    ui.text($('confirm-no'), options.cancelLabel || 'Cancel');

    function close() {
      ui.toggleClass(node, 'is-on', false);
      node.setAttribute('aria-hidden', 'true');
      $('confirm-yes').onclick = null;
      $('confirm-no').onclick = null;
      $('confirm-scrim').onclick = null;
    }
    $('confirm-yes').onclick = function () { close(); onConfirm(); };
    $('confirm-no').onclick = close;
    $('confirm-scrim').onclick = close;

    ui.toggleClass(node, 'is-on', true);
    node.setAttribute('aria-hidden', 'false');
  }

  function removeStory(story: Story): void {
    askConfirm({
      title: 'Remove \u201c' + story.title + '\u201d?',
      body: 'The audio is deleted from this phone, freeing ' + ui.bytes(story.size) +
            '. You can add the file again later.',
      confirmLabel: 'Remove',
      cancelLabel: 'Keep it'
    }, function () { deleteStoryNow(story); });
  }

  function deleteStoryNow(story: Story): void {
    App.log.add('story', 'Removed "' + story.title + '"');
    var playing = App.player.currentStory();
    if (playing && playing.id === story.id) App.player.pause();
    App.media.release(story.id);
    App.media.forgetArt(story.id);
    App.store.deleteStory(story.id).then(function () {
      stories = stories.filter(function (s) { return s.id !== story.id; });
      if (currentId === story.id) currentId = null;
      renderAll();
      ui.toast('Removed. ' + ui.bytes(story.size) + ' freed.');
    })['catch'](function () {
      ui.toast('That story could not be removed.');
    });
  }

  function renderWeek(): void {
    var week = App.stats.week();
    ui.text($('week-listened'), week.seconds
      ? ui.minutes(week.seconds) + ' listened'
      : 'Nothing listened yet');
    ui.text($('week-nights'), week.nights
      ? 'Asleep before the timer on ' + week.slept + ' of ' + week.nights + ' nights'
      : 'No nights recorded yet');
  }

  function applySettingsToForm(): void {
    var settings = App.settings.get();
    // These are all <input> elements in index.html, hence .value.
    ($('set-bedtime') as HTMLInputElement).value = settings.bedtime;
    ($('set-per-night') as HTMLInputElement).value = String(settings.perNight);
    ($('set-sleep') as HTMLInputElement).value = String(settings.sleepMinutes);
    ($('set-name') as HTMLInputElement).value = settings.childName;
  }

  /* ============================================================== importing */

  /* A File tagged, the moment it is queued, with the key its import row is
   * stored under - there is no other way to find a row back from its file.
   */
  interface QueuedFile extends File {
    __key: string;
  }

  function handleFiles(fileList: FileList | File[]): void {
    var files: File[] = [];
    for (var i = 0; i < fileList.length; i++) files.push(fileList[i]);
    if (!files.length) return;

    var queue = files.slice();
    importing = true;
    files.forEach(function (file) { addImportRow(file); });
    ui.show($('add-empty'), false);
    ui.show($('imports-block'), true);
    ui.show($('ours-block'), true);

    function next(): Promise<void> {
      if (!queue.length) {
        importing = false;
        updateImportLabel();
        return Promise.resolve();
      }
      var file = queue.shift() as File;
      var row = importRows[(file as QueuedFile).__key];
      return App.importer.importFile(file, function (fraction) {
        setRowProgress(row, fraction);
      }).then(function (story) {
        App.log.add('import', 'Imported "' + story.title + '", ' + ui.bytes(story.size));
        stories = sortStories(stories.concat([story]));
        finishRow(row, story);
        renderAll();
        updateImportLabel();
        // Browsers weigh engagement, so a request right after a real import is
        // far more likely to be granted than one at a cold start.
        refreshStorageFacts();
        findArtwork(story);
        return next();
      })['catch'](function (err) {
        App.log.add('import', 'Failed: ' + (err && err.message ? err.message : String(err)));
        failRow(row, err && err.message ? err.message : 'Failed');
        updateImportLabel();
        return next();
      });
    }

    next();
  }

  var rowSeq = 0;

  function addImportRow(file: File): ImportRow {
    (file as QueuedFile).__key = 'imp' + (++rowSeq);
    var row: ImportRow = {
      key: (file as QueuedFile).__key,
      name: App.importer.titleFromName(file.name),
      art: ui.stripes(App.importer.hash(file.name) % 360, true),
      artLabel: 'ART',
      percent: 0,
      status: '0%',
      state: '',
      storyId: null,
      done: false
    };
    importRows[(file as QueuedFile).__key] = row;
    importOrder.push(row);
    renderImports();
    return row;
  }

  function renderImports(): void {
    App.views.imports($('imports'), importOrder, { art: chooseImportArt });
  }

  function chooseImportArt(row: ImportRow, image: File): void {
    if (!row.storyId) {
      ui.toast('Wait for the import to finish, then pick a picture.');
      return;
    }
    // Captured so the closures below keep a definite string, not row.storyId.
    var storyId = row.storyId;
    App.importer.setArt(storyId, image).then(function () {
      return App.media.artUrl(storyId);
    }).then(function (url) {
      if (url) {
        row.art = 'url("' + url + '")';
        row.artLabel = 'EDIT';
      }
      var story = byId(storyId);
      if (story) story.hasArt = true;
      renderImports();
      renderAll();
    })['catch'](function () { ui.toast('That picture could not be used.'); });
  }

  function setRowProgress(row: ImportRow, fraction: number): void {
    if (!row) return;
    var pct = Math.round(fraction * 100);
    if (pct === row.percent) return;      // the same bar, redrawn, helps nobody
    row.percent = pct;
    row.status = pct + '%';
    renderImports();
  }

  function finishRow(row: ImportRow, story: Story): void {
    if (!row) return;
    row.done = true;
    row.storyId = story.id;
    row.state = 'done';
    row.percent = 100;
    row.status = 'Ready';
    row.name = story.title;
    renderImports();
    if (!story.hasArt) return;
    App.media.artUrl(story.id).then(function (url) {
      if (!url) return;
      row.art = 'url("' + url + '")';
      row.artLabel = 'EDIT';
      renderImports();
    });
  }

  function failRow(row: ImportRow, message: string): void {
    if (!row) return;
    row.state = 'failed';
    row.percent = 100;
    row.status = 'Failed';
    renderImports();
    ui.toast(message);
  }

  function updateImportLabel(): void {
    var total = 0;
    var done = 0;
    for (var key in importRows) {
      if (!Object.prototype.hasOwnProperty.call(importRows, key)) continue;
      total++;
      if (importRows[key].done) done++;
    }
    ui.text($('import-label'), done === total ? 'Imported · ' + done : 'Importing · ' + done + ' of ' + total);
  }

  /* ================================================================= events */

  function wireControls(): void {
    $('player-close').onclick = closePlayer;
    $('mini-open').onclick = openPlayer;
    $('mini-play').onclick = function () { App.player.toggle(); };
    $('skip-back').onclick = function () { App.player.seekBy(-SKIP_SECONDS); };
    $('skip-forward').onclick = function () { App.player.seekBy(SKIP_SECONDS); };
    $('playbtn').onclick = function () {
      if (!App.player.currentStory()) {
        var story = current();
        if (story) { openStory(story.id); return; }
      }
      App.player.toggle();
    };
    $('open-sheet').onclick = function () { renderTimerOptions(); openSheet(); };
    $('sheet-close').onclick = closeSheet;
    $('sheet-scrim').onclick = closeSheet;
    $('asleep').onclick = function () {
      ui.toggleClass($('asleep'), 'is-on', false);
      App.player.wake();
    };

    $('add-btn').onclick = openAdd;
    $('parent-add').onclick = openAdd;
    $('install-row').onclick = function () {
      App.caps.promptInstall().then(function (accepted) {
        if (accepted) ui.toast('Installed. Open Bedtime from the Home Screen.');
      });
    };
    $('add-close').onclick = function () {
      ui.toggleClass($('add'), 'is-open', false);
      $('add').setAttribute('aria-hidden', 'true');
    };
    $('parent-close').onclick = function () {
      ui.toggleClass($('parent'), 'is-open', false);
      $('parent').setAttribute('aria-hidden', 'true');
    };

    $('file-input').onchange = function (event) {
      // The change event's target is this file input.
      var input = event.target as HTMLInputElement;
      handleFiles(input.files || []);
      input.value = '';
    };

    $('ours-switch').onclick = function () {
      var next = !App.settings.get().showOurs;
      App.settings.set({ showOurs: next });
      renderAll();
    };

    // `this` inside each handler below is the input it was assigned to.
    $('set-bedtime').onchange = function (this: GlobalEventHandlers) {
      App.settings.set({ bedtime: (this as HTMLInputElement).value || '19:30' });
      renderHome();
    };
    $('set-per-night').onchange = function (this: GlobalEventHandlers) {
      App.settings.set({ perNight: parseInt((this as HTMLInputElement).value, 10) || 0 });
      renderHome();
    };
    $('set-sleep').onchange = function (this: GlobalEventHandlers) {
      var minutes = parseInt((this as HTMLInputElement).value, 10) || 20;
      App.settings.set({ sleepMinutes: minutes });
      App.player.defaultSleepMinutes(minutes);
      renderTimerOptions();
    };
    $('set-name').oninput = function (this: GlobalEventHandlers) {
      App.settings.set({ childName: (this as HTMLInputElement).value.trim() });
      renderHome();
      renderParent();
    };

    wireHold();
    wireScrubber();
    wirePicksDrag();
    App.log.onChange(function () {
      if ($('parent').className.indexOf('is-open') >= 0) renderLog();
    });
    wireSwipes();
  }

  function openAdd(): void {
    ui.toggleClass($('add'), 'is-open', true);
    $('add').setAttribute('aria-hidden', 'false');
    var hasImports = importOrder.length > 0;
    ui.show($('imports-block'), hasImports);
    ui.show($('ours-block'), hasImports || stories.length > 0);
    ui.show($('add-empty'), !hasImports && stories.length === 0);
  }

  function scrollTop(): void {
    $('library').scrollTop = 0;
  }
  void scrollTop;   // unused in this build, same as in the hand-written original

  // Hold the moon for three seconds to reach parent controls. Pointer events
  // do not exist on iOS 12, so touch and mouse are wired separately.
  function wireHold(): void {
    var button = $('moon-btn');
    var ring = $('hold-ring');

    function start(event: TouchEvent | MouseEvent): void {
      if (event.type === 'touchstart') event.preventDefault();
      holdStart = Date.now();
      clearInterval(holdTimer as ReturnType<typeof setInterval>);
      holdTimer = setInterval(function () {
        var fraction = (Date.now() - holdStart) / HOLD_MS;
        ui.ring(ring, fraction);
        if (fraction >= 1) {
          stop();
          openParent();
        }
      }, 50);
    }

    function stop(): void {
      clearInterval(holdTimer as ReturnType<typeof setInterval>);
      holdTimer = null;
      ui.ring(ring, 0);
    }

    button.addEventListener('touchstart', start, false);
    button.addEventListener('touchend', stop, false);
    button.addEventListener('touchcancel', stop, false);
    button.addEventListener('mousedown', start, false);
    button.addEventListener('mouseup', stop, false);
    button.addEventListener('mouseleave', stop, false);
    button.addEventListener('contextmenu', function (event) { event.preventDefault(); }, false);
  }

  function openParent(): void {
    renderParent();
    applySettingsToForm();
    ui.toggleClass($('parent'), 'is-open', true);
    $('parent').setAttribute('aria-hidden', 'false');
  }

  /* --------------------------------------------------------------- startup */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Used by test/browser.test.js.
  App.debug = {
    stories: function () { return stories; },
    lineup: lineup,
    togglePick: togglePick,
    reclaimOrphanChunks: reclaimOrphanChunks,
    setImporting: function (value: boolean) { importing = value; },
    renderAll: renderAll,
    verifyStorage: verifyStorage,
    findArtwork: findArtwork
  };
})();
