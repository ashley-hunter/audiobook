/* Bedtime - parent settings and the weekly listening record.
 *
 * Both live in the `kv` object store. They are cached in memory and written
 * back lazily so the phone is not hammered while a story is playing.
 */
window.App = window.App || {};

App.settings = (function () {
  'use strict';

  var DEFAULTS = {
    childName: '',
    bedtime: '19:30',
    perNight: 2,
    sleepMinutes: 20,
    lock: true,
    dim: true,
    resume: true,
    showOurs: true,
    taughtParentGate: false
  };

  var current = null;
  var saveTimer = null;

  function load() {
    return App.store.kvGet('settings', null).then(function (saved) {
      current = {};
      for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) current[k] = DEFAULTS[k];
      if (saved) {
        for (var j in saved) if (Object.prototype.hasOwnProperty.call(current, j)) current[j] = saved[j];
      }
      return current;
    })['catch'](function () {
      current = JSON.parse(JSON.stringify(DEFAULTS));
      return current;
    });
  }

  function get() { return current || DEFAULTS; }

  function set(patch) {
    if (!current) current = JSON.parse(JSON.stringify(DEFAULTS));
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) current[k] = patch[k];
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 250);
    return current;
  }

  // iOS can tear the app down without warning, so anything pending is written
  // out the moment the app is backgrounded.
  function flush() {
    clearTimeout(saveTimer);
    if (current) App.store.kvSet('settings', current)['catch'](function () { return null; });
  }

  return { load: load, get: get, set: set, flush: flush, DEFAULTS: DEFAULTS };
})();

App.stats = (function () {
  'use strict';

  var data = { days: {}, nights: [] };
  var saveTimer = null;

  function dayKey(when) {
    // A story started at 11pm belongs to that evening, not to the small hours.
    var d = new Date(when);
    if (d.getHours() < 5) d.setDate(d.getDate() - 1);
    var month = String(d.getMonth() + 1);
    var day = String(d.getDate());
    if (month.length < 2) month = '0' + month;
    if (day.length < 2) day = '0' + day;
    return d.getFullYear() + '-' + month + '-' + day;
  }

  function load() {
    return App.store.kvGet('stats', null).then(function (saved) {
      if (saved && saved.days) data = saved;
      if (!data.nights) data.nights = [];
      return data;
    })['catch'](function () { return data; });
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 500);
  }

  function flush() {
    clearTimeout(saveTimer);
    App.store.kvSet('stats', data)['catch'](function () { return null; });
  }

  function addListening(seconds) {
    if (!seconds || seconds < 1) return;
    var key = dayKey(Date.now());
    data.days[key] = (data.days[key] || 0) + seconds;
    prune();
    save();
  }

  // sleptThrough: the sleep timer ran out on its own, rather than the story
  // being stopped by hand.
  function recordNight(sleptThrough) {
    var key = dayKey(Date.now());
    for (var i = 0; i < data.nights.length; i++) {
      if (data.nights[i].d === key) {
        if (sleptThrough) data.nights[i].slept = true;
        save();
        return;
      }
    }
    data.nights.push({ d: key, slept: !!sleptThrough });
    prune();
    save();
  }

  function prune() {
    var cutoff = dayKey(Date.now() - 30 * 86400000);
    for (var key in data.days) {
      if (Object.prototype.hasOwnProperty.call(data.days, key) && key < cutoff) delete data.days[key];
    }
    data.nights = data.nights.filter(function (n) { return n.d >= cutoff; }).slice(-30);
  }

  function week() {
    var seconds = 0;
    var from = dayKey(Date.now() - 6 * 86400000);
    for (var key in data.days) {
      if (Object.prototype.hasOwnProperty.call(data.days, key) && key >= from) seconds += data.days[key];
    }
    var nights = data.nights.filter(function (n) { return n.d >= from; });
    var slept = nights.filter(function (n) { return n.slept; }).length;
    return { seconds: seconds, nights: nights.length, slept: slept };
  }

  // How many stories were opened tonight, used for the "stories per night" nudge.
  function storiesTonight(stories) {
    var key = dayKey(Date.now());
    var count = 0;
    for (var i = 0; i < stories.length; i++) {
      if (stories[i].lastPlayedAt && dayKey(stories[i].lastPlayedAt) === key) count++;
    }
    return count;
  }

  return {
    load: load,
    flush: flush,
    addListening: addListening,
    recordNight: recordNight,
    week: week,
    storiesTonight: storiesTonight,
    dayKey: dayKey
  };
})();
