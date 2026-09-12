#!/usr/bin/env node
/* Unit tests for the tag reader (assets/js/id3.js).
 *
 * The parser only touches FileReader, TextDecoder and `window`, so it runs
 * under Node with a handful of shims. Run with: node test/tags.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ------------------------------------------------------------- test harness */

let failures = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)})`}`);
}

/* ------------------------------------------------------------------- shims */

class FakeFile {
  constructor(buffer) { this.bytes = Buffer.from(buffer); this.size = this.bytes.length; }
  slice(start, end) { return new FakeFile(this.bytes.subarray(start, end)); }
}

class FakeFileReader {
  readAsArrayBuffer(file) {
    this.result = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.length);
    setTimeout(() => this.onload(), 0);
  }
}

// id3.js assigns to a bare `App`, so `window` has to be the global itself,
// exactly as it is in a browser.
const sandbox = { TextDecoder, FileReader: FakeFileReader, Promise, setTimeout, console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'id3.js'), 'utf8'), sandbox);
const tags = sandbox.App.tags;

/* ------------------------------------------------------------ tag builders */

function syncsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

function id3v23Frame(id, body) {
  const header = Buffer.alloc(10);
  header.write(id, 0, 'latin1');
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function textFrame(id, value) {
  return id3v23Frame(id, Buffer.concat([Buffer.from([0x00]), Buffer.from(value, 'latin1')]));
}

function apicFrame(mime, description, data) {
  return id3v23Frame('APIC', Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from(mime + '\0', 'latin1'),
    Buffer.from([0x03]),
    Buffer.from(description + '\0', 'latin1'),
    data,
  ]));
}

function id3v2Tag(frames) {
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), syncsafe(body.length), body]);
}

function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function dataBox(flag, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(flag, 0);
  return box('data', Buffer.concat([head, payload]));
}

function mp4WithTags({ title, artist, cover }) {
  const items = [];
  if (title) items.push(box('©nam', dataBox(1, Buffer.from(title, 'utf8'))));
  if (artist) items.push(box('©ART', dataBox(1, Buffer.from(artist, 'utf8'))));
  if (cover) items.push(box('covr', dataBox(14, cover)));
  const ilst = box('ilst', Buffer.concat(items));
  const meta = box('meta', Buffer.concat([Buffer.alloc(4), ilst]));
  const udta = box('udta', meta);
  const moov = box('moov', udta);
  const ftyp = box('ftyp', Buffer.from('M4A isom', 'latin1'));
  return Buffer.concat([ftyp, moov]);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/* -------------------------------------------------------------------- runs */

(async () => {
  // ID3v2.3 with text frames and embedded art
  const mp3 = new FakeFile(Buffer.concat([
    id3v2Tag([
      textFrame('TIT2', 'The Lighthouse Cat'),
      textFrame('TPE1', 'Ida'),
      textFrame('TALB', 'Bedtime Stories'),
      apicFrame('image/png', 'cover', PNG),
    ]),
    Buffer.alloc(4096, 0x55),
  ]));
  const a = await tags.read(mp3);
  check('id3: title', a.title, 'The Lighthouse Cat');
  check('id3: artist', a.artist, 'Ida');
  check('id3: album', a.album, 'Bedtime Stories');
  check('id3: picture mime', a.picture && a.picture.type, 'image/png');
  check('id3: picture bytes', a.picture && a.picture.data.byteLength, PNG.length);

  // UTF-16 text, which is what most taggers actually write
  const utf16Body = Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from([0xff, 0xfe]),
    Buffer.from('Seven Sleepy Foxes', 'utf16le'),
  ]);
  const utf16 = new FakeFile(Buffer.concat([
    id3v2Tag([id3v23Frame('TIT2', utf16Body)]),
    Buffer.alloc(64, 0),
  ]));
  const b = await tags.read(utf16);
  check('id3: utf-16 title', b.title, 'Seven Sleepy Foxes');

  // MP4 atoms at the front of the file
  const m4a = new FakeFile(Buffer.concat([
    mp4WithTags({ title: 'Whalesong', artist: 'Ruth', cover: PNG }),
    Buffer.alloc(2048, 0x11),
  ]));
  const c = await tags.read(m4a);
  check('mp4: title', c.title, 'Whalesong');
  check('mp4: artist', c.artist, 'Ruth');
  check('mp4: cover mime', c.picture && c.picture.type, 'image/png');

  // M4B style: metadata parked at the very end, past the 1 MiB head window
  const tail = mp4WithTags({ title: 'Mira and the Paper Boat', artist: 'Sam' });
  const m4b = new FakeFile(Buffer.concat([Buffer.alloc(1024 * 1024 + 4096, 0x22), tail]));
  const d = await tags.read(m4b);
  check('m4b: title found in the tail', d.title, 'Mira and the Paper Boat');
  check('m4b: artist found in the tail', d.artist, 'Sam');

  // Untagged audio must come back empty rather than throwing
  const bare = new FakeFile(Buffer.alloc(8192, 0xaa));
  const e = await tags.read(bare);
  check('untagged: no title', e.title, undefined);

  // Truncated tag must not throw
  const broken = new FakeFile(Buffer.concat([
    Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), syncsafe(9999), Buffer.alloc(12, 0xff),
  ]));
  const f = await tags.read(broken);
  check('malformed: returns an object', typeof f, 'object');

  console.log(failures ? `\n${failures} failing` : '\nAll tag tests passed.');
  process.exit(failures ? 1 : 0);
})();
