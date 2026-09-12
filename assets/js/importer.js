/* Bedtime - copying a picked file into the app's own storage.
 *
 * The file is never read in one go. It is sliced into 1 MiB pieces and each
 * piece is written to IndexedDB before the next one is read, so importing a
 * two hour audiobook costs about a megabyte of memory rather than hundreds.
 */
window.App = window.App || {};

App.importer = (function () {
  'use strict';

  var AUDIO_EXT = /\.(mp3|m4a|m4b|aac|wav|flac|mp4|caf)$/i;

  function newId() {
    return 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  function titleFromName(name) {
    return name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled story';
  }

  function looksLikeAudio(file) {
    return (file.type && file.type.indexOf('audio') === 0) || AUDIO_EXT.test(file.name || '') ||
           file.type === 'video/mp4'; // iOS reports some .m4b files this way
  }

  // Duration straight from the decoder, so the player shows real times.
  function measure(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var audio = document.createElement('audio');
      var settled = false;
      function done(seconds) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        audio.removeAttribute('src');
        try { audio.load(); } catch (err) { void err; }
        URL.revokeObjectURL(url);
        resolve(seconds && isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0);
      }
      var timer = setTimeout(function () { done(0); }, 20000);
      audio.preload = 'metadata';
      audio.onloadedmetadata = function () { done(audio.duration); };
      audio.onerror = function () { done(0); };
      audio.src = url;
    });
  }

  function readChunk(file, start, size) {
    return App.caps.readArrayBuffer(file.slice(start, Math.min(file.size, start + size)));
  }

  function friendlyError(err) {
    var name = err && err.name ? err.name : '';
    if (name === 'QuotaExceededError' || /quota/i.test(String(err && err.message))) {
      return 'No room left on this phone for that file.';
    }
    if (name === 'NotReadableError' || name === 'NotFoundError') {
      return 'iOS would not let go of that file. Try picking it again.';
    }
    return 'Import failed. Try again.';
  }

  /* Imports one file.
   * onProgress(fraction 0..1) fires as chunks land.
   * Resolves with the saved story record.
   */
  function importFile(file, onProgress) {
    if (!looksLikeAudio(file)) {
      return Promise.reject(new Error('That is not an audio file.'));
    }

    var id = newId();
    var chunkSize = App.store.CHUNK_SIZE;
    var chunkCount = Math.max(1, Math.ceil(file.size / chunkSize));
    var story = {
      id: id,
      title: titleFromName(file.name),
      narrator: 'you',
      album: '',
      mood: 'Ours',
      chapters: 1,
      len: 0,
      size: file.size,
      mime: file.type || 'audio/mpeg',
      chunkSize: chunkSize,
      chunkCount: chunkCount,
      hasArt: false,
      hue: Math.abs(hash(id + file.name)) % 360,
      fav: false,
      pos: 0,
      addedAt: Date.now(),
      lastPlayedAt: 0
    };

    return App.store.open()
      .then(function () { return measure(file); })
      .then(function (seconds) {
        story.len = seconds;
        return App.tags.read(file);
      })
      .then(function (tags) {
        if (tags.title) story.title = tags.title;
        if (tags.artist) story.narrator = tags.artist;
        if (tags.album) story.album = tags.album;
        if (tags.picture && tags.picture.data && tags.picture.data.byteLength) {
          story.hasArt = true;
          return App.store.putArt(id, tags.picture.data, tags.picture.type);
        }
        return null;
      })
      .then(function () { return writeChunks(file, id, chunkSize, chunkCount, onProgress); })
      .then(function () { return App.store.putStory(story); })
      .then(function () { return story; })
      ['catch'](function (err) {
        return App.store.deleteStory(id)['catch'](function () { return null; }).then(function () {
          var wrapped = new Error(friendlyError(err));
          wrapped.cause = err;
          throw wrapped;
        });
      });
  }

  function writeChunks(file, id, chunkSize, chunkCount, onProgress) {
    var index = 0;
    function step() {
      if (index >= chunkCount) return Promise.resolve();
      return readChunk(file, index * chunkSize, chunkSize)
        .then(function (buffer) { return App.store.putChunk(id, index, buffer); })
        .then(function () {
          index++;
          if (onProgress) onProgress(index / chunkCount);
          // Yield to the run loop so the progress bar actually paints on a
          // slower phone rather than freezing until the import finishes.
          return new Promise(function (resolve) { setTimeout(resolve, 0); });
        })
        .then(step);
    }
    return step();
  }

  function hash(text) {
    var h = 0;
    for (var i = 0; i < text.length; i++) {
      h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    }
    return h;
  }

  // Replaces the cover art on an existing story.
  function setArt(storyId, file) {
    if (!file || file.type.indexOf('image') !== 0) {
      return Promise.reject(new Error('That is not an image.'));
    }
    return App.caps.readArrayBuffer(file).then(function (buffer) {
      return App.store.putArt(storyId, buffer, file.type);
    }).then(function () {
      App.media.forgetArt(storyId);
      return App.store.patchStory(storyId, { hasArt: true });
    });
  }

  return {
    importFile: importFile,
    setArt: setArt,
    looksLikeAudio: looksLikeAudio,
    titleFromName: titleFromName,
    hash: hash
  };
})();
