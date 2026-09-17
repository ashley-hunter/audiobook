/* Bedtime - parent settings and the weekly listening record.
 *
 * Both live in the `kv` object store. They are cached in memory and written
 * back lazily so the phone is not hammered while a story is playing.
 */
window.App = window.App || ({} as typeof App);

App.settings = (function (): SettingsModule {
  'use strict';

  var DEFAULTS: Settings = {
    childName: '',
    bedtime: '19:30',
    perNight: 2,
    sleepMinutes: 20,
    dim: true,
    resume: true,
    artwork: true,
    showOurs: true
  };

  var current: Settings | null = null;
  var saveTimer: ReturnType<typeof setTimeout> | undefined;

  function load(): Promise<Settings> {
    return App.store.kvGet<Settings | null>('settings', null).then(function (saved) {
      // Built up field by field below, so the cast just states what the loop
      // is about to make true.
      current = {} as Settings;
      for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) current[k] = DEFAULTS[k];
      if (saved) {
        for (var j in saved) if (Object.prototype.hasOwnProperty.call(current, j)) current[j] = saved[j];
      }
      return current;
    })['catch'](function () {
      // A deep clone of DEFAULTS, so it is a Settings even though JSON.parse
      // returns any.
      current = JSON.parse(JSON.stringify(DEFAULTS)) as Settings;
      return current;
    });
  }

  function get(): Settings { return current || DEFAULTS; }

  function set(patch: Partial<Settings>): Settings {
    if (!current) current = JSON.parse(JSON.stringify(DEFAULTS)) as Settings;
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) current[k] = patch[k];
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 250);
    return current;
  }

  // iOS can tear the app down without warning, so anything pending is written
  // out the moment the app is backgrounded.
  function flush(): void {
    clearTimeout(saveTimer);
    if (current) App.store.kvSet('settings', current)['catch'](function () { return null; });
  }

  return { load: load, get: get, set: set, flush: flush, DEFAULTS: DEFAULTS };
})();

/** The stats module's on-disk shape: a running tally of seconds per day, plus
 * a rolling log of nights, both pruned to the last 30 days. */
interface NightRecord {
  d: string;
  slept: boolean;
}

interface StatsData {
  days: { [key: string]: number };
  nights: NightRecord[];
}

App.stats = (function (): StatsModule {
  'use strict';

  var data: StatsData = { days: {}, nights: [] };
  var saveTimer: ReturnType<typeof setTimeout> | undefined;

  function dayKey(when: number): string {
    // A story started at 11pm belongs to that evening, not to the small hours.
    var d = new Date(when);
    if (d.getHours() < 5) d.setDate(d.getDate() - 1);
    var month = String(d.getMonth() + 1);
    var day = String(d.getDate());
    if (month.length < 2) month = '0' + month;
    if (day.length < 2) day = '0' + day;
    return d.getFullYear() + '-' + month + '-' + day;
  }

  function load(): Promise<StatsData> {
    return App.store.kvGet<Partial<StatsData> | null>('stats', null).then(function (saved) {
      // `days` was just checked truthy; `nights` may be missing on older
      // saves and is backfilled on the next line.
      if (saved && saved.days) data = saved as StatsData;
      if (!data.nights) data.nights = [];
      return data;
    })['catch'](function () { return data; });
  }

  function save(): void {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 500);
  }

  function flush(): void {
    clearTimeout(saveTimer);
    App.store.kvSet('stats', data)['catch'](function () { return null; });
  }

  function addListening(seconds: number): void {
    if (!seconds || seconds < 1) return;
    var key = dayKey(Date.now());
    data.days[key] = (data.days[key] || 0) + seconds;
    prune();
    save();
  }

  // sleptThrough: the sleep timer ran out on its own, rather than the story
  // being stopped by hand.
  function recordNight(sleptThrough: boolean): void {
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

  function prune(): void {
    var cutoff = dayKey(Date.now() - 30 * 86400000);
    for (var key in data.days) {
      if (Object.prototype.hasOwnProperty.call(data.days, key) && key < cutoff) delete data.days[key];
    }
    data.nights = data.nights.filter(function (n) { return n.d >= cutoff; }).slice(-30);
  }

  function week(): WeekSummary {
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
  function storiesTonight(stories: Story[]): number {
    var key = dayKey(Date.now());
    var count = 0;
    for (var i = 0; i < stories.length; i++) {
      // Cast is safe: just checked truthy on the left of the `&&`.
      if (stories[i].lastPlayedAt && dayKey(stories[i].lastPlayedAt as number) === key) count++;
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
