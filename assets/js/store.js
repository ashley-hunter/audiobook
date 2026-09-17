/* Bedtime - IndexedDB layer.
 *
 * Everything the app owns lives here: story records, the audio itself (split
 * into fixed size ArrayBuffer chunks), cover art and settings.
 *
 * Safari 12 notes that shaped this file:
 *   - Blobs stored in IndexedDB were unreliable in that era, so audio and art
 *     are kept as ArrayBuffers with the mime type recorded alongside.
 *   - A transaction goes inactive as soon as control returns to the event loop
 *     via a non-IDB promise, so every helper opens its own short transaction
 *     instead of holding one open across awaits.
 */
window.App = window.App || {};

App.store = (function () {
  'use strict';

  var DB_NAME = 'bedtime';
  var DB_VERSION = 1;
  var CHUNK_SIZE = 1024 * 1024; // 1 MiB - small enough to never strain a 1 GB phone

  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error('This browser has no IndexedDB, so stories cannot be saved.'));
        return;
      }
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = function (event) {
        var db = req.result;
        if (!db.objectStoreNames.contains('stories')) db.createObjectStore('stories', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('art')) db.createObjectStore('art', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
        void event;
      };
      req.onsuccess = function () {
        var db = req.result;
        // A version change from another tab would otherwise wedge this one.
        db.onversionchange = function () { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { reject(req.error || new Error('IndexedDB refused to open')); };
      req.onblocked = function () { reject(new Error('IndexedDB is blocked by another copy of this app')); };
    });
    // A failed open should not poison every later call - iOS occasionally
    // refuses the very first open after a cold standalone launch.
    dbPromise['catch'](function () { dbPromise = null; });
    return dbPromise;
  }

  function tx(storeName, mode, run) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, mode);
        var out;
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('Transaction aborted')); };
        try {
          out = run(t.objectStore(storeName), function (value) { out = value; });
        } catch (err) {
          try { t.abort(); } catch (ignored) { void ignored; }
          reject(err);
        }
      });
    });
  }

  function reqValue(request, set) {
    request.onsuccess = function () { set(request.result); };
  }

  function chunkKey(storyId, index) {
    // Zero padded so a key range walks the chunks in playback order.
    var n = String(index);
    while (n.length < 6) n = '0' + n;
    return storyId + '#' + n;
  }

  /* ---------------------------------------------------------------- stories */

  function getStories() {
    return tx('stories', 'readonly', function (store, set) {
      if (store.getAll) {
        reqValue(store.getAll(), set);
        return;
      }
      var out = [];
      store.openCursor().onsuccess = function (event) {
        var cursor = event.target.result;
        if (cursor) { out.push(cursor.value); cursor['continue'](); } else { set(out); }
      };
    }).then(function (list) { return list || []; });
  }

  function getStory(id) {
    return tx('stories', 'readonly', function (store, set) { reqValue(store.get(id), set); });
  }

  function putStory(story) {
    return tx('stories', 'readwrite', function (store) { store.put(story); }).then(function () { return story; });
  }

  function patchStory(id, patch) {
    return tx('stories', 'readwrite', function (store, set) {
      store.get(id).onsuccess = function (event) {
        var story = event.target.result;
        if (!story) { set(null); return; }
        for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) story[k] = patch[k];
        store.put(story);
        set(story);
      };
    });
  }

  function deleteStory(id) {
    return deleteChunks(id)
      .then(function () { return tx('art', 'readwrite', function (store) { store['delete'](id); }); })
      .then(function () { return tx('stories', 'readwrite', function (store) { store['delete'](id); }); });
  }

  /* ----------------------------------------------------------------- chunks */

  function putChunk(storyId, index, buffer) {
    return tx('chunks', 'readwrite', function (store) {
      store.put({ key: chunkKey(storyId, index), data: buffer });
    });
  }

  function getChunk(storyId, index) {
    return tx('chunks', 'readonly', function (store, set) {
      store.get(chunkKey(storyId, index)).onsuccess = function (event) {
        var row = event.target.result;
        set(row ? row.data : null);
      };
    });
  }

  /* Whether a story's audio is still on disk, without reading it. The startup
   * audit asks this of every story, and getChunk would hand back a megabyte
   * each time only for it to be thrown away.
   */
  function hasChunk(storyId, index) {
    return tx('chunks', 'readonly', function (store, set) {
      store.count(chunkKey(storyId, index)).onsuccess = function (event) {
        set(event.target.result > 0);
      };
    });
  }

  // Reads chunks [from, to] inclusive in one transaction.
  function getChunks(storyId, from, to) {
    return tx('chunks', 'readonly', function (store, set) {
      var out = [];
      var range = IDBKeyRange.bound(chunkKey(storyId, from), chunkKey(storyId, to));
      store.openCursor(range).onsuccess = function (event) {
        var cursor = event.target.result;
        if (cursor) { out.push(cursor.value.data); cursor['continue'](); } else { set(out); }
      };
    });
  }

  /* Every story id that has chunks on disk. An import writes chunks before it
   * writes the story row, so anything killed part way through - iOS reclaiming
   * a backgrounded app, a crash, a reload - leaves chunks with no owner and no
   * way to reach them. Nothing else walks the store, so without this they sit
   * there taking up space for good.
   */
  function chunkOwners() {
    return tx('chunks', 'readonly', function (store, set) {
      var ids = {};
      var request = store.openKeyCursor ? store.openKeyCursor() : store.openCursor();
      request.onsuccess = function (event) {
        var cursor = event.target.result;
        if (!cursor) {
          var out = [];
          for (var id in ids) if (Object.prototype.hasOwnProperty.call(ids, id)) out.push(id);
          set(out);
          return;
        }
        var key = String(cursor.key);
        var hash = key.indexOf('#');
        if (hash > 0) ids[key.slice(0, hash)] = true;
        cursor['continue']();
      };
    }).then(function (list) { return list || []; });
  }

  function deleteChunks(storyId) {
    return tx('chunks', 'readwrite', function (store) {
      var range = IDBKeyRange.bound(storyId + '#', storyId + '#￿');
      store['delete'](range);
    });
  }

  /* -------------------------------------------------------------------- art */

  function putArt(id, buffer, type) {
    return tx('art', 'readwrite', function (store) { store.put({ id: id, data: buffer, type: type }); });
  }

  function getArt(id) {
    return tx('art', 'readonly', function (store, set) { reqValue(store.get(id), set); });
  }

  /* --------------------------------------------------------------- settings */

  function kvGet(key, fallback) {
    return tx('kv', 'readonly', function (store, set) {
      store.get(key).onsuccess = function (event) {
        var row = event.target.result;
        set(row ? row.v : fallback);
      };
    });
  }

  function kvSet(key, value) {
    return tx('kv', 'readwrite', function (store) { store.put({ k: key, v: value }); });
  }

  /* ------------------------------------------------------------------ usage */

  function usage() {
    return getStories().then(function (list) {
      var bytes = 0;
      for (var i = 0; i < list.length; i++) bytes += list[i].size || 0;
      return bytes;
    });
  }

  return {
    CHUNK_SIZE: CHUNK_SIZE,
    open: open,
    getStories: getStories,
    getStory: getStory,
    putStory: putStory,
    patchStory: patchStory,
    deleteStory: deleteStory,
    putChunk: putChunk,
    getChunk: getChunk,
    hasChunk: hasChunk,
    chunkOwners: chunkOwners,
    getChunks: getChunks,
    deleteChunks: deleteChunks,
    putArt: putArt,
    getArt: getArt,
    kvGet: kvGet,
    kvSet: kvSet,
    usage: usage
  };
})();
