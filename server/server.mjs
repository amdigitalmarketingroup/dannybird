// Danny Bird — scoreboard API (aislado, sin Supabase). Node http + node:sqlite.
// Archivo propio scores.db → no toca ninguna otra base/infra. Detrás de Traefik
// en https://dannybird.25ocho.agency/api (mismo origen que el juego → sin CORS real,
// igual mando headers CORS por si se prueba desde otro origen).
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(join(__dir, 'scores.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    score INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS scores_top ON scores(score DESC, id ASC);
`);
// ranking = el MEJOR score de cada nombre (highscore), sin duplicados
const qTop = db.prepare('SELECT name, MAX(score) AS score FROM scores GROUP BY name ORDER BY score DESC, MIN(id) ASC LIMIT ?');
const qInsert = db.prepare('INSERT INTO scores (name, score) VALUES (?, ?)');
const qRank = db.prepare('SELECT COUNT(*) + 1 AS rank FROM (SELECT name, MAX(score) AS m FROM scores GROUP BY name) WHERE m > ?');

// rate-limit anti-spam por IP: máx 20 envíos / 60s (en memoria, suficiente)
const hits = new Map();
function rateOk(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= 20) { hits.set(ip, recent); return false; }
  recent.push(now); hits.set(ip, recent);
  return true;
}
// nombre: máx 5, solo A-Z 0-9 (mayúsculas). Sanitiza server-side (no confiar en cliente).
const cleanName = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(obj == null ? '' : JSON.stringify(obj));
}

const server = createServer((req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.method === 'OPTIONS') return send(res, 204, null);
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, { error: 'url' }); }

  if (req.method === 'GET' && url.pathname === '/api/scores') {
    let limit = parseInt(url.searchParams.get('limit') || '10', 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 10;
    limit = Math.min(limit, 50);
    try { return send(res, 200, { scores: qTop.all(limit) }); }
    catch (e) { console.error('[GET /api/scores]', e.message); return send(res, 500, { error: 'db' }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/scores') {
    if (!rateOk(ip)) return send(res, 429, { error: 'rate' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1000) req.destroy(); });
    req.on('end', () => {
      try {
        const { name, score } = JSON.parse(body || '{}');
        const n = cleanName(name);
        const s = Math.floor(Number(score));
        if (!n) return send(res, 400, { error: 'name' });
        if (!Number.isFinite(s) || s < 0 || s > 100000) return send(res, 400, { error: 'score' });
        qInsert.run(n, s);
        return send(res, 201, { ok: true, name: n, score: s, rank: qRank.get(s).rank, scores: qTop.all(10) });
      } catch (e) { console.error('[POST /api/scores]', e.message); return send(res, 400, { error: 'bad' }); }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true });
  return send(res, 404, { error: 'not found' });
});

const HOST = process.env.HOST || '172.18.0.1'; // bridge gateway: alcanzable por Traefik, NO público
const PORT = parseInt(process.env.PORT || '3210', 10);
server.listen(PORT, HOST, () => console.log(`[dannybird-api] escuchando en http://${HOST}:${PORT}`));
