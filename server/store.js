'use strict';
/*
 * Armazenamento dos dados do app.
 * - PostgreSQL quando DATABASE_URL está definido (produção).
 * - Memória quando não está (desenvolvimento e testes; os dados somem ao reiniciar).
 *
 * Os registros do app (clientes, visitas, leads, equipe) ficam numa tabela de documentos JSON,
 * no mesmo formato que o front já usava.
 */

const COLLECTIONS = ['clientes', 'visitas', 'leads', 'equipe'];
const MAX_DOC_BYTES = 256 * 1024;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function deepMerge(target, patch) {
  const out = Object.assign({}, target);
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}
function validate(col, id, data) {
  if (!COLLECTIONS.includes(col)) throw Object.assign(new Error('coleção inválida'), { status: 404 });
  if (typeof id !== 'string' || !/^[A-Za-z0-9_\-.:@+~]{1,120}$/.test(id)) {
    throw Object.assign(new Error('id inválido'), { status: 400 });
  }
  if (data !== undefined) {
    if (!isPlainObject(data)) throw Object.assign(new Error('o corpo precisa ser um objeto JSON'), { status: 400 });
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_DOC_BYTES) {
      throw Object.assign(new Error('registro grande demais'), { status: 413 });
    }
  }
}

/* ---------------- memória ---------------- */
function memoryStore() {
  const docs = new Map(); // col -> Map(id -> {data, updatedAt})
  const users = new Map();
  for (const c of COLLECTIONS) docs.set(c, new Map());
  return {
    kind: 'memory',
    async init() {},
    async ping() { return true; },
    async listAll() {
      const out = {};
      for (const c of COLLECTIONS) {
        out[c] = [...docs.get(c).entries()].map(([id, d]) => Object.assign({}, d.data, { id }));
      }
      return out;
    },
    async get(col, id) {
      validate(col, id);
      const d = docs.get(col).get(id);
      return d ? Object.assign({}, d.data, { id }) : null;
    },
    async put(col, id, data, by) {
      validate(col, id, data);
      docs.get(col).set(id, { data: JSON.parse(JSON.stringify(data)), updatedAt: Date.now(), by });
      return Object.assign({}, data, { id });
    },
    async merge(col, id, patch, by) {
      validate(col, id, patch);
      const cur = docs.get(col).get(id);
      if (!cur) return null;
      const data = deepMerge(cur.data, JSON.parse(JSON.stringify(patch)));
      validate(col, id, data);
      docs.get(col).set(id, { data, updatedAt: Date.now(), by });
      return Object.assign({}, data, { id });
    },
    async del(col, id) {
      validate(col, id);
      docs.get(col).delete(id);
    },
    async upsertUser(u) {
      const cur = users.get(u.id) || {};
      const next = Object.assign({}, cur, u, { lastLogin: Date.now() });
      users.set(u.id, next);
      return next;
    },
    async getUser(id) { return users.get(id) || null; },
    async listUsers() {
      return [...users.values()].map((u) => ({ id: u.id, name: u.name, email: u.email, picture: u.picture }));
    },
    async setTokens(id, t) {
      const cur = users.get(id);
      if (cur) users.set(id, Object.assign({}, cur, t));
    },
    async close() {},
  };
}

/* ---------------- PostgreSQL ---------------- */
function pgStore(config) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });
  const row = (r) => Object.assign({}, r.data, { id: r.id });
  return {
    kind: 'postgres',
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS docs (
          col        text        NOT NULL,
          id         text        NOT NULL,
          data       jsonb       NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now(),
          updated_by text,
          PRIMARY KEY (col, id)
        );
        CREATE TABLE IF NOT EXISTS users (
          id            text PRIMARY KEY,
          email         text NOT NULL,
          name          text,
          picture       text,
          refresh_token text,
          access_token  text,
          token_expiry  bigint,
          created_at    timestamptz NOT NULL DEFAULT now(),
          last_login    timestamptz
        );
      `);
    },
    async ping() { await pool.query('SELECT 1'); return true; },
    async listAll() {
      const { rows } = await pool.query('SELECT col, id, data FROM docs WHERE col = ANY($1)', [COLLECTIONS]);
      const out = {};
      for (const c of COLLECTIONS) out[c] = [];
      for (const r of rows) out[r.col].push(row(r));
      return out;
    },
    async get(col, id) {
      validate(col, id);
      const { rows } = await pool.query('SELECT id, data FROM docs WHERE col=$1 AND id=$2', [col, id]);
      return rows[0] ? row(rows[0]) : null;
    },
    async put(col, id, data, by) {
      validate(col, id, data);
      await pool.query(
        `INSERT INTO docs (col, id, data, updated_at, updated_by) VALUES ($1,$2,$3,now(),$4)
         ON CONFLICT (col, id) DO UPDATE SET data=EXCLUDED.data, updated_at=now(), updated_by=EXCLUDED.updated_by`,
        [col, id, data, by || null],
      );
      return Object.assign({}, data, { id });
    },
    async merge(col, id, patch, by) {
      validate(col, id, patch);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT data FROM docs WHERE col=$1 AND id=$2 FOR UPDATE', [col, id]);
        if (!rows[0]) { await client.query('ROLLBACK'); return null; }
        const data = deepMerge(rows[0].data, patch);
        validate(col, id, data);
        await client.query('UPDATE docs SET data=$3, updated_at=now(), updated_by=$4 WHERE col=$1 AND id=$2', [col, id, data, by || null]);
        await client.query('COMMIT');
        return Object.assign({}, data, { id });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async del(col, id) {
      validate(col, id);
      await pool.query('DELETE FROM docs WHERE col=$1 AND id=$2', [col, id]);
    },
    async upsertUser(u) {
      const { rows } = await pool.query(
        `INSERT INTO users (id, email, name, picture, last_login) VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, name=EXCLUDED.name, picture=EXCLUDED.picture, last_login=now()
         RETURNING *`,
        [u.id, u.email, u.name || '', u.picture || ''],
      );
      return rows[0];
    },
    async getUser(id) {
      const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
      const r = rows[0];
      if (!r) return null;
      return { id: r.id, email: r.email, name: r.name, picture: r.picture, refreshToken: r.refresh_token, accessToken: r.access_token, tokenExpiry: r.token_expiry ? Number(r.token_expiry) : 0 };
    },
    async listUsers() {
      const { rows } = await pool.query('SELECT id, name, email, picture FROM users ORDER BY name');
      return rows;
    },
    async setTokens(id, t) {
      const sets = [];
      const vals = [id];
      if (t.refreshToken !== undefined) { vals.push(t.refreshToken); sets.push(`refresh_token=$${vals.length}`); }
      if (t.accessToken !== undefined) { vals.push(t.accessToken); sets.push(`access_token=$${vals.length}`); }
      if (t.tokenExpiry !== undefined) { vals.push(t.tokenExpiry); sets.push(`token_expiry=$${vals.length}`); }
      if (!sets.length) return;
      await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id=$1`, vals);
    },
    async close() { await pool.end(); },
  };
}

function createStore(config) {
  return config.databaseUrl ? pgStore(config) : memoryStore();
}

module.exports = { createStore, COLLECTIONS, deepMerge };
