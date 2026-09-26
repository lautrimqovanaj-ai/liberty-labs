// server.js – serves the website (public/) and state.json from the same process as the bot.
// No second host needed: one Railway/Render/VPS instance = bot + website + live data.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };

export function startServer({ root = 'public', statePath = null, port = Number(process.env.PORT || 3000), log = console } = {}) {
  const base = resolve(root);
  const stateFile = statePath ? resolve(statePath) : null;   // state.json may live outside public/ (persistent volume)
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      if (path === '/' || path === '\\') path = '/index.html';
      const file = (path === '/state.json' && stateFile) ? stateFile : join(base, path);
      if (file !== stateFile && !file.startsWith(base)) { res.writeHead(403); return res.end(); }
      const info = await stat(file).catch(() => null);
      if (!info || !info.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
      const ext = extname(file).toLowerCase();
      const headers = { 'content-type': TYPES[ext] || 'application/octet-stream', 'access-control-allow-origin': '*' };
      headers['cache-control'] = ext === '.json' ? 'no-store' : 'public, max-age=300';
      res.writeHead(200, headers);
      res.end(await readFile(file));
    } catch (e) { res.writeHead(500); res.end('error'); }
  });
  server.listen(port, () => log.log(`Website + state.json online on port ${port} (folder ${base})`));
  return server;
}
