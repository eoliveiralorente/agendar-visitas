'use strict';
const crypto = require('node:crypto');

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.events',
];

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function createAuth(config) {
  const hmacKey = crypto.createHash('sha256').update(config.sessionSecret + ':session').digest();
  const encKey = crypto.createHash('sha256').update(config.sessionSecret + ':tokens').digest();

  function sign(payload) {
    const body = b64url(JSON.stringify(payload));
    const mac = b64url(crypto.createHmac('sha256', hmacKey).update(body).digest());
    return body + '.' + mac;
  }
  function verify(token) {
    if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
    const [body, mac] = token.split('.');
    const expect = b64url(crypto.createHmac('sha256', hmacKey).update(body).digest());
    const a = Buffer.from(mac || '');
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const p = JSON.parse(fromB64url(body).toString('utf8'));
      if (!p.exp || p.exp < Date.now()) return null;
      return p;
    } catch {
      return null;
    }
  }

  // Tokens do Google ficam cifrados no banco (AES-256-GCM).
  function encrypt(text) {
    if (!text) return null;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return ['v1', b64url(iv), b64url(c.getAuthTag()), b64url(enc)].join('.');
  }
  function decrypt(s) {
    if (!s) return null;
    try {
      const [v, iv, tag, enc] = String(s).split('.');
      if (v !== 'v1') return null;
      const d = crypto.createDecipheriv('aes-256-gcm', encKey, fromB64url(iv));
      d.setAuthTag(fromB64url(tag));
      return Buffer.concat([d.update(fromB64url(enc)), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  function cookie(name, value, opts) {
    opts = opts || {};
    const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (config.cookieSecure) parts.push('Secure');
    if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
    return parts.join('; ');
  }
  function parseCookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach((p) => {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out;
  }

  function sessionCookie(uid) {
    const maxAge = config.sessionDays * 86400;
    return cookie('sid', sign({ uid, exp: Date.now() + maxAge * 1000 }), { maxAge });
  }
  function clearSessionCookie() {
    return cookie('sid', '', { maxAge: 0 });
  }
  function sessionUid(req) {
    const p = verify(parseCookies(req).sid);
    return p ? p.uid : null;
  }

  function isAllowed(email) {
    const e = String(email || '').toLowerCase();
    if (!config.allowedDomains.length && !config.allowedEmails.length) return true;
    if (config.allowedEmails.includes(e)) return true;
    const dom = e.split('@')[1] || '';
    return config.allowedDomains.includes(dom);
  }

  function redirectUri() {
    return config.baseUrl + '/auth/callback';
  }
  function authUrl(state, forceConsent) {
    const q = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      include_granted_scopes: 'true',
      state,
    });
    if (forceConsent) q.set('prompt', 'consent');
    return GOOGLE_AUTH + '?' + q.toString();
  }
  async function exchangeCode(code) {
    const res = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Falha ao trocar o código do Google: ' + (j.error_description || j.error || res.status));
    // O id_token veio direto do Google por HTTPS nesta chamada, então basta ler o conteúdo.
    const claims = JSON.parse(fromB64url(String(j.id_token || '').split('.')[1] || '').toString('utf8') || '{}');
    if (claims.aud !== config.google.clientId) throw new Error('id_token com audiência inválida');
    if (!claims.email || claims.email_verified === false) throw new Error('E-mail do Google não verificado');
    return {
      user: { id: 'g_' + claims.sub, email: String(claims.email).toLowerCase(), name: claims.name || claims.email, picture: claims.picture || '' },
      accessToken: j.access_token,
      refreshToken: j.refresh_token || null,
      expiresAt: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000,
      scope: j.scope || '',
    };
  }
  async function refresh(refreshToken) {
    const res = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error('Falha ao renovar o acesso ao Google: ' + (j.error || res.status));
      err.code = j.error === 'invalid_grant' ? 'needs_reauth' : 'google_error';
      throw err;
    }
    return { accessToken: j.access_token, expiresAt: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000 };
  }

  // Devolve um access token válido do usuário, renovando quando preciso.
  async function accessTokenFor(store, uid) {
    const u = await store.getUser(uid);
    if (!u) throw Object.assign(new Error('usuário não encontrado'), { code: 'needs_reauth' });
    const at = decrypt(u.accessToken);
    if (at && u.tokenExpiry && u.tokenExpiry > Date.now()) return at;
    const rt = decrypt(u.refreshToken);
    if (!rt) throw Object.assign(new Error('Sem acesso ao Google Calendar. Saia e entre de novo.'), { code: 'needs_reauth' });
    const r = await refresh(rt);
    await store.setTokens(uid, { accessToken: encrypt(r.accessToken), tokenExpiry: r.expiresAt });
    return r.accessToken;
  }

  return {
    SCOPES, sign, verify, encrypt, decrypt, cookie, parseCookies,
    sessionCookie, clearSessionCookie, sessionUid, isAllowed,
    authUrl, exchangeCode, accessTokenFor,
  };
}

module.exports = { createAuth };
