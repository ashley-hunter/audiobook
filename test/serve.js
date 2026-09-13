#!/usr/bin/env node
/* Static server for local testing.
 *
 * Service workers need a secure context, and http://localhost counts as one,
 * so this is enough to exercise the real storage and streaming paths.
 *
 *   node test/serve.js [port] [basePath]
 *
 * `basePath` mounts the site under a subdirectory, which is how GitHub Pages
 * serves a project site (https://user.github.io/<repo>/). Running against that
 * shape is the only way to catch an absolute path that works locally and
 * breaks the moment it is deployed.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2], 10) || 8777;
const BASE = process.argv[3] || '/';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
};

function createServer(options) {
  const opts = options || {};
  const root = path.resolve(opts.root || DEFAULT_ROOT);
  let base = opts.base || '/';
  if (base.charAt(0) !== '/') base = '/' + base;
  if (base.charAt(base.length - 1) !== '/') base += '/';

  return http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);

    if (rel.indexOf(base) !== 0) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Outside the base path');
      return;
    }
    rel = '/' + rel.slice(base.length);
    if (rel === '/') rel = '/index.html';

    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Service-Worker-Allowed': base,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
}

// Only bind a port when run directly; the test suites listen on their own.
if (require.main === module) {
  createServer({ base: BASE }).listen(PORT, () => {
    console.log(`Bedtime on http://127.0.0.1:${PORT}${BASE}`);
  });
}

module.exports = createServer;
