# Bedtime

An offline audiobook player for children. It installs to the iPhone Home
Screen as a web app; stories are copied onto the phone from the Files app and
played back with no server and no signal needed.

**Live at https://ashley-hunter.github.io/audiobook/** - open it in Safari on
the phone, then Share -> Add to Home Screen.

## The floor

Built to run on an **iPhone 6**, which puts the floor at **Safari 12 / iOS
12.5.7**. `npm run check` parses every shipped file at ES2018 and fails the
build on anything newer, so a slip in the source or a dependency update can't
ship syntax the phone can't parse. The published files are also put through
Babel targeting Safari 12, down-levelling anything newer before it ships; the
check is what actually enforces the floor, Babel is the belt to its braces.

Newer phones aren't held down to that floor: any API that arrived later is
used when it's there and falls back when it isn't. The full list of those
capabilities and their fallbacks lives in `src/capabilities.ts` and stays
current there rather than here.

## Commands

```
npm install                 # typescript, babel, playwright and vitest
npm run serve               # http://127.0.0.1:8777
npm test                    # everything, in order, about four minutes
npm run build               # compiles and assembles _site/, ready to deploy
npm run compile             # TypeScript in src/ -> plain scripts in assets/js/
npm run parity              # proves a change didn't alter the screen
```

The tests are split so CI can run them at once, and so one failure names
itself:

```
npm run test:views          # the lists, in a real browser, in under a second
npm run test:tags           # ID3 and MP4 tag reading, no browser
npm run test:artwork        # cover lookup, no browser
npm run test:browser        # import, playback, the queue, gestures
npm run test:oldphone       # the same app with every post-floor API deleted
npm run test:artfake        # cover lookup with both search hosts faked
npm run test:fade           # the sleep timer's fade, where volume is read-only
npm run test:pages          # the built site, served the way Pages serves it
npm run test:safari         # the built site in a real WebKit
```

`npm run parity` renders every list against a previous commit and against the
working tree, then compares the markup and screenshots of eight states. It is
what proves a change to how the screen is drawn changed nothing on it.

## Architecture

- Source is TypeScript in `src/`, compiled by `npm run compile` to plain
  scripts in `assets/js/` (and `sw.js` at the root). There is no bundler: each
  module hangs itself off a shared `App` global and the scripts load in
  dependency order.
- **Preact and htm** are vendored as plain scripts in `assets/vendor/` and used
  by `src/views.ts` to draw every list on screen. The player is still updated by
  hand, field by field, so the once-a-second tick never rebuilds a node.
- **Audio storage**: an imported file is sliced into 1 MiB pieces and written
  to IndexedDB as `ArrayBuffer` chunks (`src/importer.ts`, `src/store.ts`), so
  importing a two-hour audiobook doesn't hold the whole file in memory.
- **Playback**: the service worker serves `./media/<storyId>` and answers
  `Range` requests by reading only the chunks asked for (`src/sw.ts`). If a
  media element won't load through the service worker, `src/media.ts` falls
  back to a Blob URL assembled a chunk at a time.
- `npm run build` (`scripts/build-site.js`) assembles `_site/` with only what
  belongs on a phone, and refuses to publish if anything the page loads is
  missing from the service worker's shell list.

## Deploying

`.github/workflows/pages.yml` runs the checks on every push and pull request,
and publishes `_site/` to GitHub Pages from the default branch. Pages itself
has to be turned on once by hand: **Settings -> Pages -> Build and deployment
-> Source: GitHub Actions**. The built-in `GITHUB_TOKEN` can't do this for you
(`Create Pages site failed. Error: Resource not accessible by integration`),
so the deploy job prints the instruction rather than leaving you with that
error. If the setting is greyed out, it's the plan, not a bug: a private
repository needs GitHub Pro, Team or Enterprise to publish Pages, or the
repository has to be public.

The app needs HTTPS to register a service worker (`localhost` counts, so
`npm run serve` is fine for development). On the phone, install first and
import second: the Home Screen app is a separate context from the Safari tab
it was installed from, with its own IndexedDB, so stories added in the tab
won't show up in the app. The first launch from the icon also needs a
connection, to register the service worker before anything is cached.

## Known iOS limits

- **Background audio may stop** when the screen locks or the app is
  backgrounded on iOS 12. Safari 16.4+ declares the audio as playback, which
  helps there, but nothing fixes this on iOS 12 itself - that would need a
  native or Capacitor wrapper.
- **No screen wake lock** - the API doesn't exist on iOS.
- **`audio.volume` is read-only on iOS**, so the sleep timer's fade routes the
  element through Web Audio and ramps a `GainNode` instead.
- **Storage can be evicted.** `storage.persist()` is a request, not a
  guarantee, and Safari 12 has no such request at all. The app checks each
  story's first chunk at startup and flags any whose audio is gone.
- **Codecs**: MP3, AAC/M4A, M4B, WAV and FLAC play; Opus, Ogg Vorbis and WebM
  don't, on any iOS 12 device.
- **The file picker** only sees Files and iCloud Drive, never the Music
  library or DRM'd Apple Music tracks.

## Still to check by hand on a real iPhone 6

The browser tests run in Chromium, so they prove the logic, not Safari 12
itself:

1. Play a story, lock the screen, wait a minute - does the audio survive?
2. Whether the media element loads through the service worker or falls back
   to the Blob route (both work; worth knowing which one you're on).
3. Importing a realistically sized file (100 MB and up) without the tab being
   killed.
4. The storage permission prompt past roughly 50 MB.
5. Whether stored audio is still there a week later, having not opened the
   app in between.

## Files

```
index.html                  every screen's markup, rendered once
manifest.webmanifest        used by Android; iOS reads the apple-* meta tags
assets/css/app.css          one stylesheet, tokens at the top
assets/vendor/              preact and htm, vendored as plain scripts
assets/js/                  compiled from src/ by `npm run compile`, gitignored
src/types.d.ts              the shapes the modules pass between each other
src/capabilities.ts         every post-floor API, detected with its fallback
src/store.ts                IndexedDB: stories, chunks, art, settings
src/settings.ts             parent settings + the weekly listening record
src/id3.ts                  ID3v2 and MP4 tag reading
src/artwork.ts              cover lookup: iTunes Search, then Open Library
src/media.ts                picks the playback route, caches object URLs
src/importer.ts             chunked copy into storage
src/player.ts               playback, sleep timer, fade, checkpoints
src/ui.ts                   DOM and formatting helpers
src/views.ts                every list on screen, drawn with Preact
src/app.ts                  screen wiring
src/sw.ts                   shell cache + the ./media/<id> range route
tsconfig.json               ES2018 out, strict; sw has its own, for worker types
scripts/check-ios12.js      the Safari 12 guard
scripts/build-site.js       assembles _site/, and refuses an inconsistent one
scripts/parity.sh           the parity check, in a throwaway worktree
scripts/make-icons.py       regenerates the icon set (stdlib only)
test/                       tag, browser and deployment tests, plus the dev server
.github/workflows/pages.yml checks on every push, Pages deploy from default
```
