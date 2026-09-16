/* Bedtime - optional platform capabilities.
 *
 * The app has to run on an iPhone 6 (Safari 12), but there is no reason a
 * newer phone should be held back to that. Every API that arrived after the
 * floor is detected here and nowhere else, and each one is paired with the
 * behaviour used when it is missing. The rest of the app talks to `App.caps`
 * and never touches these APIs directly, which is what
 * `scripts/check-ios12.js` enforces.
 *
 * Capability                Arrived          Without it
 * ------------------------  ---------------  --------------------------------
 * Media Session             Safari 15        no lock screen controls
 * navigator.audioSession    Safari 16.4      audio follows the silent switch
 * storage.persist()         Safari 15.2      iOS may evict stored audio
 * storage.estimate()        Safari 15.2      space shown as bytes held only
 * Blob.arrayBuffer()        Safari 14        FileReader
 * requestIdleCallback       Safari 18        setTimeout
 * beforeinstallprompt       Chromium only    no Install row; Safari installs
 *                                            from its own Share menu
 */
window.App = window.App || {};

App.caps = (function () {
  'use strict';

  var nav = window.navigator;
  var storage = nav.storage;

  var has = {
    serviceWorker: 'serviceWorker' in nav,
    mediaSession: !!(nav.mediaSession && typeof nav.mediaSession.setActionHandler === 'function'),
    audioSession: !!nav.audioSession,
    persistentStorage: !!(storage && typeof storage.persist === 'function'),
    storageEstimate: !!(storage && typeof storage.estimate === 'function'),
    blobArrayBuffer: typeof Blob !== 'undefined' && !!Blob.prototype && typeof Blob.prototype.arrayBuffer === 'function',
    idleCallback: typeof window.requestIdleCallback === 'function',
    webAudio: !!(window.AudioContext || window.webkitAudioContext),
    indexedDb: !!window.indexedDB,
    installPrompt: false
  };

  function supports(name) { return !!has[name]; }

  /* ------------------------------------------------------------- reading */

  // Blob.arrayBuffer() where it exists, FileReader on iOS 12 and 13.
  function readArrayBuffer(blob) {
    if (has.blobArrayBuffer) {
      return blob.arrayBuffer();
    }
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('Could not read the file')); };
      reader.readAsArrayBuffer(blob);
    });
  }

  /* -------------------------------------------------------------- timing */

  // Runs work when the phone is not busy, or soon, on phones without the API.
  function idle(fn, timeout) {
    if (has.idleCallback) {
      window.requestIdleCallback(fn, { timeout: timeout || 2000 });
      return;
    }
    setTimeout(fn, 60);
  }

  /* ------------------------------------------------------------- storage */

  /* Asks the browser to keep stored audio even under pressure.
   * Resolves true (granted), false (refused) or null (the browser has no say),
   * which is what an iPhone 6 always gets. Browsers weigh engagement, so this
   * is worth asking again after the first import rather than only at startup.
   */
  function requestPersistence() {
    if (!has.persistentStorage) return Promise.resolve(null);
    return storage.persisted().then(function (already) {
      if (already) return true;
      return storage.persist();
    })['catch'](function () { return null; });
  }

  function persisted() {
    if (!has.persistentStorage) return Promise.resolve(null);
    return storage.persisted()['catch'](function () { return null; });
  }

  // Resolves { usage, quota } or null when the browser will not say.
  function estimate() {
    if (!has.storageEstimate) return Promise.resolve(null);
    return storage.estimate().then(function (result) {
      if (!result || typeof result.quota !== 'number') return null;
      return { usage: result.usage || 0, quota: result.quota };
    })['catch'](function () { return null; });
  }

  /* ------------------------------------------------- iOS audio behaviour */

  /* Tells Safari 16.4+ this is playback rather than an incidental sound, so it
   * ignores the silent switch and behaves properly in the background. Older
   * iOS has no equivalent, which is why background audio has to be checked by
   * hand on the target phone.
   */
  function claimPlaybackAudio() {
    if (!has.audioSession) return false;
    try {
      nav.audioSession.type = 'playback';
      return true;
    } catch (err) {
      void err;
      return false;
    }
  }

  /* -------------------------------------------------------- media session */

  var media = (function () {
    var handlers = {};

    function setMetadata(info) {
      if (!has.mediaSession || !window.MediaMetadata) return;
      try {
        var artwork = [];
        if (info.artwork) {
          artwork.push({ src: info.artwork, sizes: '512x512', type: 'image/jpeg' });
        }
        artwork.push({ src: 'assets/icons/icon-512.png', sizes: '512x512', type: 'image/png' });
        artwork.push({ src: 'assets/icons/icon-192.png', sizes: '192x192', type: 'image/png' });
        nav.mediaSession.metadata = new MediaMetadata({
          title: info.title || 'Bedtime story',
          artist: info.artist || 'Bedtime',
          album: info.album || 'Bedtime',
          artwork: artwork
        });
      } catch (err) { void err; }
    }

    // actions: { play, pause, stop, back, forward }
    function setActions(actions) {
      if (!has.mediaSession) return;
      handlers = actions || {};
      bind('play', handlers.play);
      bind('pause', handlers.pause);
      bind('stop', handlers.stop);
      bind('seekbackward', handlers.back);
      bind('seekforward', handlers.forward);
    }

    function bind(name, fn) {
      try {
        nav.mediaSession.setActionHandler(name, fn || null);
      } catch (err) {
        void err; // an action this browser does not know about
      }
    }

    function setPlaybackState(playing) {
      if (!has.mediaSession) return;
      try {
        nav.mediaSession.playbackState = playing ? 'playing' : 'paused';
      } catch (err) { void err; }
    }

    function setPosition(duration, position, rate) {
      if (!has.mediaSession || typeof nav.mediaSession.setPositionState !== 'function') return;
      if (!duration || !isFinite(duration) || duration <= 0) return;
      try {
        nav.mediaSession.setPositionState({
          duration: duration,
          position: Math.min(Math.max(0, position || 0), duration),
          playbackRate: rate || 1
        });
      } catch (err) { void err; }
    }

    function clear() {
      if (!has.mediaSession) return;
      try {
        nav.mediaSession.metadata = null;
        nav.mediaSession.playbackState = 'none';
      } catch (err) { void err; }
    }

    return {
      setMetadata: setMetadata,
      setActions: setActions,
      setPlaybackState: setPlaybackState,
      setPosition: setPosition,
      clear: clear
    };
  })();

  /* -------------------------------------------------------- install prompt */

  var deferredPrompt = null;
  var installListeners = [];

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    has.installPrompt = true;
    for (var i = 0; i < installListeners.length; i++) installListeners[i](true);
  }, false);

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    has.installPrompt = false;
    for (var i = 0; i < installListeners.length; i++) installListeners[i](false);
  }, false);

  function onInstallAvailable(fn) {
    installListeners.push(fn);
    if (has.installPrompt) fn(true);
  }

  // Chromium can install from a button. Safari installs from its own Share
  // menu, so there is nothing for the app to do there.
  function promptInstall() {
    if (!deferredPrompt) return Promise.resolve(false);
    var prompt = deferredPrompt;
    deferredPrompt = null;
    has.installPrompt = false;
    try {
      prompt.prompt();
      return prompt.userChoice.then(function (choice) {
        return !!choice && choice.outcome === 'accepted';
      })['catch'](function () { return false; });
    } catch (err) {
      void err;
      return Promise.resolve(false);
    }
  }

  return {
    supports: supports,
    readArrayBuffer: readArrayBuffer,
    idle: idle,
    requestPersistence: requestPersistence,
    persisted: persisted,
    estimate: estimate,
    claimPlaybackAudio: claimPlaybackAudio,
    media: media,
    onInstallAvailable: onInstallAvailable,
    promptInstall: promptInstall
  };
})();
