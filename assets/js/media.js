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
window.App = window.App || {};

App.media = (function () {
  'use strict';

  var swUsable = null;    // null = not probed yet
  var demoted = false;    // a media element already failed on the worker route
  var blobUrls = {};      // storyId -> object URL
  var artUrls = {};       // storyId -> object URL

  function swPath(id) {
    return 'media/' + encodeURIComponent(id);
  }

  function probe() {
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
  function demote() {
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

  function usingServiceWorker() {
    return swUsable === true;
  }

  function blobUrl(story) {
    if (blobUrls[story.id]) return Promise.resolve(blobUrls[story.id]);
    var type = story.mime || 'audio/mpeg';
    var blob = new Blob([], { type: type });
    var index = 0;

    function step() {
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
  function source(story) {
    return probe().then(function (ok) {
      if (ok) return { url: swPath(story.id), viaServiceWorker: true };
      return blobUrl(story).then(function (url) { return { url: url, viaServiceWorker: false }; });
    });
  }

  function release(storyId) {
    if (blobUrls[storyId]) {
      URL.revokeObjectURL(blobUrls[storyId]);
      delete blobUrls[storyId];
    }
  }

  function releaseAll() {
    for (var id in blobUrls) if (Object.prototype.hasOwnProperty.call(blobUrls, id)) release(id);
  }

  // Cover art stored as an ArrayBuffer -> object URL, cached per story.
  function artUrl(storyId) {
    if (Object.prototype.hasOwnProperty.call(artUrls, storyId)) return Promise.resolve(artUrls[storyId]);
    return App.store.getArt(storyId).then(function (row) {
      var url = null;
      if (row && row.data) {
        url = URL.createObjectURL(new Blob([row.data], { type: row.type || 'image/jpeg' }));
      }
      artUrls[storyId] = url;
      return url;
    })['catch'](function () { return null; });
  }

  function forgetArt(storyId) {
    if (artUrls[storyId]) URL.revokeObjectURL(artUrls[storyId]);
    delete artUrls[storyId];
  }

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
