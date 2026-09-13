/* Bedtime - screen wiring.
 *
 * The markup for every screen already exists in index.html; this file keeps it
 * in step with the data. Lists are rebuilt when the library changes, but the
 * player is updated field by field so the once-a-second tick never rebuilds
 * nodes or restarts the starfield animation.
 */
window.App = window.App || {};

(function () {
  'use strict';

  var ui = App.ui;
  var $ = ui.$;

  var HOLD_MS = 3000;       // how long the moon must be held to reach parent controls

  var stories = [];
  var tab = 'home';
  var mood = 'All';
  var currentId = null;
  var importRows = {};
  var holdTimer = null;
  var holdStart = 0;
  var persistedState = null;   // null until the browser has been asked
  var spaceEstimate = null;    // null on browsers that will not say

  /* ==================================================================== boot */

  function boot() {
    registerServiceWorker();

    App.store.open()
      .then(function () {
        return Promise.all([App.settings.load(), App.stats.load(), App.store.getStories()]);
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
        refreshStorageFacts();
        nudgeInstall();
        wireTeardown();
      })
      ['catch'](function (err) {
        ui.toast(err && err.message ? err.message : 'This browser will not let the app store stories.');
      });
  }

  // iOS kills a backgrounded Home Screen app without notice, so pending
  // settings and listening time are written out the moment it goes away.
  function wireTeardown() {
    function flush() {
      App.settings.flush();
      App.stats.flush();
      App.player.checkpoint(true);
    }
    window.addEventListener('pagehide', flush, false);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) flush();
    }, false);
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js')['catch'](function () { return null; });
  }

  /* Asks for protected storage and reads the real free space, where the
   * browser offers either. On an iPhone 6 both come back null and the app
   * falls back to reporting the bytes it holds, plus the startup audit that
   * spots audio iOS has already reclaimed.
   */
  function refreshStorageFacts() {
    App.caps.requestPersistence().then(function (granted) {
      persistedState = granted;
      return App.caps.estimate();
    }).then(function (estimate) {
      spaceEstimate = estimate;
      renderStorage();
      renderDeviceCaps();
    })['catch'](function () { return null; });
  }

  // A Home Screen install is what gives the player its full screen and its own
  // storage. Chromium can offer a button; Safari can only be told how.
  function nudgeInstall() {
    App.caps.onInstallAvailable(function (available) {
      ui.show($('install-row'), available);
    });
    if (App.caps.isStandalone()) return;
    if (App.caps.isIOS()) {
      setTimeout(function () {
        ui.toast('Tip: Share → Add to Home Screen, so the player runs full screen.');
      }, 1500);
    }
  }

  /* ================================================================== data */

  function sortStories(list) {
    return list.slice().sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
  }

  function byId(id) {
    for (var i = 0; i < stories.length; i++) if (stories[i].id === id) return stories[i];
    return null;
  }

  // Stories the child is allowed to see.
  function visibleStories() {
    if (App.settings.get().showOurs) return stories;
    return stories.filter(function (s) { return s.mood !== 'Ours'; });
  }

  function filteredStories() {
    var list = visibleStories();
    if (mood === 'All') return list;
    return list.filter(function (s) { return s.mood === mood; });
  }

  function keepGoingStory() {
    var best = null;
    var list = visibleStories();
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s.lastPlayedAt || !s.pos || s.missing) continue;
      if (s.len && s.pos >= s.len - 5) continue;
      if (!best || s.lastPlayedAt > best.lastPlayedAt) best = s;
    }
    return best;
  }

  function current() {
    return byId(currentId) || keepGoingStory() || visibleStories()[0] || null;
  }

  // Marks stories whose audio WebKit has evicted, so the library can say so
  // rather than failing at the moment a child presses play.
  function verifyStorage() {
    var pending = stories.slice();
    function step() {
      if (!pending.length) return;
      var story = pending.shift();
      App.store.getChunk(story.id, 0).then(function (chunk) {
        var missing = !chunk;
        if (missing !== !!story.missing) {
          story.missing = missing;
          renderAll();
        }
        step();
      })['catch'](step);
    }
    step();
  }

  /* ================================================================ render */

  function renderAll() {
    renderHome();
    renderSaved();
    renderPlayer();
    renderParent();
    renderTabs();
  }

  function renderTabs() {
    ui.toggleClass($('tab-home'), 'is-on', tab === 'home');
    ui.toggleClass($('tab-saved'), 'is-on', tab === 'saved');
    ui.show($('screen-home'), tab === 'home');
    ui.show($('screen-saved'), tab === 'saved');
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
      var pct = keep.len ? Math.min(1, keep.pos / keep.len) : 0;
      $('kg-bar').style.width = (pct * 100).toFixed(1) + '%';
      $('keepgoing').onclick = function () { openStory(keep.id); };
    }

    var visible = visibleStories();
    var picks = visible.filter(function (s) {
      return (!keep || s.id !== keep.id) && !s.missing;
    }).slice(0, 4);
    ui.show($('picks-block'), picks.length >= 2);
    renderPicks(picks);

    renderMoods(visible);
    renderRows($('library-rows'), filteredStories());

    var empty = $('library-empty');
    ui.show(empty, visible.length === 0);
    if (visible.length === 0) renderEmptyState(empty);
  }

  function renderEmptyState(empty) {
    ui.clear(empty);
    var hiddenByParent = stories.length > 0;

    empty.appendChild(ui.el('p', 'empty-title display display-sm',
      hiddenByParent ? 'Stories are hidden' : 'No stories yet'));

    empty.appendChild(ui.el('p', null, hiddenByParent
      // The "Show in the library" switch lives on the Add screen, so the same
      // button is the way back from here as well as the way to add more.
      ? 'Turn "Show in the library" back on from the Add stories screen.'
      : 'Bring in audio you already own. Files are copied into this app and stay on this phone.'));

    var button = ui.el('button', 'empty-add');
    button.type = 'button';
    button.appendChild(ui.el('span', 'plus', '+'));
    button.appendChild(document.createTextNode('Add stories'));
    button.onclick = openAdd;
    empty.appendChild(button);
  }

  function homeSubtitle() {
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

  function pastBedtime(bedtime) {
    if (!bedtime || bedtime.indexOf(':') < 0) return false;
    var parts = bedtime.split(':');
    var now = new Date();
    var minutesNow = now.getHours() * 60 + now.getMinutes();
    var minutesBed = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    // Only counts in the evening, so 7am does not read as "past bedtime".
    return minutesNow >= minutesBed && now.getHours() >= 12;
  }

  function renderPicks(picks) {
    var host = $('picks');
    ui.clear(host);
    picks.forEach(function (story) {
      var wrap = ui.el('div', 'pick');
      var button = ui.el('button', null);
      button.type = 'button';
      var cover = ui.el('span', 'cover pick-cover');
      ui.paintCover(cover, story);
      button.appendChild(cover);
      button.appendChild(ui.el('span', 'pick-title', story.title));
      button.appendChild(ui.el('span', 'pick-mins', ui.minutes(story.len)));
      button.style.display = 'block';
      button.style.width = '100%';
      button.onclick = function () { openStory(story.id); };
      wrap.appendChild(button);
      host.appendChild(wrap);
    });
  }

  function renderMoods(list) {
    var host = $('moods');
    var names = ['All'];
    list.forEach(function (s) {
      if (s.mood && names.indexOf(s.mood) < 0) names.push(s.mood);
    });
    ui.clear(host);
    // With a single category the filter row is noise, so it stays hidden.
    if (names.length < 3) {
      mood = 'All';
      return;
    }
    names.forEach(function (name) {
      var chip = ui.el('button', 'mood' + (mood === name ? ' is-on' : ''), name);
      chip.type = 'button';
      chip.onclick = function () { mood = name; renderHome(); };
      host.appendChild(chip);
    });
  }

  function renderRows(host, list) {
    ui.clear(host);
    list.forEach(function (story) {
      var row = ui.el('div', 'row' + (story.missing ? ' is-missing' : ''));

      var open = ui.el('button', 'row-open');
      open.type = 'button';
      var cover = ui.el('span', 'cover cover-row');
      ui.paintCover(cover, story);
      var textWrap = ui.el('span', 'row-text');
      textWrap.appendChild(ui.el('span', 'row-title', story.title));
      textWrap.appendChild(ui.el('span', 'row-meta', rowMeta(story)));
      open.appendChild(cover);
      open.appendChild(textWrap);
      open.onclick = function () { openStory(story.id); };

      var heart = ui.el('button', 'row-heart' + (story.fav ? ' is-on' : ''), '♥');
      heart.type = 'button';
      heart.setAttribute('aria-label', story.fav ? 'Remove from saved' : 'Save this story');
      heart.onclick = function (event) {
        event.stopPropagation();
        toggleFav(story.id);
      };

      row.appendChild(open);
      row.appendChild(heart);
      host.appendChild(row);
    });
  }

  function rowMeta(story) {
    if (story.missing) return 'Needs adding again - the phone cleared it';
    var parts = [ui.minutes(story.len)];
    if (story.narrator && story.narrator !== 'you') parts.push('read by ' + story.narrator);
    else parts.push('added by you');
    return parts.join(' · ');
  }

  function renderSaved() {
    var saved = visibleStories().filter(function (s) { return s.fav; });
    renderRows($('saved-rows'), saved);
    var label;
    if (!saved.length) label = 'Tap a heart to keep a story here';
    else label = saved.length + (saved.length === 1 ? ' story' : ' stories') + ' kept for later';
    ui.text($('saved-sub'), label);
  }

  /* ================================================================ player */

  function renderPlayer() {
    var story = current();
    if (!story) return;
    ui.text($('player-title'), story.title);
    ui.text($('player-meta'), rowMeta(story));
    ui.paintCover($('disc-cover'), story);
    ui.toggleClass($('player-fav'), 'is-on', !!story.fav);
    renderTimerOptions();
    updateProgress(App.player.position(), App.player.duration());
  }

  function updateProgress(position, length) {
    var story = current();
    var total = length || (story ? story.len : 0) || 0;
    var fraction = total ? Math.min(1, position / total) : 0;
    ui.ring($('disc-fill'), fraction);
    ui.text($('elapsed'), ui.clock(position));
    ui.text($('remaining'), '-' + ui.clock(Math.max(0, total - position)));

    var dim = App.settings.get().dim && App.player.playing() ? Math.min(0.5, fraction * 0.8) : 0;
    $('sky-dim').style.opacity = String(dim);

    if (story && $('keepgoing') && !$('keepgoing').hidden) {
      var keep = keepGoingStory();
      if (keep && keep.id === story.id) {
        $('kg-bar').style.width = (fraction * 100).toFixed(1) + '%';
      }
    }
  }

  function renderTimerOptions() {
    var host = $('timer-options');
    var story = current();
    var left = story ? Math.max(1, Math.ceil(((story.len || 0) - App.player.position()) / 60)) : 30;
    var chosen = App.player.currentSleepMinutes();
    var options = [
      { m: 10, label: '10 minutes', note: 'a short one' },
      { m: 20, label: '20 minutes', note: '' },
      { m: 30, label: '30 minutes', note: 'a long one' },
      { m: left, label: 'End of the story', note: left + ' min' }
    ];
    ui.clear(host);
    options.forEach(function (option) {
      var on = chosen === option.m;
      var button = ui.el('button', 'timer-opt' + (on ? ' is-on' : ''));
      button.type = 'button';
      button.appendChild(document.createTextNode(option.label));
      button.appendChild(ui.el('span', 'note', on ? '✓' : option.note));
      button.onclick = function () {
        App.player.setSleepMinutes(option.m);
        closeSheet();
        renderTimerOptions();
        App.player.play();
      };
      host.appendChild(button);
    });
  }

  function wirePlayerEvents() {
    App.player.on({
      tick: function (position, length) {
        updateProgress(position, length);
      },
      state: function (isPlaying) {
        ui.text($('play-label'), isPlaying ? 'Pause' : 'Play');
        if (isPlaying) ui.toggleClass($('asleep'), 'is-on', false);
      },
      sleep: function (secondsLeft) {
        ui.text($('sleep-label'), secondsLeft > 0
          ? 'Sleep timer · ' + Math.ceil(secondsLeft / 60) + ' min left'
          : 'Sleep timer finished');
      },
      asleep: function () {
        ui.toggleClass($('asleep'), 'is-on', true);
      },
      ended: function () {
        ui.toggleClass($('asleep'), 'is-on', false);
        renderHome();
      },
      loaded: function (story) {
        currentId = story.id;
        renderPlayer();
      },
      error: function (message) {
        ui.toast(message);
      }
    });
  }

  function openStory(id) {
    var story = byId(id);
    if (!story) return;
    if (story.missing) {
      ui.toast('This phone cleared that audio. Add the file again.');
      return;
    }
    currentId = id;
    openPlayer();
    var resume = App.settings.get().resume === false ? 0 : (story.pos || 0);
    App.player.load(story, { autoplay: true, startAt: resume })['catch'](function (err) {
      ui.toast(err && err.message ? err.message : 'That story could not be opened.');
    });
    App.player.setSleepMinutes(App.settings.get().sleepMinutes);
    renderPlayer();
  }

  function openPlayer() { ui.toggleClass($('player'), 'is-open', true); $('player').setAttribute('aria-hidden', 'false'); }
  function closePlayer() { ui.toggleClass($('player'), 'is-open', false); $('player').setAttribute('aria-hidden', 'true'); renderHome(); }
  function openSheet() { ui.toggleClass($('sheet'), 'is-open', true); ui.toggleClass($('sheet-scrim'), 'is-on', true); }
  function closeSheet() { ui.toggleClass($('sheet'), 'is-open', false); ui.toggleClass($('sheet-scrim'), 'is-on', false); }

  function toggleFav(id) {
    var story = byId(id);
    if (!story) return;
    story.fav = !story.fav;
    App.store.patchStory(id, { fav: story.fav })['catch'](function () { return null; });
    renderHome();
    renderSaved();
    if (current() && current().id === id) ui.toggleClass($('player-fav'), 'is-on', story.fav);
  }

  /* ======================================================= parent controls */

  function renderParent() {
    var settings = App.settings.get();
    renderDeviceCaps();
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

  function renderToggles() {
    var settings = App.settings.get();
    var host = $('toggles');
    var rows = [
      { key: 'dim', label: 'Screen dims while playing' },
      { key: 'resume', label: 'Remember where each story stopped' }
    ];
    ui.clear(host);
    rows.forEach(function (row) {
      var on = row.key === 'resume' ? settings.resume !== false : !!settings[row.key];
      var button = ui.el('button', 'card-row');
      button.type = 'button';
      button.appendChild(document.createTextNode(row.label));
      var sw = ui.el('span', 'switch' + (on ? ' is-on' : ''));
      sw.appendChild(ui.el('span', 'knob'));
      button.appendChild(sw);
      button.onclick = function () {
        var patch = {};
        patch[row.key] = !on;
        App.settings.set(patch);
        renderToggles();
        renderHome();
      };
      host.appendChild(button);
    });
  }

  function renderStorage() {
    var total = 0;
    stories.forEach(function (s) { total += s.size || 0; });
    ui.text($('storage-used'), ui.bytes(total) + ' stored');
    ui.text($('storage-note'), storageNote());

    var host = $('stored-list');
    ui.clear(host);
    ui.show(host, stories.length > 0);
    stories.forEach(function (story) {
      var row = ui.el('div', 'stored');
      var textWrap = ui.el('div', 'stored-text');
      textWrap.appendChild(ui.el('p', 'stored-name', story.title));
      var meta = ui.el('p', 'stored-meta' + (story.missing ? ' is-missing' : ''),
        story.missing ? 'Audio was cleared by iOS' : ui.bytes(story.size) + ' · ' + ui.minutes(story.len));
      textWrap.appendChild(meta);
      var remove = ui.el('button', 'remove', 'Remove');
      remove.type = 'button';
      remove.onclick = function () { removeStory(story); };
      row.appendChild(textWrap);
      row.appendChild(remove);
      host.appendChild(row);
    });
  }

  function storageNote() {
    var parts = [];
    if (spaceEstimate && spaceEstimate.quota > spaceEstimate.usage) {
      parts.push(ui.bytes(spaceEstimate.quota - spaceEstimate.usage) + ' still free for this app');
    } else {
      parts.push('Copied into this app, so they play with no signal');
    }
    if (persistedState === true) parts.push('this phone has promised to keep them');
    else if (persistedState === false) parts.push('iOS may reclaim them if space runs short');
    return parts.join(' · ');
  }

  // Shows what this particular phone can and cannot do, so the fallbacks are
  // visible rather than mysterious.
  function renderDeviceCaps() {
    var host = $('device-caps');
    if (!host) return;
    ui.clear(host);
    App.caps.report({ persisted: persistedState }).forEach(function (row) {
      var node = ui.el('div', 'cap');
      var textWrap = ui.el('div', 'cap-text');
      textWrap.appendChild(ui.el('p', 'cap-label', row.label));
      textWrap.appendChild(ui.el('p', 'cap-note', row.note));
      node.appendChild(textWrap);
      node.appendChild(ui.el('span', 'cap-mark' + (row.ok ? ' is-on' : ''), row.ok ? '✓' : '–'));
      host.appendChild(node);
    });
  }

  function removeStory(story) {
    if (!window.confirm('Remove "' + story.title + '" from this phone?')) return;
    if (App.player.currentStory() && App.player.currentStory().id === story.id) App.player.pause();
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

  function renderWeek() {
    var week = App.stats.week();
    ui.text($('week-listened'), week.seconds
      ? ui.minutes(week.seconds) + ' listened'
      : 'Nothing listened yet');
    ui.text($('week-nights'), week.nights
      ? 'Asleep before the timer on ' + week.slept + ' of ' + week.nights + ' nights'
      : 'No nights recorded yet');
  }

  function applySettingsToForm() {
    var settings = App.settings.get();
    $('set-bedtime').value = settings.bedtime;
    $('set-per-night').value = String(settings.perNight);
    $('set-sleep').value = String(settings.sleepMinutes);
    $('set-name').value = settings.childName;
  }

  /* ============================================================== importing */

  function handleFiles(fileList) {
    var files = [];
    for (var i = 0; i < fileList.length; i++) files.push(fileList[i]);
    if (!files.length) return;

    var queue = files.slice();
    files.forEach(function (file) { addImportRow(file); });
    ui.show($('add-empty'), false);
    ui.show($('imports-block'), true);
    ui.show($('ours-block'), true);

    function next() {
      if (!queue.length) {
        updateImportLabel();
        return Promise.resolve();
      }
      var file = queue.shift();
      var row = importRows[file.__key];
      return App.importer.importFile(file, function (fraction) {
        setRowProgress(row, fraction);
      }).then(function (story) {
        stories = sortStories(stories.concat([story]));
        finishRow(row, story);
        renderAll();
        updateImportLabel();
        // Browsers weigh engagement, so a request right after a real import is
        // far more likely to be granted than one at a cold start.
        refreshStorageFacts();
        return next();
      })['catch'](function (err) {
        failRow(row, err && err.message ? err.message : 'Failed');
        updateImportLabel();
        return next();
      });
    }

    next();
  }

  var rowSeq = 0;

  function addImportRow(file) {
    file.__key = 'imp' + (++rowSeq);
    var host = $('imports');
    var node = ui.el('div', 'import');

    var art = ui.el('label', 'import-art');
    art.style.backgroundImage = ui.stripes(App.importer.hash(file.name) % 360, true);
    var artLabel = ui.el('span', 'art-label', 'ART');
    var artInput = document.createElement('input');
    artInput.type = 'file';
    artInput.accept = 'image/*';
    art.appendChild(artLabel);
    art.appendChild(artInput);

    var textWrap = ui.el('div', 'import-text');
    textWrap.appendChild(ui.el('p', 'import-name', App.importer.titleFromName(file.name)));
    var bar = ui.el('div', 'import-bar');
    var fill = ui.el('span');
    bar.appendChild(fill);
    textWrap.appendChild(bar);

    var status = ui.el('div', 'import-status', '0%');

    node.appendChild(art);
    node.appendChild(textWrap);
    node.appendChild(status);
    host.appendChild(node);

    var row = { node: node, fill: fill, status: status, art: art, artLabel: artLabel, artInput: artInput, storyId: null, done: false };
    artInput.onchange = function () {
      var image = artInput.files && artInput.files[0];
      artInput.value = '';
      if (!image) return;
      if (!row.storyId) {
        ui.toast('Wait for the import to finish, then pick a picture.');
        return;
      }
      App.importer.setArt(row.storyId, image).then(function () {
        return App.media.artUrl(row.storyId);
      }).then(function (url) {
        if (url) art.style.backgroundImage = 'url("' + url + '")';
        artLabel.textContent = 'EDIT';
        var story = byId(row.storyId);
        if (story) story.hasArt = true;
        renderAll();
      })['catch'](function () { ui.toast('That picture could not be used.'); });
    };

    importRows[file.__key] = row;
    return row;
  }

  function setRowProgress(row, fraction) {
    if (!row) return;
    var pct = Math.round(fraction * 100);
    row.fill.style.width = pct + '%';
    row.status.textContent = pct + '%';
  }

  function finishRow(row, story) {
    if (!row) return;
    row.done = true;
    row.storyId = story.id;
    ui.toggleClass(row.node, 'is-done', true);
    row.fill.style.width = '100%';
    row.status.textContent = 'Ready';
    row.node.querySelector('.import-name').textContent = story.title;
    if (story.hasArt) {
      App.media.artUrl(story.id).then(function (url) {
        if (url) {
          row.art.style.backgroundImage = 'url("' + url + '")';
          row.artLabel.textContent = 'EDIT';
        }
      });
    }
  }

  function failRow(row, message) {
    if (!row) return;
    ui.toggleClass(row.node, 'is-failed', true);
    row.fill.style.width = '100%';
    row.status.textContent = 'Failed';
    ui.toast(message);
  }

  function updateImportLabel() {
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

  function wireControls() {
    $('tab-home').onclick = function () { tab = 'home'; renderTabs(); scrollTop(); };
    $('tab-saved').onclick = function () { tab = 'saved'; renderTabs(); scrollTop(); };

    $('player-close').onclick = closePlayer;
    $('to-library').onclick = function () { tab = 'home'; renderTabs(); closePlayer(); };
    $('playbtn').onclick = function () {
      if (!App.player.currentStory()) {
        var story = current();
        if (story) { openStory(story.id); return; }
      }
      App.player.toggle();
    };
    $('player-fav').onclick = function () {
      var story = current();
      if (story) toggleFav(story.id);
    };
    $('open-sheet').onclick = function () { renderTimerOptions(); openSheet(); };
    $('sheet-close').onclick = closeSheet;
    $('sheet-scrim').onclick = closeSheet;
    $('asleep').onclick = function () {
      ui.toggleClass($('asleep'), 'is-on', false);
      App.player.wake();
    };

    $('add-btn').onclick = openAdd;
    $('add-btn-saved').onclick = openAdd;
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
      handleFiles(event.target.files || []);
      event.target.value = '';
    };

    $('ours-switch').onclick = function () {
      var next = !App.settings.get().showOurs;
      App.settings.set({ showOurs: next });
      renderAll();
    };

    $('set-bedtime').onchange = function () {
      App.settings.set({ bedtime: this.value || '19:30' });
      renderHome();
    };
    $('set-per-night').onchange = function () {
      App.settings.set({ perNight: parseInt(this.value, 10) || 0 });
      renderHome();
    };
    $('set-sleep').onchange = function () {
      var minutes = parseInt(this.value, 10) || 20;
      App.settings.set({ sleepMinutes: minutes });
      App.player.defaultSleepMinutes(minutes);
      renderTimerOptions();
    };
    $('set-name').oninput = function () {
      App.settings.set({ childName: this.value.trim() });
      renderHome();
      renderParent();
    };

    wireHold();
  }

  function openAdd() {
    ui.toggleClass($('add'), 'is-open', true);
    $('add').setAttribute('aria-hidden', 'false');
    var hasImports = !!$('imports').firstChild;
    ui.show($('imports-block'), hasImports);
    ui.show($('ours-block'), hasImports || stories.length > 0);
    ui.show($('add-empty'), !hasImports && stories.length === 0);
  }

  function scrollTop() {
    $('library').scrollTop = 0;
  }

  // Hold the moon for three seconds to reach parent controls. Pointer events
  // do not exist on iOS 12, so touch and mouse are wired separately.
  function wireHold() {
    var button = $('moon-btn');
    var ring = $('hold-ring');

    function start(event) {
      if (event.type === 'touchstart') event.preventDefault();
      holdStart = Date.now();
      clearInterval(holdTimer);
      holdTimer = setInterval(function () {
        var fraction = (Date.now() - holdStart) / HOLD_MS;
        ui.ring(ring, fraction);
        if (fraction >= 1) {
          stop();
          openParent();
        }
      }, 50);
    }

    function stop() {
      clearInterval(holdTimer);
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

  function openParent() {
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
    stories: function () { return stories; }
  };
})();
