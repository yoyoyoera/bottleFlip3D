import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';
import { attachMultiplayer } from './multiplayer.js';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(resolve(root) + sep)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
attachMultiplayer(server);
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`Bottle Flip 3D: http://${host}:${port}`));
