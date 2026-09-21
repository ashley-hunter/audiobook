/* Bedtime - a diagnostics log that stays on the phone.
 *
 * The bugs that took longest to find were ones that raised no error at all: a
 * story silent while every sign said it was playing. The phone knew what had
 * happened and nobody else did. So what the player and the app do is written
 * here - playback, stalls, the route the audio took, updates, storage checks,
 * and anything thrown that nothing caught - and shown at the bottom of parent
 * controls, where it can be copied and sent.
 *
 * It keeps the last few hundred entries, in IndexedDB beside the settings, so
 * it survives iOS killing the app, which is exactly when it is wanted. Nothing
 * in it ever leaves the phone unless a grown-up copies it out.
 *
 * Loaded before every other script of the app's own, so an error in any of
 * them is caught.
 */
window.App = window.App || ({} as typeof App);

App.log = (function (): LogModule {
  'use strict';

  var MAX = 300;
  var KEY = 'log';
  var SAVE_AFTER_MS = 1000;       // a burst of stalls is one write, not twenty

  var entries: LogEntry[] = [];
  var saveTimer: ReturnType<typeof setTimeout> | undefined;
  var listeners: Array<() => void> = [];

  function add(kind: string, message: string): void {
    entries.push({ t: Date.now(), k: kind, m: String(message).slice(0, 300) });
    if (entries.length > MAX) entries.splice(0, entries.length - MAX);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_AFTER_MS);
    for (var i = 0; i < listeners.length; i++) listeners[i]();
  }

  /* What was saved last time goes in front of anything logged since the page
   * loaded, which can be a little: errors are caught from the first script. */
  function load(): Promise<void> {
    return App.store.kvGet<LogEntry[]>(KEY, []).then(function (saved) {
      var earlier = Array.isArray(saved) ? saved : [];
      entries = earlier.concat(entries).slice(-MAX);
    })['catch'](function () { return undefined; });
  }

  function flush(): void {
    clearTimeout(saveTimer);
    App.store.kvSet(KEY, entries)['catch'](function () { return null; });
  }

  function clear(): void {
    entries = [];
    flush();
    for (var i = 0; i < listeners.length; i++) listeners[i]();
  }

  function list(): LogEntry[] {
    return entries.slice();
  }

  function pad(n: number): string {
    return n < 10 ? '0' + n : String(n);
  }

  function stamp(t: number): string {
    var d = new Date(t);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // Oldest first, one entry to a line: what gets pasted into a message.
  function text(): string {
    return entries.map(function (e) {
      return stamp(e.t) + '  ' + e.k + '  ' + e.m;
    }).join('\n');
  }

  function onChange(fn: () => void): void {
    listeners.push(fn);
  }

  /* Anything thrown that nothing caught. A resource that fails to load also
   * raises `error`, but not on the window, so only script errors land here. */
  window.addEventListener('error', function (event: ErrorEvent) {
    var where = event.filename ? ' at ' + event.filename.split('/').pop() + ':' + event.lineno : '';
    add('error', (event.message || 'Unknown error') + where);
  });
  window.addEventListener('unhandledrejection', function (event: PromiseRejectionEvent) {
    var reason = event.reason;
    add('error', 'Unhandled: ' + (reason && reason.message ? reason.message : String(reason)));
  });

  return {
    add: add,
    load: load,
    flush: flush,
    clear: clear,
    list: list,
    text: text,
    stamp: stamp,
    onChange: onChange
  };
})();
