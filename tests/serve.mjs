// Minimal static preview server: `npm start` then open http://localhost:4173
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };
const root = process.cwd();
const PORT = Number(process.env.PORT) || 4173;
http.createServer((req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  if (!p) p = 'index.html';
  const f = join(root, p);
  if (!f.startsWith(root) || /node_modules|\.git/.test(p) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=600' });
  let body = readFileSync(f);
  // Local contact-form development only (npm run dev:contact): allow the local mock API in the page CSP.
  if (process.env.CONTACT_DEV === '1' && (p === 'index.html' || p === 'verify.html')) body = Buffer.from(body.toString('utf8').replace("connect-src 'self' https://api.nuray.io", "connect-src 'self' https://api.nuray.io http://localhost:8787"));
  res.end(body);
}).listen(PORT, () => console.log('http://localhost:' + PORT));
