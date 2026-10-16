import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const COOKIE = '__Host-previsit-access';
const idPattern = '[A-Za-z0-9_-]+';
const hash = (text) => createHash('sha256').update(text).digest();
const same = (a, b) => timingSafeEqual(hash(a), hash(b));

// This gateway serves the production UI, not Vite's development file server.
// Default-deny API routing keeps existing cases, recordings and doctor endpoints
// protected while a visitor can create and access only their own new sessions.
export function createPublicGateway({
  apiBase = 'http://127.0.0.1:4176',
  distRoot = resolve('web/dist'),
  access = JSON.parse(readFileSync('server/data/run/cpolar-clinician-access.json', 'utf8')),
  accessDbPath = resolve('server/data/run/public-session-access.db'),
} = {}) {
  if (!access.username || !access.password) throw new Error('Staff access credentials are required');
  if (!existsSync(join(distRoot, 'index.html'))) throw new Error('Build the production UI first');
  mkdirSync(dirname(accessDbPath), { recursive: true });
  const db = new Database(accessDbPath);
  chmodSync(accessDbPath, 0o600);
  db.exec(`CREATE TABLE IF NOT EXISTS session_access (session_id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS media_access (media_id TEXT PRIMARY KEY, session_id TEXT NOT NULL);`);
  const credential = `${access.username}:${access.password}`;
  const invitationKey = createHmac('sha256', credential).update('previsit-case-invitation-v1').digest();
  const owns = (sessionId, owner) => Boolean(owner && db.prepare('SELECT 1 FROM session_access WHERE session_id=? AND owner_hash=?').get(sessionId, hash(owner).toString('hex')));
  const isStaff = (req) => {
    const match = /^Basic ([A-Za-z0-9+/=]{1,2048})$/i.exec(req.headers.authorization ?? '');
    return Boolean(match && same(Buffer.from(match[1], 'base64').toString('utf8'), credential));
  };
  const sign = (payload) => {
    const value = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${value}.${createHmac('sha256', invitationKey).update(value).digest('base64url')}`;
  };
  function validInvitation(token, body) {
    if (typeof token !== 'string' || token.length > 2000) return false;
    const parts = token.split('.');
    if (parts.length !== 2 || !same(parts[1], createHmac('sha256', invitationKey).update(parts[0]).digest('base64url'))) return false;
    try {
      const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      return data.caseId === body.caseId && data.role === (body.speakerRole ?? body.profile?.respondent)
        && Number.isFinite(data.expiresAt) && data.expiresAt > Date.now();
    } catch { return false; }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Previsit-Access', 'visitor-scoped');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url, 'http://gateway.local');
      const path = decodeURIComponent(url.pathname);
      const method = req.method;
      if (!['GET', 'HEAD', 'POST', 'PATCH', 'OPTIONS'].includes(method)) return json(res, 405, { error: 'Method not allowed' });
      // Reject cross-origin writes, including authenticated form-based CSRF.
      if (['POST', 'PATCH'].includes(method) && req.headers.origin) {
        const origin = new URL(req.headers.origin);
        const requestedHost = String(req.headers['x-forwarded-host'] ?? req.headers.host).split(',')[0].trim();
        if (origin.host !== requestedHost && origin.host !== 'childpsych-previsit-a001.vip.cpolar.cn') return json(res, 403, { error: 'Cross-origin writes are not allowed' });
      }
      if (method === 'OPTIONS') return json(res, 403, { error: 'Cross-origin access is not allowed' });
      const staff = isStaff(req);
      const owner = cookieOwner(req.headers.cookie);
      if (path === '/health' && ['GET', 'HEAD'].includes(method)) return await proxy();
      if (path === '/api/previsit/access/invitations' && method === 'POST') {
        if (!staff) return staffRequired(res);
        const body = await readJson(req);
        if (!new RegExp(`^${idPattern}$`).test(body.caseId ?? '') || !['child', 'guardian'].includes(body.role)) return json(res, 400, { error: 'A valid case and role are required' });
        const upstream = await fetch(`${apiBase}/api/previsit/clinician/cases/${body.caseId}`, { signal: AbortSignal.timeout(10_000) });
        if (!upstream.ok) return json(res, 404, { error: 'Case not found' });
        await upstream.body?.cancel();
        return json(res, 200, { token: sign({ caseId: body.caseId, role: body.role, expiresAt: Date.now() + 7 * 86400_000, nonce: randomBytes(12).toString('hex') }) });
      }
      if (path.startsWith('/api/')) {
        if (staff) return await proxy(['POST', 'PATCH'].includes(method) ? await readJson(req) : undefined);
        if (method === 'POST' && path === '/api/previsit/tts') return await proxy(await readJson(req));
        if (method === 'POST' && path === '/api/previsit/sessions') {
          const body = await readJson(req);
          if (body.caseId && !validInvitation(body.caseInvitation, body)) return json(res, 403, { error: '请使用医生提供的有效病例入口，或从普通访谈入口开始。' });
          delete body.caseInvitation;
          const visitor = owner ?? randomBytes(32).toString('hex');
          return await proxy(body, (data) => {
            const sessionId = data.session?.sessionId;
            if (!sessionId) throw new Error('Session response is missing its identifier');
            db.prepare('INSERT INTO session_access(session_id,owner_hash) VALUES(?,?)').run(sessionId, hash(visitor).toString('hex'));
            res.setHeader('Set-Cookie', `${COOKIE}=${visitor}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
          });
        }
        if (method === 'POST' && ['/api/previsit/turns', '/api/previsit/media'].includes(path)) {
          const body = await readJson(req);
          if (!owns(body.sessionId, owner)) return json(res, 403, { error: '无权访问此会话。' });
          return await proxy(body, path.endsWith('/media') ? (data) => {
            if (data.mediaRecord?.sessionId !== body.sessionId) throw new Error('Media ownership mismatch');
            db.prepare('INSERT INTO media_access(media_id,session_id) VALUES(?,?)').run(data.mediaRecord.mediaId, body.sessionId);
          } : undefined);
        }
        const getSession = new RegExp(`^/api/previsit/(?:sessions|packet|evidence|media)/(${idPattern})$`).exec(path);
        const modifySession = new RegExp(`^/api/previsit/(?:sessions/(${idPattern})/stop|packet/(${idPattern})/generate)$`).exec(path);
        const blob = new RegExp(`^/api/previsit/media/blob/(${idPattern})$`).exec(path);
        if (method === 'GET' && getSession || method === 'POST' && modifySession) {
          const sessionId = getSession?.[1] ?? modifySession?.[1] ?? modifySession?.[2];
          if (!owns(sessionId, owner)) return json(res, 403, { error: '无权访问此会话。' });
          return await proxy(method === 'POST' ? await readJson(req) : undefined);
        }
        if (['GET', 'HEAD'].includes(method) && blob) {
          const row = db.prepare('SELECT session_id FROM media_access WHERE media_id=?').get(blob[1]);
          if (!row || !owns(row.session_id, owner)) return json(res, 403, { error: '无权访问此录音。' });
          return await proxy();
        }
        return staffRequired(res);
      }
      if (!['GET', 'HEAD'].includes(method)) return json(res, 405, { error: 'Method not allowed' });
      if (['/clinician', '/doctor'].includes(path) && !staff) return staffRequired(res);
      if (['/', '/child', '/guardian', '/clinician', '/doctor', '/index.html'].includes(path)) return staticFile('index.html');
      // Only hashed build assets are public. No /@fs, source, .env, database,
      // media file-system path, source map or arbitrary file proxy is exposed.
      if (/^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|png|jpe?g|svg|webp|woff2?)$/.test(path)) return staticFile(path.slice(1));
      return json(res, 404, { error: 'Not found' });

      async function proxy(body, onSuccess) {
        const upstream = await fetch(`${apiBase}${url.pathname}${url.search}`, {
          method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(req.headers.range ? { range: req.headers.range } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(12 * 60_000),
        });
        const payload = Buffer.from(await upstream.arrayBuffer());
        if (upstream.ok && onSuccess) onSuccess(JSON.parse(payload.toString('utf8')));
        for (const name of ['content-type', 'content-range', 'accept-ranges']) if (upstream.headers.has(name)) res.setHeader(name, upstream.headers.get(name));
        res.setHeader('Cache-Control', 'no-store');
        res.statusCode = upstream.status;
        res.end(method === 'HEAD' ? undefined : payload);
      }
      function staticFile(relative) {
        const filename = join(distRoot, relative);
        if (!existsSync(filename) || !statSync(filename).isFile()) return json(res, 404, { error: 'Not found' });
        res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2' })[extname(filename)] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.end(method === 'HEAD' ? undefined : readFileSync(filename));
      }
    } catch (error) {
      if (!res.headersSent) json(res, error.statusCode ?? 502, { error: error.statusCode ? error.message : '暂时无法连接服务，请稍后重试。' });
      else res.destroy();
    }
  });
  server.on('close', () => db.close());
  return server;
}

function cookieOwner(value = '') {
  const matches = value.split(';').map((item) => item.trim()).filter((item) => item.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return null;
  const owner = matches[0].slice(COOKIE.length + 1);
  return /^[0-9a-f]{64}$/.test(owner) ? owner : null;
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function staffRequired(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="ChildPsych clinician", charset="UTF-8"');
  return json(res, 401, { error: '医生端及已有病例需要身份验证。' });
}
async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw Object.assign(new Error('JSON body required'), { statusCode: 415 });
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 250 * 1024 * 1024) throw Object.assign(new Error('Request is too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON object required');
    return body;
  }
  catch { throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createPublicGateway();
  server.listen(Number(process.env.PREVISIT_PUBLIC_PORT ?? 5178), '127.0.0.1', () => console.log('Public interview gateway ready'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
