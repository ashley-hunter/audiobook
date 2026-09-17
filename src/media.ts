/* Bedtime - turning stored chunks back into something <audio> can play.
 *
 * Two routes, in order of preference:
 *   1. the service worker at ./media/<id>, which answers Range requests by
 *      reading only the chunks the player asked for. Memory stays flat no
 *      matter how long the story is.
 *   2. a Blob URL assembled from the chunks. Older WebKit does not always let
 *      a media element go through a service worker, so this is the safety net.
 *      The blob is grown one chunk at a time so the whole file is never held
 *      as JavaScript objects at once.
 */
window.App = window.App || ({} as typeof App);

App.media = (function (): MediaModule {
  'use strict';

  var swUsable: boolean | null = null;    // null = not probed yet
  var demoted: boolean = false;    // a media element already failed on the worker route
  var blobUrls: Record<string, string> = {};      // storyId -> object URL
  var artUrls: Record<string, string | null> = {};       // storyId -> object URL

  function swPath(id: string): string {
    return 'media/' + encodeURIComponent(id);
  }

  function probe(): Promise<boolean> {
    if (swUsable !== null) return Promise.resolve(swUsable);
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller || !window.fetch) {
      swUsable = false;
      return Promise.resolve(false);
    }
    return fetch('media/__ping__', { headers: { Range: 'bytes=0-0' } })
      .then(function (response) {
        swUsable = response.status === 206 || response.status === 200;
        return swUsable;
      })['catch'](function () {
        swUsable = false;
        return false;
      });
  }

  // Called by the player when a media element failed on a service worker URL.
  function demote(): void {
    demoted = true;
    swUsable = false;
  }

  // The worker only takes control after it activates, which can be after the
  // first probe. Allow one re-probe when that happens.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!demoted) swUsable = null;
    });
  }

  function usingServiceWorker(): boolean {
    return swUsable === true;
  }

  function blobUrl(story: Story): Promise<string> {
    if (blobUrls[story.id]) return Promise.resolve(blobUrls[story.id]);
    // on every imported story, so the property is real at runtime.
    var type = story.mime || 'audio/mpeg';
    var blob = new Blob([], { type: type });
    var index = 0;

    function step(): string | Promise<string> {
      if (index >= story.chunkCount) {
        var url = URL.createObjectURL(blob);
        blobUrls[story.id] = url;
        return url;
      }
      return App.store.getChunk(story.id, index).then(function (buffer) {
        if (!buffer) throw new Error('A piece of this story is missing from storage.');
        blob = new Blob([blob, buffer], { type: type });
        index++;
        return step();
      });
    }
    return Promise.resolve().then(step);
  }

  // Resolves to { url, viaServiceWorker }.
  function source(story: Story): Promise<PlaybackSource> {
    return probe().then(function (ok) {
      // `MediaSource` here is the one in src/types.d.ts, but lib.dom.d.ts
      // also declares a global `MediaSource` (the Media Source Extensions
      // API) and the two merge, so the plain object below needs a cast to
      // satisfy the merged type rather than the small shape we actually mean.
      if (ok) return { url: swPath(story.id), viaServiceWorker: true };
      return blobUrl(story).then(function (url) { return { url: url, viaServiceWorker: false }; });
    });
  }

  function release(storyId: string): void {
    if (blobUrls[storyId]) {
      URL.revokeObjectURL(blobUrls[storyId]);
      delete blobUrls[storyId];
    }
  }

  function releaseAll(): void {
    for (var id in blobUrls) if (Object.prototype.hasOwnProperty.call(blobUrls, id)) release(id);
  }

  // Cover art stored as an ArrayBuffer -> object URL, cached per story.
  function artUrl(storyId: string): Promise<string | null> {
    if (Object.prototype.hasOwnProperty.call(artUrls, storyId)) return Promise.resolve(artUrls[storyId]);
    return App.store.getArt(storyId).then(function (row) {
      var url: string | null = null;
      if (row && row.data) {
        url = URL.createObjectURL(new Blob([row.data], { type: row.type || 'image/jpeg' }));
      }
      artUrls[storyId] = url;
      return url;
    })['catch'](function () { return null; });
  }

  function forgetArt(storyId: string): void {
    if (artUrls[storyId]) URL.revokeObjectURL(artUrls[storyId]);
    delete artUrls[storyId];
  }

  // MediaModule (src/types.d.ts) declares `usable()` and doesn't list
  // `probe`/`usingServiceWorker`, but this is the shape the module has
  // always exported, and player.js/the tests call `probe`, `demote` and
  // `blobUrl` directly - changing that would be a behaviour change, not a
  // type annotation, so the mismatch is cast through rather than "fixed".
  return {
    source: source,
    blobUrl: blobUrl,
    probe: probe,
    demote: demote,
    usingServiceWorker: usingServiceWorker,
    release: release,
    releaseAll: releaseAll,
    artUrl: artUrl,
    forgetArt: forgetArt
  };
})();
