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
window.App = window.App || ({} as typeof App);

App.store = (function (): StoreModule {
  'use strict';

  var DB_NAME = 'bedtime';
  var DB_VERSION = 1;
  var CHUNK_SIZE = 1024 * 1024; // 1 MiB - small enough to never strain a 1 GB phone

  var dbPromise: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error('This browser has no IndexedDB, so stories cannot be saved.'));
        return;
      }
      var req: IDBOpenDBRequest;
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

  function tx<T>(
    storeName: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore, set: (value: T) => void) => void
  ): Promise<T> {
    return open().then(function (db) {
      return new Promise<T>(function (resolve, reject) {
        var t = db.transaction(storeName, mode);
        // Definitely assigned before `oncomplete` fires: `set` below is called
        // either synchronously inside `run` or from a request's `onsuccess`,
        // and either way that happens before the transaction can complete.
        var out!: T;
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('Transaction aborted')); };
        try {
          // `run` never actually returns a value - every caller reports
          // through `set` instead - so this assignment is always a no-op;
          // the cast just keeps that no-op typed rather than reaching for `any`.
          out = run(t.objectStore(storeName), function (value) { out = value; }) as unknown as T;
        } catch (err) {
          try { t.abort(); } catch (ignored) { void ignored; }
          reject(err);
        }
      });
    });
  }

  function reqValue<T>(request: IDBRequest<T>, set: (value: T) => void): void {
    request.onsuccess = function () { set(request.result); };
  }

  function chunkKey(storyId: string, index: number): string {
    // Zero padded so a key range walks the chunks in playback order.
    var n = String(index);
    while (n.length < 6) n = '0' + n;
    return storyId + '#' + n;
  }

  /* ---------------------------------------------------------------- stories */

  function getStories(): Promise<Story[]> {
    return tx<Story[]>('stories', 'readonly', function (store, set) {
      if (store.getAll) {
        reqValue(store.getAll(), set);
        return;
      }
      var out: Story[] = [];
      store.openCursor().onsuccess = function (event) {
        // Cast because `event.target` is typed as a plain EventTarget: at
        // runtime it is always the request whose `onsuccess` this is.
        var cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (cursor) { out.push(cursor.value); cursor['continue'](); } else { set(out); }
      };
    }).then(function (list) { return list || []; });
  }

  function getStory(id: string): Promise<Story | undefined> {
    return tx<Story | undefined>('stories', 'readonly', function (store, set) { reqValue(store.get(id), set); });
  }

  function putStory(story: Story): Promise<Story> {
    return tx<void>('stories', 'readwrite', function (store) { store.put(story); }).then(function () { return story; });
  }

  function patchStory(id: string, patch: Partial<Story>): Promise<Story | null> {
    return tx<Story | null>('stories', 'readwrite', function (store, set) {
      store.get(id).onsuccess = function (event) {
        var story = (event.target as IDBRequest<Story | undefined>).result;
        if (!story) { set(null); return; }
        // `k` is a plain string from `for...in`, not a `keyof Story`; the cast
        // preserves the original dynamic-key copy the types can't express.
        for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) (story as any)[k] = (patch as any)[k];
        store.put(story);
        set(story);
      };
    });
  }

  function deleteStory(id: string): Promise<void> {
    return deleteChunks(id)
      .then(function () { return tx<void>('art', 'readwrite', function (store) { store['delete'](id); }); })
      .then(function () { return tx<void>('stories', 'readwrite', function (store) { store['delete'](id); }); });
  }

  /* ----------------------------------------------------------------- chunks */

  function putChunk(storyId: string, index: number, buffer: ArrayBuffer): Promise<void> {
    return tx<void>('chunks', 'readwrite', function (store) {
      store.put({ key: chunkKey(storyId, index), data: buffer });
    });
  }

  function getChunk(storyId: string, index: number): Promise<ArrayBuffer | null> {
    return tx<ArrayBuffer | null>('chunks', 'readonly', function (store, set) {
      store.get(chunkKey(storyId, index)).onsuccess = function (event) {
        var row = (event.target as IDBRequest<{ key: string; data: ArrayBuffer } | undefined>).result;
        set(row ? row.data : null);
      };
    });
  }

  /* Whether a story's audio is still on disk, without reading it. The startup
   * audit asks this of every story, and getChunk would hand back a megabyte
   * each time only for it to be thrown away.
   */
  function hasChunk(storyId: string, index: number): Promise<boolean> {
    return tx<boolean>('chunks', 'readonly', function (store, set) {
      store.count(chunkKey(storyId, index)).onsuccess = function (event) {
        set((event.target as IDBRequest<number>).result > 0);
      };
    });
  }

  // Reads chunks [from, to] inclusive in one transaction.
  function getChunks(storyId: string, from: number, to: number): Promise<ArrayBuffer[]> {
    return tx<ArrayBuffer[]>('chunks', 'readonly', function (store, set) {
      var out: ArrayBuffer[] = [];
      var range = IDBKeyRange.bound(chunkKey(storyId, from), chunkKey(storyId, to));
      store.openCursor(range).onsuccess = function (event) {
        var cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
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
  function chunkOwners(): Promise<string[]> {
    return tx<string[]>('chunks', 'readonly', function (store, set) {
      var ids: Record<string, boolean> = {};
      // Cast: IDBRequest<A> | IDBRequest<B> doesn't collapse to
      // IDBRequest<A | B>, even though both branches are read the same way
      // below (.result.key, .result.continue()).
      var request = (store.openKeyCursor ? store.openKeyCursor() : store.openCursor()) as
        IDBRequest<IDBCursor | IDBCursorWithValue | null>;
      request.onsuccess = function (event) {
        var cursor = (event.target as IDBRequest<IDBCursor | IDBCursorWithValue | null>).result;
        if (!cursor) {
          var out: string[] = [];
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

  function deleteChunks(storyId: string): Promise<void> {
    return tx<void>('chunks', 'readwrite', function (store) {
      var range = IDBKeyRange.bound(storyId + '#', storyId + '#￿');
      store['delete'](range);
    });
  }

  /* -------------------------------------------------------------------- art */

  function putArt(id: string, buffer: ArrayBuffer, type: string): Promise<void> {
    return tx<void>('art', 'readwrite', function (store) { store.put({ id: id, data: buffer, type: type }); });
  }

  function getArt(id: string): Promise<ArtRow | null> {
    return tx<ArtRow | null>('art', 'readonly', function (store, set) { reqValue(store.get(id), set); });
  }

  /* --------------------------------------------------------------- settings */

  function kvGet<T>(key: string, fallback: T): Promise<T> {
    return tx<T>('kv', 'readonly', function (store, set) {
      store.get(key).onsuccess = function (event) {
        var row = (event.target as IDBRequest<{ k: string; v: T } | undefined>).result;
        set(row ? row.v : fallback);
      };
    });
  }

  function kvSet(key: string, value: any): Promise<void> {
    return tx<void>('kv', 'readwrite', function (store) { store.put({ k: key, v: value }); });
  }

  /* ------------------------------------------------------------------ usage */

  function usage(): Promise<number> {
    return getStories().then(function (list) {
      var bytes = 0;
      for (var i = 0; i < list.length; i++) bytes += list[i].size || 0;
      return bytes;
    });
  }

  // Built up in a variable rather than returned as a literal: `getStory` and
  // `usage` are real, used elsewhere (tests, the startup audit) but aren't
  // part of the shared StoreModule shape, and a literal return would fail
  // TypeScript's excess-property check for them.
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
