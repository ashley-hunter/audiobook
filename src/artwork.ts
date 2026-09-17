/* Bedtime - finding cover art online.
 *
 * Embedded art from the file's own tags is always preferred and handled in
 * id3.js. This is the fallback for untagged files: it asks the iTunes Search
 * API, then Open Library, for a cover matching the story's title.
 *
 * Three rules shape the whole module:
 *
 *   1. It never blocks an import. The audio is already saved by the time this
 *      runs, and every failure path resolves rather than rejecting.
 *   2. A wrong cover is worse than no cover. A result has to actually look like
 *      the story before its artwork is taken, so "Whalesong" does not come back
 *      with a heavy metal album.
 *   3. The bytes are fetched and stored, not linked. A remote URL would leave
 *      the library looking broken on a phone with no signal, which is the one
 *      place this app is meant to work.
 *
 * Rule 3 needs the host to allow cross-origin reads. iTunes does, confirmed on
 * a real device. Open Library is only reached when iTunes has nothing, so that
 * leg is unproven; if it ever refuses, the fetch rejects, no cover is returned
 * and the generated striped cover stands - the same as being offline.
 */
window.App = window.App || ({} as typeof App);

App.artwork = (function (): ArtworkModule {
  'use strict';

  // The image a source hands back, before it is known to be a good match.
  // `source` and `matched` are filled in by the caller once a candidate is
  // confirmed, so they start absent rather than empty.
  type MatchedImage = { data: ArrayBuffer; type: string; source?: string; matched?: string };

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
  function clean(title: string): string {
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

  function words(text: string): string[] {
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
  function match(wanted: string, got: string): number {
    var a = words(wanted);
    var b = words(got);
    if (!a.length || !b.length) return 0;
    var index: { [word: string]: boolean } = {};
    for (var i = 0; i < b.length; i++) index[b[i]] = true;
    var hits = 0;
    for (var j = 0; j < a.length; j++) if (index[a[j]]) hits++;
    return hits / a.length;
  }

  // iTunes hands back a 100px thumbnail; the same path serves any size.
  function upscale(url: string): string {
    return String(url || '').replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/600x600bb.jpg');
  }

  /* ------------------------------------------------------------ fetching */

  function timed<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>(function (resolve, reject) {
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

  // The JSON coming back from either search host is untrusted and unshaped;
  // callers pick fields out of it and re-check every one before trusting it.
  function getJson(url: string): Promise<any> {
    return timed(fetch(url)).then(function (response) {
      if (!response || !response.ok) throw new Error('bad response');
      return response.json();
    });
  }

  function getImage(url: string): Promise<MatchedImage> {
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

  function fromItunes(title: string, artist?: string): Promise<FoundArtwork> {
    var term = artist && artist !== 'you' ? title + ' ' + artist : title;
    var url = ITUNES + '?media=audiobook&entity=audiobook&limit=8&term=' + encodeURIComponent(term);

    return getJson(url).then(function (body) {
      var results = (body && body.results) || [];
      var best: any = null;
      var bestScore = 0;
      for (var i = 0; i < results.length; i++) {
        var name = results[i].collectionName || results[i].trackName || '';
        var score = match(title, name);
        if (score > bestScore) {
          bestScore = score;
          best = results[i];
        }
      }
      if (!best || bestScore < MIN_MATCH || !best.artworkUrl100) return searched(null);
      return getImage(upscale(best.artworkUrl100)).then(function (image) {
        image.source = 'itunes';
        image.matched = best.collectionName || best.trackName;
        return searched(image);
      }, function () { return searched(null); });
    }, unreachable);
  }

  function fromOpenLibrary(title: string): Promise<FoundArtwork> {
    var url = OPENLIB + '?limit=8&fields=title,cover_i&q=' + encodeURIComponent(title);

    return getJson(url).then(function (body) {
      var docs = (body && body.docs) || [];
      var best: any = null;
      var bestScore = 0;
      for (var i = 0; i < docs.length; i++) {
        if (!docs[i].cover_i) continue;
        var score = match(title, docs[i].title || '');
        if (score > bestScore) {
          bestScore = score;
          best = docs[i];
        }
      }
      if (!best || bestScore < MIN_MATCH) return searched(null);
      return getImage(COVERS + best.cover_i + '-L.jpg').then(function (image) {
        image.source = 'openlibrary';
        image.matched = best.title;
        return searched(image);
      }, function () { return searched(null); });
    }, unreachable);
  }

  /* -------------------------------------------------------------- public */

  /* "Nothing found" and "could not look" need telling apart. A story imported
   * on a phone with no signal must not be written off as having no cover: the
   * caller records a miss so it is not retried forever, and that is only right
   * once a source has actually answered.
   */
  function searched(image: MatchedImage | null): FoundArtwork { return { image: image, searched: true }; }
  function unreachable(): FoundArtwork { return { image: null, searched: false }; }

  /* Resolves { image, searched }, where image is { data, type, source, matched }
   * or null. Never rejects: a missing cover is not worth interrupting anything.
   */
  function find(title: string, artist?: string): Promise<FoundArtwork | null> {
    if (typeof fetch !== 'function') return Promise.resolve(unreachable());
    if (navigator.onLine === false) return Promise.resolve(unreachable());

    var cleaned = clean(title);
    // No amount of retrying will make a title of track numbers searchable.
    if (words(cleaned).length === 0) return Promise.resolve(searched(null));

    return fromItunes(cleaned, artist)['catch'](unreachable).then(function (first) {
      if (first.image) return first;
      return fromOpenLibrary(cleaned)['catch'](unreachable).then(function (second) {
        return {
          image: second.image,
          searched: first.searched || second.searched
        };
      });
    })['catch'](unreachable);
  }

  /* Covers are drawn at 136px at the very largest, and publishers embed art
   * several thousand pixels square. Storing that is bytes the phone does not
   * have and, worse, a full decode of a multi-megapixel image every time a
   * cover is painted. Anything larger than this is redrawn at this size before
   * it is stored; anything smaller is kept as it is.
   */
  var MAX_DIM = 400;

  function shrink(data: ArrayBuffer, type: string): Promise<{ data: ArrayBuffer; type: string } | null> {
    return new Promise(function (resolve) {
      if (!data || !data.byteLength || typeof document === 'undefined') return resolve(null);

      var url = URL.createObjectURL(new Blob([data], { type: type || 'image/jpeg' }));
      var image = new Image();
      var settled = false;

      function finish(value: { data: ArrayBuffer; type: string } | null): void {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        resolve(value);
      }

      image.onerror = function () { finish(null); };
      image.onload = function () {
        var scale = Math.min(1, MAX_DIM / Math.max(image.width, image.height));
        if (scale >= 1) return finish(null);        // already small enough

        var canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        try {
          // getContext('2d') can return null; when it does, this throws and
          // the catch below runs finish(null), exactly as it would without
          // the cast - the cast only names what the try/catch already handles.
          (canvas.getContext('2d') as CanvasRenderingContext2D).drawImage(image, 0, 0, canvas.width, canvas.height);
        } catch (err) {
          void err;
          return finish(null);
        }
        if (!canvas.toBlob) return finish(null);
        canvas.toBlob(function (blob) {
          if (!blob) return finish(null);
          App.caps.readArrayBuffer(blob).then(function (buffer) {
            finish({ data: buffer, type: 'image/jpeg' });
          })['catch'](function () { finish(null); });
        }, 'image/jpeg', 0.82);
      };

      image.src = url;
      // A picture that never decodes must not hold an import up.
      setTimeout(function () { finish(null); }, 5000);
    });
  }

  // Stores a cover, shrunk where that is worth doing. Failure to shrink is not
  // failure to store: the original goes in instead.
  function store(storyId: string, data: ArrayBuffer, type: string): Promise<void> {
    return shrink(data, type)['catch'](function () { return null; })
      .then(function (smaller) {
        var use = smaller || { data: data, type: type };
        return App.store.putArt(storyId, use.data, use.type);
      });
  }

  return {
    find: find,
    shrink: shrink,
    store: store,
    // exercised directly by test/artwork.test.js
    clean: clean,
    // ArtworkModule declares this as returning boolean, but the real
    // function (proven by test/artwork.test.js, which checks the exact
    // fraction) returns the share of words matched, a number - cast at this
    match: match,
    upscale: upscale
  };
})();
