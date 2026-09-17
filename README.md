# Bedtime

A bedtime audiobook player for children, built from the Claude Design prototype
`Bedtime Player Prototype.dc.html`. It installs to the iPhone Home Screen as a
web app, and the audio you add is copied into the app and played back from the
phone, with no server and no signal needed.

**Live at https://ashley-hunter.github.io/audiobook/** - open it in Safari on
the phone, then Share → Add to Home Screen.

Built to run on an **iPhone 6**, which means the floor is **Safari 12 / iOS 12.5.7**.
Newer phones are not held down to that floor: anything that arrived later is
used when it is there and has a stated fallback when it is not. Parent controls
show which of them the phone in your hand actually has.

```
npm install                 # playwright, for the browser tests only
npm run serve               # http://127.0.0.1:8777
npm test                    # compatibility check, unit tests, browser tests, WebKit
```

There is no build step. The files you edit are the files that ship. The one
dependency that reaches the phone is Preact (with `htm`), vendored in
`assets/vendor/` as plain scripts and used by `assets/js/lists.js` to draw the
library list and the queue; everything else on the screen is still built by
hand.

    npm run parity              # proves a change did not alter the screen
    npm run test:safari         # runs the built site in a real WebKit

`npm run parity` renders every list against a previous commit and against the
working tree, then compares the markup and the screenshots of eight states. It
is what proved the move to Preact changed nothing a child would see.

**Is Babel needed for the floor?** No, and this is checked rather than assumed.
Safari 12 is an ES2018 engine - it has classes, arrow functions, template
literals, spread and async/await, and it has not got optional chaining or
anything later. Nothing that ships, Preact and htm included, uses syntax newer
than Safari 10. `npm run check` parses every shipped file at ES2018 and fails
on anything newer, so a dependency cannot bring modern syntax in behind the
denylist of specific features it also carries. The ES5 style in this repo's own
files - `var`, no arrows - is house style, not a requirement.

---

## What it does

| Screen | Behaviour |
| --- | --- |
| **Tonight** | Greeting, a "Keep going" card for the half-finished story, tonight's picks, and the full library with hearted stories first. Each story's ⋯ menu adds it to or takes it out of tonight's picks. |
| **Tonight's picks** | The queue: a single scrolling row, numbered in play order, empty until something is added. Playing a story or adding it from its menu appends it, a story leaves once it has played to the end, and each one runs on into the next. Hold a pick and drag it to reorder, or use "Play sooner" in its menu. |
| **Player** | Starfield, progress ring, scrubber, 15 second back and forward either side of play/pause, the sleep timer behind the moon, and a "Sleep tight" curtain once the timer runs out. The sky darkens as the story progresses. Swipe down to put it away; a mini player keeps the story in reach, and swiping that away stops the story. |
| **Sleep timer** | 10 / 20 / 30 minutes or any number typed in, or a number of stories from the queue (the one playing counts as one, however far in). The sound fades out over the last 20 seconds. |
| **Parent controls** | Hold the moon for three seconds. Bedtime, stories per night, default timer, child's name, playback switches, storage use, and the week's listening. |
| **Add stories** | Pick audio from the Files app. Each file is copied into the app, tagged, given cover art, and listed. Reachable from the header, the empty state and parent controls - anyone can add. |

Everything is real: the settings persist, the listening statistics are counted
from actual playback, and the storage figures are the actual bytes held.

### With no signal

Everything works offline except finding a cover for a story that has none. The
app shell, the fonts and the icons are cached by the service worker, the audio
lives in IndexedDB, and cover art is stored as bytes rather than linked, so the
library paints the same with the phone in aeroplane mode as with full bars. The
one thing that needs the network is the initial artwork lookup, and a story
imported with no signal is not written off: nothing is recorded as a miss, and
the next launch with a connection quietly fills the cover in.

Nothing else reaches out - no fonts from Google, no CDN, no analytics. That is
kept honest by the build rather than by discipline: `scripts/build-site.js`
refuses to publish if anything the page or the stylesheet loads is missing from
the service worker's shell list, which is the easy way to ship a web font that
silently falls back on the first phone in a bedroom with no reception.

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

**Cover art** (`assets/js/artwork.js`)
Embedded art from the file's own tags is always preferred. Failing that, the
iTunes Search API is asked, then Open Library. Three rules shape it: it never
blocks an import, because the audio is already stored by the time it runs and
every failure resolves to null; a result has to actually look like the story
before its artwork is taken, because a wrong cover is worse than none; and the
bytes are fetched and stored rather than linked, so the library does not look
broken with no signal. Stories that miss out - offline at the time, or imported
before this existed - are retried once per launch, capped and spaced out. The
switch is "Find cover art online" in parent controls.

"Nothing found" and "could not look" are kept apart. A miss is recorded so the
same hopeless title is not searched on every launch, but only once a source has
actually answered - otherwise a story imported with no signal would be written
off as having no cover for good.

Storing the bytes needs the host to allow cross-origin reads. CI has no route to
either host, so the tests fake them, but the iTunes path is confirmed working on
a real device. Open Library is only reached when iTunes has nothing, so that leg
is still unproven in practice; if it ever refuses, the lookup degrades to the
generated cover rather than breaking.

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

**Shipping an update** (`scripts/build-site.js`, `sw.js`)
The service worker serves the app shell from cache, so a deploy only reaches a
phone if the browser installs a new worker. `build-site.js` stamps `sw.js` with
a hash of everything that ships, which means the worker bytes change whenever
the app does and stay identical when it does not. The new worker claims the page
on activate, and the page reloads once to pick up the new HTML and scripts -
unless a story is playing or someone is part way through something, in which
case it waits and is taken the moment the app is put away. Without the stamp
the worker never changes, `activate` never runs, and the old release keeps
being served.

A cached file is served as it is and never refreshed in place. Fetching each
file again in the background sounds harmless and is not: on a phone that had
not restarted since a deploy it wrote new files into the running release's
cache, so a launch could mix a new script with the old HTML written for it. A
release now changes only when a new worker installs a whole new cache.

---

## What a newer phone gets, and what the iPhone 6 does instead

Every API past the floor is detected in one place, `assets/js/capabilities.js`,
and each is paired with the behaviour used when it is missing. Nothing else in
the app touches these directly, which `npm run check` enforces.

| Capability | Arrived | On a newer phone | On the iPhone 6 |
| --- | --- | --- | --- |
| Media Session | Safari 15 | Title, artwork and play/pause on the lock screen, Control Center and headphones, with a live position scrubber and 15 second skips | In-app controls only |
| `navigator.audioSession` | Safari 16.4 | Audio is declared as playback, so it ignores the silent switch and backgrounds properly | The silent switch stops it |
| `storage.persist()` | Safari 15.2 | The browser is asked to protect the stored audio, again after each import when engagement is highest | Audio can be evicted; the app detects it and says so |
| `storage.estimate()` | Safari 15.2 | Parent controls show the real space left for the app | Shows the bytes held |
| `Blob.arrayBuffer()` | Safari 14 | Chunks are read straight to an ArrayBuffer | `FileReader` |
| `requestIdleCallback` | Safari 18 | The startup storage audit waits for a quiet moment | A short `setTimeout` |
| `beforeinstallprompt` | Chromium only | An Install row in parent controls | No row; Safari installs from its own Share menu |

---

## Known iOS limits

These are platform facts, not things left to do.

**Background audio is the risk to watch.** On iOS 12, a Home Screen web app
generally stops playing when the screen locks or the app is backgrounded. You
said this is fine for your setup; if it turns out not to be, no amount of code
changes it, and the answer is a native or Capacitor wrapper. On iOS 16.4 and up
the app declares its audio as playback, which helps, but it cannot help iOS 12.

**No screen wake lock.** The Wake Lock API is not available on iOS at all, so
the app cannot keep the screen on. It would be the wrong thing for a bedtime
player anyway.

**The sleep timer follows the audio, not the clock.** It counts down only while
sound is actually coming out, so pausing holds it and playing resumes it from
where it stopped - including when an interruption such as a call does the
pausing, because it is driven by the element's own play and pause events rather
than by the app's buttons. A fade already in progress is abandoned on pause and
started again on resume, so a story paused inside the last twenty seconds still
fades rather than being cut off at full volume.

**`audio.volume` is read-only on iOS.** The sleep timer's fade therefore routes
the element through Web Audio and ramps a `GainNode`. Where `volume` is writable
(Android, desktop) it ramps that instead.

The routing is the delicate part, and getting it wrong is loud. Connecting an
element to a graph takes its sound away from the speakers and hands it to the
graph, so an element joined to a context iOS has not unlocked goes silent on the
spot. A context can only be unlocked from inside a user gesture, so the graph is
built when play is pressed - not when the fade starts, which is a timer callback
twenty seconds before the end and far too late to ask. The element is only ever
joined to a context confirmed to be running; if that never happens there is no
fade and the story plays straight to the speakers, which is the right way to
fail. The fade itself is a quadratic taper rather than a straight line in
amplitude, which falls away faster than the ear expects, and every path back
into playback resets the gain to one so a story always starts at full volume.

**An update must not land on a finger.** A new worker claims the page as soon
as it activates, and the app reloads to pick up the new release. That reload is
only ever an optimisation - the next launch gets the new files either way - so
it is skipped entirely once the app has been touched, or while anything is open,
playing or importing - and then taken when the app is backgrounded, where there
is no finger to pull the page out from under and nothing on screen to lose. It used to fire seconds after boot, which is exactly when
someone is reaching for Add: the sheet vanished and, on iOS, took the file
picker with it, so tapping the dropzone appeared to do nothing.

**Storage can still be taken away.** `storage.persist()` is a request, not a
guarantee, and Safari 12 has no such request at all. Either way the app checks
every story's first chunk at startup and marks the ones whose audio has gone
with "Needs adding again - the phone cleared it", rather than failing at the
moment a child presses play. Expect a permission prompt past roughly 50 MB.

**A file input must stay rendered.** WebKit will not reliably open the picker
for an input hidden with `display: none`, and the dropzone is a `<label>`
wrapped round one, so the input is hidden by being 0x0 and transparent instead.
The suites drive the real tap and wait for a real file chooser, because
`setInputFiles` - which every other import test uses - skips the tap entirely
and would not notice this breaking.

**The file picker only sees Files and iCloud Drive.** It cannot reach the Music
library or anything with DRM from Apple Music. The `accept` list is deliberately
broad, because a bare `accept="audio/*"` hides `.m4b` files in the iOS picker.

**Codecs.** MP3, AAC/M4A, M4B, WAV and FLAC play. Opus, Ogg Vorbis and WebM do
not, on any iOS 12 device.

**Service workers exist on iOS 12, but media elements may refuse to go through
one.** Support landed in Safari 11.3, so iOS 12.5.7 has it and the offline shell
is real. What is not safe to assume is the streaming route: WebKit of this era
does not reliably let an `<audio>` element load from a service worker URL, which
is why `media.js` keeps a second route. A media element that errors on the
worker URL demotes it for the session and the story is reassembled as a Blob URL
instead, picking up where it was. The cost is memory - a Blob URL holds the
whole file - which is why it is the fallback rather than the default. Which
route a real iPhone 6 actually takes is still unverified.

**Considered and left out.** The Origin Private File System (Safari 15.2) would
be a tidier home for the audio on a modern phone, but it would mean a second
storage backend and a migration for a difference no one can see - the service
worker route already keeps memory flat. Worth revisiting only if the iPhone 6
stops being a requirement.

---

## Staying inside Safari 12

`npm run check` is worth running before every commit, because the failure mode
on the device is silent: a CSS property is ignored and the layout quietly
collapses, or a JS operator is a parse error and the whole file stops running.

It enforces two different rules, because the two failures are not alike:

- **Syntax is absolute.** A `?.` anywhere is a parse error on the target device
  and stops the whole file from running, so no amount of feature detection saves
  it. Checked in every shipped file, `capabilities.js` included.
- **APIs are about reach.** A missing `navigator.mediaSession` is survivable if
  it is detected. These are allowed in `assets/js/capabilities.js`, or on a line
  marked `// caps-ok` for a guarded one-off. Anywhere else they fail, so an
  unguarded call cannot drift into the app.

CSS that Safari 12 ignores harmlessly (`:focus-visible`, `overscroll-behavior`)
is allowed, but each gets its own rule block - Safari 12 throws away an entire
rule when one selector in the list is unknown, and the check catches that too.

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
- **"Lock to the library" is gone.** It was implemented as "Only parents can add
  stories", hiding the Add button and leaving the three second moon hold as the
  only way in. That made a fresh install a dead end - the empty state invited
  you to add a story with no button to do it. Adding is now open to anyone, from
  the header chip, the empty state and parent controls alike. Parent controls
  themselves stay behind the moon hold, so settings, removal and the week's
  listening are still not somewhere a child lands by accident.
- **Bedtime, stories per night and child's name are editable.** The prototype
  draws them as static rows. A settings row that does nothing is worse than one
  that works, so they use native controls and feed the home screen's subtitle.
- **Removing a story was added,** under "Storage on this phone" in parent
  controls. Storage is finite and the prototype has no way to reclaim it. It
  asks first, naming the story and the space it frees, using an in-app dialog
  rather than `window.confirm` - which a Home Screen web app renders as a system
  alert captioned with the site's origin. Removal stays behind the moon hold
  even though adding does not: adding a wrong file is a nuisance, deleting the
  right one is not.
- **A scrubber was added to the player.** The prototype deliberately has none,
  showing only elapsed and remaining. It is a real `<input type="range">` rather
  than a hand-rolled bar, so iOS handles the drag, the touch target and the
  accessibility. Dragging previews the time and only seeks on release, because
  seeking on every input event stutters the audio, and the once-a-second tick
  leaves the thumb alone while a finger is on it. Safari draws no fill for the
  elapsed part, so that is a gradient on the input itself - not on the track
  pseudo-element, which a script cannot reach.
- **Tonight's picks became a queue.** The prototype draws a fixed strip of
  covers with nothing behind it. Here the strip is a queue: stories are added
  from each row's menu or by playing them, reordered by holding and dragging
  (touch events, since iOS 12 has neither HTML drag and drop on iPhone nor
  pointer events), and dropped once they finish. A finished story runs on into
  the next one, so the queue is also the answer to "what's up next"; the player
  names it under the sleep timer. With nothing queued a story ends the night on
  its own rather than rolling into the rest of the library. An unfinished sleep
  timer is handed to the next story rather than restarted, because twenty
  minutes of sleep timer has to mean twenty minutes of night, not twenty
  minutes per story.
- **The player's close control is an inline SVG chevron,** not the `U+2304 ⌄`
  character the prototype uses. Several of the fonts iOS falls back to have no
  glyph for it, so the button came out blank or comically small. The other
  symbols (moon, heart, list) are in every iOS font and stay as text.
- **The iOS device frame** (`ios-frame.jsx`) is prototype chrome, not part of the
  app - on the phone the real status bar and home indicator do that job.

---

## Layout

```
index.html                  every screen's markup, rendered once
manifest.webmanifest        used by Android; iOS reads the apple-* meta tags
sw.js                       shell cache + the ./media/<id> range route
assets/css/app.css          one stylesheet, tokens at the top
assets/js/capabilities.js   every post-floor API, detected with its fallback
assets/js/store.js          IndexedDB: stories, chunks, art, settings
assets/js/settings.js       parent settings + the weekly listening record
assets/js/id3.js            ID3v2 and MP4 tag reading
assets/js/artwork.js        cover lookup: iTunes Search, then Open Library
assets/js/media.js          picks the playback route, caches object URLs
assets/js/importer.js       chunked copy into storage
assets/js/player.js         playback, sleep timer, fade, checkpoints
assets/js/ui.js             DOM and formatting helpers
assets/js/app.js            screen wiring
scripts/check-ios12.js      the Safari 12 guard
scripts/build-site.js       assembles _site/, and refuses an inconsistent one
scripts/make-icons.py       regenerates the icon set (stdlib only)
test/                       tag, browser and deployment tests, plus the dev server
.github/workflows/pages.yml checks on every push, Pages deploy from default
```

---

## Deploying

`.github/workflows/pages.yml` runs the checks on every push and pull request,
and publishes to GitHub Pages from the default branch.

- **`npm run build`** assembles `_site/` with only what belongs on a phone:
  `index.html`, `manifest.webmanifest`, `sw.js` and `assets/`. The tests, build
  scripts and vendored design prototypes stay behind.
- The build **refuses to publish an inconsistent site**: a script tag pointing
  at a file that is not there, an absolute path that would break on a project
  site, or a file the page loads that is missing from the service worker's
  shell list. That last one only shows up as an app that is half broken with no
  signal, which is the worst way to find out.
- The deploy job is gated on `github.event.repository.default_branch` rather
  than a hardcoded `main`, so it keeps working whatever the default branch is
  called now or later.

### The one thing a workflow could not do for itself

Pages is already on, so there is nothing left to do here. It is recorded because
it is the step that will bite anyone forking this.

**Settings → Pages → Build and deployment → Source: GitHub Actions** has to be
clicked by a person. `configure-pages` has an `enablement` option, which was
tried and does not work: creating a Pages site counts as administering
repository settings, and the built-in `GITHUB_TOKEN` is refused whatever
permissions the workflow requests.

```
Create Pages site failed. Error: Resource not accessible by integration
```

So the deploy job prints what to click when it hits this, rather than leaving
you with the raw "Pages site not found".

**If that settings page says Pages is unavailable, it is the plan and not the
setting.** Publishing a private repository needs GitHub Pro, Team or Enterprise;
making the repository public is the other way through, and is what this one did.
Nothing sensitive is published either way - the site is the app shell, and every
story a child adds stays in that phone's own storage and never reaches a server.
Worth knowing that the published site is reachable by anyone with the URL; only
Enterprise can restrict who can load it.

The test job runs regardless, on every branch and every pull request.

### The URL

**https://ashley-hunter.github.io/audiobook/**

A project site is served from a subdirectory, not the root of a domain. Every
path in the app is relative for that reason, and `npm run test:pages` builds the
real artifact, serves it from a subdirectory and checks that the service worker
claims the right scope, that the media route resolves, and that the whole thing
still plays with the network switched off.

To try that shape locally:

```
npm run build
node test/serve.js 8777 /audiobook/     # http://127.0.0.1:8777/audiobook/
```

### Installing it on the phone

The app has to be served over **HTTPS** - service workers require a secure
context, and without one there is no offline shell and no streaming route.
`localhost` counts as secure, so `npm run serve` is enough for development.

On the phone: open https://ashley-hunter.github.io/audiobook/ in **Safari** (not
Chrome - only Safari can install to the Home Screen), then Share → Add to Home
Screen. Launching from that icon is what gives the app its full screen and its
own storage.

Two things follow from "its own storage", and both are easy to trip over:

- **Install first, import second.** On this vintage of iOS the Home Screen app
  is a separate context from Safari, with its own IndexedDB. Stories added in
  the Safari tab will not be in the app launched from the icon. Add to Home
  Screen first, then import from the icon.
- **Open it once with a connection.** The service worker has to register again
  in that context before anything is cached, so the very first launch from the
  icon needs signal. After that it runs with none.

---

## Testing

`npm test` runs four things:

- `scripts/check-ios12.js` - the syntax and CSS floor.
- `test/tags.test.js` - the tag reader against hand-built ID3 and MP4 fixtures,
  including a truncated tag and an M4B with its metadata past the 1 MiB head.
- `test/artwork.test.js` - the cover lookup with the network faked: the query
  built from a messy filename, the refusal to take a result that does not match,
  the size and content-type guards, and that every failure path ends in null
  rather than an exception during an import.
- `test/browser.test.js` - a real import, range requests that straddle a chunk
  boundary, the 4 MiB window cap, playback, the sleep timer pausing with the
  audio, persistence across a reload, and the Blob fallback. It then runs a
  **second pass with every post-floor API deleted before the page loads**, which
  is what an iPhone 6 presents, and checks that import, playback, the storage
  and storage wording all still work without them. Testing only the
  enhanced path would prove nothing about the phone this is for.

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
