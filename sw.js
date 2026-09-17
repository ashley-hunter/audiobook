/* Bedtime - service worker.
 *
 * Two jobs:
 *   1. cache the app shell so the player opens with no signal;
 *   2. serve ./media/<storyId> out of IndexedDB with Range support, so a long
 *      audiobook streams a few megabytes at a time instead of being held in
 *      memory as one enormous Blob.
 *
 * Written for the Safari 12 service worker implementation: no optional
 * chaining, no async/await in the fetch path beyond plain promises.
 */
'use strict';

/* Stamped by scripts/build-site.js with a hash of everything that ships, so
 * each deploy produces a different service worker. Without that the browser
 * sees identical bytes, never installs a new worker, never runs activate, and
 * the cache below keeps serving the previous release. Left as 'dev' when the
 * repo is served straight from disk. */
var BUILD = 'dev';

var VERSION = 'bedtime-' + BUILD;
var MEDIA_PREFIX = 'media/';
var MAX_WINDOW = 4 * 1024 * 1024; // largest slice answered in one response

var SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/css/app.css',
  'assets/js/capabilities.js',
  'assets/js/store.js',
  'assets/js/settings.js',
  'assets/js/id3.js',
  'assets/js/artwork.js',
  'assets/js/media.js',
  'assets/js/importer.js',
  'assets/js/player.js',
  'assets/js/ui.js',
  'assets/js/lists.js',
  'assets/vendor/preact.umd.js',
  'assets/vendor/htm.umd.js',
  'assets/js/app.js',
  'assets/fonts/baloo2-latin.woff2',
  'assets/fonts/baloo2-latin-ext.woff2',
  'assets/fonts/karla-latin.woff2',
  'assets/fonts/karla-latin-ext.woff2',
  'assets/icons/icon-120.png',
  'assets/icons/icon-152.png',
  'assets/icons/icon-167.png',
  'assets/icons/icon-180.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  /* addAll is all or nothing, and that is the point. Swallowing a failed entry
   * would let a half cached shell install and take over, and activate would
   * then delete the previous complete cache - leaving the app broken offline
   * with nothing to fall back on. A failed install keeps the old worker and
   * the old cache, which still work. Every SHELL path is verified to exist by
   * scripts/build-site.js, so a failure here means the network, not a typo.
   */
  event.waitUntil(
    caches.open(VERSION)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return key === VERSION ? null : caches['delete'](key);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  var scope = new URL('./', self.location.href).pathname;
  var path = url.pathname.indexOf(scope) === 0 ? url.pathname.slice(scope.length) : url.pathname;

  if (path.indexOf(MEDIA_PREFIX) === 0) {
    event.respondWith(serveMedia(decodeURIComponent(path.slice(MEDIA_PREFIX.length)), request));
    return;
  }

  event.respondWith(
    caches.match(request).then(function (hit) {
      /* A hit is served as it is, and nothing refreshes it in place.
       *
       * This used to fetch each file again in the background and write the
       * answer into this release's cache. On a phone that had not restarted
       * since a deploy, that quietly mixed two releases in one cache - a new
       * script beside the old HTML that was written for it - which shows up as
       * an app that is half updated and impossible to reason about. A release
       * now only changes when a new worker installs a whole new cache and
       * activate throws the old one away.
       */
      if (hit) return hit;
      // A miss that succeeds from the network is worth keeping, so a shell
      // file that somehow escaped the install is repaired rather than fetched
      // every time and missing the next time there is no signal.
      return fetch(request).then(function (response) {
        if (response && response.ok && isShell(path)) {
          var copy = response.clone();
          caches.open(VERSION).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      })['catch'](function () {
        return caches.match('index.html').then(function (fallback) {
          return fallback || new Response('Offline', { status: 503 });
        });
      });
    })
  );
});

function isShell(path) {
  return SHELL.indexOf(path) >= 0 || path === '' || path === 'index.html';
}

/* ------------------------------------------------------------ media route */

function serveMedia(storyId, request) {
  if (storyId === '__ping__') {
    // Lets the page find out whether this route works at all.
    return Promise.resolve(new Response(new Uint8Array(1), {
      status: 206,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': 'bytes 0-0/1',
        'Accept-Ranges': 'bytes'
      }
    }));
  }

  return getStory(storyId).then(function (story) {
    if (!story) return new Response('Unknown story', { status: 404 });

    var total = story.size;
    var mime = story.mime || 'audio/mpeg';
    var range = parseRange(request.headers.get('Range'), total);

    if (!range) {
      return wholeFile(story, mime, total);
    }
    if (range.start >= total) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': 'bytes */' + total }
      });
    }

    var end = Math.min(range.end, range.start + MAX_WINDOW - 1, total - 1);
    return readBytes(story, range.start, end).then(function (bytes) {
      return new Response(bytes, {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(bytes.byteLength),
          'Content-Range': 'bytes ' + range.start + '-' + end + '/' + total,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store'
        }
      });
    })['catch'](function () {
      return new Response('Story data missing', { status: 404 });
    });
  })['catch'](function () {
    return new Response('Storage unavailable', { status: 500 });
  });
}

function wholeFile(story, mime, total) {
  var headers = {
    'Content-Type': mime,
    'Content-Length': String(total),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  };

  if (typeof ReadableStream === 'function') {
    var index = 0;
    var stream = new ReadableStream({
      pull: function (controller) {
        if (index >= story.chunkCount) {
          controller.close();
          return undefined;
        }
        return getChunk(story.id, index++).then(function (buffer) {
          if (!buffer) {
            controller.error(new Error('missing chunk'));
            return;
          }
          controller.enqueue(new Uint8Array(buffer));
        });
      }
    });
    try {
      return new Response(stream, { status: 200, headers: headers });
    } catch (err) {
      void err; // Safari 12 cannot always build a Response from a stream.
    }
  }

  /* No stream, so the whole file cannot be answered without holding all of it
   * in memory at once - which for an audiobook is the very thing this route
   * exists to avoid, and on a phone with a gigabyte is how the app gets killed.
   * The first window is answered as a partial instead: a media element that
   * asked without a Range header still gets something to start on, sees
   * Accept-Ranges, and asks for the rest a window at a time.
   */
  var end = Math.min(MAX_WINDOW - 1, total - 1);
  return readBytes(story, 0, end).then(function (bytes) {
    return new Response(bytes, {
      status: 206,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(bytes.byteLength),
        'Content-Range': 'bytes 0-' + end + '/' + total,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      }
    });
  });
}

function parseRange(header, total) {
  if (!header) return null;
  var match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  var start;
  var end;
  if (match[1] === '') {
    // suffix form: the last N bytes
    var suffix = parseInt(match[2], 10);
    if (isNaN(suffix)) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = parseInt(match[1], 10);
    end = match[2] === '' ? total - 1 : parseInt(match[2], 10);
  }
  if (isNaN(start) || isNaN(end)) return null;
  // Past the end of the file: hand it back so the caller can answer 416
  // rather than falling through to "no range asked for".
  if (start >= total) return { start: start, end: start };
  if (end < start) return null;
  return { start: start, end: Math.min(end, total - 1) };
}

// Reads the byte range out of the stored chunks, touching only the chunks it needs.
function readBytes(story, start, end) {
  var chunkSize = story.chunkSize;
  var first = Math.floor(start / chunkSize);
  var last = Math.floor(end / chunkSize);
  var out = new Uint8Array(end - start + 1);
  var written = 0;
  var index = first;

  function step() {
    if (index > last) return out;
    return getChunk(story.id, index).then(function (buffer) {
      if (!buffer) throw new Error('missing chunk ' + index);
      var chunkStart = index * chunkSize;
      var from = Math.max(0, start - chunkStart);
      var to = Math.min(buffer.byteLength, end - chunkStart + 1);
      out.set(new Uint8Array(buffer, from, to - from), written);
      written += to - from;
      index++;
      return step();
    });
  }
  return Promise.resolve().then(step);
}

/* -------------------------------------------------------- IndexedDB (worker) */

var dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function (resolve, reject) {
    var request = indexedDB.open('bedtime', 1);
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
    // The page owns the schema; the worker only ever reads.
    request.onupgradeneeded = function () { reject(new Error('database not ready')); };
  });
  dbPromise['catch'](function () { dbPromise = null; });
  return dbPromise;
}

function get(storeName, key) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, 'readonly');
      var request = tx.objectStore(storeName).get(key);
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  });
}

function getStory(id) {
  return get('stories', id);
}

function getChunk(storyId, index) {
  var n = String(index);
  while (n.length < 6) n = '0' + n;
  return get('chunks', storyId + '#' + n).then(function (row) {
    return row ? row.data : null;
  });
}
