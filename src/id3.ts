/* Bedtime - audio tag reading.
 *
 * Pulls title / artist / cover art out of an imported file so the library
 * shows "The Lighthouse Cat, read by Ida" instead of "track_04_final.mp3".
 * Handles ID3v2.2/2.3/2.4 (MP3) and the iTunes metadata atoms (M4A/M4B).
 * Anything it cannot read simply comes back empty and the filename is used.
 */
window.App = window.App || ({} as typeof App);

App.tags = (function (): TagsModule {
  'use strict';

  var HEAD_BYTES = 1024 * 1024; // tags at the front of the file
  var TAIL_BYTES = 512 * 1024;  // M4B files often park `moov` at the end

  var ATOM_NAME = '©nam';
  var ATOM_ARTIST = '©ART';
  var ATOM_ALBUM = '©alb';

  function decode(bytes: Uint8Array, encoding: number): string {
    if (!bytes || !bytes.length) return '';
    var label = encoding === 1 ? 'utf-16' : encoding === 2 ? 'utf-16be' : encoding === 3 ? 'utf-8' : 'iso-8859-1';
    if (window.TextDecoder) {
      try {
        return new TextDecoder(label).decode(bytes).replace(/\u0000+$/, '').trim();
      } catch (err) { void err; }
    }
    var out = '';
    for (var i = 0; i < bytes.length; i++) if (bytes[i]) out += String.fromCharCode(bytes[i]);
    return out.trim();
  }

  function readSyncsafe(view: DataView, offset: number): number {
    return ((view.getUint8(offset) & 0x7f) << 21) | ((view.getUint8(offset + 1) & 0x7f) << 14)
         | ((view.getUint8(offset + 2) & 0x7f) << 7) | (view.getUint8(offset + 3) & 0x7f);
  }

  function ascii(bytes: Uint8Array, offset: number, length: number): string {
    var out = '';
    for (var i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
    return out;
  }

  /* -------------------------------------------------------------- ID3v2 */

  function parseId3(bytes: Uint8Array): Tags | null {
    if (bytes.length < 10 || ascii(bytes, 0, 3) !== 'ID3') return null;
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var major = bytes[3];
    var flags = bytes[5];
    var size = readSyncsafe(view, 6);
    var pos = 10;
    var end = Math.min(bytes.length, 10 + size);
    if (flags & 0x40) { // extended header
      if (pos + 4 > end) return null;
      pos += major === 4 ? readSyncsafe(view, pos) : view.getUint32(pos) + 4;
    }

    var small = major === 2;
    var idLen = small ? 3 : 4;
    var headerLen = small ? 6 : 10;
    var out: Tags = {};

    while (pos + headerLen <= end) {
      var id = ascii(bytes, pos, idLen);
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
      var frameSize;
      if (small) {
        frameSize = (bytes[pos + 3] << 16) | (bytes[pos + 4] << 8) | bytes[pos + 5];
      } else if (major === 4) {
        frameSize = readSyncsafe(view, pos + 4);
      } else {
        frameSize = view.getUint32(pos + 4);
      }
      var body = pos + headerLen;
      if (frameSize <= 0 || body + frameSize > end) break;
      var frame = bytes.subarray(body, body + frameSize);

      if (id === 'TIT2' || id === 'TT2') out.title = decode(frame.subarray(1), frame[0]);
      else if (id === 'TPE1' || id === 'TP1') out.artist = decode(frame.subarray(1), frame[0]);
      else if (id === 'TALB' || id === 'TAL') out.album = decode(frame.subarray(1), frame[0]);
      else if (id === 'APIC' || id === 'PIC') out.picture = out.picture || parsePicture(frame, id === 'PIC');

      pos = body + frameSize;
    }
    return out;
  }

  function parsePicture(frame: Uint8Array, short: boolean): { type: string; data: ArrayBuffer } | null {
    var encoding = frame[0];
    var i = 1;
    var mime;
    if (short) {
      mime = ascii(frame, 1, 3).toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
      i = 4;
    } else {
      var start = i;
      while (i < frame.length && frame[i] !== 0) i++;
      mime = decode(frame.subarray(start, i), 0) || 'image/jpeg';
      i++;
    }
    i++; // picture type byte
    // description, terminated by one or two NULs depending on the encoding
    if (encoding === 1 || encoding === 2) {
      while (i + 1 < frame.length && !(frame[i] === 0 && frame[i + 1] === 0)) i += 2;
      i += 2;
    } else {
      while (i < frame.length && frame[i] !== 0) i++;
      i++;
    }
    if (i >= frame.length) return null;
    return { type: mime, data: frame.slice(i).buffer };
  }

  /* ---------------------------------------------------------------- MP4 */

  function parseMp4(bytes: Uint8Array): Tags | null {
    var out: Tags = {};
    walk(bytes, 0, bytes.length, 0, false);
    // A tail window starts mid-box, so when the ordinary walk finds nothing,
    // look for the container by name and walk from there instead.
    if (!found()) scanFrom('moov');
    if (!found()) scanFrom('ilst');
    return found() ? out : null;

    function found(): boolean { return !!(out.title || out.artist || out.picture); }

    function scanFrom(tag: string): void {
      for (var i = 4; i + 4 <= bytes.length; i++) {
        if (bytes[i] !== tag.charCodeAt(0)) continue;
        if (ascii(bytes, i, 4) !== tag) continue;
        walk(bytes, i - 4, bytes.length, 0, true);
        if (found()) return;
      }
    }

    // `lenient` clamps a box that runs past the end of a truncated window,
    // which is exactly the case when reading the tail of an M4B.
    function walk(buf: Uint8Array, start: number, end: number, depth: number, lenient: boolean): void {
      var view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      var pos = start;
      while (pos + 8 <= end && depth < 8) {
        var size = view.getUint32(pos);
        var type = ascii(buf, pos + 4, 4);
        var body = pos + 8;
        if (size === 1) { // 64-bit size: only the low word is used here
          size = view.getUint32(pos + 12);
          body = pos + 16;
        }
        if (size < 8) return;
        if (pos + size > end) {
          if (!lenient) return;
          size = end - pos;
        }
        var boxEnd = pos + size;

        if (type === 'moov' || type === 'udta' || type === 'ilst' || type === 'trak' || type === 'mdia') {
          walk(buf, body, boxEnd, depth + 1, lenient);
        } else if (type === 'meta') {
          walk(buf, body + 4, boxEnd, depth + 1, lenient); // meta carries 4 extra version/flag bytes
        } else if (type === ATOM_NAME || type === ATOM_ARTIST || type === ATOM_ALBUM || type === 'covr') {
          readData(buf, view, body, boxEnd, type);
        }
        pos = boxEnd;
      }
    }

    function readData(buf: Uint8Array, view: DataView, start: number, end: number, type: string): void {
      var pos = start;
      while (pos + 8 <= end) {
        var size = view.getUint32(pos);
        var boxType = ascii(buf, pos + 4, 4);
        if (size < 16 || pos + size > end) return;
        if (boxType === 'data') {
          var flag = view.getUint32(pos + 8) & 0xffffff;
          var payload = buf.subarray(pos + 16, pos + size);
          if (type === 'covr') {
            if (!out.picture) {
              out.picture = { type: flag === 14 ? 'image/png' : 'image/jpeg', data: payload.slice().buffer };
            }
          } else {
            var text = decode(payload, 3);
            if (type === ATOM_NAME) out.title = out.title || text;
            else if (type === ATOM_ARTIST) out.artist = out.artist || text;
            else out.album = out.album || text;
          }
        }
        pos += size;
      }
    }
  }

  /* -------------------------------------------------------------- public */

  function readSlice(file: File, start: number, length: number): Promise<Uint8Array | null> {
    var slice = file.slice(start, Math.min(file.size, start + length));
    return App.caps.readArrayBuffer(slice).then(function (buffer) {
      return new Uint8Array(buffer);
    })['catch'](function () { return null; });
  }

  // Returns { title, artist, album, picture } - every field optional.
  function read(file: File): Promise<Tags> {
    return readSlice(file, 0, HEAD_BYTES).then(function (head) {
      if (!head) return {};
      var tags: Tags | null = null;
      try { tags = parseId3(head) || parseMp4(head); } catch (err) { void err; }
      if (tags && (tags.title || tags.picture)) return tags;
      if (file.size <= HEAD_BYTES) return tags || {};
      // M4B commonly stores `moov` last, so take one more look at the tail.
      return readSlice(file, Math.max(0, file.size - TAIL_BYTES), TAIL_BYTES).then(function (tail) {
        if (!tail) return tags || {};
        var late: Tags | null = null;
        try { late = parseMp4(tail); } catch (err) { void err; }
        return late || tags || {};
      });
    })['catch'](function () { return {}; });
  }

  return { read: read };
})();
