#!/usr/bin/env node
/* Static server for local testing.
 *
 * Service workers need a secure context, and http://localhost counts as one,
 * so this is enough to exercise the real storage and streaming paths.
 *
 *   node test/serve.js [port]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2], 10) || 8777;

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

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, rel);

  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Service-Worker-Allowed': '/',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

// Only bind a port when run directly; the test suite listens on its own port.
if (require.main === module) {
  server.listen(PORT, () => console.log(`Bedtime on http://127.0.0.1:${PORT}`));
}

module.exports = server;
