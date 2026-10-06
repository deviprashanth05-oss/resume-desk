// Tiny server for local use or any Node host (Render, Railway, Fly.io, a VPS). On Vercel this file is not used.
const http = require('http'), fs = require('fs'), path = require('path');
const handler = require('./api/ai.js');
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/ai') {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 9e6) req.destroy(); else chunks.push(c); });
    req.on('end', () => { try { req.body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { req.body = null; } handler(req, res); });
    return;
  }
  const file = path.join(PUB, url === '/' ? 'index.html' : path.normalize(url).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(PUB)) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (e, d) => { if (e) { res.statusCode = 404; return res.end('Not found'); } res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream'); res.end(d); });
}).listen(PORT, () => console.log('Resume Desk running on http://localhost:' + PORT));
