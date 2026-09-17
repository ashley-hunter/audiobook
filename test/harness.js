#!/usr/bin/env node
/* Bedtime - what the browser suites share.
 *
 * The suites are split so they can run at the same time. They have nothing in
 * common but these fixtures and this bookkeeping, and each one spends most of
 * its life waiting on audio, so waiting on four at once costs no more than
 * waiting on the longest.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// A mono WAV of the given length, big enough at 40 seconds to land in more
// than one 1 MiB chunk.
function writeWav(file, seconds) {
  const rate = 22050;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return 44 + data.length;
}

/* Three stories to import: one that spans several chunks, one over the 4 MiB
 * window the service worker answers in, and a second short one for the queue.
 */
function fixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bedtime-'));
  const first = path.join(dir, 'Sleepy Foxes.wav');
  const big = path.join(dir, 'The Button Kingdom.wav');
  const second = path.join(dir, 'Moon Boat.wav');
  const firstBytes = writeWav(first, 40);
  const bigBytes = writeWav(big, 130);
  writeWav(second, 25);
  return { dir, first, firstBytes, big, bigBytes, second };
}

/* Cover art lookup is on by default, so every context that is not testing it
 * would otherwise reach for itunes.apple.com. The app handles that failing -
 * that is what the unit tests cover - but the browser still logs a network
 * error for it, which would blunt the "no console errors" assertions. Failing
 * the fetch in the page keeps those assertions strict and the lookup honest:
 * this is exactly what a phone with no signal presents.
 */
const NO_ARTWORK_HOSTS = () => {
  const real = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = String(input && input.url ? input.url : input);
    if (url.indexOf('itunes.apple.com') >= 0 || url.indexOf('openlibrary.org') >= 0) {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    return real(input, init);
  };
};

/* Results are collected and printed at the end, so a suite reads as one list
 * rather than interleaved with whatever Playwright has to say.
 */
function reporter() {
  const log = [];
  let failed = 0;
  return {
    log,
    check(name, ok, detail) {
      if (!ok) failed++;
      log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
    },
    finish(what) {
      console.log(log.join('\n'));
      console.log(failed ? `\n${failed} failing` : `\nAll ${what} tests passed.`);
      process.exit(failed ? 1 : 0);
    },
    threw(err) {
      console.log(log.join('\n'));
      console.error('\nThrew: ' + err.message);
      process.exit(1);
    },
  };
}

// Chromium, told not to demand a gesture before it will play audio.
function launchOptions() {
  const launch = { args: ['--autoplay-policy=no-user-gesture-required'] };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  return launch;
}

module.exports = { writeWav, fixtures, NO_ARTWORK_HOSTS, reporter, launchOptions };
