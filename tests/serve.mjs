// Minimal static preview server: `npm start` then open http://localhost:4173
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.xml': 'application/xml' };
const root = process.cwd();
http.createServer((req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  if (!p) p = 'index.html';
  const f = join(root, p);
  if (!f.startsWith(root) || /node_modules|\.git/.test(p) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=600' });
  res.end(readFileSync(f));
}).listen(4173, () => console.log('http://localhost:4173'));
