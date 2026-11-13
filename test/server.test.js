'use strict';
const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'segredo-de-teste';
delete process.env.DATABASE_URL;

const config = require('../server/config');
const { createStore, deepMerge } = require('../server/store');
const { createAuth } = require('../server/auth');

test('deepMerge mescla objetos e substitui listas', () => {
  const a = { x: 1, r: { clima: 'neutro', o: { nivel: 'baixa', valor: 1 } }, l: [1, 2] };
  const b = { r: { o: { nivel: 'alta' } }, l: [3] };
  assert.deepStrictEqual(deepMerge(a, b), { x: 1, r: { clima: 'neutro', o: { nivel: 'alta', valor: 1 } }, l: [3] });
});

test('store em memória: put, merge, list, delete', async () => {
  const s = createStore(config);
  await s.init();
  await s.put('clientes', 'c1', { nome: 'A' }, 'u1');
  assert.deepStrictEqual(await s.get('clientes', 'c1'), { nome: 'A', id: 'c1' });
  await s.merge('clientes', 'c1', { status: 'ativo' }, 'u1');
  const all = await s.listAll();
  assert.strictEqual(all.clientes.length, 1);
  assert.strictEqual(all.clientes[0].status, 'ativo');
  assert.strictEqual(await s.merge('clientes', 'nao-existe', { a: 1 }), null);
  await s.del('clientes', 'c1');
  assert.strictEqual(await s.get('clientes', 'c1'), null);
});

test('store recusa coleção e id inválidos', async () => {
  const s = createStore(config);
  await assert.rejects(() => s.put('usuarios', 'x', {}), /coleção inválida/);
  await assert.rejects(() => s.put('clientes', '../x', {}), /id inválido/);
  await assert.rejects(() => s.put('clientes', 'x', [1]), /objeto JSON/);
});

test('sessão assinada: válida, adulterada e expirada', () => {
  const a = createAuth(config);
  const t = a.sign({ uid: 'u1', exp: Date.now() + 10000 });
  assert.strictEqual(a.verify(t).uid, 'u1');
  assert.strictEqual(a.verify(t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), null);
  assert.strictEqual(a.verify(a.sign({ uid: 'u1', exp: Date.now() - 1 })), null);
});

test('tokens do Google são cifrados e decifrados', () => {
  const a = createAuth(config);
  const enc = a.encrypt('refresh-token-123');
  assert.notStrictEqual(enc, 'refresh-token-123');
  assert.strictEqual(a.decrypt(enc), 'refresh-token-123');
  assert.strictEqual(a.decrypt('lixo'), null);
});

test('lista de acesso por domínio e e-mail', () => {
  const a = createAuth(Object.assign({}, config, { allowedDomains: ['empresa.com.br'], allowedEmails: ['fulano@gmail.com'] }));
  assert.ok(a.isAllowed('ana@empresa.com.br'));
  assert.ok(a.isAllowed('Fulano@Gmail.com'));
  assert.ok(!a.isAllowed('outro@gmail.com'));
});
