'use strict';
const crypto = require('node:crypto');

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function list(v) {
  return String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const env = process.env;
const isProd = env.NODE_ENV === 'production';

const config = {
  isProd,
  port: parseInt(env.PORT || '8080', 10),
  // URL pública do app, sem barra no final. Ex.: https://visitas.suaempresa.com.br
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 8080}`).replace(/\/+$/, ''),
  databaseUrl: env.DATABASE_URL || '',
  databaseSsl: bool(env.DATABASE_SSL, false),
  sessionSecret: env.SESSION_SECRET || '',
  sessionDays: parseInt(env.SESSION_DAYS || '30', 10),
  cookieSecure: bool(env.COOKIE_SECURE, isProd),
  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
  },
  // Quem pode entrar. Se os dois estiverem vazios, qualquer conta Google entra (não recomendado).
  allowedDomains: list(env.ALLOWED_DOMAINS), // ex.: suaempresa.com.br
  allowedEmails: list(env.ALLOWED_EMAILS), // ex.: fulano@gmail.com,ciclano@gmail.com
  timeZone: env.TZ_EVENTS || 'America/Sao_Paulo',
  // Login de desenvolvimento sem Google (nunca em produção).
  devLogin: !isProd && bool(env.DEV_LOGIN, false),
};

if (!config.sessionSecret) {
  if (isProd) {
    throw new Error('SESSION_SECRET é obrigatório em produção.');
  }
  config.sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[config] SESSION_SECRET não definido: usando um valor temporário (as sessões caem ao reiniciar).');
}
if (isProd && (!config.google.clientId || !config.google.clientSecret)) {
  throw new Error('GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET são obrigatórios em produção.');
}
if (!config.allowedDomains.length && !config.allowedEmails.length) {
  console.warn('[config] ALLOWED_DOMAINS e ALLOWED_EMAILS vazios: qualquer conta Google poderá entrar.');
}

module.exports = config;
