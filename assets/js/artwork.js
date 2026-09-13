/* Bedtime - finding cover art online.
 *
 * Embedded art from the file's own tags is always preferred and handled in
 * id3.js. This is the fallback for untagged files: it asks the iTunes Search
 * API, then Open Library, for a cover matching the story's title.
 *
 * Three rules shape the whole module:
 *
 *   1. It never blocks an import. The audio is already saved by the time this
 *      runs, and every failure path resolves to null rather than rejecting.
 *   2. A wrong cover is worse than no cover. A result has to actually look like
 *      the story before its artwork is taken, so "Whalesong" does not come back
 *      with a heavy metal album.
 *   3. The bytes are fetched and stored, not linked. A remote URL would leave
 *      the library looking broken on a phone with no signal, which is the one
 *      place this app is meant to work.
 *
 * Both hosts have to allow cross-origin reads for rule 3 to hold. If either
 * refuses, the fetch rejects, this returns null and the generated striped cover
 * stands - the same as being offline.
 */
window.App = window.App || {};

App.artwork = (function () {
  'use strict';

  var ITUNES = 'https://itunes.apple.com/search';
  var OPENLIB = 'https://openlibrary.org/search.json';
  var COVERS = 'https://covers.openlibrary.org/b/id/';

  var TIMEOUT = 8000;
  var MAX_BYTES = 3 * 1024 * 1024;
  var MIN_MATCH = 0.6;          // share of the title's words a result must carry

  /* ------------------------------------------------------------- cleaning */

  var NOISE = /\b(unabridged|abridged|audio ?books?|full cast|dramati[sz]ed|read by|narrated by)\b/gi;
  var PARTS = /\b(part|chapter|disc|cd|track|vol|volume)\s*\.?\s*\d+\b/gi;
  var OF_N = /\b\d{1,3}\s*of\s*\d{1,3}\b/gi;

  // Turns "03_the-gruffalo_part2 (unabridged).mp3" into "the gruffalo".
  function clean(title) {
    return String(title || '')
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/[_]+/g, ' ')
      .replace(/[\[(][^\])]*[\])]/g, ' ')
      .replace(NOISE, ' ')
      .replace(PARTS, ' ')
      .replace(OF_N, ' ')
      .replace(/^\s*\d{1,3}\s*[-.)]\s*/, '')
      .replace(/[-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function words(text) {
    var out = String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return out ? out.split(' ') : [];
  }

  /* How much of `wanted` appears in `got`. Deliberately one-directional: a
   * result may carry extra words ("The Gruffalo: 25th Anniversary Edition")
   * and still be right, but one that is missing half the title is not.
   */
  function match(wanted, got) {
    var a = words(wanted);
    var b = words(got);
    if (!a.length || !b.length) return 0;
    var index = {};
    for (var i = 0; i < b.length; i++) index[b[i]] = true;
    var hits = 0;
    for (var j = 0; j < a.length; j++) if (index[a[j]]) hits++;
    return hits / a.length;
  }

  // iTunes hands back a 100px thumbnail; the same path serves any size.
  function upscale(url) {
    return String(url || '').replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/600x600bb.jpg');
  }

  /* ------------------------------------------------------------ fetching */

  function timed(promise) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('timed out'));
      }, TIMEOUT);
      promise.then(function (value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      }, function (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function getJson(url) {
    return timed(fetch(url)).then(function (response) {
      if (!response || !response.ok) throw new Error('bad response');
      return response.json();
    });
  }

  function getImage(url) {
    return timed(fetch(url)).then(function (response) {
      if (!response || !response.ok) throw new Error('bad response');
      var type = response.headers.get('content-type') || 'image/jpeg';
      if (type.indexOf('image/') !== 0) throw new Error('not an image');
      return response.arrayBuffer().then(function (data) {   // caps-ok: a Response, not a Blob
        if (!data || !data.byteLength || data.byteLength > MAX_BYTES) throw new Error('unusable image');
        return { data: data, type: type };
      });
    });
  }

  /* ------------------------------------------------------------- sources */

  function fromItunes(title, artist) {
    var term = artist && artist !== 'you' ? title + ' ' + artist : title;
    var url = ITUNES + '?media=audiobook&entity=audiobook&limit=8&term=' + encodeURIComponent(term);

    return getJson(url).then(function (body) {
      var results = (body && body.results) || [];
      var best = null;
      var bestScore = 0;
      for (var i = 0; i < results.length; i++) {
        var name = results[i].collectionName || results[i].trackName || '';
        var score = match(title, name);
        if (score > bestScore) {
          bestScore = score;
          best = results[i];
        }
      }
      if (!best || bestScore < MIN_MATCH || !best.artworkUrl100) return null;
      return getImage(upscale(best.artworkUrl100)).then(function (image) {
        image.source = 'itunes';
        image.matched = best.collectionName || best.trackName;
        return image;
      });
    });
  }

  function fromOpenLibrary(title) {
    var url = OPENLIB + '?limit=8&fields=title,cover_i&q=' + encodeURIComponent(title);

    return getJson(url).then(function (body) {
      var docs = (body && body.docs) || [];
      var best = null;
      var bestScore = 0;
      for (var i = 0; i < docs.length; i++) {
        if (!docs[i].cover_i) continue;
        var score = match(title, docs[i].title || '');
        if (score > bestScore) {
          bestScore = score;
          best = docs[i];
        }
      }
      if (!best || bestScore < MIN_MATCH) return null;
      return getImage(COVERS + best.cover_i + '-L.jpg').then(function (image) {
        image.source = 'openlibrary';
        image.matched = best.title;
        return image;
      });
    });
  }

  /* -------------------------------------------------------------- public */

  /* Resolves { data, type, source, matched } or null. Never rejects: a missing
   * cover is not a failure worth interrupting anything for.
   */
  function find(title, artist) {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    if (navigator.onLine === false) return Promise.resolve(null);

    var cleaned = clean(title);
    if (words(cleaned).length === 0) return Promise.resolve(null);

    return fromItunes(cleaned, artist)
      ['catch'](function () { return null; })
      .then(function (found) {
        if (found) return found;
        return fromOpenLibrary(cleaned)['catch'](function () { return null; });
      })
      ['catch'](function () { return null; });
  }

  return {
    find: find,
    // exercised directly by test/artwork.test.js
    clean: clean,
    match: match,
    upscale: upscale
  };
})();
