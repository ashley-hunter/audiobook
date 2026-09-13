#!/usr/bin/env node
/* Unit tests for the cover art lookup (assets/js/artwork.js).
 *
 * The network is faked, which is the point: what matters is the query built
 * from a messy filename, the refusal to accept a result that does not look
 * like the story, and that every failure path ends in null rather than an
 * exception that would surface during an import.
 *
 *   node test/artwork.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)})`}`);
}

/* ------------------------------------------------------------------ harness */

function load(fetchImpl, online) {
  const sandbox = {
    fetch: fetchImpl,
    navigator: { onLine: online !== false },
    Promise,
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'artwork.js'), 'utf8'), sandbox);
  return sandbox.App.artwork;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function jsonResponse(body) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
    headers: { get: () => 'application/json' },
  });
}

function imageResponse(bytes, type) {
  const buf = bytes || PNG;
  return Promise.resolve({
    ok: true,
    headers: { get: () => type || 'image/jpeg' },
    arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)),
  });
}

const itunesHit = (name) => ({
  resultCount: 1,
  results: [{ collectionName: name, artworkUrl100: 'https://is1.mzstatic.com/image/thumb/x/100x100bb.jpg' }],
});

/* -------------------------------------------------------------------- runs */

(async () => {
  /* ------------------------------------------------------------ cleaning */
  const pure = load(() => Promise.reject(new Error('no network')));

  check('clean: strips extension and underscores', pure.clean('the_gruffalo.mp3'), 'the gruffalo');
  check('clean: strips a leading track number', pure.clean('03 - Whalesong'), 'Whalesong');
  check('clean: strips bracketed noise', pure.clean('Whalesong (Unabridged)'), 'Whalesong');
  check('clean: strips part markers', pure.clean('Seven Sleepy Foxes Part 2'), 'Seven Sleepy Foxes');
  check('clean: strips "3 of 12"', pure.clean('Mira and the Paper Boat 3 of 12'), 'Mira and the Paper Boat');
  check('clean: leaves a clean title alone', pure.clean('The Lighthouse Cat'), 'The Lighthouse Cat');

  /* ------------------------------------------------------------- matching */
  check('match: identical', pure.match('The Gruffalo', 'The Gruffalo'), 1);
  check('match: result may carry extra words',
    pure.match('The Gruffalo', 'The Gruffalo: 25th Anniversary Edition'), 1);
  check('match: a missing half does not count',
    pure.match('Seven Sleepy Foxes', 'Seven Samurai') < 0.6, true);
  check('match: unrelated', pure.match('Whalesong', 'Reign in Blood'), 0);

  check('upscale: asks for the large artwork',
    pure.upscale('https://is1.mzstatic.com/image/thumb/x/100x100bb.jpg'),
    'https://is1.mzstatic.com/image/thumb/x/600x600bb.jpg');

  /* ------------------------------------------------------------- finding */
  const calls = [];
  const happy = load((url) => {
    calls.push(url);
    if (url.indexOf('itunes.apple.com') >= 0) return jsonResponse(itunesHit('The Lighthouse Cat'));
    return imageResponse(PNG, 'image/png');
  });
  const found = (await happy.find('03_the-lighthouse-cat (unabridged).mp3', 'Ida')).image;
  check('a matching result yields artwork', !!found && found.source, 'itunes');
  check('the bytes are fetched, not linked', found && found.data.byteLength, PNG.length);
  check('the content type is kept', found && found.type, 'image/png');
  check('the query is built from the cleaned title',
    calls[0].indexOf(encodeURIComponent('the lighthouse cat Ida')) >= 0, true);
  check('the large artwork is requested', calls[1].indexOf('600x600bb') >= 0, true);

  // A wrong cover is worse than none, so a poor match must fall through.
  const wrong = load((url) => {
    if (url.indexOf('itunes.apple.com') >= 0) return jsonResponse(itunesHit('Reign in Blood'));
    if (url.indexOf('openlibrary.org/search.json') >= 0) return jsonResponse({ docs: [{ title: 'Something Else', cover_i: 7 }] });
    return imageResponse();
  });
  check('a result that does not look like the story is refused',
    (await wrong.find('Whalesong')).image, null);
  check('and that counts as searched, so it is not retried forever',
    (await wrong.find('Whalesong')).searched, true);

  // iTunes has no audiobook for most home recordings; Open Library might.
  const secondSource = load((url) => {
    if (url.indexOf('itunes.apple.com') >= 0) return jsonResponse({ results: [] });
    // covers.openlibrary.org also contains "openlibrary.org", so match the
    // search endpoint specifically or the image fetch gets handed JSON.
    if (url.indexOf('openlibrary.org/search.json') >= 0) {
      return jsonResponse({ docs: [{ title: 'The Gruffalo', cover_i: 42 }] });
    }
    return imageResponse();
  });
  const second = (await secondSource.find('The Gruffalo')).image;
  check('Open Library is tried when iTunes has nothing', second && second.source, 'openlibrary');

  /* --------------------------------------------------- every failure is null */
  /* A source that never answered must not be recorded as a miss, or a story
   * imported with no signal would be written off as having no cover for good. */
  const blocked = await load(() => Promise.reject(new Error('CORS'))).find('The Gruffalo');
  check('a rejected search yields no cover', blocked.image, null);
  check('and is not counted as searched', blocked.searched, false);

  check('a non-ok response yields no cover',
    (await load(() => Promise.resolve({ ok: false, headers: { get: () => '' } })).find('The Gruffalo')).image, null);

  check('malformed JSON yields no cover',
    (await load(() => Promise.resolve({ ok: true, headers: { get: () => '' }, json: () => Promise.reject(new Error('bad')) }))
      .find('The Gruffalo')).image, null);

  const notAnImage = load((url) => {
    if (url.indexOf('itunes.apple.com') >= 0) return jsonResponse(itunesHit('The Gruffalo'));
    return Promise.resolve({ ok: true, headers: { get: () => 'text/html' }, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
  });
  check('an HTML error page is not treated as a cover', (await notAnImage.find('The Gruffalo')).image, null);

  const huge = load((url) => {
    if (url.indexOf('itunes.apple.com') >= 0) return jsonResponse(itunesHit('The Gruffalo'));
    return imageResponse(Buffer.alloc(4 * 1024 * 1024), 'image/jpeg');
  });
  check('an oversized image is refused', (await huge.find('The Gruffalo')).image, null);

  let touched = false;
  const offline = load(() => { touched = true; return imageResponse(); }, false);
  const whileOffline = await offline.find('The Gruffalo');
  check('offline yields no cover', whileOffline.image, null);
  check('and really did not call fetch', touched, false);
  check('and is not counted as searched, so it retries when back online',
    whileOffline.searched, false);

  const hopeless = await happy.find('01 - 02 - 03.mp3');
  check('a title with nothing usable in it is skipped', hopeless.image, null);
  check('and is not retried, because no title will ever appear',
    hopeless.searched, true);

  console.log(failures ? `\n${failures} failing` : '\nAll artwork tests passed.');
  process.exit(failures ? 1 : 0);
})();
