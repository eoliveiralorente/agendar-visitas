'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('./config');
const { createStore } = require('./store');
const { createAuth } = require('./auth');
const gcal = require('./gcal');

const store = createStore(config);
const auth = createAuth(config);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 300 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: https://*.googleusercontent.com",
    "connect-src 'self'",
    'frame-src https://www.google.com https://maps.google.com',
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

function send(res, status, body, headers) {
  const h = Object.assign({}, SEC_HEADERS, headers || {});
  if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
    body = JSON.stringify(body);
    h['Content-Type'] = 'application/json; charset=utf-8';
    h['Cache-Control'] = 'no-store';
  }
  res.writeHead(status, h);
  res.end(body);
}
function redirect(res, to, cookies) {
  const h = { Location: to };
  if (cookies) h['Set-Cookie'] = cookies;
  send(res, 302, '', h);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('corpo grande demais'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

async function currentUser(req) {
  const uid = auth.sessionUid(req);
  if (!uid) return null;
  const u = await store.getUser(uid);
  if (!u || !auth.isAllowed(u.email)) return null;
  return u;
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'proibido');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'não encontrado');
    const ext = path.extname(file);
    send(res, 200, buf, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
  });
}

/* ---------------- rotas ---------------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  if (p === '/healthz') return send(res, 200, 'ok');
  if (p === '/readyz') {
    try { await store.ping(); return send(res, 200, 'ok'); } catch { return send(res, 503, 'db indisponível'); }
  }

  /* ---- login com Google ---- */
  if (p === '/auth/google' && m === 'GET') {
    if (!config.google.clientId) return send(res, 500, 'Login Google não configurado (GOOGLE_CLIENT_ID).');
    const state = crypto.randomBytes(16).toString('hex');
    return redirect(res, auth.authUrl(state, url.searchParams.get('consent') === '1'),
      [auth.cookie('oauth_state', state, { maxAge: 600 })]);
  }
  if (p === '/auth/callback' && m === 'GET') {
    const cookies = auth.parseCookies(req);
    const clearState = auth.cookie('oauth_state', '', { maxAge: 0 });
    if (url.searchParams.get('error')) return redirect(res, '/?erro=login_cancelado', [clearState]);
    const state = url.searchParams.get('state');
    if (!state || state !== cookies.oauth_state) return redirect(res, '/?erro=sessao_expirada', [clearState]);
    try {
      const r = await auth.exchangeCode(url.searchParams.get('code'));
      if (!auth.isAllowed(r.user.email)) return redirect(res, '/?erro=sem_permissao', [clearState]);
      await store.upsertUser(r.user);
      const prev = await store.getUser(r.user.id);
      const tokens = { accessToken: auth.encrypt(r.accessToken), tokenExpiry: r.expiresAt };
      if (r.refreshToken) tokens.refreshToken = auth.encrypt(r.refreshToken);
      await store.setTokens(r.user.id, tokens);
      // Sem refresh token guardado: pede o consentimento de novo para o Google enviar um.
      if (!r.refreshToken && !(prev && prev.refreshToken)) {
        return redirect(res, '/auth/google?consent=1', [clearState]);
      }
      return redirect(res, '/', [clearState, auth.sessionCookie(r.user.id)]);
    } catch (e) {
      console.error('[auth] callback:', e.message);
      return redirect(res, '/?erro=falha_login', [clearState]);
    }
  }
  if (p === '/auth/dev' && m === 'GET' && config.devLogin) {
    const email = String(url.searchParams.get('email') || 'dev@example.com').toLowerCase();
    const name = url.searchParams.get('name') || email.split('@')[0];
    const id = 'dev_' + crypto.createHash('sha1').update(email).digest('hex').slice(0, 12);
    await store.upsertUser({ id, email, name, picture: '' });
    return redirect(res, '/', [auth.sessionCookie(id)]);
  }
  if (p === '/auth/logout' && (m === 'POST' || m === 'GET')) {
    return redirect(res, '/', [auth.clearSessionCookie()]);
  }

  /* ---- API ---- */
  if (p.startsWith('/api/')) {
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'not_logged_in' });
    if (m !== 'GET' && req.headers['x-requested-with'] !== 'fetch') return send(res, 403, { error: 'csrf' });

    if (p === '/api/me' && m === 'GET') {
      return send(res, 200, { id: user.id, email: user.email, name: user.name, picture: user.picture, googleCalendar: !!user.refreshToken || config.devLogin, devLogin: config.devLogin });
    }
    if (p === '/api/users' && m === 'GET') return send(res, 200, await store.listUsers());
    if (p === '/api/data' && m === 'GET') return send(res, 200, await store.listAll());

    const dm = p.match(/^\/api\/data\/([a-z]+)\/([^/]+)$/);
    if (dm) {
      const col = dm[1];
      const id = decodeURIComponent(dm[2]);
      if (m === 'PUT') {
        const body = await readJson(req);
        delete body.id;
        return send(res, 200, await store.put(col, id, body, user.id));
      }
      if (m === 'PATCH') {
        const body = await readJson(req);
        delete body.id;
        const out = await store.merge(col, id, body, user.id);
        return out ? send(res, 200, out) : send(res, 404, { error: 'not_found' });
      }
      if (m === 'DELETE') {
        await store.del(col, id);
        return send(res, 204, '');
      }
    }

    if (p === '/api/gcal/events' && m === 'POST') {
      const ev = await readJson(req);
      if (config.devLogin && !config.google.clientId) {
        return send(res, 200, { id: 'dev-' + Date.now(), htmlLink: '', dev: true });
      }
      try {
        const token = await auth.accessTokenFor(store, user.id);
        return send(res, 200, await gcal.createEvent(token, ev, config.timeZone));
      } catch (e) {
        const code = e.code || 'google_error';
        return send(res, e.status || (code === 'needs_reauth' ? 401 : 502), { error: code, message: e.message });
      }
    }
    return send(res, 404, { error: 'not_found' });
  }

  if (m === 'GET' || m === 'HEAD') return serveStatic(req, res, p);
  return send(res, 405, 'método não permitido');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) console.error('[erro]', req.method, req.url, e);
    if (!res.headersSent) send(res, status, { error: status >= 500 ? 'internal' : 'bad_request', message: status >= 500 ? 'Erro interno' : e.message });
  });
});

async function start() {
  await store.init();
  server.listen(config.port, () => {
    console.log(`[agenda-visitas] ouvindo na porta ${config.port} · armazenamento: ${store.kind} · ${config.baseUrl}`);
  });
}
function shutdown(sig) {
  console.log(`[agenda-visitas] ${sig} recebido, encerrando…`);
  server.close(() => store.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  start().catch((e) => { console.error('[agenda-visitas] falha ao iniciar:', e); process.exit(1); });
}

module.exports = { server, start, store };
