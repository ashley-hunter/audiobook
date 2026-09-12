# Bedtime

A bedtime audiobook player for children, built from the Claude Design prototype
`Bedtime Player Prototype.dc.html`. It installs to the iPhone Home Screen as a
web app, and the audio you add is copied into the app and played back from the
phone, with no server and no signal needed.

Built to run on an **iPhone 6**, which means the floor is **Safari 12 / iOS 12.5.7**.
That constraint shapes most of what follows.

```
npm install                 # playwright, for the browser tests only
npm run serve               # http://127.0.0.1:8777
npm test                    # compatibility check + tag tests + browser tests
```

There is no build step. The files you edit are the files that ship.

---

## What it does

| Screen | Behaviour |
| --- | --- |
| **Tonight** | Greeting, a "Keep going" card for the half-finished story, tonight's picks, and the full library. |
| **Saved** | Everything hearted. |
| **Player** | Starfield, progress ring, play/pause, sleep timer, and a "Sleep tight" curtain once the timer runs out. The sky darkens as the story progresses. |
| **Sleep timer** | 10 / 20 / 30 minutes or to the end of the story. The sound fades out over the last 20 seconds. |
| **Parent controls** | Hold the moon for three seconds. Bedtime, stories per night, default timer, child's name, safety switches, storage use, and the week's listening. |
| **Add stories** | Pick audio from the Files app. Each file is copied into the app, tagged, given cover art, and listed. |

Everything is real: the settings persist, the listening statistics are counted
from actual playback, and the storage figures are the actual bytes held.

---

## How a file gets stored and played back

This is the part the platform makes awkward, so it is worth spelling out.

**Importing** (`assets/js/importer.js`)
The file is never read into memory in one piece. It is sliced into 1 MiB pieces
with `File.slice()`, and each piece is written to IndexedDB before the next one
is read. Importing a two hour audiobook costs about a megabyte of memory rather
than hundreds, which matters a great deal on a phone with 1 GB of RAM.

Audio is stored as `ArrayBuffer` chunks, never as `Blob`s - Blobs in IndexedDB
were unreliable in the Safari 12 era. Title, narrator and embedded cover art are
read from the file's own tags (`assets/js/id3.js` handles ID3v2.2/2.3/2.4 and the
iTunes atoms in M4A/M4B, including the common case of an M4B keeping `moov` at
the very end of the file). Duration comes from the decoder, not from a guess.

**Playing back** (`assets/js/media.js`, `sw.js`)
Two routes, tried in order:

1. The service worker serves `./media/<storyId>` and answers `Range` requests by
   reading only the chunks asked for, capped at 4 MiB per response. Memory stays
   flat however long the story is.
2. If that fails, a Blob URL assembled from the chunks. The blob is grown one
   chunk at a time so the whole file is never held as JavaScript objects at once.

Route 2 exists because some WebKit builds will not let a media element load
through a service worker. The player detects the failure on the `error` event,
demotes the service worker route for the session, and reloads at the same
position. You should not be able to notice the switch.

**Position** is checkpointed to IndexedDB every five seconds and on every
`pagehide` / `visibilitychange`, because iOS tears down a backgrounded Home
Screen app without warning and reopening it is a cold start, not a resume.

---

## Known iOS limits

These are platform facts, not things left to do.

**Background audio is the risk to watch.** On iOS 12, a Home Screen web app
generally stops playing when the screen locks or the app is backgrounded. You
said this is fine for your setup; if it turns out not to be, no amount of code
changes it, and the answer is a native or Capacitor wrapper.

**No lock screen controls.** The Media Session API landed in iOS 15. On iOS 12
there is no title, artwork, or play/pause from Control Center or headphones,
and there is no way to add them.

**No screen wake lock.** The Wake Lock API is not available, so the app cannot
keep the screen on.

**`audio.volume` is read-only on iOS.** The sleep timer's fade therefore routes
the element through Web Audio and ramps a `GainNode`. That routing is permanent
for the life of an element, so the player throws the element away after a fade
and builds a fresh one. If Web Audio is unavailable or its context will not
resume, the timer stops the story without a fade rather than failing.

**Storage can be taken away.** Safari 12 has no `navigator.storage.persist()`,
so stored audio cannot be marked as protected and iOS may evict it under
pressure. The app checks every story's first chunk at startup and marks the ones
whose audio has gone with "Needs adding again - the phone cleared it", rather
than failing at the moment a child presses play. Expect the permission prompt
for storage past roughly 50 MB.

**The file picker only sees Files and iCloud Drive.** It cannot reach the Music
library or anything with DRM from Apple Music. The `accept` list is deliberately
broad, because a bare `accept="audio/*"` hides `.m4b` files in the iOS picker.

**Codecs.** MP3, AAC/M4A, M4B, WAV and FLAC play. Opus, Ogg Vorbis and WebM do
not, on any iOS 12 device.

---

## Staying inside Safari 12

`npm run check` fails the build on anything that shipped after the floor. It is
worth running before every commit, because the failure mode on the device is
silent: a CSS property is ignored and the layout quietly collapses, or a JS
operator is a parse error and the whole file stops running.

What the code avoids, and what it does instead:

| Not available | Used instead |
| --- | --- |
| flexbox `gap` (Safari 14.1) | margins |
| `inset` shorthand (14.1) | `top` / `right` / `bottom` / `left` |
| `conic-gradient` (12.2) | SVG rings with `stroke-dasharray` |
| unprefixed `backdrop-filter` | `-webkit-backdrop-filter` alongside it |
| `?.` and `??` (13.1) | explicit checks |
| Pointer Events | `touchstart` / `mousedown` pairs |
| ES modules with a bundler | plain scripts in dependency order |

Safe-area insets use a cascade of three declarations so the iPhone 6 (which has
no insets) still clears its status bar while a notched phone clears its own.

---

## Deviations from the prototype

Places where the prototype could not be followed literally, and why:

- **The library starts empty.** The prototype ships six demo stories. There is
  no bundled audio here, so the library is entirely what you import, and the
  empty state explains how to add the first one.
- **Mood filter chips are hidden until they are useful.** Imported files all
  land under "Ours", so the chip row would be a single redundant filter. The
  code renders chips as soon as more than one category exists, so the row lights
  up the moment moods can be assigned.
- **"Downloads over Wi-Fi only" was replaced with "Remember where each story
  stopped".** Nothing downloads in a local-file app, so the original switch would
  have done nothing. The replacement is real and defaults to on.
- **"Lock to the library" became "Only parents can add stories"**, which is what
  it actually does: it hides the Add button from the child's screens, leaving
  import available only through parent controls.
- **Bedtime, stories per night and child's name are editable.** The prototype
  draws them as static rows. A settings row that does nothing is worse than one
  that works, so they use native controls and feed the home screen's subtitle.
- **Removing a story was added,** under "Storage on this phone". Storage is
  finite and the prototype has no way to reclaim it.
- **The player has no seek control,** matching the prototype. A child's player
  deliberately has nothing to scrub.
- **The iOS device frame** (`ios-frame.jsx`) is prototype chrome, not part of the
  app - on the phone the real status bar and home indicator do that job.

---

## Layout

```
index.html                  every screen's markup, rendered once
manifest.webmanifest        used by Android; iOS reads the apple-* meta tags
sw.js                       shell cache + the ./media/<id> range route
assets/css/app.css          one stylesheet, tokens at the top
assets/js/store.js          IndexedDB: stories, chunks, art, settings
assets/js/settings.js       parent settings + the weekly listening record
assets/js/id3.js            ID3v2 and MP4 tag reading
assets/js/media.js          picks the playback route, caches object URLs
assets/js/importer.js       chunked copy into storage
assets/js/player.js         playback, sleep timer, fade, checkpoints
assets/js/ui.js             DOM and formatting helpers
assets/js/app.js            screen wiring
scripts/check-ios12.js      the Safari 12 guard
scripts/make-icons.py       regenerates the icon set (stdlib only)
test/                       tag unit tests, end-to-end browser tests, dev server
```

---

## Installing it on the phone

The app has to be served over **HTTPS** - service workers require a secure
context, and without one there is no offline shell and no streaming route.
`localhost` counts as secure, so `npm run serve` is enough for development.

On the phone: open the URL in **Safari** (not Chrome - only Safari can install to
the Home Screen), then Share → Add to Home Screen. Launching from that icon is
what gives the app its full screen and its own storage.

`.github/workflows/pages.yml` publishes the repository to GitHub Pages on every
push to `main`. It does nothing until Pages is enabled for the repository under
Settings → Pages → Source: GitHub Actions.

---

## Testing

`npm test` runs three things:

- `scripts/check-ios12.js` - the syntax and CSS floor.
- `test/tags.test.js` - the tag reader against hand-built ID3 and MP4 fixtures,
  including a truncated tag and an M4B with its metadata past the 1 MiB head.
- `test/browser.test.js` - a real import, range requests that straddle a chunk
  boundary, the 4 MiB window cap, playback, the sleep timer pausing with the
  audio, persistence across a reload, and the Blob fallback.

The browser tests run in Chromium, so they prove the logic, not Safari 12
behaviour. **These still need checking by hand on the iPhone 6:**

1. Play a story, lock the screen, wait a minute. Does the audio survive? This is
   the one that decides whether the concept works at all.
2. Whether the media element loads through the service worker or falls back to
   the Blob route. Both work; it is worth knowing which one you are on.
3. An import of a realistically sized file (100 MB and up) without the tab being
   killed.
4. The storage permission prompt past roughly 50 MB.
5. Whether the stored audio is still there a week later, having not opened the
   app in between.
